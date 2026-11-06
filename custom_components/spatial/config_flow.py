"""Lets users add Spatial from the UI and go straight on to the editor."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, PANEL_URL_PATH

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
