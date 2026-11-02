"""Keeps the integration's names and tuning values in one place."""

from fractions import Fraction
from typing import Final, Literal, NamedTuple

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

# Websocket error code for a write based on data that changed since it was read.
ERR_CONFLICT: Final = "conflict"
# Websocket error code for an indoor room that would extend beyond the building outline.
ERR_OUTSIDE_OUTLINE: Final = "outside_outline"

# Hex characters of the sha256 that identify one version of a stored entry.
REV_LENGTH: Final = 12

# The site fields a write command may set; the centre is derived, never written,
# and the lattice is set with the first origin.
SITE_FIELD_NAMES: Final = ("bearing_deg", "origin", "outline")

# The stored room properties a write command may set; the others are derived.
ROOM_PROPERTY_NAMES: Final = ("floors_up", "on_facade_override")

# Floors without spatial data stack this many metres per level.
DEFAULT_FLOOR_HEIGHT_M: Final = 3.0

# Two areas are adjacent, and a room is on the facade, when their wall axes
# coincide over at least this length.
MIN_SHARED_EDGE_M: Final = 0.3

type LatticeName = Literal["metric", "us"]


class LatticeSize(NamedTuple):
    """One lattice: its unit and the drawing grid and half walls in whole units."""

    unit_m: Fraction
    grid_units: int
    interior_inset_units: int
    exterior_inset_units: int


# Every point is read on the lattice of the unit system in use when the origin
# was first set; walls lie on the axes, so a room loses half of a 100 mm (4 in)
# partition and half of a 300 mm (6 in) exterior wall.
LATTICES: Final[dict[LatticeName, LatticeSize]] = {
    "metric": LatticeSize(Fraction(1, 100), 10, 5, 15),
    "us": LatticeSize(Fraction(254, 10000), 4, 2, 3),
}

# JSON-FG (OGC) conformance classes and the feature type of an area footprint.
JSONFG_CORE: Final = "http://www.opengis.net/spec/json-fg-1/1.0/conf/core"
JSONFG_TYPES_SCHEMAS: Final = "http://www.opengis.net/spec/json-fg-1/1.0/conf/types-schemas"
BOT_SPACE: Final = "https://w3id.org/bot#Space"
