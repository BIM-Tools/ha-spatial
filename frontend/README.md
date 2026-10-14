# frontend

The map panel. Source here, built into `custom_components/spatial/frontend/`.

## Why

- See the floors and rooms on Home Assistant's own map, read-only.
- Opens from the integration, no dashboard needed.

## How to use

Open Settings > Devices & services > Spatial > Configure. **All** stacks the floors in 3D;
a floor button shows that floor as a plan with room outlines.

| Task | Command (Git Bash, from the repository root) |
| --- | --- |
| Install, test, typecheck, build | `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/frontend":/app -v "$(pwd -W)/custom_components":/custom_components -w /app node:24-alpine sh -c "npm ci && npm run typecheck && npm test && npm run build"` |
| Build on every change | `docker compose up -d frontend` (runs `npm run watch`) |
| Sync versions with Home Assistant | `python tools/sync_frontend_versions.py` (`--check` only compares) |

The build output is not in git. Run a build or the `frontend` service before opening the panel
locally. On a published GitHub release, `.github/workflows/release.yml` builds it, adds the
licences of the bundled MapLibre and Lit code and uploads `spatial.zip`, which HACS installs.

## Architecture

### Files

| File | Purpose |
| --- | --- |
| `src/spatial-panel.ts` | The panel element: floor buttons, the MapLibre map, websocket calls |
| `src/map-view.ts` | Pure helpers: map bearing, style URL, map tiles token, floor order |
| `test/` | Unit tests (vitest) |

### Serving

| Part | How |
| --- | --- |
| Bundle | esbuild writes `spatial-panel.js`; the integration serves the folder under `/spatial_static` and registers the panel |
| MapLibre worker and shared chunk | `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` are copied next to the bundle; the shared chunk stays external |
| Versions | Packages shared with Home Assistant's frontend use its exact versions, set by `tools/sync_frontend_versions.py` |

- Uses only the public websocket API; no geometry code of its own.
