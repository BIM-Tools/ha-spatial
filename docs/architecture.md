# Architecture

For developers: how the parts fit together. How to use Spatial is in the
[user guide](user-guide.md); the rules for changing it, the settled decisions and all commands
are in [AGENTS.md](../AGENTS.md).

## Parts

```mermaid
flowchart LR
  subgraph ha[Home Assistant]
    registries[Area and floor registries]
    tiles[map_tiles proxy and map style]
    subgraph integration[custom_components/spatial]
      ws[websocket_api.py]
      coordinator[coordinator.py]
      geometry[geometry.py]
      store[store.py<br>.storage/spatial]
      search[address_search.py]
    end
  end
  nominatim[OpenStreetMap Nominatim]
  panel[Panel<br>admin, edits]
  card[Dashboard card<br>every user, read-only]
  tools[tools/<br>importer]
  ws --> coordinator
  coordinator --> geometry
  coordinator --> store
  coordinator -- names, levels, floors; removals --> registries
  ws --> search
  search -- explicit address searches only --> nominatim
  panel -- websocket API and registry commands --> ws
  card -- websocket API --> ws
  tools -- websocket API and registry commands --> ws
  panel --> tiles
  card --> tiles
```

| Part | Role | Reference |
| --- | --- | --- |
| Home Assistant registries | Own areas and floors: ids, names, icons, levels, floor assignment | |
| Integration | Stores footprints, room properties, floor heights and the site; computes areas, neighbours, facade and outdoor flags and point lookups; the only API | [Integration README](../custom_components/spatial/README.md): data, websocket API, geometry rules, modules |
| Panel | The admin-only editor, saving each action at once | [Frontend README](../frontend/README.md): files, serving, the commands each action sends |
| Card | The same map on a dashboard, read-only, for every user | [Frontend README](../frontend/README.md#serving) |
| Tools | Import GeoJSON over the websocket API; keep frontend package versions in step | [Tools README](../tools/README.md) |

- Tools, bridges and frontends use only the websocket API; nothing else reads `.storage/spatial`.
- Measurement happens in the integration only: the panel applies the site frame that
  `spatial/site` publishes and shows the lengths and areas the integration returns.
- The concepts follow the W3C Building Topology Ontology (BOT); the feed marks each footprint as
  `bot:Space` and conforms to JSON-FG.

## Repository layout

| Path | Content |
| --- | --- |
| `custom_components/spatial/` | The integration ([README](../custom_components/spatial/README.md)) |
| `frontend/` | Panel and card source, built into the integration ([README](../frontend/README.md)) |
| `tests/` | Integration tests against a real Home Assistant |
| `e2e/` | Browser scripts: the smoke test and the state gallery, which also renders the documentation images |
| `tools/` | GeoJSON importer, example house, version sync ([README](../tools/README.md)) |
| `docs/` | This page, the user guide and their images |

## Development

- Home Assistant runs on Linux only, so everything runs in Docker; a VS Code devcontainer is
  included. The commands are in [AGENTS.md](../AGENTS.md#commands); `docker compose up
  homeassistant` serves Home Assistant with your changes at <http://localhost:8123>.
- The Home Assistant version tested against is pinned in `requirements_test.txt`.
- To try the panel on an example house, import `tools/example_house.geojson` as in
  [tools](../tools/README.md).
