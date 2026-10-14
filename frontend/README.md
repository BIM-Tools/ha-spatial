# frontend

The map panel and the dashboard card. Source here, built into `custom_components/spatial/frontend/`.

## Why

- See the floors and rooms on Home Assistant's own map.
- Pick the building and the wall the site aligns to, with one click on the map.
- The panel opens from the integration, no dashboard needed.
- The card shows the same view on a dashboard, also for non-admin users.

## How to use

Open Settings > Devices & services > Spatial > Configure. **All** stacks the floors in 3D;
a floor button shows that floor as a plan with room outlines.
**Building**, then a click on your building just inside one wall, saves the building outline
(0.25 m inside the OSM outline) and turns the map so that wall is horizontal. **Building** again
shows a handle on every corner; dragging one saves the outline, and moving one of the first
wall's two corners turns the map. **Building** once more hides the handles. The card shows the
outline but has no Building button.
On a dashboard, add a card with `type: custom:spatial-map-card`, best in a panel view; its
`floor` option (`all` or a `floor_id`) fixes the view, see `custom_components/spatial/README.md`.

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
| `src/spatial-card.ts` | The card: wraps the panel element, without the menu button; loads the panel bundle when created |
| `src/map-view.ts` | Pure helpers: map bearing, style URL, map tiles token, floor order, room bounds |
| `src/outline.ts` | Building outline from an OSM building: inset, orientation and start wall, all with turf |
| `test/` | Unit tests (vitest) |

### Serving

| Part | How |
| --- | --- |
| Bundles | esbuild writes `spatial-panel.js` and `spatial-card.js`; the integration serves the folder under `/spatial_static`, registers the panel and adds the card to every page |
| Lazy loading | The card module is about 1 kB; it imports `spatial-panel.js`, with MapLibre, only when a card is created, at the same `?v=` URL as the panel so both share one module |
| MapLibre worker and shared chunk | `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` are copied next to the bundle; the shared chunk stays external |
| Versions | Packages shared with Home Assistant's frontend use its exact versions, set by `tools/sync_frontend_versions.py` |

- Uses only the public websocket API. Its only geometry is picking the outline, done with turf;
  lengths and areas come from the integration.
- The OSM building is the `buildings` part under the click, as MapLibre renders it from one
  tile: a building cut by a tile border gives only the part in that tile.
