"""Proves Spatial can be added from the UI, once."""

from unittest.mock import patch

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.spatial.const import DOMAIN


async def test_step_user_show_form(hass: HomeAssistant) -> None:
    """Test initial form is shown when user starts setup."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"


async def test_step_user_create_entry(hass: HomeAssistant) -> None:
    """Test entry creation when user confirms setup."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    with patch(
        "custom_components.spatial.async_setup_entry", return_value=True
    ) as mock_setup_entry:
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
        await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Spatial"
    assert len(mock_setup_entry.mock_calls) == 1


async def test_step_user_already_configured(hass: HomeAssistant) -> None:
    """Test flow aborts if Spatial is already configured."""
    MockConfigEntry(domain=DOMAIN, title="Spatial").add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"
