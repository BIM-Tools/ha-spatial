# AGENTS.md

Rules for everyone who changes this repository, people and coding agents alike. Project
facts are in the READMEs; this file holds the rules and gotchas the code does not show.

## Principle: the smallest thing that works

Home Assistant already has plenty of complexity. Every line here has to be maintained by
someone and understood by the people who install it.

- Solve the case at hand, not the class it belongs to.
- A new concept (walls, doors, stairs, sub-areas, options) is a maintainer decision,
  proposed in an issue first, never a side effect of another change.
- No BIM, GIS or semantic-web tooling inside the integration. Such tools run outside Home
  Assistant and use the public websocket API.

## Commands

Home Assistant runs on Linux only, so everything runs in Docker. In Git Bash on Windows,
prefix `docker` commands with `MSYS_NO_PATHCONV=1`.

| Task | Command |
| --- | --- |
| Build the test image | `docker compose build test` (after changing `requirements_test.txt`) |
| All tests | `docker compose run --rm test` |
| Geometry | `docker compose run --rm test pytest tests/test_geometry.py` |
| Websocket API and storage | `docker compose run --rm test pytest tests/test_websocket_api.py tests/test_site.py` |
| Config flow | `docker compose run --rm test pytest tests/test_config_flow.py` |
| Coverage (fails under 99%) | `docker compose run --rm test pytest --cov=custom_components.spatial` |
| Type check (mypy strict) | `docker compose run --rm test mypy` |
| Lint and format | `docker compose run --rm test sh -c "ruff format . && ruff check ."` |
| hassfest | `docker run --rm -v "$(pwd -W)":/github/workspace:ro ghcr.io/home-assistant/hassfest` |
| Panel build, rebuilt on change | `docker compose up -d frontend` |
| Real Home Assistant | `docker compose up homeassistant` |
| Frontend (typecheck, test, build) | `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/frontend":/app -v "$(pwd -W)/custom_components":/custom_components -w /app node:24-alpine sh -c "npm ci && npm run typecheck && npm test && npm run build"` |
| E2E smoke test (build the panel first) | `docker compose run --rm e2e; docker compose rm -sf homeassistant-e2e` |
| Sync frontend versions | `python tools/sync_frontend_versions.py` (`--check` only compares) |
| Tools | Run them against the real Home Assistant, see `tools/README.md` |

## Settled decisions

Change these only through an issue that names the reason.

