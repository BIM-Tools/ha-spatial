"""Constants for the Spatial integration."""

from typing import Final

DOMAIN: Final = "spatial"

PANEL_URL_PATH: Final = "spatial"
PANEL_COMPONENT: Final = "spatial-panel"
STATIC_URL: Final = "/spatial_static"

STORAGE_KEY: Final = DOMAIN
STORAGE_VERSION: Final = 1

# Writes are delayed so a multi-step edit is saved once. Short enough to lose
# little if the process is killed; Home Assistant flushes on a normal stop.
SAVE_DELAY_S: Final = 2

# Fired when spatial data changes.
EVENT_SPATIAL_UPDATED: Final = "spatial_updated"

# Floors without spatial data stack this many metres per level.
DEFAULT_FLOOR_HEIGHT_M: Final = 3.0

# Rooms are drawn to wall centrelines: two areas are adjacent when
# their edges coincide within the tolerance over at least the minimum length.
ADJACENCY_TOLERANCE_M: Final = 0.05
ADJACENCY_MIN_SHARED_M: Final = 0.3

# JSON-FG (OGC) conformance classes and the feature type of an area footprint.
JSONFG_CORE: Final = "http://www.opengis.net/spec/json-fg-1/1.0/conf/core"
JSONFG_TYPES_SCHEMAS: Final = "http://www.opengis.net/spec/json-fg-1/1.0/conf/types-schemas"
BOT_SPACE: Final = "https://w3id.org/bot#Space"

# Reported room areas are net: the drawn polygon shrunk on every side, so an
# interior centreline loses half of a 100 mm partition and an exterior line
# (0.25 m inside the facade) loses the rest of a 300 mm wall.
NET_INSET_M: Final = 0.05
