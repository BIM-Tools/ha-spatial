"""Keeps spatial data in step with the area and floor registries and answers queries."""

from __future__ import annotations

import hashlib
from typing import Any, NamedTuple, TypedDict

from homeassistant.components.websocket_api import ERR_INVALID_FORMAT
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr
from homeassistant.helpers.json import json_bytes_sorted

from .const import (
    BOT_SPACE,
    DEFAULT_FLOOR_HEIGHT_M,
    ERR_OUTSIDE_OUTLINE,
    EVENT_SPATIAL_UPDATED,
    JSONFG_CORE,
    JSONFG_TYPES_SCHEMAS,
    LATTICES,
    MIN_SHARED_EDGE_M,
    REV_LENGTH,
    ROOM_PROPERTY_NAMES,
    SITE_FIELD_NAMES,
    LatticeName,
    LatticeSize,
)
from .geometry import (
    OutlineRelation,
    Ring,
    SiteFrame,
    contains,
    net_area,
    outline_relation,
    shared_edge_length,
    validate_lattice_polygon,
)
from .store import AreaSpatial, Site, SpatialStore, lattice_of_unit_system, new_area


class SiteView(TypedDict):
    """The site as clients read it: the stored fields plus the derived centre and rev."""

    lon: float
    lat: float
    bearing_deg: float | None
    origin: list[float] | None
    lattice: LatticeName | None
    outline: dict[str, Any] | None
    rev: str


class _SiteGeometry(NamedTuple):
    """The frame of a site with an origin, bearing and lattice, and its outline on the lattice."""

    frame: SiteFrame
    lattice: LatticeSize
    outline: list[Ring] | None


class _Footprint(NamedTuple):
    """A footprint read on the lattice and every fact derived from it."""

    corners: list[Ring]
    geometry: dict[str, Any]
    net_m2: float
    facade_m: float
    relation: OutlineRelation | None


def content_rev(entry: AreaSpatial | Site) -> str:
    """Return a short hash of an entry, so a client can tell whether it changed since a read.

    Derived from the content, never stored: equal content always has the same rev,
    whoever wrote it, including restores and imports.
    """
    return hashlib.sha256(json_bytes_sorted(entry)).hexdigest()[:REV_LENGTH]


def _site_geometry(site: Site) -> _SiteGeometry | None:
    """Return the site's frame and lattice outline; None until origin and bearing are set."""
    if site["origin"] is None or site["bearing_deg"] is None or site["lattice"] is None:
        return None
    lattice = LATTICES[site["lattice"]]
    frame = SiteFrame(site["origin"], site["bearing_deg"], lattice.unit_m)
    outline = frame.snap(site["outline"]) if site["outline"] else None
    return _SiteGeometry(frame, lattice, outline)


def _measure(
    polygon: dict[str, Any], on_facade_override: bool | None, site: _SiteGeometry
) -> _Footprint:
    """Return a footprint snapped to the lattice with its net area, facade length and relation.

    Pieces on the outline lose half an exterior wall, unless the room is marked
    as not on the facade.
    """
    lattice, outline = site.lattice, site.outline
    corners = site.frame.snap(polygon)
    exterior_inset = (
        lattice.interior_inset_units
        if on_facade_override is False
        else lattice.exterior_inset_units
    )
    unit_m = float(lattice.unit_m)
    return _Footprint(
        corners,
        site.frame.to_polygon(corners),
        net_area(corners, outline, lattice.interior_inset_units, exterior_inset) * unit_m * unit_m,
        shared_edge_length(corners, outline) * unit_m if outline else 0.0,
        outline_relation(corners, outline) if outline else None,
    )