| Area | Decision |
| --- | --- |
| Coordinates | WGS84 GeoJSON, the same world as Home Assistant zones |
| Measurement | In the integration, local tangent plane with exact WGS84 radii; never UTM, national grids, Mercator or screen space |
| Footprint | One area has at most one `Polygon`, inner rings (holes) allowed; no MultiPolygon, its parts cannot carry identity |
| Rooms across floors | `floors_up` per area: the Home Assistant floor is the main and lowest floor; the room occupies the floors above it, contiguous |
| Adjacency | Derived from shared edges, outer and inner rings, on every floor a room occupies; interior walls on centrelines, exterior walls on a line inside the drawn facade at the options-flow offset (default by Home Assistant's country: 0.25 m, about 0.11 m for US and CA); both derived, never stored |
| Address search | The backend may call OpenStreetMap Nominatim, only on an explicit search, with an identifying user agent and its rate limit; country geocoders and authoritative outlines stay outside the integration |
| Home location | Onboarding may offer once to move Home Assistant's home to the chosen building: latitude and longitude only, through core config, undoable |
| Units | Display follows Home Assistant's unit system; storage stays metric WGS84 |
| Area | `area_m2` is net: the drawn polygon shrunk by 50 mm on every side |
| Outdoor, facade | `is_external` means an outdoor room (outside the outline, IFC `IsExternal`); `on_facade` is derived from touching the outline, with an optional override |
| Building, sub-spaces | Home Assistant labels; no code |
| Site anchor | One direction per installation; the centre follows all footprints, else the outline; aligns views only, so stored geometry never moves with it, except through the explicit, confirmed and undoable "Change alignment" (rotation reduced to a right angle, then snapped to the grid, in one write) |
| Site grid | A grid origin set at Align; drawing snaps to a 10 cm grid on the site axis from it |
| Dependencies | Pure Python in the integration; no shapely or other compiled packages |
| Finding the building | OSM buildings in Home Assistant's map tiles set the axis only, and may act as an unstored snap guide while the outline is drawn on the map |
| Frontend packages | Packages shared with Home Assistant's frontend use the exact version that frontend ships |
| Domain | `spatial` |

## Reuse before writing

In this order:

1. Home Assistant: registries, `homeassistant.util.location`, websocket helpers, config flow
   features, registry websocket commands.
2. An established library. In frontend code: MapLibre, turf, polygon-clipping,
   home-assistant-js-websocket. Never hand-written polygon booleans.
3. A canonical algorithm, ported line for line with its licence notice and source link
   (see `_pnpoly` in `geometry.py`). Copied Home Assistant code names its source path
   (see `normalize_name` in `tools/import_geojson.py`).
4. Only then custom code, marked as custom in its docstring (see `shared_edge_length_m`).

State known limits in the docstring, for example "a point exactly on an edge may fall either
way".

## Single implementations

- All measurement geometry is in `custom_components/spatial/geometry.py`. The panel's drawing geometry is turf in
  `frontend/src/plan.ts`; the Align pick is in `frontend/src/outline.ts`.
- Tools, bridges and frontends use only the websocket API; nothing else reads
  `.storage/spatial` or imports the integration.
- Home Assistant owns areas and floors. Data is keyed by `area_id` and `floor_id`; names,
  levels and floor assignment are read from the registries, never copied.
- Lengths and areas come from the integration, never from a map.
- Map tiles come from Home Assistant's `map_tiles` proxy, never from public tile servers.
- Frontend package versions follow the Home Assistant version in `requirements_test.txt`:
  Home Assistant's `components/frontend/manifest.json` names the frontend release, and that release
  tag's `package.json` names the versions. Never use the frontend's `dev` branch.

## UI design

The panel and the card should look as if they were always part of Home Assistant.

- Home Assistant's theme variables, components and Material Design Icons (`@mdi/js` at Home
  Assistant's version) only; no own colours, fonts or brand. Check the light and dark theme.
- In the panel, use only the components Home Assistant always loads (`ha-icon-button`,
  `ha-svg-icon`, `ha-button`, `ha-tooltip`, `ha-icon`); others are lazy and undefined on a deep
  link. The card may use `ha-card` and gets its editor from `getConfigForm`.
- Every action saves at once and can be undone: no save button, no dialogs in the main flow,
  no settings page. Messages use Home Assistant's toast (`hass-notification`); saving is silent.
- One instruction on screen at a time. A feature that needs explaining is cut or made visible.
- The plan is the content; controls float on it.
- Touch targets at least 44 px, text contrast 4.5:1, real buttons with `aria-pressed` or
  `aria-label`; colour is never the only signal.

## Home Assistant conventions

- `entry.runtime_data`, `single_config_entry`, websocket commands registered once in
  `async_setup`.
- Write commands: `@websocket_command(...)`, then `@require_admin`, then `@callback`, or
  `@async_response` only when the handler awaits.
  Read commands stay open to non-admin users.
- Unknown registry references return `not_found`; bad input returns `invalid_format`.
- Tests use the public interface: a config entry plus `hass_ws_client`. No tests of private
  attributes or store internals.
- Keep voluptuous schemas plain; Home Assistant is moving to Probatio.

## Non-negotiables

- Input validation at the websocket boundary and admin checks on every write.
- Geodetic correctness: test against an independent reference, never against the same formula.
- Privacy: a real home's location, footprint or address is personal data. Never commit one
  in fixtures, examples, screenshots or messages. Never commit or log an access token or an
  address search.

## Tests

- A bug fix starts with a failing test.
- No tests that read back what they just set, or that assert a mock's return value.

## Changes and removals

- Replacing code deletes the old code in the same change.
- Renaming or removing a command, property or file: update every reference, including the
  READMEs and `tools/`.

## Writing

- English. No em or en dashes; use a plain hyphen.
- Descriptive names for functions and variables; the names carry the meaning, not comments.
- Inline comments only for a why the code cannot show: a workaround, a platform quirk, a
  non-obvious constraint.
- Every code file opens with a one-line header saying why it exists, not what it contains:
  the module docstring in Python, a `//` comment in TypeScript and JavaScript, a `#` comment
  in YAML, Dockerfiles and shell scripts. JSON is exempt.
- Each part has one README: why it exists, how to use it, its architecture in lists and
  tables. No other Markdown files.
- Never add a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`: Claude Code then stops
  reading this file. CI fails on the first two.

## Commits and pull requests

- One change per pull request, squash merged into `main`.
- Conventional commits, subject at most 72 characters, a short body with what and why.
- No AI attribution in commits, pull requests or files: no `Co-Authored-By` trailers or
  "generated with" lines. The author is accountable for every line, however it was written.

## Real gates

What is and is not checked automatically:

- On every push and pull request to `main`: `CI Tests` (tests, line coverage with a 99% floor,
  mypy strict), `Validate` (hassfest, HACS, ruff, no-`CLAUDE.md` check) and `Frontend` (tsc,
  vitest, a build, `sync_frontend_versions.py --check`).
- `E2E` runs on the same triggers but is not a required check yet: it covers one room drawn with
  the mouse in the panel of a fresh Home Assistant, and nothing else of the panel.
- On a published GitHub release: `Release` builds the panel and uploads `spatial.zip` (the
  integration with the bundle and licences, version taken from the tag). Untested until the
  first release; check the zip then.
- `main` is protected by a ruleset: pull request required, review threads resolved, squash
  merge only, checks `test`, `hassfest`, `ruff`, `agents-file` and `hacs` required and up to
  date with `main`, no force pushes or deletion. Copilot reviews every pull request.
- `tools/sync_frontend_versions.py` has unit tests; `tools/import_geojson.py` has none, verify
  changes to it against a real Home Assistant.
- Ruff reports `EXE002` on every file through the Windows bind mount; it is an artefact of the
  mount and does not occur on Linux.

## Gotchas

- Git Bash rewrites Unix paths in `docker` arguments. Use `MSYS_NO_PATHCONV=1` and
  `$(pwd -W)` for bind mounts.
- Home Assistant does not run on Windows (`os.fchmod` in storage writes).
- Onboarding creates default areas (Living Room, Kitchen, Bedroom). Registries compare names
  after `normalize_name` (casefold, spaces removed); match names the same way.
- Deleting a floor detaches its areas; re-creating the floor does not re-attach them
  (`test_registry_removal_drops_spatial_data`).
- `OptionsFlow.config_entry` is read-only in current Home Assistant.
- `homeassistant.util.location.vincenty()` rounds to whole millimetres, which limits geodesic
  test tolerances on short edges.
- The frontend's `dev` branch is ahead of what Home Assistant ships; read the release tag.
- The `buildings` layer in Home Assistant's map tiles is one MultiPolygon without attributes
  per tile; each part is one building.
- Home Assistant's shipped map style uses root-relative sprite and glyph URLs; MapLibre
  needs them absolute.
- hassfest needs the repository root mounted, not the integration folder.
- The built panel is not in git. Run the `frontend` service or a build before using the panel
  locally. Keep `custom_components/spatial/frontend/.gitkeep`: without the folder Home
  Assistant registers `/spatial_static` as a single file and the panel 404s until a restart.
- `manifest.json`'s `version` in git is not the released one; the release workflow writes the
  tag into the zip.
