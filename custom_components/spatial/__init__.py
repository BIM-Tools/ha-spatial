"""Spatial: room footprints for Home Assistant areas."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .const import DOMAIN, PANEL_COMPONENT, PANEL_URL_PATH, STATIC_URL
from .coordinator import SpatialCoordinator
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type SpatialConfigEntry = ConfigEntry[SpatialCoordinator]


async def _module_url(hass: HomeAssistant, name: str) -> str:
    """Return the URL of a bundle; the version makes browsers fetch a new release."""
    integration = await async_get_integration(hass, DOMAIN)
    return f"{STATIC_URL}/{name}?v={integration.version}"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Spatial integration."""
    async_register_websocket_commands(hass)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), cache_headers=False)]
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: SpatialConfigEntry) -> bool:
    """Set up Spatial from a config entry."""
    coordinator = SpatialCoordinator(hass)
    await coordinator.async_setup()
    entry.runtime_data = coordinator
    # On every page, so the card is there for dashboards; it is small and loads
    # the panel bundle only when a card is created.
    frontend.add_extra_js_url(hass, await _module_url(hass, "spatial-card.js"))
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        module_url=await _module_url(hass, "spatial-panel.js"),
        require_admin=True,
        config_panel_domain=DOMAIN,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SpatialConfigEntry) -> bool:
    """Unload a Spatial config entry."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    frontend.remove_extra_js_url(hass, await _module_url(hass, "spatial-card.js"))
    await entry.runtime_data.async_teardown()
    return True
