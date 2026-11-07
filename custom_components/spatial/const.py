"""Keeps the integration's names and tuning values in one place."""

from fractions import Fraction
from typing import Final, NamedTuple

DOMAIN: Final = "spatial"

PANEL_URL_PATH: Final = "spatial"
PANEL_COMPONENT: Final = "spatial-panel"
STATIC_URL: Final = "/spatial_static"

STORAGE_KEY: Final = DOMAIN
STORAGE_VERSION: Final = 1
# Raised for every additive change, with a step in the store's migration.
STORAGE_MINOR_VERSION: Final = 3

# Writes are delayed so a multi-step edit is saved once. Short enough to lose
# little if the process is killed; Home Assistant flushes on a normal stop.
SAVE_DELAY_S: Final = 2

EVENT_SPATIAL_UPDATED: Final = "spatial_updated"

# The websocket contract clients read from `spatial/site`. Raised for every breaking
# change to a command's schema or result shape, never for an addition.
API_VERSION: Final = 1

# Websocket error code for a write based on data that changed since it was read.
ERR_CONFLICT: Final = "conflict"
# Websocket error code for an indoor room that would extend beyond the building outline.
ERR_OUTSIDE_OUTLINE: Final = "outside_outline"

# Websocket error code for an address search the search server could not answer.
ERR_SEARCH_FAILED: Final = "search_failed"

# Address search: the one server URL, and what its usage policy asks of clients
# (https://operations.osmfoundation.org/policies/nominatim/): an identifying user
# agent and at most one request per second.
ADDRESS_SEARCH_URL: Final = "https://nominatim.openstreetmap.org/search"
ADDRESS_SEARCH_USER_AGENT: Final = (
    "HomeAssistant-Spatial (+https://github.com/BIM-Tools/ha-spatial)"
)
ADDRESS_SEARCH_INTERVAL_S: Final = 1.0
ADDRESS_SEARCH_TIMEOUT_S: Final = 10
ADDRESS_SEARCH_LIMIT: Final = 5
# Half the side of the box around the home location that results near home are
# preferred in, in degrees (about 25 km); results outside it still come back.
ADDRESS_SEARCH_BIAS_DEG: Final = 0.25

# Hex characters of the sha256 that identify one version of a stored entry.
REV_LENGTH: Final = 12

# The site fields a write command may set; the centre is derived, never written.
SITE_FIELD_NAMES: Final = ("bearing_deg", "origin", "outline")

# The stored room properties a write command may set; the others are derived.
ROOM_PROPERTY_NAMES: Final = ("floors_up", "on_facade_override")

# Floors without spatial data stack this many metres per level.
DEFAULT_FLOOR_HEIGHT_M: Final = 3.0

# Two areas are adjacent, and a room is on the facade, when their wall axes
# coincide over at least this length.
MIN_SHARED_EDGE_M: Final = 0.3

# Footprints are read on a lattice of a quarter drawing grid step, fine enough
# for the walls and coarse enough that corners line up on screen.
LATTICE_UNITS_PER_STEP: Final = 4


class UnitGrid(NamedTuple):
    """The drawing grid of one unit system, with the half walls as fractions of a step."""

    step_m: Fraction
    interior_half_wall: Fraction
    exterior_half_wall: Fraction

    @property
    def lattice_unit_m(self) -> Fraction:
        """Return the size of one lattice unit in metres."""
        return self.step_m / LATTICE_UNITS_PER_STEP

    @property
    def interior_inset_units(self) -> int:
        """Return the inset of a room along an interior wall axis, in lattice units."""
        return int(self.interior_half_wall * LATTICE_UNITS_PER_STEP)

    @property
    def exterior_inset_units(self) -> int:
        """Return the inset of a room along the outline, in lattice units."""
        return int(self.exterior_half_wall * LATTICE_UNITS_PER_STEP)


# Walls lie on the axes, so a room loses half of a 100 mm (4 in) partition and
# half of a 300 mm (6 in) exterior wall: 5 cm and 15 cm, or 2 in and 3 in.
METRIC_GRID: Final = UnitGrid(Fraction(1, 10), Fraction(1, 2), Fraction(3, 2))
US_CUSTOMARY_GRID: Final = UnitGrid(Fraction(254, 2500), Fraction(1, 2), Fraction(3, 4))

# JSON-FG (OGC) conformance classes and the feature type of an area footprint.
JSONFG_CORE: Final = "http://www.opengis.net/spec/json-fg-1/1.0/conf/core"
JSONFG_TYPES_SCHEMAS: Final = "http://www.opengis.net/spec/json-fg-1/1.0/conf/types-schemas"
BOT_SPACE: Final = "https://w3id.org/bot#Space"
