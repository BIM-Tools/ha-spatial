# Spatial integration

## Why

- Give each Home Assistant area an optional footprint on the map.
- Give each floor an elevation and height, so floors stack in 3D.
- Answer "which room is this point in?" and "which rooms are next to this one?".

## How to use

1. Copy `custom_components/spatial/` into your Home Assistant `config/custom_components/`.
2. Restart, then add **Spatial** under Settings > Devices & services (one instance).
3. Add footprints, for now with `tools/import_geojson.py` (no editor yet).
4. Read the data over the websocket API below, for example from a dashboard card.

## Architecture

### Data

| Object | Keyed by | Fields | Owner of the key |
| --- | --- | --- | --- |
| Area footprint | `area_id` | `polygon` (GeoJSON, WGS84), `area_m2` (computed) | Area registry |
| Floor | `floor_id` | `elevation_m`, `height_m` (both optional) | Floor registry |
| Site | - | `bearing_deg` (the centre is derived, not stored) | This integration |

- Stored in `.storage/spatial`, written 2 seconds after the last change, and on unload and shutdown.
- Names, levels and floor assignment are read from Home Assistant's registries, never copied.
- Deleting an area or floor in Home Assistant deletes its spatial data.
- Floors without data stack 3 m per level.
- Site centre: the middle of the bounding box of all footprints, computed on every read; the home location without footprints. The bearing defaults to north.

### Websocket API

| Command | Admin | Input | Result |
| --- | --- | --- | --- |
| `spatial/geojson` | no | `floor_id`? | FeatureCollection of footprints, JSON-FG conformant (`conformsTo`), each feature with `featureType` `https://w3id.org/bot#Space` |
| `spatial/query_point` | no | `lon`, `lat`, `floor_id`? | `{area_id}` (smallest match, or null) |
| `spatial/area/adjacent` | no | `area_id` | `{area_ids}` |
| `spatial/site` | no | - | `{lon, lat, bearing_deg}` (centre derived from the footprints) |
| `spatial/area/update_geometries` | yes | `areas`: `{area_id: polygon or null}` (null removes) | `{area_m2: {area_id: m²}}` |
| `spatial/floor/update_spatial` | yes | `floor_id`, `elevation_m`?, `height_m`? | - |
| `spatial/site/update` | yes | `bearing_deg` (0 to under 360) | - |

- Feature properties: `area_id`, `name`, `floor_id`, `level`, `area_m2`, `base_height`, `height`
  (ready for MapLibre `fill-extrusion`).
- Errors: `not_found` (unknown area or floor), `invalid_format` (bad input), `unauthorized`.
- Event `spatial_updated` fires after every change.

### Rules

| Rule | Value |
| --- | --- |
| Polygon | RFC 7946 `Polygon`, closed rings, at least 4 positions, holes allowed |
| Adjacency | Same floor, edges within 0.05 m over at least 0.3 m |
| Area | Local tangent plane with exact WGS84 radii, holes subtracted |
| Point in polygon | PNPOLY; a point exactly on an edge may fall either way |
| Overlaps | `query_point` returns the smallest containing area |

### Modules

| File | Responsibility |
| --- | --- |
| `__init__.py` | Setup, `runtime_data`, websocket registration, admin-only `spatial` panel (bundle in `frontend/`, served at `/spatial_static`) |
| `config_flow.py` | Single-instance config flow |
| `coordinator.py` | Data access, registry sync, queries |
| `store.py` | Persistence |
| `geometry.py` | All geometry: validation, m², point in polygon, shared edges |
| `websocket_api.py` | Websocket commands and validation |
