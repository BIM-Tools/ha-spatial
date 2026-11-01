# Spatial integration

## Why

- Give each Home Assistant area an optional footprint on the map.
- Give each floor an elevation and height, so floors stack in 3D.
- Answer "which room is this point in?" and "which rooms are next to this one?".

## How to use

1. Install and add **Spatial** as in the root [README](../../README.md#install) (one instance).
2. Draw footprints in the panel (Spatial > Configure, or Open Spaces after adding it; see Panel below), or import them
   with `tools/import_geojson.py`.
3. Show the rooms on a dashboard: add a card with `type: custom:spatial-map-card`, best in a
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
| Area footprint | `area_id` | `polygon` (GeoJSON, WGS84), `floors_up` (floors the room reaches above its own, 0), `on_facade_override` (null, true or false); `area_m2`, `floor_ids`, `on_facade` and `is_external` are computed on read | Area registry |
| Floor | `floor_id` | `elevation_m`, `height_m` (both optional) | Floor registry |
| Site | - | `bearing_deg` (null until the first Align), `origin` (`[lon, lat]` of the grid, or null), `outline` (the drawn facade, GeoJSON Polygon or null); the centre is derived, not stored | This integration |
| Onboarding | - | `home_pin` (null) | This integration |

- Stored in `.storage/spatial` as version 1.2, written atomically 2 seconds after the last change, and on unload and shutdown.
- Data saved by an older release is migrated on load: every key is present afterwards, and a stored `area_m2` and the site's `lon` and `lat` are dropped. An older release drops the newer fields on its first save.
- `home_pin` keeps its default; no command sets it yet.
- Each area entry and the site have a `rev`: the first 12 hex characters of the sha256 of the entry as sorted JSON. Derived, never stored; it changes exactly when the content changes, whoever changed it.
- Names, levels and floor assignment are read from Home Assistant's registries, never copied.
- Deleting an area or floor in Home Assistant deletes its spatial data.
- Floors without data stack 3 m per level.
- Site centre: the middle of the bounding box of all footprints, computed on every read; else the building outline, else the home location. The bearing is null until the first Align.
- Site origin: the grid origin; the 10 cm drawing grid runs along the site bearing from it. Set at Align and never moved automatically; the centre may move, the origin does not.

### Websocket API

| Command | Admin | Input | Result |
| --- | --- | --- | --- |
| `spatial/geojson` | no | `floor_id`? (the areas occupying that floor) | FeatureCollection of footprints, JSON-FG conformant (`conformsTo`), each feature with `featureType` `https://w3id.org/bot#Space` |
| `spatial/query_point` | no | `lon`, `lat`, `floor_id`? (among the areas occupying that floor) | `{area_id}` (smallest match, or null) |
| `spatial/area/adjacent` | no | `area_id` | `{area_ids}` |
| `spatial/site` | no | - | `{lon, lat, bearing_deg, origin, outline, rev}` (`bearing_deg` null until the first Align; centre derived from the footprints, else the outline, else the home location) |
| `spatial/subscribe` | no | - | An empty event message on every change, until `unsubscribe_events` |
| `spatial/area/update_geometries` | yes | `areas`?: `{area_id: polygon or null}` (null removes); `properties`?: `{area_id: {floors_up?, on_facade_override?}}` (for areas with a footprint after the change; omitted ones are kept); `site`?: `{bearing_deg?, origin?, outline?}` (null removes one); `expected_rev`?: `{area_id: rev or null}` (null: expect no footprint); `expected_site_rev`?; areas, properties and/or site | `{area_m2: {area_id: m²}, rev: {area_id: rev or null}, site_rev}` (`rev` of every area in areas or properties) |
| `spatial/floor/update` | yes | `floor_id`, `elevation_m`?, `height_m`? (null clears one; omitted ones are kept) | - |
| `spatial/site/update` | yes | `bearing_deg`? (0 to under 360, or null to remove), `origin`? (`[lon, lat]`, or null to remove), `outline`? (Polygon, or null to remove); at least one; `expected_rev`? (the site rev) | `{site_rev}` |

- Feature properties, ready for automations and exports:

  | Property | Meaning |
  | --- | --- |
  | `area_id`, `name` | The area, named as in Home Assistant |
  | `floor_id`, `level` | Its Home Assistant floor, the lowest one it occupies (null for a site-level area) |
  | `area_m2` | Net area, see Rules |
  | `base_m`, `top_m` | Bottom of its floor and top of the highest floor it occupies (ready for MapLibre `fill-extrusion`) |
  | `floors_up` | Stored: floors it reaches above its own |
  | `floor_ids` | Derived: the floors it occupies, lowest first (empty without a floor) |
  | `on_facade_override` | Stored: null, or the value that replaces the derived `on_facade` |
  | `on_facade` | Derived: an edge lies on the outline (within 0.05 m over at least 0.3 m), unless overridden |
  | `is_external` | Derived: an outdoor room (IFC `Pset_SpaceCommon.IsExternal`): more than half of its area lies outside the outline; false without an outline |
  | `rev` | The rev of its entry |

- `spatial/site/update` and the `site` part of `spatial/area/update_geometries` accept the same fields and check `expected_rev` the same way as `expected_site_rev`.
- `properties` in `spatial/area/update_geometries`: `floors_up` is a whole number from 0 up to
  the number of floors with a higher level than the area's floor (0 without a floor, or on a
  floor without a level); `on_facade_override` is null, true or false. An area without a
  footprint, or more floors than exist, return `invalid_format`. Changing only properties keeps
  the polygon.
