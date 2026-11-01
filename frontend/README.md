# frontend

The map panel and the dashboard card. Source here, built into `custom_components/spatial/frontend/`.

## Why

- See the floors and rooms on Home Assistant's own map.
- Pick the wall the site aligns to, with one click on a building on the map.
- Draw the building outline and each room as boxes along that wall, straight onto its Home Assistant area; type exact side lengths; undo and redo.
- The panel opens from the integration, no dashboard needed.
- The card shows the same view on a dashboard, also for non-admin users.

## How to use

Open Settings > Devices & services > Spatial > Configure. The map fills the page under a header with
Back and Help; the floors float top left, the tools top right, the map controls bottom right.
**All** stacks the floors in 3D and disables the tools; a floor button shows that floor as a plan
with room outlines. One tool is always active, **Adjust** by default.
**Align**, on a floor, then a click on your house near the wall the rooms follow, saves that wall's
bearing, turns the map so that wall is horizontal and goes back to Adjust. The card shows the
outline but has no tools.
The map button hides the map under the plan (remembered in this browser; Align turns it back on
while it is active); the compass faces north again.
**Draw**, on a floor, draws the building outline and rooms. The strip at the bottom starts
with **Building**, then lists the floor's areas, those without a footprint first; the highlighted
one is drawn next and its shape is outlined on the map. Without an outline, Building comes first
on every floor: draw it along the facade as the map shows it. Press and drag from one corner to
the opposite one, or click one corner and then the other (two taps on a phone). Each box is saved
at once; a box against the area's footprint joins it, a box apart from it is refused. Then the
next area without a footprint is highlighted. A drag that starts inside the highlighted area's
footprint moves it instead; a click there still sets a corner. **+ New area** creates "Room 1", "Room 2" and so
on, on this floor. Tapping the highlighted area again renames it. Hold Space and drag to pan;
Escape cancels a box. **All** shows the floors in 3D and does not draw.
**Adjust**, on a floor: a tap on a room makes its area active; the Building pill makes the
outline active. When the room is a rectangle along the site axis, each side shows its length
as a button; tap one, type the length in metres and press Enter to save (at least 0.20 m; the
side's start corner stays). Dragging the active room moves it, as in Draw. **Undo** and **Redo**
(Ctrl+Z, Ctrl+Shift+Z) undo every saved change of this session, each as one save. Undo restores
footprints only: an area created by drawing stays in Home Assistant.
On a dashboard, add a card with `type: custom:spatial-map-card`, best in a panel view; its
`floor` option (`all` or a `floor_id`) fixes the view, see `custom_components/spatial/README.md`.

| Task | Command (Git Bash, from the repository root) |
| --- | --- |
| Install, test, typecheck, build | `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/frontend":/app -v "$(pwd -W)/custom_components":/custom_components -w /app node:24-alpine sh -c "npm ci && npm run typecheck && npm test && npm run build"` |
| Build on every change | `docker compose up -d frontend` (runs `npm run watch`) |
| Draw one room in a real browser (after a build) | `docker compose run --rm e2e; docker compose rm -sf homeassistant-e2e`, see `e2e/draw_room.py` |
| Sync versions with Home Assistant | `python tools/sync_frontend_versions.py` (`--check` only compares) |

The build output is not in git. Run a build or the `frontend` service before opening the panel
locally. On a published GitHub release, `.github/workflows/release.yml` builds it, adds the
licences of the bundled MapLibre, Lit, turf, polyclip-ts (with bignumber.js and splaytree-ts) and @mdi/js code and uploads `spatial.zip`, which HACS installs.

## Architecture

### Files

| File | Purpose |
| --- | --- |
| `src/spatial-panel.ts` | The panel element: layout, the MapLibre map and its style, Align, websocket calls |
| `src/panel-header.ts` | The panel's header in the look of Home Assistant's subpage: Back, title, Help |
| `src/floor-selector.ts` | Floor buttons: a floating segmented control, or a chip row on a phone |
| `src/editor-toolbar.ts` | Align, Draw, Adjust, Undo and Redo: floating, or a bottom bar on a phone |
| `src/map-stack.ts` | Map toggle, zoom and compass |
| `src/room-editor.ts` | The space editor controller: the area strip, side length fields, undo and redo, saving each action, area creation and rename |
| `src/box-interaction.ts` | Pointer and keyboard drafting input on the map, screen-rectangle projection, Space pan, draft preview |
| `src/area-strip.ts` | The strip of pills, Building first: order, next area, new area names, rename |
| `src/history.ts` | Session undo and redo of footprint changes |
| `src/spatial-card.ts` | The card: wraps the panel element, without the header and tools; loads the panel bundle when created |
| `src/map-view.ts` | Pure helpers: map bearing, style URL, map tiles token, floor order, room bounds |
| `src/outline.ts` | The OSM building under a click and the bearing of its nearest wall, with turf |
| `src/plan.ts` | Box from screen corners, side lengths, resizing, moving and joining footprints, all with turf |
| `test/` | Unit tests (vitest) |

### Serving

| Part | How |
| --- | --- |
| Bundles | esbuild writes `spatial-panel.js` and `spatial-card.js`; the integration serves the folder under `/spatial_static`, registers the panel and adds the card to every page |
| Lazy loading | The card module is about 1 kB; it imports `spatial-panel.js`, with MapLibre, only when a card is created, at the same `?v=` URL as the panel so both share one module |
| MapLibre worker and shared chunk | `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` are copied next to the bundle; the shared chunk stays external |
| Versions | Packages shared with Home Assistant's frontend use its exact versions, set by `tools/sync_frontend_versions.py` |

- The header, floor buttons, toolbar and map stack are own Lit elements styled with Home Assistant's theme
  variables; they use only the Home Assistant elements that are always loaded (`ha-icon-button`,
  `ha-svg-icon`), as `hass-subpage` and its toggle groups are undefined on a deep link. Icons are
  `@mdi/js` named imports. Below 600 px the panel switches to the phone layout.
- Uses only the public websocket API and Home Assistant's area and floor registry commands. Its
  geometry (the wall bearing, boxes, joining a box to a footprint) is done with turf; lengths and m²
  shown while drawing are previews, a saved room's `area_m2` comes from the integration.
- A box is a screen rectangle, unprojected corner by corner, on the flat map turned to the site
  axis, so its sides follow the picked wall. Draw turns the map back to that axis and disables
  rotating and tilting until it ends.
- Every box, move, resize, undo and redo is one save, one at a time: `spatial/site/update`
  with `outline` for the building, else one `spatial/area/update_geometries` batch; boxes, moves and resizes are recorded in the session history. A rejected save reloads the rooms, says
  "Could not save" and keeps the history position. Side lengths are MapLibre Markers holding a
  native number field.
- Align sends only `bearing_deg`: the direction of the OSM building's outer edge nearest the
  click, with the building on its left.
- The OSM building is the `buildings` part under the click, as MapLibre renders it from one
  tile: a building cut by a tile border gives only the part in that tile.

Known limits: undo restores this session's footprints, also over changes made elsewhere. An undo for an
area deleted in Home Assistant keeps failing; reload the panel to clear the history. A feed update
while a side field is open resets the field.
