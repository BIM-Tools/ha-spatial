"""Websocket API for Spatial."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr

from .const import DOMAIN
from .coordinator import SpatialCoordinator
from .geometry import validate_polygon

POSITIVE_METRES = vol.All(vol.Coerce(float), vol.Range(min=0, min_included=False))


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register the websocket commands."""
    websocket_api.async_register_command(hass, ws_geojson)
    websocket_api.async_register_command(hass, ws_query_point)
    websocket_api.async_register_command(hass, ws_adjacent_areas)
    websocket_api.async_register_command(hass, ws_update_area_geometries)
    websocket_api.async_register_command(hass, ws_update_floor)
    websocket_api.async_register_command(hass, ws_site)
    websocket_api.async_register_command(hass, ws_update_site)


def _coordinator(hass: HomeAssistant) -> SpatialCoordinator:
    """Return the coordinator of the loaded config entry."""
    if not (entries := hass.config_entries.async_loaded_entries(DOMAIN)):
        raise HomeAssistantError("Spatial is not loaded")
    coordinator: SpatialCoordinator = entries[0].runtime_data
    return coordinator


def _area_exists(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> bool:
    """Return True if msg["area_id"] exists, else send a not_found error."""
    if ar.async_get(hass).async_get_area(msg["area_id"]) is not None:
        return True
    connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Area not found")
    return False


@websocket_api.websocket_command(
    {vol.Required("type"): "spatial/geojson", vol.Optional("floor_id"): str}
)
@callback
def ws_geojson(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return area footprints as a GeoJSON FeatureCollection."""
    connection.send_result(msg["id"], _coordinator(hass).get_geojson(msg.get("floor_id")))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "spatial/query_point",
        vol.Required("lon"): vol.Coerce(float),
        vol.Required("lat"): vol.Coerce(float),
        vol.Optional("floor_id"): str,
    }
)
@callback
def ws_query_point(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the area containing a coordinate."""
    area_id = _coordinator(hass).query_point(msg["lon"], msg["lat"], msg.get("floor_id"))
    connection.send_result(msg["id"], {"area_id": area_id})


@websocket_api.websocket_command(
    {vol.Required("type"): "spatial/area/adjacent", vol.Required("area_id"): str}
)
@callback
def ws_adjacent_areas(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the areas adjacent to an area."""
    if _area_exists(hass, connection, msg):
        area_ids = _coordinator(hass).adjacent_areas(msg["area_id"])
        connection.send_result(msg["id"], {"area_ids": area_ids})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "spatial/area/update_geometries",
        vol.Required("areas"): vol.All({str: vol.Any(None, validate_polygon)}, vol.Length(min=1)),
    }
)
@websocket_api.require_admin
@callback
def ws_update_area_geometries(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Set (polygon) or remove (null) the footprints of several areas at once.

    Everything is validated first: if any area is unknown, nothing changes.
    """
    area_registry = ar.async_get(hass)
    if missing := sorted(a for a in msg["areas"] if area_registry.async_get_area(a) is None):
        connection.send_error(
            msg["id"], websocket_api.ERR_NOT_FOUND, f"Areas not found: {', '.join(missing)}"
        )
        return
    area_m2 = _coordinator(hass).async_set_area_geometries(msg["areas"])
    connection.send_result(msg["id"], {"area_m2": area_m2})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "spatial/floor/update_spatial",
        vol.Required("floor_id"): str,
        vol.Optional("elevation_m"): vol.Coerce(float),
        vol.Optional("height_m"): POSITIVE_METRES,
    }
)
@websocket_api.require_admin
@callback
def ws_update_floor(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Set the elevation and height of a floor."""
    if fr.async_get(hass).async_get_floor(msg["floor_id"]) is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Floor not found")
        return
    _coordinator(hass).async_set_floor(msg["floor_id"], msg.get("elevation_m"), msg.get("height_m"))
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): "spatial/site"})
@callback
def ws_site(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the site centre and bearing."""
    connection.send_result(msg["id"], _coordinator(hass).get_site())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "spatial/site/update",
        vol.Required("bearing_deg"): vol.All(
            vol.Coerce(float), vol.Range(min=0, max=360, max_included=False)
        ),
    }
)
@websocket_api.require_admin
@callback
def ws_update_site(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Set the bearing of the site's x-axis, clockwise from north."""
    _coordinator(hass).async_set_site_bearing(msg["bearing_deg"])
    connection.send_result(msg["id"])
