# Spatial integration

## Why

- Give each Home Assistant area an optional footprint on the map.
- Give each floor an elevation and height, so floors stack in 3D.
- Answer "which room is this point in?" and "which rooms are next to this one?".

## How to use

1. Install and add **Spatial** as in the root [README](../../README.md#install) (one instance).
2. Draw footprints in the panel and show them on a dashboard: see the
   [user guide](../../docs/user-guide.md). Or import them with
   [`tools/import_geojson.py`](../../tools/README.md).
3. Read and write the data from elsewhere through the websocket API below.

## Architecture

### Data

| Object | Keyed by | Fields | Owner of the key |
| --- | --- | --- | --- |
| Area footprint | `area_id` | `polygon` (GeoJSON, WGS84), `floors_up` (floors the room reaches above its own, 0), `on_facade_override` (null, true or false); `area_m2`, `floor_ids`, `on_facade` and `is_external` are computed on read | Area registry |
| Floor | `floor_id` | `elevation_m`, `height_m` (both optional) | Floor registry |
| Site | - | `bearing_deg` (null until the first Align), `origin` (`[lon, lat]` of the grid, or null until the first write), `outline` (the exterior wall axis, GeoJSON Polygon or null); the centre is derived, not stored | This integration |
| Onboarding | - | `home_pin` (null) | This integration |

- Stored in `.storage/spatial` as version 1.3, written atomically 2 seconds after the last change, and on unload and shutdown.
- Data saved by an older release is migrated on load: every key is present afterwards, and a stored `area_m2` and the site's `lon` and `lat` are dropped. A site saved before 1.3 without an origin gets the default origin below, so its plans are measured; no stored geometry moves. An older release drops the newer fields on its first save.
- `home_pin` keeps its default; no command sets it yet.
- Each area entry and the site have a `rev`: the first 12 hex characters of the sha256 of the entry as sorted JSON. Derived, never stored; it changes exactly when the content changes, whoever changed it.
- Names, levels and floor assignment are read from Home Assistant's registries, never copied.
- Deleting an area or floor in Home Assistant deletes its spatial data.
- Floors without data stack 3 m per level.
- Site centre: the middle of the bounding box of all footprints, computed on every read; else the building outline, else the home location. The bearing is null until the first Align.
- Site origin: the grid origin; the 10 cm (4 in) drawing grid runs along the site bearing from it, or north before the first Align. Set by Align, with the bearing, to the left end of the picked wall while the plan is empty; never moved automatically; the centre may move, the origin does not. The first write to a site without an origin, unless it sets one, stores the default origin: the first corner of the outline, else of the first footprint, else the home location. A site whose origin was removed reads on that default.
- Site frame and lattice: the origin, the bearing and the WGS84 radii at the origin's latitude give one plane per site. Coordinates are stored exactly as written; every read snaps them to the lattice in that plane (a quarter of the drawing grid of Home Assistant's unit system: 2.5 cm, or 1 in for US customary; a unit switch reads everything again on the new lattice), and every derived value is computed from those lattice points. Reads return the snapped coordinates, which snap to themselves again. A new bearing or origin moves no stored data, only the lattice it is read on.
- Site frame as published: `frame` holds the effective origin and bearing (after the defaults), `unit_m` (the lattice unit), `units_per_step` and `to_lattice`, the 2 x 2 matrix that maps `[lon - lon0, lat - lat0]` to lattice units; its inverse maps back. Clients apply it instead of computing their own.

### Websocket API

| Command | Admin | Input | Result |
| --- | --- | --- | --- |
| `spatial/geojson` | no | `floor_id`? (the areas occupying that floor) | FeatureCollection of footprints, JSON-FG conformant (`conformsTo`), each feature with `featureType` `https://w3id.org/bot#Space` |
| `spatial/query_point` | no | `lon`, `lat`, `floor_id`? (among the areas occupying that floor) | `{area_id}` (smallest match, or null) |
| `spatial/area/adjacent` | no | `area_id` | `{area_ids}` |
| `spatial/site` | no | - | `{lon, lat, bearing_deg, origin, outline, rev, frame, api_version}`: `lon` and `lat` are the site centre, the outline is on the lattice, `frame` is the site frame as published (see Data), `api_version` is the contract (see Compatibility) |
| `spatial/subscribe` | no | - | An empty event message on every change, until `unsubscribe_events` |
| `spatial/area/update_geometries` | yes | `areas`?: `{area_id: polygon or null}` (null removes); `properties`?: `{area_id: {floors_up?, on_facade_override?}}` (for areas with a footprint after the change; omitted ones are kept); `site`?: `{bearing_deg?, origin?, outline?}` (null removes one); `expected_rev`?: `{area_id: rev or null}` (null: expect no footprint); `expected_site_rev`?; areas, properties and/or site | `{area_m2: {area_id: m²}, rev: {area_id: rev or null}, site_rev}` (`rev` of every area in areas or properties) |
| `spatial/floor/update` | yes | `floor_id`, `elevation_m`?, `height_m`? (null clears one; omitted ones are kept) | - |
| `spatial/site/update` | yes | `bearing_deg`? (0 to under 360, or null to remove), `origin`? (`[lon, lat]`, or null to remove), `outline`? (Polygon, or null to remove); at least one; `expected_rev`? (the site rev) | `{site_rev}` |
| `spatial/address/search` | yes | `query` (3 to 200 characters after trimming) | `{places: [{label, lat, lon, bbox}]}`: up to 5 places from OpenStreetMap Nominatim, places near Home Assistant's home preferred; `bbox` is `[west, south, east, north]` or null |

