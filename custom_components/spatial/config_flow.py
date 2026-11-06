"""Lets users add Spatial from the UI, and later reach the editor and its one setting."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback

from .address_search import is_allowed_search_server, search_server
from .const import CONF_ADDRESS_SEARCH_SERVER, DOMAIN, PANEL_URL_PATH

# Passed as a placeholder because hassfest rejects URLs in translation strings.
EDITOR_LINK_PLACEHOLDERS = {"panel_url": f"/{PANEL_URL_PATH}"}


class SpatialConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Spatial."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle the initial user setup step."""
        if user_input is not None:
            return self.async_create_entry(
                title="Spatial", data={}, description_placeholders=EDITOR_LINK_PLACEHOLDERS
            )
        return self.async_show_form(step_id="user")

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> SpatialOptionsFlow:
        """Return the form behind Configure."""
        return SpatialOptionsFlow()


class SpatialOptionsFlow(OptionsFlow):
    """Link to the editor and hold the address search server, read on every search."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show the form, and save the server when it is allowed."""
        server = search_server(self.config_entry.options)
        errors: dict[str, str] = {}
        if user_input is not None:
            server = user_input[CONF_ADDRESS_SEARCH_SERVER].strip().rstrip("/")
            if is_allowed_search_server(server):
                return self.async_create_entry(data={CONF_ADDRESS_SEARCH_SERVER: server})
            errors[CONF_ADDRESS_SEARCH_SERVER] = "invalid_server"
        schema = vol.Schema({vol.Required(CONF_ADDRESS_SEARCH_SERVER, default=server): str})
        # Home Assistant types form schemas as probatio; plain voluptuous ones still work.
        return self.async_show_form(
            step_id="init",
            data_schema=schema,  # type: ignore[arg-type]
            errors=errors,
            description_placeholders=EDITOR_LINK_PLACEHOLDERS,
        )
