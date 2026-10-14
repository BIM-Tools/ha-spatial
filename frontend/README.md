# frontend

The map panel. Source here, built into `custom_components/spatial/frontend/`.

## Why

- See the floors and rooms on Home Assistant's own map, read-only.
- Opens from the integration, no dashboard needed.

## How to use

Open Settings > Devices & services > Spatial > Configure. **All** stacks the floors in 3D;
**Level n** shows one floor plan with room outlines.

| Task | Command (Git Bash, from the repository root) |
| --- | --- |
| Install, test, typecheck, build | `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/frontend":/app -v "$(pwd -W)/custom_components":/custom_components -w /app node:24-alpine sh -c "npm ci && npm run typecheck && npm test && npm run build"` |
| Sync versions with Home Assistant | `python tools/sync_frontend_versions.py` (`--check` only compares) |

Commit the build output; CI fails when it differs from the source.

## Architecture

### Files

| File | Purpose |
| --- | --- |
| `src/spatial-panel.ts` | The panel element: floor picker, room list, websocket calls |
| `src/map-view.ts` | MapLibre view on Home Assistant's map style and tiles |
| `test/` | Unit tests (vitest) |

### Serving

| Part | How |
| --- | --- |
| Bundle | esbuild writes `spatial-panel.js`; the integration serves the folder under `/spatial_static` and registers the panel |
| MapLibre worker and shared chunk | `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` are copied next to the bundle; the shared chunk stays external |
| Versions | Packages shared with Home Assistant's frontend use its exact versions, set by `tools/sync_frontend_versions.py` |

- Uses only the public websocket API; no geometry code of its own.
