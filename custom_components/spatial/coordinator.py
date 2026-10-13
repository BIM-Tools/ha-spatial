"""Spatial data for Home Assistant areas and floors."""

from __future__ import annotations

from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr

from .const import (
    ADJACENCY_MIN_SHARED_M,
    ADJACENCY_TOLERANCE_M,
    DEFAULT_FLOOR_HEIGHT_M,
    EVENT_SPATIAL_UPDATED,
)
from .geometry import polygon_area_m2, polygon_contains, shared_edge_length_m
from .store import Site, SpatialStore


class SpatialCoordinator:
    """Keeps area footprints and floor dimensions in sync with the registries."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the coordinator."""
        self.hass = hass
        self.store = SpatialStore(hass)
        self._unsubscribe: list[Any] = []

    async def async_setup(self) -> None:
        """Load stored data and follow registry removals."""
        await self.store.async_load()
        self._unsubscribe = [
            self.hass.bus.async_listen(ar.EVENT_AREA_REGISTRY_UPDATED, self._async_area_updated),
            self.hass.bus.async_listen(fr.EVENT_FLOOR_REGISTRY_UPDATED, self._async_floor_updated),
        ]

    async def async_teardown(self) -> None:
        """Stop following the registries and write pending changes."""
        for unsubscribe in self._unsubscribe:
            unsubscribe()
        self._unsubscribe = []
        await self.store.async_flush()

    @callback
    def _async_area_updated(self, event: Event[ar.EventAreaRegistryUpdatedData]) -> None:
        """Drop the footprint of a removed area."""
        if event.data["action"] == "remove" and event.data["area_id"] in self.store.areas:
            del self.store.areas[event.data["area_id"]]
            self._changed()

    @callback
    def _async_floor_updated(self, event: Event[fr.EventFloorRegistryUpdatedData]) -> None:
        """Drop the dimensions of a removed floor."""
        if event.data["action"] == "remove" and event.data["floor_id"] in self.store.floors:
            del self.store.floors[event.data["floor_id"]]
            self._changed()

    def _changed(self) -> None:
        """Schedule a save and notify listeners."""
        self.store.async_schedule_save()
        self.hass.bus.async_fire(EVENT_SPATIAL_UPDATED)

    @callback
    def async_set_area_geometries(
        self, polygons: dict[str, dict[str, Any] | None]
    ) -> dict[str, float]:
        """Set or remove (None) footprints in one change; return the m² of those set."""
        sizes: dict[str, float] = {}
        for area_id, polygon in polygons.items():
            if polygon is None:
                self.store.areas.pop(area_id, None)
                continue
            sizes[area_id] = round(polygon_area_m2(polygon), 2)
            self.store.areas[area_id] = {"polygon": polygon, "area_m2": sizes[area_id]}
        self._changed()
        return sizes

    @callback
    def async_set_floor(
        self, floor_id: str, elevation_m: float | None, height_m: float | None
    ) -> None:
        """Set the elevation and height of a floor."""
        self.store.floors[floor_id] = {"elevation_m": elevation_m, "height_m": height_m}
        self._changed()

    def get_site(self) -> Site:
        """Return the site anchor, defaulting to the home location facing north."""
        return self.store.site or {
            "lon": self.hass.config.longitude,
            "lat": self.hass.config.latitude,
            "bearing_deg": 0.0,
        }

    @callback
    def async_set_site(self, lon: float, lat: float, bearing_deg: float) -> None:
        """Set the site anchor."""
        self.store.site = {"lon": lon, "lat": lat, "bearing_deg": bearing_deg}
        self._changed()

    def _floor_of(self, area_id: str) -> str | None:
        """Return the floor_id of an area."""
        area = ar.async_get(self.hass).async_get_area(area_id)
        return area.floor_id if area else None

    def _floor_bounds(self, floor_id: str | None) -> tuple[float, float]:
        """Return the base and top height in metres of a floor."""
        floor = fr.async_get(self.hass).async_get_floor(floor_id) if floor_id else None
        stored = self.store.floors.get(floor_id) if floor_id else None
        level = floor.level if floor and floor.level is not None else 0
        elevation = stored["elevation_m"] if stored else None
        height = stored["height_m"] if stored else None
        base = elevation if elevation is not None else level * DEFAULT_FLOOR_HEIGHT_M
        return base, base + (height if height is not None else DEFAULT_FLOOR_HEIGHT_M)

    def get_geojson(self, floor_id: str | None = None) -> dict[str, Any]:
        """Return all area footprints as a GeoJSON FeatureCollection."""
        area_registry = ar.async_get(self.hass)
        floor_registry = fr.async_get(self.hass)
        features = []
        for area_id, data in self.store.areas.items():
            area = area_registry.async_get_area(area_id)
            area_floor_id = area.floor_id if area else None
            if floor_id and area_floor_id != floor_id:
                continue
            floor = floor_registry.async_get_floor(area_floor_id) if area_floor_id else None
            base, top = self._floor_bounds(area_floor_id)
            features.append(
                {
                    "type": "Feature",
                    "id": area_id,
                    "geometry": data["polygon"],
                    "properties": {
                        "area_id": area_id,
                        "name": area.name if area else area_id,
                        "floor_id": area_floor_id,
                        "level": floor.level if floor else None,
                        "area_m2": data["area_m2"],
                        "base_height": base,
                        "height": top,
                    },
                }
            )
        return {"type": "FeatureCollection", "features": features}

    def query_point(self, lon: float, lat: float, floor_id: str | None = None) -> str | None:
        """Return the smallest area containing the point, optionally on one floor."""
        matches = [
            (data["area_m2"], area_id)
            for area_id, data in self.store.areas.items()
            if (floor_id is None or self._floor_of(area_id) == floor_id)
            and polygon_contains(data["polygon"], lon, lat)
        ]
        return min(matches)[1] if matches else None

    def adjacent_areas(self, area_id: str) -> list[str]:
        """Return the areas on the same floor sharing a wall centreline with an area."""
        if (data := self.store.areas.get(area_id)) is None:
            return []
        floor_id = self._floor_of(area_id)
        return sorted(
            other_id
            for other_id, other in self.store.areas.items()
            if other_id != area_id
            and self._floor_of(other_id) == floor_id
            and shared_edge_length_m(data["polygon"], other["polygon"], ADJACENCY_TOLERANCE_M)
            >= ADJACENCY_MIN_SHARED_M
        )
