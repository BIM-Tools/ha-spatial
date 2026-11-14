# Spatial

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://hacs.xyz)

Draw your rooms on Home Assistant's own map, and let Home Assistant know which room is where and which rooms touch.

![The ground floor of the example house in the Spatial panel, the living room active with its side lengths](https://raw.githubusercontent.com/BIM-Tools/ha-spatial/main/docs/images/hero.png)

It is not a 3D house model: no walls, doors, furniture or device positions.

## Install

Needs Home Assistant 2026.11.0 or newer and [HACS](https://hacs.xyz). HACS installs
`spatial.zip` from a published GitHub release. The panel and card are built into that zip and
are not in git, so copying the source folder gives no editor.

1. In HACS open the three-dot menu > Custom repositories and add
   `https://github.com/BIM-Tools/ha-spatial` with type Integration.

   [![Open your Home Assistant instance and open this repository in HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=BIM-Tools&repository=ha-spatial&category=integration)

2. Download Spatial, then restart Home Assistant.
3. Create your floors and put your areas on them in Settings > Areas, labels & zones first;
   areas without a floor are drawn under No floor. Then go to Settings > Devices & services >
   Add integration > Spatial and press **Open floor plan**.

New here? The [user guide](docs/user-guide.md) walks you through drawing your house, about ten
minutes. Early version: the storage format can still change; the websocket API is versioned
(`api_version`, see the [integration README](custom_components/spatial/README.md#compatibility)).

### Install without HACS

Download `spatial.zip` from the
[releases page](https://github.com/BIM-Tools/ha-spatial/releases), unzip it into
`config/custom_components/spatial/`, restart Home Assistant, then continue with step 3.

## Why

- Home Assistant knows your floors and areas, but not where they are or which rooms touch.
- Spatial adds an optional footprint per area and a height per floor, drawn on Home Assistant's
  own map in a few clicks.
- Net room areas and neighbouring rooms follow from the footprints; nothing extra to maintain.
- Small: no extra Python packages, Home Assistant's own map and theme; the data stays in Home
  Assistant.
- For BIM, GIS and positioning tools: rooms are WGS84 polygons, served as JSON-FG with BOT
  `Space` features over a versioned
  [websocket API](custom_components/spatial/README.md#websocket-api). Bridges (IFC, CityJSON
  and the like) run outside Home Assistant on that API.
- Not a CAD tool or a tracker. Positioning projects can ask which room a point lies in.

## Your data

- The plan is stored in `.storage/spatial` and is part of every Home Assistant backup.
- To remove Spatial: delete the integration under Settings > Devices & services, then in HACS
  open Spatial > three-dot menu > Remove, and restart Home Assistant.
- This leaves `.storage/spatial` in place. Delete it by hand for a clean uninstall.
- Undo is lost after a reload; see the
  [Known limits](docs/user-guide.md#known-limits).
- Questions and bugs: [GitHub issues](https://github.com/BIM-Tools/ha-spatial/issues).

## Room colours

A dashboard card fixed to one floor can colour its rooms by live data and write the value under
each room's name. `brightness` reads the brightest light that is on in the area, `temperature`
the temperature sensor chosen for the area, else the average of its temperature sensors.

```yaml
type: custom:spatial-map-card
floor: ground_floor
colour_by: brightness
```

```yaml
type: custom:spatial-map-card
floor: ground_floor
colour_by: temperature
```

## Privacy

Your footprints, floors and site stay in Home Assistant. One thing leaves it: an address
search.

- When: only when an administrator searches for an address explicitly. Nothing is searched
  automatically or while typing.
- What: the typed text, Home Assistant's language, and an area of about 50 km around Home
  Assistant's home location rounded to 0.1 degree (so nearby places come first), sent to
  [OpenStreetMap Nominatim](https://nominatim.org/) with a user agent naming this integration.
  Nominatim also sees your IP address; see the
  [OSMF privacy policy](https://osmfoundation.org/wiki/Privacy_Policy). To use your own
  Nominatim server instead, set **Address search server** under Settings > Devices & services >
  Spatial > **Configure**.
- Kept: nothing. The text and the results are not logged or stored by the integration. Home
  Assistant's own websocket debug logging, when you switch it on, records every message,
  searches included.

## Documentation

| Document | For |
| --- | --- |
| [User guide](docs/user-guide.md) | Drawing your house, the panel and the dashboard card |
| [Architecture](docs/architecture.md) | Developers: how the parts fit together, repository layout, development |
| [Integration](custom_components/spatial/README.md) | Websocket API, storage and geometry rules, for tool and bridge builders |
| [Frontend](frontend/README.md) | Panel and card source, build and serving |
| [Tools](tools/README.md) | GeoJSON importer, example house, version sync |

## Contributing

- Read [AGENTS.md](AGENTS.md) first; it applies to people and coding agents alike.
- You are responsible for every line you submit, however it was written
  ([Home Assistant AI policy](https://developers.home-assistant.io/docs/ai_policy)).

## License

MIT
