# Spatial integration

## Why

- Give each Home Assistant area an optional footprint on the map.
- Give each floor an elevation and height, so floors stack in 3D.
- Answer "which room is this point in?" and "which rooms are next to this one?".

## How to use

1. Copy `custom_components/spatial/` into your Home Assistant `config/custom_components/`.
2. Restart, then add **Spatial** under Settings > Devices & services (one instance).
3. Add footprints, for now with `tools/import_geojson.py` (no editor yet).
4. Show the rooms on a dashboard: add a card with `type: custom:spatial-map-card`, best in a
   view of type Panel so the map fills it. Everyone who can see the dashboard sees the map.
   The card has one option, in YAML:

   | `floor` | Shows |
   | --- | --- |
   | not set | Floor buttons; pan, zoom and rotate |
   | `all` | All floors in 3D, fixed |
   | a `floor_id` | That floor as a plan, fixed |

   A fixed view has no buttons, frames its rooms and follows changes. A dashboard view with
   all three:

   ```yaml
   title: Floors
   type: sections
   sections:
     - type: grid
       cards:
         - type: custom:spatial-map-card
           floor: all
         - type: custom:spatial-map-card
           floor: ground_floor
         - type: custom:spatial-map-card
           floor: first_floor
   ```

## Architecture

### Data

| Object | Keyed by | Fields | Owner of the key |
| --- | --- | --- | --- |
| Area footprint | `area_id` | `polygon` (GeoJSON, WGS84), `area_m2` (computed) | Area registry |
| Floor | `floor_id` | `elevation_m`, `height_m` (both optional) | Floor registry |
| Site | - | `bearing_deg`, `outline` (GeoJSON Polygon or null; the centre is derived, not stored) | This integration |

- Stored in `.storage/spatial`, written 2 seconds after the last change, and on unload and shutdown.
- Names, levels and floor assignment are read from Home Assistant's registries, never copied.
- Deleting an area or floor in Home Assistant deletes its spatial data.
- Floors without data stack 3 m per level.
- Site centre: the middle of the bounding box of all footprints, computed on every read; else the building outline, else the home location. The bearing defaults to north.

### Websocket API

| Command | Admin | Input | Result |
| --- | --- | --- | --- |
| `spatial/geojson` | no | `floor_id`? | FeatureCollection of footprints, JSON-FG conformant (`conformsTo`), each feature with `featureType` `https://w3id.org/bot#Space` |
| `spatial/query_point` | no | `lon`, `lat`, `floor_id`? | `{area_id}` (smallest match, or null) |
| `spatial/area/adjacent` | no | `area_id` | `{area_ids}` |
| `spatial/site` | no | - | `{lon, lat, bearing_deg, outline}` (centre derived from the footprints, else the outline, else the home location) |
| `spatial/subscribe` | no | - | An empty event message on every change, until `unsubscribe_events` |
| `spatial/area/update_geometries` | yes | `areas`: `{area_id: polygon or null}` (null removes) | `{area_m2: {area_id: m²}}` |
| `spatial/floor/update_spatial` | yes | `floor_id`, `elevation_m`?, `height_m`? | - |
| `spatial/site/update` | yes | `bearing_deg`? (0 to under 360), `outline`? (Polygon, or null to remove); at least one | - |

- Feature properties: `area_id`, `name`, `floor_id`, `level`, `area_m2`, `base_height`, `height`
  (ready for MapLibre `fill-extrusion`).
- Errors: `not_found` (unknown area or floor), `invalid_format` (bad input), `unauthorized`.
- Event `spatial_updated` fires after every change; non-admin users follow it through `spatial/subscribe`.

### Panel

Settings > Devices & services > Spatial > Configure opens the admin-only Spatial panel.

- Home Assistant's own map: its shipped light or dark style, following the theme, with tiles from the `map_tiles` proxy.
- Centred on the site, rotated so the site direction (the picked wall) is horizontal.
- "All" stacks the floors in 3D; a button per floor (named as in Home Assistant, ordered by level) shows that floor as a flat plan with room outlines; "No floor" shows areas without one.
- Updates through `spatial/subscribe`; shows "No rooms yet" without footprints.
- **Building**: one click on an OSM building from the map tiles, near a wall, saves the outline (0.25 m inside the OSM outline, starting at that wall) and its bearing with one `spatial/site/update`. Without a building it says "No building here"; when the inset leaves nothing or splits the building, "Building too small or irregular". The outline is drawn on the map in the panel and the card.
- The card `custom:spatial-map-card` shows the same view on a dashboard, for every user, without the menu button and the Building button; it fills a panel view and is 400 px high elsewhere. Its `floor` option fixes the view: MapLibre's `interactive: false`, framed with `fitBounds` on every update.
- Source in `frontend/` at the repository root; it builds the bundles and MapLibre's worker into `frontend/` here. They are not in git; the release zip contains them.

### Rules

| Rule | Value |
| --- | --- |
| Polygon | RFC 7946 `Polygon`, closed rings, at least 4 positions, holes allowed; self-intersection is not checked |
| Adjacency | Same floor, edges within 0.05 m over at least 0.3 m |
| Area | `area_m2` is the net area: local tangent plane with exact WGS84 radii, holes subtracted, shrunk by 50 mm on every side (exact for right angles) |
| Point in polygon | PNPOLY; a point exactly on an edge may fall either way |
| Overlaps | `query_point` returns the smallest containing area |

### Modules

| File | Responsibility |
| --- | --- |
| `__init__.py` | Setup, `runtime_data`, websocket registration, admin-only `spatial` panel and the card module (bundles in `frontend/`, served at `/spatial_static`) |
| `config_flow.py` | Single-instance config flow |
| `coordinator.py` | Data access, registry sync, queries |
| `store.py` | Persistence |
| `geometry.py` | All geometry: validation, m², point in polygon, shared edges |
| `websocket_api.py` | Websocket commands and validation |