- `spatial/area/update_geometries` is one change: areas, properties and site are written together, saved once
  and announced with one event, or not at all. With expected revs it writes only if every one
  still matches, so an undo never overwrites a change made elsewhere; without them the last
  writer wins.
- Errors: `not_found` (unknown area or floor), `invalid_format` (bad input), `conflict` (an
  expected rev no longer matches; the message lists the area ids and `site`), `unauthorized`.
- Event `spatial_updated` fires after every change, including every floor registry change (it can change the floors a room occupies) and every core config change (the unit system sets net areas, the home location the centre); non-admin users follow it through `spatial/subscribe`.

### Panel

The admin-only Spatial panel at `/spatial` has no sidebar entry and Spatial has no options. Admins open it with **Open Spaces** on the success step after adding Spatial, or later with Settings > Devices & services > Spatial > **Configure**; a link in the card's full-screen view follows later.

- A Home Assistant subpage header, "Spaces", with Back (always to the integration page) and a Help link to the documentation; the map fills the rest and the controls float on it.
- Home Assistant's own map: its shipped light or dark style, following the theme, with tiles from the `map_tiles` proxy.
- Centred on the site, rotated so the site direction (the picked wall) is horizontal; north up before any Align.
- "All" stacks the floors in 3D; a button per floor (named as in Home Assistant, ordered by level) shows that floor as a flat plan with room outlines; "No floor" shows areas without one.
- Updates through `spatial/subscribe`; shows "No rooms yet" without footprints.
- Floor buttons list every floor of the floor registry, plus "No floor"; the card lists only floors with rooms.
- Exactly one tool is active: Align, Draw or Adjust, Adjust by default. On "All" every tool, Undo and Redo are disabled. On a phone (600 px wide or less) the floors are a chip row under the header and the tools a bar at the bottom.
- The map stack: the map toggle (on by default, remembered per browser, forced on during Align; off shows the plan on the page colour without vector tiles), zoom in, zoom out and a compass that turns with the map; a click returns to the site direction ("Face the house"), or to north before any Align ("Face north"); also in Draw, which keeps that view.
- **Draw**, on a floor: a strip lists a Building pill, then the floor's areas from the area registry, those without a footprint first. Building is highlighted first on every floor while there is no outline; its boxes are saved with `spatial/site/update` `outline`, its undo of the first box with `outline: null`. Pressing and dragging, or two clicks or taps, draws a box along the site direction (north up before any Align); it is saved at once to the highlighted area with one `spatial/area/update_geometries`, joined to its footprint when they touch ("A room is one shape: draw against it" when they do not); a drag that starts inside the highlighted space moves it. The next area without a footprint is highlighted next. "+ New area" creates "Room 1" (the first free number) on the floor with `config/area_registry/create`; tapping the highlighted area renames it with `config/area_registry/update`. Space plus drag pans, Escape cancels a box; "All" does not draw.
- **Adjust**, on a floor: a tap on a room makes its area active; when it is a rectangle along the site direction, a tap on a side length opens a number field, and Enter saves the side at that length (at least 0.20 m) with one `spatial/area/update_geometries`, or `spatial/site/update` for the outline. **Undo** and **Redo** (Ctrl+Z, Ctrl+Shift+Z) send the previous or next footprints of the session as one batch; undo never deletes an area from the registry.
- **Align**, on a floor: one click on an OSM building from the map tiles, near a wall, saves that wall's bearing with one `spatial/site/update` `bearing_deg`, then Adjust is active again; without a building it says "No building here". The outline is drawn on the map in the panel and the card.
- The card `custom:spatial-map-card` shows the same view on a dashboard, for every user, without the header, the toolbar, the map stack and the strip; it fills a panel view and is 400 px high elsewhere. Its `floor` option fixes the view: MapLibre's `interactive: false`, framed with `fitBounds` on every update.
- Source in `frontend/` at the repository root; it builds the bundles and MapLibre's worker into `frontend/` here. They are not in git; the release zip contains them.

