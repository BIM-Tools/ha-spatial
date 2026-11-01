"""Lets users add Spatial from the UI and change the few settings that rarely change."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv

from .const import CONF_GEOCODE_URL, DEFAULT_GEOCODE_URL, DOMAIN


class SpatialConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Spatial."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle the initial user setup step."""
        if user_input is not None:
            return self.async_create_entry(title="Spatial", data={})
        return self.async_show_form(step_id="user")

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> SpatialOptionsFlow:
        """Return the options flow."""
        return SpatialOptionsFlow()


class SpatialOptionsFlow(OptionsFlow):
    """Edit the options; every field is read per use, so no reload is needed."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show the options and save them when they are valid."""
        options = {CONF_GEOCODE_URL: DEFAULT_GEOCODE_URL, **self.config_entry.options}
        errors: dict[str, str] = {}
        if user_input is not None:
            options = {**options, **user_input}
            options[CONF_GEOCODE_URL] = options[CONF_GEOCODE_URL].strip()
            try:
                cv.url(options[CONF_GEOCODE_URL])
            except vol.Invalid:
                errors[CONF_GEOCODE_URL] = "invalid_url"
            if not errors:
                return self.async_create_entry(data=options)
        schema = vol.Schema(
            {vol.Required(CONF_GEOCODE_URL, default=options[CONF_GEOCODE_URL]): str}
        )
        # Home Assistant types form schemas as probatio; plain voluptuous ones still work.
        return self.async_show_form(
            step_id="init",
            data_schema=schema,  # type: ignore[arg-type]
            errors=errors,
        )
