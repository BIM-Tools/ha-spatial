"""Keeps spatial data in step with the area and floor registries and answers queries."""

from __future__ import annotations

import hashlib
from typing import Any, TypedDict

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr
from homeassistant.helpers.json import json_bytes_sorted

from .const import (
    ADJACENCY_MIN_SHARED_M,
    ADJACENCY_TOLERANCE_M,
    BOT_SPACE,
    DEFAULT_FLOOR_HEIGHT_M,
    EVENT_SPATIAL_UPDATED,
    JSONFG_CORE,
    JSONFG_TYPES_SCHEMAS,
    NET_INSET_M,
    REV_LENGTH,
    ROOM_PROPERTY_NAMES,
    SITE_FIELD_NAMES,
)
from .geometry import net_area_m2, overlap_area_m2, polygon_contains, shared_edge_length_m
from .store import AreaSpatial, Site, SpatialStore, new_area


class SiteView(TypedDict):
    """The site as clients read it: the stored fields plus the derived centre and rev."""

    lon: float
    lat: float
    bearing_deg: float | None
    origin: list[float] | None
    outline: dict[str, Any] | None
    rev: str


def _net_size(polygon: dict[str, Any]) -> float:
    """Return the net area in m² of a footprint, computed on every read."""
    return round(net_area_m2(polygon, NET_INSET_M), 2)


def content_rev(entry: AreaSpatial | Site) -> str:
    """Return a short hash of an entry, so a client can tell whether it changed since a read.

    Derived from the content, never stored: equal content always has the same rev,
    whoever wrote it, including restores and imports.
    """
    return hashlib.sha256(json_bytes_sorted(entry)).hexdigest()[:REV_LENGTH]


