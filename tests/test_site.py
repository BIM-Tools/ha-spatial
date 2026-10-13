"""Tests for the site anchor."""

from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial."""
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
    """Test the site anchor defaults to the home location, facing north."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site")
    assert msg["result"] == {
        "lon": hass.config.longitude,
        "lat": hass.config.latitude,
        "bearing_deg": 0.0,
    }


async def test_update_site_persists(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test the site anchor can be set and survives a reload."""
    client = await hass_ws_client(hass)
    msg = await _call(
        client, type="spatial/site/update", lon=4.89512, lat=52.37012, bearing_deg=12.5
    )
    assert msg["success"], msg

    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    msg = await _call(client, type="spatial/site")
    assert msg["result"] == {"lon": 4.89512, "lat": 52.37012, "bearing_deg": 12.5}


@pytest.mark.parametrize(
    "fields",
    [
        {"lon": 4.9, "lat": 91.0},
        {"lon": 181.0, "lat": 52.0},
        {"lon": 4.9, "lat": 52.0, "bearing_deg": 360.0},
    ],
    ids=["lat_out_of_range", "lon_out_of_range", "bearing_out_of_range"],
)
async def test_update_site_validates(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, fields: dict[str, float]
) -> None:
    """Test invalid anchors are rejected."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", **fields)
    assert msg["error"]["code"] == "invalid_format"


async def test_update_site_requires_admin(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, hass_admin_user: MockUser
) -> None:
    """Test non-admin users cannot move the site anchor but can read it."""
    hass_admin_user.groups = []
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", lon=4.9, lat=52.0)
    assert msg["error"]["code"] == "unauthorized"
    msg = await _call(client, type="spatial/site")
    assert msg["success"], msg