- Feature properties, ready for automations and exports:

  | Property | Meaning |
  | --- | --- |
  | `area_id`, `name` | The area, named as in Home Assistant |
  | `floor_id`, `level` | Its Home Assistant floor, the lowest one it occupies (null for a site-level area) |
  | `area_m2` | Net area in m² |
  | `base_m`, `top_m` | Bottom of its floor and top of the highest floor it occupies (ready for MapLibre `fill-extrusion`) |
  | `floors_up` | Stored: floors it reaches above its own, such as a stairwell or a double-height living room |
  | `floor_ids` | Derived: the floors it occupies, lowest first (empty without a floor) |
  | `on_facade_override` | Stored: null, or the value that replaces the derived `on_facade` |
  | `on_facade` | Derived: the room shares at least 0.3 m of the outline, unless overridden |
  | `is_external` | Derived: an outdoor room (IFC `Pset_SpaceCommon.IsExternal`): it lies outside the outline, touching allowed; false without an outline |
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
- Errors: `not_found` (unknown area or floor), `invalid_format` (bad input, a polygon that fails on the lattice, or a room without net area; the message names the area or `outline`), `outside_outline` (an indoor room would extend beyond the outline: a written room, or any room when the outline, origin or bearing changes, lies across it; the message lists the area ids), `conflict` (an
  expected rev no longer matches; the message lists the area ids and `site`), `search_failed` (the search server could not be reached or gave no usable answer; the message says which, so a client can offer to try again), `unauthorized`.
- `spatial/address/search` sends the query to OpenStreetMap Nominatim, one request per second at most across the integration (a search waits for the previous one), with Home Assistant's language and an identifying user agent; see [Privacy](../../README.md#privacy).
- Event `spatial_updated` fires after every change, including every floor registry change (it can change the floors a room occupies); non-admin users follow it through `spatial/subscribe`.

### Compatibility

The `spatial/*` commands are a public contract for tools, bridges and cards.

- `api_version` in the `spatial/site` result is a whole number, now 1. Check it before relying on
  the other commands, and stop or warn on a version you do not know.
- A breaking change to a command's input schema or result shape raises `api_version` and is
  named in the release notes.
- Additions do not raise it: a new optional input, a new result field, a new command. Ignore
  fields you do not know.
- Before 1.0 a breaking change can still happen, but never silently.

### Panel and card

The integration serves the admin-only panel at `/spatial` and the dashboard card
`custom:spatial-map-card`. How to open and use them is in the
[user guide](../../docs/user-guide.md); their source, build and the commands each action sends
are in the [frontend README](../../frontend/README.md).

### Rules

| Rule | Value |
| --- | --- |
| Polygon | RFC 7946 `Polygon`, closed rings, at least 4 positions; holes (inner rings) allowed, never a MultiPolygon. Checked on the lattice as it will be read, rejected with `invalid_format` and the reason: "A ring needs at least three corners" (also when corners snap together), "A polygon may have at most 500 corners", "A ring crosses itself", "Rings must not cross or share an edge", "A hole must lie inside the outline", "A hole must not lie inside another hole", "Holes must not split the area", "A corner must be between 45 and 315 degrees", "An edge must be at least one grid step" (10 cm, or 4 in). Rings may touch in single points that leave the area in one piece |
| Adjacency | On every floor both rooms occupy (site-level rooms only with each other), wall axes of outer and inner rings coinciding exactly on the lattice over at least 0.3 m, so a room filling a hole is adjacent to the room around it |
| Rooms across floors | A room occupies its Home Assistant floor and the `floors_up` floors with the next higher levels (floors on one level ordered by `floor_id`); a floor deleted later shortens `floor_ids`, `floors_up` stays as stored |
| Outline | The exterior wall axis. A room lies inside it or outside it, touching allowed; tested exactly on the lattice (edges crossing, outline edges running through the room, then the side of one piece of the room's boundary) |
| Area | `area_m2` is the net area: the lattice polygon, holes subtracted, with each edge piece moved in by half a wall: 15 cm (3 in) where it lies on the outline, unless `on_facade_override` is false, 5 cm (2 in) elsewhere, in whole lattice units (6 and 2 of 2.5 cm, 3 and 2 of 1 in). Exact for right angles; a diagonal corner between unequal insets is approximated |
| Point in polygon | PNPOLY on the lattice; a point in a hole is outside the room; a point exactly on an edge may fall either way |
| Overlaps | `query_point` returns the smallest containing area |

### Modules

| File | Responsibility |
| --- | --- |
| `__init__.py` | Setup, `runtime_data`, websocket registration, admin-only `spatial` panel behind Configure, without a sidebar entry, and the card module (bundles in `frontend/`, served at `/spatial_static`) |
| `config_flow.py` | Single-instance config flow, with a link to the editor on its success step |
| `coordinator.py` | Data access, registry sync, queries |
| `store.py` | Persistence and migration of data saved by older releases |
| `geometry.py` | All geometry: the site frame and lattice, validation, net area, point in polygon, shared edges, the room's relation to the outline |
| `websocket_api.py` | Websocket commands and validation |
| `address_search.py` | The address search request to Nominatim, its rate limit and the mapping of its answer |
