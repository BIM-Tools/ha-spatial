# tools

Development tools. Not part of the integration.

## Why

- Get footprints into Home Assistant before there is an editor.
- See the result on Home Assistant's own map.
- Try aligning on your own building.

## How to use

| Step | Command |
| --- | --- |
| Start Home Assistant | `docker compose up homeassistant` (finish onboarding, add Spatial, create a token) |
| Import the example | `docker compose run --rm test python tools/import_geojson.py tools/example_house.geojson --url http://host.docker.internal:8123 --token <token>` |
| Install the viewer | Copy `tools/viewer.html` to `.ha-config/www/` |
| Open the viewer | `http://localhost:8123/local/viewer.html#token=<token>` |

Viewer controls:

- **All**: floors stacked in 3D. **Level n**: floor plan with room outlines.
- Click a room: name, m² and neighbours.
- **Pick house**: click your building near a wall, then **Set as site anchor**.

## Architecture

### Files

| File | Purpose |
| --- | --- |
| `import_geojson.py` | Imports a GeoJSON file over the websocket API |
| `example_house.geojson` | Two storeys on a public square, drawn to wall centrelines |
| `viewer.html` | MapLibre viewer on Home Assistant's own map |
| `brand/icon.svg` | Source of `custom_components/spatial/brand/icon.png` and `icon@2x.png`: a zoning plan on Home Assistant map colours, rendered with headless Chromium at 256 and 512 px |

### Import format

| Part | Content |
| --- | --- |
| `features[]` | `Polygon` with properties `area` (name) and `floor` (name) |
| `floors[]` (optional) | `name`, `level`, `elevation_m`, `height_m` |
| `site` (optional) | `lon`, `lat`, `bearing_deg` |

- Names match the way Home Assistant matches them (case and spaces ignored).
- Missing floors and areas are created with Home Assistant's own registry commands.
- Existing areas are moved to the floor given in the file.
- All footprints are sent in one `spatial/area/update_geometries` call.

### Viewer

| Concern | How |
| --- | --- |
| Map style | `/static/map/light.json` or `dark.json`, as shipped by Home Assistant |
| Tiles, fonts, sprites | Home Assistant's `map_tiles` proxy, token from `map_tiles/access_token` |
| Buildings | OSM `buildings` layer: one MultiPolygon per tile, one part per building |
| Libraries | MapLibre GL 5, home-assistant-js-websocket, turf (CDN) |

- Uses only the public websocket API; no geometry code of its own.
- MapLibre 5 is a development choice; a dashboard card will follow Home Assistant's version.
