"""Keeps footprints, floor dimensions and the site across restarts and upgrades."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import SAVE_DELAY_S, STORAGE_KEY, STORAGE_MINOR_VERSION, STORAGE_VERSION


class AreaSpatial(TypedDict):
    """Footprint of an area and how it relates to the floors and the facade."""

    polygon: dict[str, Any]
    floors_up: int
    on_facade_override: bool | None


class FloorSpatial(TypedDict):
    """Vertical position of a floor."""

    elevation_m: float | None
    height_m: float | None


class Site(TypedDict):
    """Orientation, grid origin and building outline shared by all views and editors."""

    bearing_deg: float | None
    origin: list[float] | None
    outline: dict[str, Any] | None


class HomePin(TypedDict):
    """The answer given when the home location was checked against the building."""

    answer: Literal["moved", "kept"]
    distance_m: float


class Onboarding(TypedDict):
    """Answers given while setting up, kept apart from the site so its rev stays geometric."""

    home_pin: HomePin | None


class SpatialData(TypedDict):
    """Everything in `.storage/spatial`."""

    site: Site
    floors: dict[str, FloorSpatial]
    areas: dict[str, AreaSpatial]
    onboarding: Onboarding


def new_area(polygon: dict[str, Any]) -> AreaSpatial:
    """Return the entry of an area that gets its first footprint."""
    return {"polygon": polygon, "floors_up": 0, "on_facade_override": None}


class _VersionedStore(Store[SpatialData]):
    """Brings data saved by older releases to the current shape."""

    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict[str, Any]
    ) -> dict[str, Any]:
        """Return old_data with every key of the current minor version.

        A newer minor version, saved by a later release, passes through unchanged.
        """
        data = dict(old_data)
        if old_major_version == 1 and old_minor_version < 2:
            # 1.1 kept a gross area_m2 per area and lon/lat in the site (both derived
            # now), and could hold a null site or miss keys.
            site = data.get("site") or {}
            data["site"] = {
                "bearing_deg": site.get("bearing_deg"),
                "origin": None,
                "outline": site.get("outline"),
            }
            data["areas"] = {
                area_id: new_area(area["polygon"])
                for area_id, area in (data.get("areas") or {}).items()
            }
            data["floors"] = {
                floor_id: {
                    "elevation_m": floor.get("elevation_m"),
                    "height_m": floor.get("height_m"),
                }
                for floor_id, floor in (data.get("floors") or {}).items()
            }
            data["onboarding"] = {"home_pin": None}
        return data


class SpatialStore:
    """Stores spatial data keyed by area_id and floor_id, plus the site and onboarding."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the store."""
        self._store = _VersionedStore(
            hass,
            STORAGE_VERSION,
            STORAGE_KEY,
            minor_version=STORAGE_MINOR_VERSION,
            atomic_writes=True,
        )
        self.areas: dict[str, AreaSpatial] = {}
        self.floors: dict[str, FloorSpatial] = {}
        self.site: Site = {"bearing_deg": None, "origin": None, "outline": None}
        self.onboarding: Onboarding = {"home_pin": None}
        self._dirty = False

    async def async_load(self) -> None:
        """Load data from disk; a new install keeps the empty defaults."""
        if (data := await self._store.async_load()) is None:
            return
        self.areas = data["areas"]
        self.floors = data["floors"]
        self.site = data["site"]
        self.onboarding = data["onboarding"]

    def _data(self) -> SpatialData:
        """Return the data to persist.

        Called by the delayed save at write time, so what it returns is no longer
        pending; a change made after this sets the flag again.
        """
        self._dirty = False
        return {
            "site": self.site,
            "floors": self.floors,
            "areas": self.areas,
            "onboarding": self.onboarding,
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
