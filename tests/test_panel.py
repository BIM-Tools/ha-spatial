"""Proves the panel and the card are registered and versioned for the browser."""

from pathlib import Path

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

import custom_components.spatial
from custom_components.spatial.const import DOMAIN, STATIC_URL


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


async def test_static_path_registered(hass: HomeAssistant) -> None:
    """The bundle folder is served under the static URL, built or not.

    Without the folder Home Assistant registers a single-file route instead, so the
    committed `.gitkeep` keeps it in place until the first build.
    """
    await setup_entry(hass)

    prefixes = {resource.get_info().get("prefix") for resource in hass.http.app.router.resources()}
    assert STATIC_URL in prefixes


async def test_card_module_added_while_set_up(hass: HomeAssistant) -> None:
    """Every frontend page loads the small card module while the entry is set up."""
    entry = await setup_entry(hass)

    def card_urls() -> list[str]:
        return [
            url
            for url in hass.data[DATA_EXTRA_MODULE_URL].urls
            if url.startswith(f"{STATIC_URL}/spatial-card.js?v=")
        ]

    assert len(card_urls()) == 1

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert card_urls() == []


async def test_module_url_follows_bundle_content(hass: HomeAssistant) -> None:
    """A rebuilt bundle gets a new URL, so browsers do not keep the old one."""
    bundle = Path(custom_components.spatial.__file__).parent / "frontend" / "spatial-card.js"

    def card_url() -> str:
        (url,) = [
            url
            for url in hass.data[DATA_EXTRA_MODULE_URL].urls
            if url.startswith(f"{STATIC_URL}/spatial-card.js?v=")
        ]
        return url

    try:
        bundle.write_text("first build")
        entry = await setup_entry(hass)
        first_url = card_url()

        assert await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()
        bundle.write_text("second build")
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

        assert card_url() != first_url
    finally:
        bundle.unlink(missing_ok=True)


async def test_card_url_removed_after_bundle_rebuilt_while_loaded(hass: HomeAssistant) -> None:
    """Unloading removes the card URL that setup registered, even after a rebuild."""
    bundle = Path(custom_components.spatial.__file__).parent / "frontend" / "spatial-card.js"

    try:
        bundle.write_text("first build")
        entry = await setup_entry(hass)

        bundle.write_text("second build")
        assert await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()

        assert not [url for url in hass.data[DATA_EXTRA_MODULE_URL].urls if "spatial-card" in url]
    finally:
        bundle.unlink(missing_ok=True)
