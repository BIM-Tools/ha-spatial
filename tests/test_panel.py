"""Tests for the panel registration."""

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.spatial.const import DOMAIN


async def setup_entry(hass: HomeAssistant) -> MockConfigEntry:
    """Set up the integration with a config entry."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_panel_registered_for_admins(hass: HomeAssistant) -> None:
    """The panel is registered for admins, without a sidebar entry."""
    await setup_entry(hass)

    panel = hass.data["frontend_panels"]["spatial"]
    assert panel.config_panel_domain == DOMAIN
    assert panel.require_admin
    assert panel.sidebar_title is None


async def test_panel_removed_on_unload_and_back_on_setup(hass: HomeAssistant) -> None:
    """Unloading removes the panel and setting up again brings it back."""
    entry = await setup_entry(hass)

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert "spatial" not in hass.data["frontend_panels"]

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert "spatial" in hass.data["frontend_panels"]


async def test_bundle_is_served(hass: HomeAssistant, hass_client: ClientSessionGenerator) -> None:
    """The panel bundle is served from the static path."""
    await setup_entry(hass)

    client = await hass_client()
    response = await client.get("/spatial_static/spatial-panel.js")
    assert response.status == 200
