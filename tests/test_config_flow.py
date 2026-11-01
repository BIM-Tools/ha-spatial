"""Proves Spatial can be added from the UI, once, and its options keep to valid servers."""

from unittest.mock import patch

import pytest
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


async def test_options_show_the_public_address_search_server(hass: HomeAssistant) -> None:
    """Test the options form offers the public Nominatim server when nothing is set."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"
    [field] = result["data_schema"].schema
    assert field == "geocode_url"
    assert field.default() == "https://nominatim.openstreetmap.org"


async def test_options_save_an_address_search_server(hass: HomeAssistant) -> None:
    """Test a local http server on the LAN is accepted and stored in the options."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"geocode_url": " http://192.168.1.20:8080/nominatim "}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == {"geocode_url": "http://192.168.1.20:8080/nominatim"}

    result = await hass.config_entries.options.async_init(entry.entry_id)
    [field] = result["data_schema"].schema
    assert field.default() == "http://192.168.1.20:8080/nominatim"


@pytest.mark.parametrize(
    "url", ["nominatim.example", "ftp://nominatim.example", "https://", "javascript:alert(1)"]
)
async def test_options_reject_a_server_that_is_no_http_url(hass: HomeAssistant, url: str) -> None:
    """Test anything but an http or https URL with a host is refused with a form error."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"geocode_url": url}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"geocode_url": "invalid_url"}
    assert entry.options == {}
