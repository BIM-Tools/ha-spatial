"""Shares the setup and floor plan helpers, so tests read as floor plans and not as plumbing."""

from typing import Any

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN
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


async def setup_entry(hass: HomeAssistant) -> MockConfigEntry:
    """Set up the integration with a config entry."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def call(client: Any, **command: Any) -> dict[str, Any]:
    """Send a command and return the response message."""
    await client.send_json_auto_id(command)
    response: dict[str, Any] = await client.receive_json()
    return response


async def set_frame(hass: HomeAssistant, hass_ws_client: WebSocketGenerator) -> None:
    """Set the site origin and bearing, which drawing needs."""
    msg = await call(await hass_ws_client(hass), type="spatial/site/update", **FRAME)
    assert msg["success"], msg
