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
| Lint and format | `docker compose run --rm test sh -c "ruff format . && ruff check ."` |
| hassfest | `docker run --rm -v "$(pwd -W)":/github/workspace:ro ghcr.io/home-assistant/hassfest` |
| Real Home Assistant | `docker compose up homeassistant` |
| Tools | Run them against the real Home Assistant, see `tools/README.md` |

## Settled decisions

Change these only through an issue that names the reason.

| Area | Decision |
| --- | --- |
| Coordinates | WGS84 GeoJSON, the same world as Home Assistant zones |
| Measurement | In the integration, local tangent plane with exact WGS84 radii; never UTM, national grids, Mercator or screen space |
| Footprint | One area has at most one `Polygon`; no MultiPolygon, its parts cannot carry identity |
| Adjacency | Derived from shared wall-centreline edges on the same floor; never stored |
| Building, sub-spaces | Home Assistant labels; no code |
| Site anchor | One per installation; aligns views; stored geometry never moves with it |
| Dependencies | Pure Python in the integration; no shapely or other compiled packages |
| Finding the building | OSM buildings from Home Assistant's map tiles; national datasets are out of scope, users can import their own polygon |
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

- All geometry is in `custom_components/spatial/geometry.py`.
- Tools, bridges and frontends use only the websocket API; nothing else reads
  `.storage/spatial` or imports the integration.
- Home Assistant owns areas and floors. Data is keyed by `area_id` and `floor_id`; names,
  levels and floor assignment are read from the registries, never copied.
- Lengths and areas come from the integration, never from a map.
- Map tiles come from Home Assistant's `map_tiles` proxy, never from public tile servers.
- Frontend package versions follow the Home Assistant version in `requirements_test.txt`:
  Home Assistant's `components/frontend/manifest.json` names the frontend release, and that release
  tag's `package.json` names the versions. Never use the frontend's `dev` branch.

## Home Assistant conventions

- `entry.runtime_data`, `single_config_entry`, websocket commands registered once in
  `async_setup`.
- Write commands: `@websocket_command(...)`, then `@require_admin`, then `@async_response`.
  Read commands stay open to non-admin users.
- Unknown registry references return `not_found`; bad input returns `invalid_format`.
- Tests use the public interface: a config entry plus `hass_ws_client`. No tests of private
  attributes or store internals.
- Keep voluptuous schemas plain; Home Assistant is moving to Probatio.

## Non-negotiables

- Input validation at the websocket boundary and admin checks on every write.
- Geodetic correctness: test against an independent reference, never against the same formula.
- Privacy: a real home's location, footprint or address is personal data. Never commit one
  in fixtures, examples, screenshots or messages. Never commit or log an access token.

## Tests

- A bug fix starts with a failing test.
- No tests that read back what they just set, or that assert a mock's return value.

## Changes and removals

- Replacing code deletes the old code in the same change.
- Renaming or removing a command, property or file: update every reference, including the
  READMEs and `tools/`.

## Writing

- English. No em or en dashes; use a plain hyphen.
- Comments explain why, not what.
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

- On every push and pull request to `main`: the tests (`CI Tests`), and hassfest, HACS, ruff
  and the no-`CLAUDE.md` check (`Validate`).
- `tools/` has no automated tests; verify changes against a real Home Assistant.
- No type checker. Coverage is not measured.
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
- Home Assistant's shipped map style uses root-relative sprite and glyph URLs; MapLibre 5
  needs them absolute.
- hassfest needs the repository root mounted, not the integration folder.
