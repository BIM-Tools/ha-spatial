"""Constants for the Spatial integration."""

from typing import Final

DOMAIN: Final = "spatial"

STORAGE_KEY: Final = DOMAIN
STORAGE_VERSION: Final = 1

# Fired when spatial data changes.
EVENT_SPATIAL_UPDATED: Final = "spatial_updated"

# Floors without spatial data stack this many metres per level.
DEFAULT_FLOOR_HEIGHT_M: Final = 3.0

# Rooms are drawn to wall centrelines: two areas are adjacent when
# their edges coincide within the tolerance over at least the minimum length.
ADJACENCY_TOLERANCE_M: Final = 0.05
ADJACENCY_MIN_SHARED_M: Final = 0.3
