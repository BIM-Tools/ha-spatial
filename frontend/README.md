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
| `src/panel-state.ts` | The panel's reactive controller for what Spatial sends: site, frame, rooms, the floors with rooms, the floor in view and the stored bearing; `alignPlace` says whether Align sits in the toolbar or the header menu |
| `src/panel-header.ts` | The panel's header in the look of Home Assistant's subpage: Back, title, Help and its sheet in a native dialog, and the More options menu the panel fills |
| `src/floor-selector.ts` | Floor buttons: a floating segmented control, or a chip row on a phone |
| `src/editor-toolbar.ts` | Align (until the site has a direction), Draw, Select, Undo, Redo and Remove, with the tool the guide lights: floating, or a bottom bar on a phone |
| `src/map-stack.ts` | Address search button, map toggle, zoom and compass |
| `src/address-search.ts` | The Find your home card: field, Search, up to five results, the no result and unavailable states; sends one `spatial/address/search` per Enter or press, never while typing |
| `src/address.ts` | Pure rules of the address search: when a query may be sent, the street and town lines of a result, where the map goes for it, when Home Assistant has no home location, and whether to offer the home for a picked place (turf's distance, 25 m) |
| `src/map-paint.ts` | The map layers' colours, read from Home Assistant's theme at style load and on a theme change; a room's fill by its value (MapLibre feature state) for a card with `colour_by` |
| `src/map-cursor.ts` | The map's mouse pointer from the tool and what lies under the pointer |
| `src/floor-stack.ts` | All floors as an exploded stack of their rooms, pure and in site frame metres: floor order, floor heights, room fills and walls, the outline on the ground, the camera fit from the front corner, and the floor labels beside each floor |
| `src/room-values.ts` | `colour_by`: per area the brightest light that is on, or the temperature (the area's chosen sensor, else the average of its sensors), as the text under the name and the number its colour follows |
| `src/room-labels.ts` | Room labels: area icon, name and net area in the panel, or the card's live value, placed and stepped by the room's size on screen |
| `src/styles.ts` | The floating card, pill buttons and phone bar shared by the controls, from Home Assistant's theme tokens |
| `src/onboarding.ts` | `nextStep`: the guide line's one step and its lit control, derived from the plan every time |
| `src/room-editor.ts` | The space editor controller: the area strip, what the guide reads of the plan, the map's outline offered to the Building, undo and redo, saving each action, area creation and rename |
| `src/side-controls.ts` | A handle on each side of the active axis rectangle, a length chip on one side per axis (`sideHandles` in `plan.ts` picks it) and a grip on the other: dragged, it stretches the side through the edge drag; tapped, it opens the length field. On an outline of another shape a length chip on every side that only drags |
| `src/box-interaction.ts` | Pointer and keyboard drafting input on the map, snapped corners, moves, edge and corner drags, Alt to place freely, Space pan, draft preview |
| `src/snap.ts` | The snap engine, pure and in lattice units: room corners, then room axis edges, then the outline, else the grid |
| `src/wall-stop.ts` | Where the outline and the rooms beside it stop a moved room or a stretched side, pure and on lattice integers: a walk over the lattice offsets of the path up to the first one where the outline reaches inside the shape or the shape overlaps a neighbour |
| `src/snap-highlight.ts` | The map layer that lights up what a point snaps to: a dot on a corner, a line on an edge; and `distinctSources`, which lights each up once |
| `src/edge-drag.ts` | Edge and corner drag of an axis rectangle, or of the outline in any shape, pure and in lattice units: where the dragged edge or corner lands (a rectangle stopped at the outline and the neighbours, an outline corner free and snapped, an outline edge along its normal), which one a pointer grabs, and its cursor |
| `src/area-strip.ts` | The strip of pills, Building first: order, next area, new area names, rename field, long press, arrow keys |
| `src/history.ts` | Session undo and redo of footprint changes, and `clearChange`, the change that removes a floor's room shapes |
| `src/spatial-card.ts` | The card: wraps the panel element, without the header and tools; validates `colour_by`, and its editor (`getConfigForm`) offers `colour_by` only; loads the panel bundle when created |
| `src/map-view.ts` | Pure helpers: map bearing, style URL, map tiles token, floor order, room bounds |
| `src/outline.ts` | The OSM building under or nearest a click, the bearing of its nearest wall, with turf, and the fields an Align pick writes |
| `src/site-frame.ts` | Applies the site frame from `spatial/site`: lon/lat to lattice units and back |
| `src/plan.ts` | Boxes, side lengths, resizing and moving on the site lattice, and the outline copied from a map building; joining with turf |
| `src/units.ts` | Lengths, map distances and areas shown in Home Assistant's unit system and number format (metric at lattice precision, US feet and inches with primes), and typed lengths read back in metres |
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
  undefined on a deep link; the help sheet is a native `<dialog>` and the More options menu a
  plain list of buttons with `role="menu"`, as `ha-button-menu` is lazy too. Icons are `@mdi/js` named
  imports. The phone layout applies at a width of 600 px or less.
- Plan geometry (boxes, side lengths, resizing, moving) works on lattice integers in the site frame
  that `spatial/site` publishes, rebuilt on every site load, so a unit system change reaches the
  next gesture; turf finds the wall bearing and joins a box to a footprint.
- In Select a press on the active axis rectangle, or on the outline in any shape (`isResizable`), is
  hit-tested on its projected corners, then its edges, within the snap radius, before a move, so it
  follows the room on a turned map. An outline corner snaps as a drawn corner and to the axis lines
  through the outline's corners that stay; a ring that would cross itself or get a side under one
  grid step shows in the warning colour and is refused on release with `reshapeChange` in
  `plan.ts`, the same ring rules as a ring of clicked corners. Straight corners stay in the write;
  the integration drops them. A side's
  chip or grip drives the same edge drag with pointer events and pointer capture, for mouse and
  finger alike (`touch-action: none`); a release without a drag lets the click open the field. The
  controls are not rebuilt while one is pressed, as that would drop its capture. While a resize is
  live they follow the draft instead: each to its side, on a rectangle matched by place as the
  draft's ring may start at another corner, the chips counting the lengths and the held edge's handle primary. The
  room labels under the draft hide, as the draft shows the area, and undo, redo and Delete are
  ignored, as the save is made against the room as grabbed.
- Every box, move, resize, removal, floor clear, undo and redo is one save, one at a time:
  `spatial/site/update` with `outline` for the building, else one `spatial/area/update_geometries`
  batch; boxes, moves, resizes, removals and floor clears are recorded in the session history. A
  floor clear's toast offers Undo, which is the editor's own undo. A refused save reloads the rooms and
  keeps the history position; its toast is a `hass-notification` with `duration: -1`, closed by
  the next save that succeeds. Side lengths are MapLibre Markers holding a native text field.
- Align sends `bearing_deg`: the direction of the OSM building's outer edge nearest the click, with
  the building on its left. On an empty plan (no footprint and no outline) it also sends `origin`,
  that edge's left end in the aligned view. Once the site has a bearing, Align leaves the toolbar
  and the header menu's Change alignment starts the same tool.
- The picked building: one polygon held in the panel, never stored. A click picks it before Align,
  and again in Select while the map's outline is offered; the Align click picks the clicked wall's
  building. `nearestBuilding` in `outline.ts` takes the building under the click, else the one whose
  edge is nearest within 8 px (mouse) or 22 px (touch). While a building can be picked, the one
  under the pointer is lit, read at most once per animation frame; below zoom 16 nothing is lit and
  a click zooms in to 18.
- The map's outline: the panel offers the picked building, or after a reload finds the building a
  grid step inside the site origin once the map is idle, and `mapOutline` in `plan.ts` turns its outer ring into the
  outline: walls within 3 degrees of a site axis, or at most one map tile unit (zoom 14, 4096 units
  a tile) across it, straightened onto it, an inset of 150 mm as a
  negative buffer (the shape minus a band along every edge and a square on every corner, with
  `@turf/difference`; the largest part stays, parts narrower than 300 mm disappear), corners
  rounded to the lattice, and no offer when nothing is left, an edge falls under one grid step
  or the ring touches itself. In the length check after Use outline, as always in Select, a shape that
  is no axis rectangle gets a length chip on every side (`showSideControls` in `side-controls.ts`). While the Building pill
  is active without an outline, the editor shows it dashed with the guide line's question and adds
  it as the outline to the snap candidates of a Building gesture only. Use outline saves it like a
  drawn box, in one write and one undo step; nothing about the map building is stored.
- Without a home location in Home Assistant (unset or 0, 0) and with nothing drawn, the panel
  starts on MapLibre's globe with the search card open. A picked result fits the map to its box,
  else flies to its point at building zoom, and closes the card. The query lives only in the
  card: it is not logged or stored.
- After a saved Align, and after a click on another building while the map's outline is offered,
  the panel offers the building's middle (polylabel) as Home Assistant's home in a
  `hass-notification` toast (none within 25 m of the home); its action writes latitude and
  longitude with `config/core/update`, and the next toast's Undo writes the old ones back. A
  search pick and a click before Align ask nothing; nothing is stored.
- The guide line: `nextStep` in `onboarding.ts` takes the plan as plain data (home location and
  whether the map draws a building there, search used, bearing, outline, the map outline's
  question or length check, every floor with its areas and which have a shape, the floor in view,
  tool and active pill) and returns the one step: find the home, choose a floor (on All), align,
  the outline question or drawing it, the length check, the next area to draw, the floor done
  with Next floor, or done. Its line is the only instruction on screen, and its one lit control
  gets the tinted fill and 1.5 px ring (`litControl` in `styles.ts`). Nothing is stored: at start
  a plan with work left opens on the step's floor, and a skipped or finished step follows from
  the data. Before any Align the picked building shows dashed and Align is lit.
- Areas are created and renamed with Home Assistant's area registry commands; renaming the
  building sends `config/core/update` with `location_name`.
