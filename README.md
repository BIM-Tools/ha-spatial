# spatial

Room footprints for Home Assistant areas, on the same map as your zones.

## Why

- Home Assistant knows your floors and areas, but not where they are or which rooms touch.
- `spatial` adds an optional footprint per area and a height per floor.
- Which rooms are neighbours follows from the footprints; nothing extra to maintain.
- Follows Home Assistant's own conventions: small, no extra dependencies, uses Home Assistant's own map.

## Status

Early version. The API and storage format can still change. There is no editor yet.

## Parts

| Path | What | Details |
| --- | --- | --- |
| `custom_components/spatial/` | The integration | [README](custom_components/spatial/README.md) |
| `tools/` | GeoJSON importer, example house, development viewer | [README](tools/README.md) |
| `tests/` | Tests against a real Home Assistant | - |
| `AGENTS.md` | Rules for contributors and coding agents | - |

## Try it

1. `docker compose up homeassistant`, open <http://localhost:8123>, finish onboarding.
2. Add the Spatial integration (Settings > Devices & services).
3. Create a long-lived access token (profile > Security).
4. Import the example house, then open the viewer: see [tools/README.md](tools/README.md).

## Design rules

| Rule | Value |
| --- | --- |
| Coordinates | WGS84 GeoJSON, the same world as Home Assistant zones |
| Footprint | One area has at most one `Polygon` (holes allowed, no MultiPolygon) |
| Drawing convention | Rooms are drawn to wall centrelines, so neighbours share edges |
| Adjacency | Derived from shared edges on the same floor, never stored |
| Measurements | Computed by the integration in metres, never from the map projection |
| Building, sub-spaces | Home Assistant labels |
| Site anchor | One bearing per installation; the centre follows all footprints; aligns views only |
| Finding the building | OSM buildings from Home Assistant's own map tiles |
| Dependencies | Pure Python |
| Concepts | Structure of the W3C Building Topology Ontology (BOT), Home Assistant naming |

## Development

| Task | Command |
| --- | --- |
| Tests | `docker compose run --rm test` |
| Some tests | `docker compose run --rm test pytest -k <expr>` |
| Lint | `docker compose run --rm test sh -c "ruff format --check . && ruff check ."` |
| Home Assistant | `docker compose up homeassistant` |

- Home Assistant runs on Linux only, so everything runs in Docker. A VS Code devcontainer is included.
- The Home Assistant version tested against is pinned in `requirements_test.txt`.

## Contributing

- Read `AGENTS.md` first; it applies to people and coding agents alike.
- You are responsible for every line you submit, however it was written
  ([Home Assistant AI policy](https://developers.home-assistant.io/docs/ai_policy)).

## License

MIT
