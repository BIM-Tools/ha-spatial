"""Builds test footprints in metres around a fixed origin, so tests read as floor plans."""

from typing import Any

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.geometry import metres_per_degree

ORIGIN_LON = 5.0
ORIGIN_LAT = 52.0
_M_PER_DEG_LON, _M_PER_DEG_LAT = metres_per_degree(ORIGIN_LAT)

# The site frame at the origin, facing north. Its lattice runs along the axes of
# rect(), so rectangles in whole lattice units read back exactly as written.
FRAME = {"origin": [ORIGIN_LON, ORIGIN_LAT], "bearing_deg": 0.0}


def lonlat(x: float, y: float) -> list[float]:
    """Return [lon, lat] for a point x metres east and y metres north of the origin."""
    return [ORIGIN_LON + x / _M_PER_DEG_LON, ORIGIN_LAT + y / _M_PER_DEG_LAT]


def rect(x0: float, y0: float, x1: float, y1: float) -> dict[str, Any]:
    """Return a GeoJSON Polygon for a rectangle given in metres from the origin."""
    ring = [lonlat(x0, y0), lonlat(x1, y0), lonlat(x1, y1), lonlat(x0, y1), lonlat(x0, y0)]
    return {"type": "Polygon", "coordinates": [ring]}


async def set_frame(hass: HomeAssistant, hass_ws_client: WebSocketGenerator) -> None:
    """Set the site origin and bearing, which drawing needs."""
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "spatial/site/update", **FRAME})
    msg = await client.receive_json()
    assert msg["success"], msg
