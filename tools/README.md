# tools

Development tools. Not part of the integration.

## Why

- Get footprints into Home Assistant before there is an editor.
- See the result in the panel on Home Assistant's own map.

## How to use

| Step | Command |
| --- | --- |
| Start Home Assistant | `docker compose up homeassistant` (finish onboarding, add Spatial, create a token) |
| Import the example | `docker compose run --rm test python tools/import_geojson.py tools/example_house.geojson --url http://host.docker.internal:8123 --token <token>` |

## Architecture

### Files

| File | Purpose |
| --- | --- |
| `import_geojson.py` | Imports a GeoJSON file over the websocket API |
| `example_house.geojson` | Two storeys on a public square, drawn to wall centrelines |
| `sync_frontend_versions.py` | Sets the `home-assistant-frontend` pin in `requirements_test.txt` and the versions in `frontend/package.json` and `frontend/.nvmrc` to what Home Assistant's frontend ships; `--check` lists differences and exits 1 |
| `brand/icon.svg` | Source of `custom_components/spatial/brand/icon.png` and `icon@2x.png`: a zoning plan on Home Assistant map colours, rendered with headless Chromium at 256 and 512 px |

### Import format

| Part | Content |
| --- | --- |
| `features[]` | `Polygon` with properties `area` (name) and `floor` (name) |
| `floors[]` (optional) | `name`, `level`, `elevation_m`, `height_m` |
| `site` (optional) | `bearing_deg` (`lon` and `lat` in older files are ignored) |

- Names match the way Home Assistant matches them (case and spaces ignored).
- Missing floors and areas are created with Home Assistant's own registry commands.
- Existing areas are moved to the floor given in the file.
- All footprints are sent in one `spatial/area/update_geometries` call.