class SpatialCoordinator:
    """Keeps area footprints and floor dimensions in sync with the registries."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the coordinator."""
        self.hass = hass
        self.store = SpatialStore(hass)
        self._unsubscribe: list[Any] = []
        self._site_geometry_by_rev: tuple[str, _SiteGeometry | None] | None = None
        self._footprint_by_area: dict[str, tuple[str, str, _Footprint]] = {}
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
        """Drop the dimensions of a removed floor; announce every floor change.

        Any floor change can change the floors a room reaching up occupies.
        """
        if event.data["action"] == "remove" and event.data["floor_id"] in self.store.floors:
            del self.store.floors[event.data["floor_id"]]
            self._changed()
        else:
            self.hass.bus.async_fire(EVENT_SPATIAL_UPDATED)

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

    def _site_after(self, site_fields: dict[str, Any]) -> Site:
        """Return the site with the given fields set; the first origin also fixes the lattice."""
        site = self.store.site.copy()
        for key in SITE_FIELD_NAMES:
            if key in site_fields:
                site[key] = site_fields[key]
        if site["origin"] is not None and site["lattice"] is None:
            site["lattice"] = lattice_of_unit_system(self.hass)
        return site

    def change_problem(
        self,
        polygons: dict[str, dict[str, Any] | None],
        site_fields: dict[str, Any],
        room_properties: dict[str, dict[str, Any]],
    ) -> tuple[str, str] | None:
        """Return the error code and message that reject a change, or None if it can be applied.

        Footprints and an outline need the site frame, and are checked on the
        lattice as they will be read. Indoor rooms may not extend beyond the
        outline: the rooms written, or all rooms when the outline or the frame
        changes (both move what the lattice reads), must lie inside it or outside
        it. Rooms written must keep a net area.
        """
        written = {area_id: p for area_id, p in polygons.items() if p is not None}
        new_outline = site_fields.get("outline")
        site_after = self._site_after(site_fields)
        site = _site_geometry(site_after)
        if site is None:
            if written or new_outline is not None:
                return ERR_INVALID_FORMAT, "Set the site origin and bearing before drawing"
            return None
        to_validate = [(area_id, site.frame.snap(polygon)) for area_id, polygon in written.items()]
        if site.outline is not None and new_outline is not None:
            to_validate.append(("outline", site.outline))
        for name, corners in to_validate:
            try:
                validate_lattice_polygon(corners, site.lattice.grid_units)
            except ValueError as err:
                return ERR_INVALID_FORMAT, f"{err} ({name})"

        rooms = {area_id: entry["polygon"] for area_id, entry in self.store.areas.items()}
        for area_id, polygon in polygons.items():
            if polygon is None:
                rooms.pop(area_id, None)
            else:
                rooms[area_id] = polygon
        frame_changed = any(
            site_after[key] != self.store.site[key] for key in ("origin", "bearing_deg", "lattice")
        )
        checked = list(rooms) if new_outline is not None or frame_changed else list(written)
        footprints = {
            area_id: _measure(rooms[area_id], self._override_after(area_id, room_properties), site)
            for area_id in checked
        }
        if beyond := sorted(
            area_id for area_id, footprint in footprints.items() if footprint.relation == "crossing"
        ):
            return ERR_OUTSIDE_OUTLINE, f"Beyond the building outline: {', '.join(beyond)}"
        if empty := sorted(area_id for area_id in written if footprints[area_id].net_m2 <= 0):
            return ERR_INVALID_FORMAT, f"No net area: {', '.join(empty)}"
        return None

    def _override_after(
        self, area_id: str, room_properties: dict[str, dict[str, Any]]
    ) -> bool | None:
        """Return the on_facade_override an area will have after a change."""
        fields = room_properties.get(area_id, {})
        if "on_facade_override" in fields:
            override: bool | None = fields["on_facade_override"]
            return override
        entry = self.store.areas.get(area_id)
        return entry["on_facade_override"] if entry else None

    @callback
    def async_apply_change(
        self,
        polygons: dict[str, dict[str, Any] | None],
        site_fields: dict[str, Any],
        room_properties: dict[str, dict[str, Any]],
    ) -> dict[str, float | None]:
        """Set or remove (None) footprints, room properties and site fields in one change.

        Return the net m² of the footprints set. Fields not given are kept. Room
        properties apply to areas that have a footprint after the polygons are set.
        """
        self.store.site.update(self._site_after(site_fields))
        for area_id, polygon in polygons.items():
            if polygon is None:
                self.store.areas.pop(area_id, None)
            elif (entry := self.store.areas.get(area_id)) is not None:
                entry["polygon"] = polygon
            else:
                self.store.areas[area_id] = new_area(polygon)
        for area_id, fields in room_properties.items():
            entry = self.store.areas[area_id]
            for name in ROOM_PROPERTY_NAMES:
                if name in fields:
                    entry[name] = fields[name]
        self._changed()
        return {
            area_id: self._area_m2(area_id)
            for area_id, polygon in polygons.items()
            if polygon is not None
        }

    @callback
    def async_update_floor(self, floor_id: str, fields: dict[str, float | None]) -> None:
        """Set the given fields of a floor (None clears one) and keep the others."""
        floor = self.store.floors.setdefault(floor_id, {"elevation_m": None, "height_m": None})
        for key in ("elevation_m", "height_m"):
            if key in fields:
                floor[key] = fields[key]
        self._changed()

    def _site_geometry(self) -> _SiteGeometry | None:
        """Return the site's frame and lattice outline, kept until the site rev changes."""
        site_rev = self.site_rev()
        if self._site_geometry_by_rev is None or self._site_geometry_by_rev[0] != site_rev:
            self._site_geometry_by_rev = (site_rev, _site_geometry(self.store.site))
        return self._site_geometry_by_rev[1]

    def _footprint(self, area_id: str) -> _Footprint | None:
        """Return an area's footprint on the lattice, or None without a frame."""
        site = self._site_geometry()
        return self._footprint_on(area_id, site) if site else None

    def _footprint_on(self, area_id: str, site: _SiteGeometry) -> _Footprint:
        """Return an area's footprint on the lattice of the current site.

        Kept per area until its rev or the site rev changes, as it is the costliest
        part of a read.
        """
        data = self.store.areas[area_id]
        revs = (content_rev(data), self.site_rev())
        cached = self._footprint_by_area.get(area_id)
        if cached is not None and cached[:2] == revs:
            return cached[2]
        footprint = _measure(data["polygon"], data["on_facade_override"], site)
        self._footprint_by_area[area_id] = (*revs, footprint)
        return footprint

    def _area_m2(self, area_id: str) -> float | None:
        """Return an area's net m² to two decimals, or None without a frame."""
        footprint = self._footprint(area_id)
        return round(footprint.net_m2, 2) if footprint else None

    def _geometry(self, area_id: str) -> dict[str, Any]:
        """Return an area's footprint as read: on the lattice, or as stored without a frame."""
        footprint = self._footprint(area_id)
        return footprint.geometry if footprint else self.store.areas[area_id]["polygon"]

    def get_site(self) -> SiteView:
        """Return the site: the centre of the bounding box, the stored fields and the rev.

        Custom code. Computed on read, so it follows every edit. The box covers the
        footprints, else the outline, as read, and is taken in lon/lat degrees,
        which is accurate enough at building scale but not across the antimeridian.
        Without either the centre is the home location.
        """
        site = self._site_geometry()
        outline = self.store.site["outline"]
        if site is not None and site.outline is not None:
            outline = site.frame.to_polygon(site.outline)
        rings = [self._geometry(area_id)["coordinates"][0] for area_id in self.store.areas]
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
            "lattice": self.store.site["lattice"],
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

    def _on_facade(self, area_id: str) -> bool:
        """Return the override, else whether the footprint shares enough of the outline."""
        if (override := self.store.areas[area_id]["on_facade_override"]) is not None:
            return override
        footprint = self._footprint(area_id)
        return footprint is not None and footprint.facade_m >= MIN_SHARED_EDGE_M

    def _is_external(self, area_id: str) -> bool:
        """Return True if the footprint lies outside the outline; False without one."""
        footprint = self._footprint(area_id)
        return footprint is not None and footprint.relation == "outside"

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
                    "geometry": self._geometry(area_id),
                    "properties": {
                        "area_id": area_id,
                        "name": area.name if area else area_id,
                        "floor_id": area_floor_id,
                        "level": floor.level if floor else None,
                        "area_m2": self._area_m2(area_id),
                        "base_m": base,
                        "top_m": top,
                        "floors_up": data["floors_up"],
                        "floor_ids": floor_ids,
                        "on_facade_override": data["on_facade_override"],
                        "on_facade": self._on_facade(area_id),
                        "is_external": self._is_external(area_id),
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
        """Return the smallest area containing the point, optionally among those on one floor.

        Without a frame no footprint can be read, so no area matches.
        """
        if (site := self._site_geometry()) is None:
            return None
        point = site.frame.to_lattice_units(lon, lat)
        matches = [
            (footprint.net_m2, area_id)
            for area_id, data in self.store.areas.items()
            if (floor_id is None or floor_id in self._floor_ids(area_id, data))
            and contains((footprint := self._footprint_on(area_id, site)).corners, point)
        ]
        return min(matches)[1] if matches else None

    def adjacent_areas(self, area_id: str) -> list[str]:
        """Return the areas sharing a wall axis with an area on a floor both occupy.

        Site-level areas, without a floor, are adjacent only to each other. Without
        a frame no footprint can be read, so no area is adjacent.
        """
        if (data := self.store.areas.get(area_id)) is None or (
            site := self._site_geometry()
        ) is None:
            return []
        levels = self._levels(area_id, data)
        corners = self._footprint_on(area_id, site).corners
        unit_m = float(site.lattice.unit_m)
        return sorted(
            other_id
            for other_id, other in self.store.areas.items()
            if other_id != area_id
            and not levels.isdisjoint(self._levels(other_id, other))
            and shared_edge_length(corners, self._footprint_on(other_id, site).corners) * unit_m
            >= MIN_SHARED_EDGE_M
        )
