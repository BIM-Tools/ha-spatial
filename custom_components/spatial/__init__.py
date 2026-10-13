"""Spatial: The canonical spatial data model for Home Assistant."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .coordinator import SpatialCoordinator
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type SpatialConfigEntry = ConfigEntry[SpatialCoordinator]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Spatial integration."""
    async_register_websocket_commands(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: SpatialConfigEntry) -> bool:
    """Set up Spatial from a config entry."""
    coordinator = SpatialCoordinator(hass)
    await coordinator.async_setup()
    entry.runtime_data = coordinator
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SpatialConfigEntry) -> bool:
    """Unload a Spatial config entry."""
    entry.runtime_data.async_teardown()
    return True
