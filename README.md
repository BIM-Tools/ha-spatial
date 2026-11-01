# spatial

Room footprints for Home Assistant areas, on the same map as your zones.

## Why

- Home Assistant knows your floors and areas, but not where they are or which rooms touch.
- `spatial` adds an optional footprint per area and a height per floor.
- Which rooms are neighbours follows from the footprints; nothing extra to maintain.
- Follows Home Assistant's own conventions: small, no extra dependencies, uses Home Assistant's own map.

## Status

Early version. The API and storage format can still change. The editor draws the building outline and the rooms as boxes along one wall.

## Install

HACS installs `spatial.zip` from a published GitHub release. The panel and card are built
into that zip and are not in git, so copying the source folder gives no editor.

1. In HACS, open the three-dot menu > Custom repositories and add
   `https://github.com/BIM-Tools/ha-spatial` with type Integration.
2. Download Spatial (Home Assistant 2026.10.0 or newer). The first releases are
   pre-releases: pick one under "Need a different version?". To be offered later
   pre-releases as updates, enable and turn on the repository's pre-release switch entity
   (HACS creates it disabled).
3. Restart Home Assistant, then Settings > Devices & services > Add integration > Spatial.

Without HACS: download `spatial.zip` from the
[releases page](https://github.com/BIM-Tools/ha-spatial/releases), unzip it into
`config/custom_components/spatial/`, then continue with step 3.

## Parts

| Path | What | Details |
| --- | --- | --- |
| `custom_components/spatial/` | The integration | [README](custom_components/spatial/README.md) |
| `tools/` | GeoJSON importer, example house, version sync | [README](tools/README.md) |
| `frontend/` | Map panel and dashboard card source, built into the integration | [README](frontend/README.md) |
| `tests/` | Tests against a real Home Assistant | - |
| `e2e/` | A browser smoke test (one room drawn in the panel) and a state gallery (every panel and card state as screenshots, both themes and sizes) | Commands in [AGENTS.md](AGENTS.md) |
| `AGENTS.md` | Rules for contributors and coding agents | - |

## Try it

1. `docker compose up -d frontend homeassistant` (builds the panel, starts Home Assistant),
   open <http://localhost:8123>, finish onboarding.
2. Add the Spatial integration (Settings > Devices & services).
3. Create a long-lived access token (profile > Security).
4. Import the example house, see [tools/README.md](tools/README.md).
5. Open the panel: Settings > Devices & services > Spatial > Configure.
6. Optionally add `type: custom:spatial-map-card` to a dashboard, best in a panel view.

## Design rules

| Rule | Value |
| --- | --- |
| Coordinates | WGS84 GeoJSON, the same world as Home Assistant zones |
| Footprint | One area has at most one `Polygon` (holes allowed, no MultiPolygon) |
| Drawing convention | Rooms are drawn to wall centrelines, so neighbours share edges |
| Adjacency | Derived from shared edges on the same floor, never stored |
| Measurements | Computed by the integration in metres, never from the map projection |
| Area | `area_m2` is net: the drawn polygon shrunk by 50 mm on every side |
| Building, sub-spaces | Home Assistant labels |
| Site anchor | One bearing and optional building outline per installation; the centre follows the footprints, else the outline; aligns views only |
| Finding the building | OSM buildings in Home Assistant's map tiles set the axis only; the outline is drawn on the map |
| Dependencies | Pure Python |
| Concepts | Structure of the W3C Building Topology Ontology (BOT), Home Assistant naming |

## Development

| Task | Command |
| --- | --- |
| Tests | `docker compose run --rm test` |
| Some tests | `docker compose run --rm test pytest -k <expr>` |
| Lint | `docker compose run --rm test sh -c "ruff format --check . && ruff check ."` |
| Panel build, rebuilt on change | `docker compose up -d frontend` |
| Home Assistant | `docker compose up homeassistant` |

- Home Assistant runs on Linux only, so everything runs in Docker. A VS Code devcontainer is included.
- The Home Assistant version tested against is pinned in `requirements_test.txt`.
- The built panel is not in git; HACS installs it from the release zip that `.github/workflows/release.yml` builds.

## Contributing

- Read `AGENTS.md` first; it applies to people and coding agents alike.
- You are responsible for every line you submit, however it was written
  ([Home Assistant AI policy](https://developers.home-assistant.io/docs/ai_policy)).

## License

MIT
