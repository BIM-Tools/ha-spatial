# frontend

The map panel and the dashboard card. Source here, built into `custom_components/spatial/frontend/`.

## Why

- See the floors and rooms on Home Assistant's own map.
- Pick the building and the wall the site aligns to, with one click on the map.
- Draw each room as boxes along that wall, straight onto its Home Assistant area; type exact side lengths; undo and redo.
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
**Draw**, on a floor, draws rooms. The strip under the toolbar lists the floor's areas, those
without a footprint first; the highlighted one is drawn next. Press and drag from one corner to
the opposite one, or click one corner and then the other (two taps on a phone). Each box is saved
at once; a box against the area's footprint joins it, a box apart from it is refused. Then the
next area without a footprint is highlighted. **+ New area** creates "Room 1", "Room 2" and so
on, on this floor. Tapping the highlighted area again renames it. Hold Space and drag to pan;
Escape cancels a box. **All** shows the floors in 3D and does not draw.
**Adjust**, on a floor: a tap on a room makes its area active. When the room is a rectangle along
the site axis, each side shows its length as a button; tap one, type the length in metres and
press Enter to save (at least 0.20 m; the side's start corner stays). **Undo** and **Redo**
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
licences of the bundled MapLibre, Lit, turf, JSTS, d3 and polyclip-ts (with bignumber.js and splaytree-ts) code and uploads `spatial.zip`, which HACS installs.

## Architecture

### Files

| File | Purpose |
| --- | --- |
| `src/spatial-panel.ts` | The panel element: floor buttons, the MapLibre map, websocket calls |
| `src/room-editor.ts` | Drawing and adjusting in the panel: the area strip, mouse and tap input, side length fields, undo and redo, saving each action, area creation and rename |
| `src/area-strip.ts` | The strip of area chips: order, next area, new area names, rename |
| `src/history.ts` | Session undo and redo of footprint changes |
| `src/spatial-card.ts` | The card: wraps the panel element, without the menu button; loads the panel bundle when created |
| `src/map-view.ts` | Pure helpers: map bearing, style URL, map tiles token, floor order, room bounds |
| `src/outline.ts` | Building outline from an OSM building: inset, orientation and start wall, all with turf |
| `src/plan.ts` | Box from screen corners, side lengths, resizing and joining footprints, all with turf |
| `test/` | Unit tests (vitest) |

### Serving

| Part | How |
| --- | --- |
| Bundles | esbuild writes `spatial-panel.js` and `spatial-card.js`; the integration serves the folder under `/spatial_static`, registers the panel and adds the card to every page |
| Lazy loading | The card module is about 1 kB; it imports `spatial-panel.js`, with MapLibre, only when a card is created, at the same `?v=` URL as the panel so both share one module |
| MapLibre worker and shared chunk | `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` are copied next to the bundle; the shared chunk stays external |
| Versions | Packages shared with Home Assistant's frontend use its exact versions, set by `tools/sync_frontend_versions.py` |

- Uses only the public websocket API and Home Assistant's area and floor registry commands. Its
  geometry (the outline, boxes, joining a box to a footprint) is done with turf; lengths and m²
  shown while drawing are previews, a saved room's `area_m2` comes from the integration.
- A box is a screen rectangle, unprojected corner by corner, on the flat map turned to the site
  axis, so its sides follow the picked wall. Draw turns the map back to that axis and disables
  rotating and tilting until it ends.
- Every box, resize, undo and redo is one `spatial/area/update_geometries` batch, one at a time;
  boxes and resizes are recorded in the session history. A rejected save reloads the rooms, says
  "Could not save" and keeps the history position. Side lengths are MapLibre Markers holding a
  native number field.
- The outline is the outer shell only: courtyards (holes) of the OSM building are dropped, and a
  click is matched to the outer walls.
- The OSM building is the `buildings` part under the click, as MapLibre renders it from one
  tile: a building cut by a tile border gives only the part in that tile.

Known limits: undo restores this session's footprints, also over changes made elsewhere. An undo for an
area deleted in Home Assistant keeps failing; reload the panel to clear the history. A feed update
while a side field is open resets the field.
