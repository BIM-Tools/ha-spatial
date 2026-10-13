"""Persistence of area footprints and floor dimensions."""

from __future__ import annotations

from typing import Any, TypedDict

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION


class AreaSpatial(TypedDict):
    """Footprint of an area."""

    polygon: dict[str, Any]
    area_m2: float


class FloorSpatial(TypedDict):
    """Vertical position of a floor."""

    elevation_m: float | None
    height_m: float | None


class Site(TypedDict):
    """Shared origin and orientation for aligning views and editors."""

    lon: float
    lat: float
    bearing_deg: float


class SpatialStore:
    """Stores spatial data keyed by area_id and floor_id, plus the site anchor."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the store."""
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.areas: dict[str, AreaSpatial] = {}
        self.floors: dict[str, FloorSpatial] = {}
        self.site: Site | None = None

    async def async_load(self) -> None:
        """Load data from disk."""
        data = await self._store.async_load() or {}
        self.areas = data.get("areas", {})
        self.floors = data.get("floors", {})
        self.site = data.get("site")

    async def async_save(self) -> None:
        """Save data to disk."""
        await self._store.async_save(
            {"areas": self.areas, "floors": self.floors, "site": self.site}
        )