### Rules

| Rule | Value |
| --- | --- |
| Polygon | RFC 7946 `Polygon`, closed rings, at least 4 positions; holes (inner rings) allowed, never a MultiPolygon. Rejected with `invalid_format`; footprints and outlines name the reason: "A ring needs at least three corners", "A polygon may have at most 500 corners", "A ring crosses itself", "Rings must not cross or share an edge", "A hole must lie inside the outline", "A hole must not lie inside another hole", "Holes must not split the area". Rings may touch in single points that leave the area in one piece; tests are exact in degrees |
| Adjacency | On every floor both rooms occupy (site-level rooms only with each other), edges of outer and inner rings within 0.05 m over at least 0.3 m, so a room filling a hole is adjacent to the room around it |
| Rooms across floors | A room occupies its Home Assistant floor and the `floors_up` floors with the next higher levels (floors on one level ordered by `floor_id`); a floor deleted later shortens `floor_ids`, `floors_up` stays as stored |
| Outdoor | `is_external` compares the room's common area with the outline (exact for any polygons, holes included) with half its gross area; exactly half counts as indoor |
| Area | `area_m2` is the net area: local tangent plane with exact WGS84 radii, holes subtracted. Every edge moves in by 50 mm, holes grow by 50 mm; when an indoor room (not `is_external`) is on the outline as for `on_facade` (the override aside), each outer edge along it (over more than 0.05 m) moves in by the exterior wall offset instead: 0.25 m with Home Assistant's metric unit system, 0.11 m with US customary (an assumption about thinner walls, not yet validated). Switching the unit system applies at once. Edges are offset and intersected (mitred), exact for any corner angle; a part narrower than twice its inset is miscounted, edges turning less than 10 degrees with different insets step at their shared corner, and a room shrunk to nothing measures 0 |
| Point in polygon | PNPOLY; a point in a hole is outside the room; a point exactly on an edge may fall either way |
| Overlaps | `query_point` returns the smallest containing area |

### Modules

| File | Responsibility |
| --- | --- |
| `__init__.py` | Setup, `runtime_data`, websocket registration, admin-only `spatial` panel behind Configure, without a sidebar entry, and the card module (bundles in `frontend/`, served at `/spatial_static`) |
| `config_flow.py` | Single-instance config flow, with a link to the editor on its success step |
| `coordinator.py` | Data access, registry sync, queries |
| `store.py` | Persistence and migration of data saved by older releases |
| `geometry.py` | All geometry: validation, m², point in polygon, shared edges, common area of two polygons |
| `websocket_api.py` | Websocket commands and validation |
