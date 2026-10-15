"""Gives Home Assistant areas a footprint on the map, with a panel, a card and an API."""

from __future__ import annotations

import hashlib
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

FRONTEND_PATH = Path(__file__).parent / "frontend"

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type SpatialConfigEntry = ConfigEntry[SpatialCoordinator]


def _bundle_version(bundle: Path, fallback: str) -> str:
    """Return a short content hash of the bundle, or the fallback before the first build."""
    try:
        return hashlib.sha256(bundle.read_bytes()).hexdigest()[:8]
    except FileNotFoundError:
        return fallback


async def _module_url(hass: HomeAssistant, name: str) -> str:
    """Return the URL of a bundle; its content hash makes browsers fetch every rebuild."""
    integration = await async_get_integration(hass, DOMAIN)
    version = await hass.async_add_executor_job(
        _bundle_version, FRONTEND_PATH / name, str(integration.version)
    )
    return f"{STATIC_URL}/{name}?v={version}"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Spatial integration."""
    async_register_websocket_commands(hass)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(FRONTEND_PATH), cache_headers=False)]
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: SpatialConfigEntry) -> bool:
    """Set up Spatial from a config entry."""
    coordinator = SpatialCoordinator(hass)
    await coordinator.async_setup()
    entry.runtime_data = coordinator
    # On every page, so the card is there for dashboards; it is small and loads
    # the panel bundle only when a card is created.
    coordinator.card_url = await _module_url(hass, "spatial-card.js")
    frontend.add_extra_js_url(hass, coordinator.card_url)
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
    frontend.remove_extra_js_url(hass, entry.runtime_data.card_url)
    await entry.runtime_data.async_teardown()
    return True
