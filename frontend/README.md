# frontend

The map panel and the dashboard card. Source here, built into `custom_components/spatial/frontend/`.

## Why

- Draw and show the footprints on Home Assistant's own map, in its look, with no dashboard needed
  for the editor.
- One source for the admin panel and the read-only card, so both show the same plan.

## How to use

Using the panel and the card: [user guide](../docs/user-guide.md).

| Task | Command (Git Bash, from the repository root) |
| --- | --- |
| Install, test, typecheck, build | `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/frontend":/app -v "$(pwd -W)/custom_components":/custom_components -w /app node:24-alpine sh -c "npm ci && npm run typecheck && npm test && npm run build"` |
| Build on every change | `docker compose up -d frontend` (runs `npm run watch`) |
| Draw one room in a real browser (after a build) | `docker compose run --rm e2e; docker compose rm -sf homeassistant-e2e`, see `e2e/draw_room.py` |

Package versions follow Home Assistant's frontend; to update them, see
[tools](../tools/README.md).

The build output is not in git. Run a build or the `frontend` service before opening the panel
locally. On a pushed `v*` tag, `.github/workflows/release.yml` builds it, adds the
licences of the bundled MapLibre, Lit, turf, polyclip-ts (with bignumber.js and splaytree-ts), polylabel (with tinyqueue) and @mdi/js code and creates the release with `spatial.zip`, which HACS installs.

## Architecture

### Files

| File | Purpose |
| --- | --- |
| `src/spatial-panel.ts` | The panel element: layout, the MapLibre map and its style, Align, websocket calls |
| `src/panel-state.ts` | The panel's reactive controller for what Spatial sends: site, frame, rooms, the floors with rooms, the floor in view and the stored bearing |
| `src/panel-header.ts` | The panel's header in the look of Home Assistant's subpage: Back, title, Help and its sheet in a native dialog |
| `src/floor-selector.ts` | Floor buttons: a floating segmented control, or a chip row on a phone |
| `src/editor-toolbar.ts` | Align, Draw, Adjust, Undo and Redo: floating, or a bottom bar on a phone |
| `src/map-stack.ts` | Map toggle, zoom and compass |
| `src/map-paint.ts` | The map layers' colours, read from Home Assistant's theme at style load and on a theme change |
| `src/room-labels.ts` | Room labels: area icon, name and (in the panel) net area, placed and stepped by the room's size on screen |
| `src/styles.ts` | The floating card, pill buttons and phone bar shared by the controls, from Home Assistant's theme tokens |
| `src/room-editor.ts` | The space editor controller: the area strip, undo and redo, saving each action, area creation and rename |
| `src/side-controls.ts` | The length chip on each side of the active axis rectangle: dragged, it stretches the side through the edge drag; tapped, it opens the length field |
| `src/box-interaction.ts` | Pointer and keyboard drafting input on the map, snapped corners, moves, edge and corner drags, Alt to place freely, Space pan, draft preview |
| `src/snap.ts` | The snap engine, pure and in lattice units: room corners, then room axis edges, then the outline, else the grid |
| `src/outline-stop.ts` | Where the outline stops a moved room or a stretched side, pure and on lattice integers: a walk over the lattice offsets of the path up to the first one where the outline reaches inside the shape |
| `src/snap-highlight.ts` | The map layer that lights up what a point snaps to: a dot on a corner, a line on an edge; and `distinctSources`, which lights each up once |
| `src/edge-drag.ts` | Edge and corner drag of an axis rectangle, pure and in lattice units: where the dragged edge or corner lands, stopped at the outline, which one a pointer grabs, and its resize cursor |
| `src/area-strip.ts` | The strip of pills, Building first: order, next area, new area names, rename field, long press, arrow keys |
| `src/history.ts` | Session undo and redo of footprint changes |
| `src/spatial-card.ts` | The card: wraps the panel element, without the header and tools; loads the panel bundle when created |
| `src/map-view.ts` | Pure helpers: map bearing, style URL, map tiles token, floor order, room bounds |
| `src/outline.ts` | The OSM building under a click, the bearing of its nearest wall, with turf, and the fields an Align pick writes |
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

### Inside the panel

- The header, floor buttons, toolbar and map stack are own Lit elements styled with Home Assistant's theme
  variables; they use only the Home Assistant elements that are always loaded (`ha-icon-button`,
  `ha-svg-icon`, `ha-icon`), as `hass-subpage`, its toggle groups and Home Assistant's dialog are
  undefined on a deep link; the help sheet is a native `<dialog>`. Icons are `@mdi/js` named
  imports. The phone layout applies at a width of 600 px or less.
- Plan geometry (boxes, side lengths, resizing, moving) works on lattice integers in the site frame
  that `spatial/site` publishes, rebuilt on every site load, so a unit system change reaches the
  next gesture; turf finds the wall bearing and joins a box to a footprint.
- In Adjust a press on the active axis rectangle is hit-tested on its projected corners, then its
  edges, within the snap radius, before a move, so it follows the room on a turned map. A side's
  length chip drives the same edge drag with pointer events and pointer capture, for mouse and
  finger alike (`touch-action: none`); a release without a drag lets the click open the field. The
  chips are not rebuilt while one is pressed, as that would drop its capture. While a resize is
  live the side chips and the labels under the
  draft hide, as the draft shows the lengths and area, and undo, redo and Delete are ignored, as the
  save is made against the room as grabbed.
- Every box, move, resize, removal, undo and redo is one save, one at a time: `spatial/site/update`
  with `outline` for the building, else one `spatial/area/update_geometries` batch; boxes, moves,
  resizes and removals are recorded in the session history. A refused save reloads the rooms and
  keeps the history position; its toast is a `hass-notification` with `duration: -1`, closed by
  the next save that succeeds. Side lengths are MapLibre Markers holding a native text field.
- Align sends `bearing_deg`: the direction of the OSM building's outer edge nearest the click, with
  the building on its left. On an empty plan (no footprint and no outline) it also sends `origin`,
  that edge's left end in the aligned view.
- Areas are created and renamed with Home Assistant's area registry commands; renaming the
  building sends `config/core/update` with `location_name`.
