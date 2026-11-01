"""Keeps footprints, floor dimensions and the site across restarts."""

from __future__ import annotations

from typing import Any, TypedDict

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import SAVE_DELAY_S, STORAGE_KEY, STORAGE_VERSION


class AreaSpatial(TypedDict):
    """Footprint of an area."""

    polygon: dict[str, Any]


class FloorSpatial(TypedDict):
    """Vertical position of a floor."""

    elevation_m: float | None
    height_m: float | None


class Site(TypedDict):
    """Shared centre and orientation for aligning views and editors."""

    lon: float
    lat: float
    bearing_deg: float | None
    outline: dict[str, Any] | None


class SpatialStore:
    """Stores spatial data keyed by area_id and floor_id, plus the site bearing and outline."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the store."""
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.areas: dict[str, AreaSpatial] = {}
        self.floors: dict[str, FloorSpatial] = {}
        self.bearing_deg: float | None = None
        self.outline: dict[str, Any] | None = None
        self._dirty = False

    async def async_load(self) -> None:
        """Load data from disk."""
        data = await self._store.async_load() or {}
        self.areas = data.get("areas", {})
        self.floors = data.get("floors", {})
        # Earlier versions stored null, or an origin besides the bearing, and no outline.
        # A missing bearing means the site was never aligned.
        site = data.get("site") or {}
        self.bearing_deg = site.get("bearing_deg")
        self.outline = site.get("outline")

    def _data(self) -> dict[str, Any]:
        """Return the data to persist.

        Called by the delayed save at write time, so what it returns is no longer
        pending; a change made after this sets the flag again.
        """
        self._dirty = False
        return {
            "areas": self.areas,
            "floors": self.floors,
            "site": {"bearing_deg": self.bearing_deg, "outline": self.outline},
        }

    @callback
    def async_schedule_save(self) -> None:
        """Save soon, so edits that follow each other are written once.

        Home Assistant also writes pending data at shutdown (Store final write).
        """
        self._dirty = True
        self._store.async_delay_save(self._data, SAVE_DELAY_S)

    async def async_flush(self) -> None:
        """Write pending changes now, for example before the entry unloads."""
        if self._dirty:
            await self._store.async_save(self._data())
