"""Tests for the site anchor."""

from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN

from .common import lonlat, rect


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial with two areas."""
    areas = ar.async_get(hass)
    areas.async_create("Kitchen")
    areas.async_create("Garden")
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _call(client: Any, **command: Any) -> dict[str, Any]:
    """Send a command and return the response message."""
    await client.send_json_auto_id(command)
    return await client.receive_json()


async def test_site_defaults_to_home_location(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test without footprints the site is the home location, facing north."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site")
    assert msg["result"] == {
        "lon": hass.config.longitude,
        "lat": hass.config.latitude,
        "bearing_deg": 0.0,
    }


async def test_site_centre_is_the_middle_of_all_footprints(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the centre is the middle of the combined bounds of all footprints."""
    client = await hass_ws_client(hass)
    areas = {"kitchen": rect(0, 0, 4, 3), "garden": rect(10, -6, 20, 0)}
    msg = await _call(client, type="spatial/area/update_geometries", areas=areas)
    assert msg["success"], msg

    msg = await _call(client, type="spatial/site")
    lon, lat = lonlat(10, -1.5)  # x from 0 to 20, y from -6 to 3
    assert msg["result"]["lon"] == pytest.approx(lon, abs=1e-9)
    assert msg["result"]["lat"] == pytest.approx(lat, abs=1e-9)
    assert msg["result"]["bearing_deg"] == 0.0


async def test_site_centre_follows_footprint_edits(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the centre moves when a footprint changes or is removed."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["lon"] == pytest.approx(lonlat(2, 0)[0], abs=1e-9)

    await _call(
        client, type="spatial/area/update_geometries", areas={"kitchen": rect(10, 0, 14, 3)}
    )
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["lon"] == pytest.approx(lonlat(12, 0)[0], abs=1e-9)
    assert msg["result"]["lat"] == pytest.approx(lonlat(0, 1.5)[1], abs=1e-9)

    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": None})
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["lon"] == hass.config.longitude


async def test_update_site_persists_bearing(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test the bearing can be set and survives a reload."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", bearing_deg=12.5)
    assert msg["success"], msg

    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    msg = await _call(client, type="spatial/site")
    assert msg["result"] == {
        "lon": hass.config.longitude,
        "lat": hass.config.latitude,
        "bearing_deg": 12.5,
    }


@pytest.mark.parametrize(
    "fields",
    [
        {"bearing_deg": 360.0},
        {"bearing_deg": -1.0},
        {"bearing_deg": 10.0, "lon": 4.9},
        {"bearing_deg": 10.0, "lat": 52.0},
    ],
    ids=["bearing_too_big", "bearing_negative", "lon_not_accepted", "lat_not_accepted"],
)
async def test_update_site_validates(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, fields: dict[str, float]
) -> None:
    """Test invalid input is rejected, including the removed lon and lat."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", **fields)
    assert msg["error"]["code"] == "invalid_format"


async def test_update_site_requires_admin(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, hass_admin_user: MockUser
) -> None:
    """Test non-admin users cannot set the bearing but can read the site."""
    hass_admin_user.groups = []
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", bearing_deg=10.0)
    assert msg["error"]["code"] == "unauthorized"
    msg = await _call(client, type="spatial/site")
    assert msg["success"], msg
