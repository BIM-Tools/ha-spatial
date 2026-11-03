# frontend

The map panel and the dashboard card. Source here, built into `custom_components/spatial/frontend/`.

## Why

- See the floors and rooms on Home Assistant's own map.
- Pick the wall the site aligns to, with one click on a building on the map.
- Draw the building outline and each room as boxes along that wall, straight onto its Home Assistant area; type exact side lengths; undo and redo.
- The panel opens from the integration, no dashboard needed.
- The card shows the same view on a dashboard, also for non-admin users.

## How to use

Using the panel and the card: [user guide](../docs/user-guide.md).

| Task | Command (Git Bash, from the repository root) |
| --- | --- |
| Install, test, typecheck, build | `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/frontend":/app -v "$(pwd -W)/custom_components":/custom_components -w /app node:24-alpine sh -c "npm ci && npm run typecheck && npm test && npm run build"` |
| Build on every change | `docker compose up -d frontend` (runs `npm run watch`) |
| Draw one room in a real browser (after a build) | `docker compose run --rm e2e; docker compose rm -sf homeassistant-e2e`, see `e2e/draw_room.py` |
| Sync versions with Home Assistant | `python tools/sync_frontend_versions.py` (`--check` only compares) |

The build output is not in git. Run a build or the `frontend` service before opening the panel
locally. On a pushed `v*` tag, `.github/workflows/release.yml` builds it, adds the
licences of the bundled MapLibre, Lit, turf, polyclip-ts (with bignumber.js and splaytree-ts), polylabel (with tinyqueue) and @mdi/js code and creates the release with `spatial.zip`, which HACS installs.

## Architecture

### Files

| File | Purpose |
| --- | --- |
| `src/spatial-panel.ts` | The panel element: layout, the MapLibre map and its style, Align, websocket calls |
| `src/panel-header.ts` | The panel's header in the look of Home Assistant's subpage: Back, title, Help and its sheet in a native dialog |
| `src/floor-selector.ts` | Floor buttons: a floating segmented control, or a chip row on a phone |
| `src/editor-toolbar.ts` | Align, Draw, Adjust, Undo and Redo: floating, or a bottom bar on a phone |
| `src/map-stack.ts` | Map toggle, zoom and compass |
| `src/map-paint.ts` | The map layers' colours, read from Home Assistant's theme at style load and on a theme change |
| `src/room-labels.ts` | Room labels: area icon, name and (in the panel) net area, placed and stepped by the room's size on screen |
| `src/styles.ts` | The floating card, pill buttons and phone bar shared by the controls, from Home Assistant's theme tokens |
| `src/room-editor.ts` | The space editor controller: the area strip, side length fields, undo and redo, saving each action, area creation and rename |
| `src/box-interaction.ts` | Pointer and keyboard drafting input on the map, corners and moves on the site grid, Space pan, draft preview |
| `src/area-strip.ts` | The strip of pills, Building first: order, next area, new area names, rename field, long press, arrow keys |
| `src/history.ts` | Session undo and redo of footprint changes |
| `src/spatial-card.ts` | The card: wraps the panel element, without the header and tools; loads the panel bundle when created |
| `src/map-view.ts` | Pure helpers: map bearing, style URL, map tiles token, floor order, room bounds |
| `src/outline.ts` | The OSM building under a click and the bearing of its nearest wall, with turf |
| `src/site-frame.ts` | Applies the site frame from `spatial/site`: lon/lat to lattice units and back |
| `src/plan.ts` | Boxes, side lengths, resizing and moving on the site lattice; joining with turf |
| `src/units.ts` | Lengths and areas shown in Home Assistant's unit system and number format (metric at lattice precision, US feet and inches with primes), and typed lengths read back in metres |
| `test/` | Unit tests (vitest) |

### Serving

| Part | How |
| --- | --- |
| Bundles | esbuild writes `spatial-panel.js` and `spatial-card.js`; the integration serves the folder under `/spatial_static`, registers the panel and adds the card to every page |
| Lazy loading | The card module is about 1 kB; it imports `spatial-panel.js`, with MapLibre, only when a card is created, at the same `?v=` URL as the panel so both share one module |
| MapLibre worker and shared chunk | esbuild also bundles MapLibre's worker as `maplibre-gl-worker.js`; code it shares with the panel goes to `chunks/`, named by content hash, so a browser never mixes an old chunk with a new bundle. The panel loads the worker from next to itself with its own `?v=`, and the integration counts the worker in that version. Each build first empties the output folder, except `.gitkeep` |
| Versions | Packages shared with Home Assistant's frontend use its exact versions, set by `tools/sync_frontend_versions.py` |

- The header, floor buttons, toolbar and map stack are own Lit elements styled with Home Assistant's theme
  variables; they use only the Home Assistant elements that are always loaded (`ha-icon-button`,
  `ha-svg-icon`), as `hass-subpage`, its toggle groups and Home Assistant's dialog are undefined on a
  deep link; the help sheet is a native `<dialog>`. Icons are
  `@mdi/js` named imports. Below 600 px the panel switches to the phone layout.
- Uses only the public websocket API and Home Assistant's area and floor registry commands. Plan
  geometry (boxes, side lengths, resizing, moving) works on lattice integers in the site frame that
  `spatial/site` publishes, rebuilt on every site load, so a unit system change reaches the next
  gesture; turf finds the wall bearing and joins a box to a footprint. Lengths and m² shown while
  drawing are previews, a saved room's `area_m2` comes from the integration.
- A box runs between two corners on the 10 cm (4 in) grid (Alt: on the lattice), along the site
  axes; a move shifts a room by whole grid steps. A box with a side under one grid step shows only
  its start dot and is not created. Draw turns the map to the site axis and disables rotating and
  tilting until it ends.
- Every box, move, resize, removal, undo and redo is one save, one at a time: `spatial/site/update`
  with `outline` for the building, else one `spatial/area/update_geometries` batch; boxes, moves,
  resizes and removals are recorded in the session history. A rejected save reloads the rooms,
  fires a "Could not save" toast with Retry (`hass-notification`, `duration: -1`, closed by the next
  save that succeeds) and keeps the history position. Side lengths are MapLibre Markers holding a
  native number field.
- Align sends `bearing_deg`: the direction of the OSM building's outer edge nearest the click, with
  the building on its left. On an empty plan (no footprint and no outline) it also sends `origin`,
  that edge's left end in the aligned view, so the grid starts on the wall.
- The OSM building is the `buildings` part under the click, as MapLibre renders it from one
  tile: a building cut by a tile border gives only the part in that tile.

A feed update while a side field is open resets the field; the other known limits are in the
[user guide](../docs/user-guide.md#known-limits).
