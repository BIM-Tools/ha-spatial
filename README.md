# Spatial

Room footprints for Home Assistant areas, on the same map as your zones.

![The ground floor of the example house in the Spatial panel, the living room active with its side lengths](docs/images/hero.png)

## Why

- Home Assistant knows your floors and areas, but not where they are or which rooms touch.
- Spatial adds an optional footprint per area and a height per floor, drawn on Home Assistant's
  own map in a few clicks.
- Net room areas and neighbouring rooms follow from the footprints; nothing extra to maintain.
- Small: pure Python, no extra dependencies, Home Assistant's own map and theme; the data
  stays in Home Assistant.

Early version: the API and storage format can still change.

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

## Documentation

| Document | For |
| --- | --- |
| [User guide](docs/user-guide.md) | Drawing your house, the panel and the dashboard card |
| [Architecture](docs/architecture.md) | Developers: parts, data model, design rules, development |
| [Integration](custom_components/spatial/README.md) | Websocket API, storage and geometry rules |
| [Frontend](frontend/README.md) | Panel and card source, build and serving |
| [Tools](tools/README.md) | GeoJSON importer, example house, version sync |

## Contributing

- Read [AGENTS.md](AGENTS.md) first; it applies to people and coding agents alike.
- You are responsible for every line you submit, however it was written
  ([Home Assistant AI policy](https://developers.home-assistant.io/docs/ai_policy)).

## License

MIT