class SpatialCoordinator:
    """Keeps area footprints and floor dimensions in sync with the registries."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the coordinator."""
        self.hass = hass
        self.store = SpatialStore(hass)
        self._unsubscribe: list[Any] = []
        self.card_url = ""

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

    def area_rev(self, area_id: str) -> str | None:
        """Return the rev of an area's entry, or None without a footprint."""
        entry = self.store.areas.get(area_id)
        return content_rev(entry) if entry is not None else None

    def site_rev(self) -> str:
        """Return the rev of the site."""
        return content_rev(self.store.site)

    def conflicts(
        self, expected_area_revs: dict[str, str | None], expected_site_rev: str | None
    ) -> list[str]:
        """Return the area ids, and "site", whose rev differs from the expected one."""
        changed = sorted(
            area_id
            for area_id, expected in expected_area_revs.items()
            if self.area_rev(area_id) != expected
        )
        if expected_site_rev is not None and self.site_rev() != expected_site_rev:
            changed.append("site")
        return changed

    @callback
    def async_apply_change(
        self,
        polygons: dict[str, dict[str, Any] | None],
        site_fields: dict[str, Any],
        room_properties: dict[str, dict[str, Any]],
    ) -> dict[str, float]:
        """Set or remove (None) footprints, room properties and site fields in one change.

        Return the m² of the footprints set. Fields not given are kept. Room
        properties apply to areas that have a footprint after the polygons are set.
        """
        sizes: dict[str, float] = {}
        for area_id, polygon in polygons.items():
            if polygon is None:
                self.store.areas.pop(area_id, None)
                continue
            sizes[area_id] = _net_size(polygon)
            if (entry := self.store.areas.get(area_id)) is not None:
                entry["polygon"] = polygon
            else:
                self.store.areas[area_id] = new_area(polygon)
        for area_id, fields in room_properties.items():
            entry = self.store.areas[area_id]
            for name in ROOM_PROPERTY_NAMES:
                if name in fields:
                    entry[name] = fields[name]
        for key in SITE_FIELD_NAMES:
            if key in site_fields:
                self.store.site[key] = site_fields[key]
        self._changed()
        return sizes

    @callback
    def async_update_floor(self, floor_id: str, fields: dict[str, float | None]) -> None:
        """Set the given fields of a floor (None clears one) and keep the others."""
        floor = self.store.floors.setdefault(floor_id, {"elevation_m": None, "height_m": None})
        for key in ("elevation_m", "height_m"):
            if key in fields:
                floor[key] = fields[key]
        self._changed()

    def get_site(self) -> SiteView:
        """Return the site: the centre of the bounding box, the stored fields and the rev.

        Custom code. Computed on read, so it follows every edit. The box covers the
        footprints, else the outline, and is taken in lon/lat degrees, which is
        accurate enough at building scale but not across the antimeridian. Without
        either the centre is the home location.
        """
        outline = self.store.site["outline"]
        rings = [data["polygon"]["coordinates"][0] for data in self.store.areas.values()]
        if not rings and outline:
            rings = [outline["coordinates"][0]]
        points = [position for ring in rings for position in ring]
        if not points:
            lon, lat = self.hass.config.longitude, self.hass.config.latitude
        else:
            lons, lats = [p[0] for p in points], [p[1] for p in points]
            lon, lat = (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2
        return {
            "lon": lon,
            "lat": lat,
            "bearing_deg": self.store.site["bearing_deg"],
            "origin": self.store.site["origin"],
            "outline": outline,
            "rev": self.site_rev(),
        }

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

    def _floors_above(self, floor_id: str | None) -> list[str]:
        """Return the floors with a higher level than a floor, lowest first.

        A floor without a level has no floors above it, and a floor without a
        level is above none. Floors on the same level are ordered by floor_id.
        """
        floor_registry = fr.async_get(self.hass)
        floor = floor_registry.async_get_floor(floor_id) if floor_id else None
        if floor is None or floor.level is None:
            return []
        base_level = floor.level
        above = sorted(
            (other.level, other.floor_id)
            for other in floor_registry.async_list_floors()
            if other.level is not None and other.level > base_level
        )
        return [other_floor_id for _, other_floor_id in above]

    def max_floors_up(self, area_id: str) -> int:
        """Return how many floors an area can reach above its own floor."""
        return len(self._floors_above(self._floor_of(area_id)))

    def has_footprint(self, area_id: str) -> bool:
        """Return True if an area has a stored footprint."""
        return area_id in self.store.areas

    def _floor_ids(self, area_id: str, data: AreaSpatial) -> list[str]:
        """Return the floors an area occupies: its own and floors_up above it, lowest first.

        Empty for a site-level area without a floor. When floors above were
        deleted after floors_up was set, the area reaches only the remaining ones.
        """
        if (floor_id := self._floor_of(area_id)) is None:
            return []
        return [floor_id, *self._floors_above(floor_id)[: data["floors_up"]]]

    def _levels(self, area_id: str, data: AreaSpatial) -> set[str | None]:
        """Return the floors an area occupies, with None standing for the site level."""
        return set(self._floor_ids(area_id, data)) or {None}

    def _is_external(self, polygon: dict[str, Any]) -> bool:
        """Return True if most of a footprint lies outside the outline; False without one."""
        outline = self.store.site["outline"]
        if outline is None:
            return False
        return 2 * overlap_area_m2(polygon, outline) < net_area_m2(polygon, 0)

    def _on_facade(self, data: AreaSpatial) -> bool:
        """Return the override, else whether an edge of the footprint lies on the outline."""
        if data["on_facade_override"] is not None:
            return data["on_facade_override"]
        outline = self.store.site["outline"]
        return (
            outline is not None
            and shared_edge_length_m(data["polygon"], outline, ADJACENCY_TOLERANCE_M)
            >= ADJACENCY_MIN_SHARED_M
        )

    def get_geojson(self, floor_id: str | None = None) -> dict[str, Any]:
        """Return the area footprints, all or those occupying a floor, as a FeatureCollection."""
        area_registry = ar.async_get(self.hass)
        floor_registry = fr.async_get(self.hass)
        features = []
        for area_id, data in self.store.areas.items():
            floor_ids = self._floor_ids(area_id, data)
            if floor_id and floor_id not in floor_ids:
                continue
            area = area_registry.async_get_area(area_id)
            area_floor_id = area.floor_id if area else None
            floor = floor_registry.async_get_floor(area_floor_id) if area_floor_id else None
            base, _ = self._floor_bounds(area_floor_id)
            _, top = self._floor_bounds(floor_ids[-1] if floor_ids else None)
            features.append(
                {
                    "type": "Feature",
                    "id": area_id,
                    "featureType": BOT_SPACE,
                    "geometry": data["polygon"],
                    "properties": {
                        "area_id": area_id,
                        "name": area.name if area else area_id,
                        "floor_id": area_floor_id,
                        "level": floor.level if floor else None,
                        "area_m2": _net_size(data["polygon"]),
                        "base_m": base,
                        "top_m": top,
                        "floors_up": data["floors_up"],
                        "floor_ids": floor_ids,
                        "on_facade_override": data["on_facade_override"],
                        "on_facade": self._on_facade(data),
                        "is_external": self._is_external(data["polygon"]),
                        "rev": content_rev(data),
                    },
                }
            )
        return {
            "type": "FeatureCollection",
            "conformsTo": [JSONFG_CORE, JSONFG_TYPES_SCHEMAS],
            "features": features,
        }

    def query_point(self, lon: float, lat: float, floor_id: str | None = None) -> str | None:
        """Return the smallest area containing the point, optionally among those on one floor."""
        matches = [
            (_net_size(data["polygon"]), area_id)
            for area_id, data in self.store.areas.items()
            if (floor_id is None or floor_id in self._floor_ids(area_id, data))
            and polygon_contains(data["polygon"], lon, lat)
        ]
        return min(matches)[1] if matches else None

    def adjacent_areas(self, area_id: str) -> list[str]:
        """Return the areas sharing a wall centreline with an area on a floor both occupy.

        Site-level areas, without a floor, are adjacent only to each other.
        """
        if (data := self.store.areas.get(area_id)) is None:
            return []
        levels = self._levels(area_id, data)
        return sorted(
            other_id
            for other_id, other in self.store.areas.items()
            if other_id != area_id
            and not levels.isdisjoint(self._levels(other_id, other))
            and shared_edge_length_m(data["polygon"], other["polygon"], ADJACENCY_TOLERANCE_M)
            >= ADJACENCY_MIN_SHARED_M
        )
