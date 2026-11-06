"""Proves Spatial can be added from the UI, once, and Configure keeps to allowed servers."""

from unittest.mock import patch

import pytest
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant.common import MockConfigEntry

from custom_components.spatial.const import DOMAIN, PANEL_URL_PATH

SERVER = "address_search_server"


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
    assert result["description_placeholders"] == {"panel_url": f"/{PANEL_URL_PATH}"}
    assert len(mock_setup_entry.mock_calls) == 1


async def test_step_user_already_configured(hass: HomeAssistant) -> None:
    """Test flow aborts if Spatial is already configured."""
    MockConfigEntry(domain=DOMAIN, title="Spatial").add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_options_link_the_editor_and_offer_the_public_server(hass: HomeAssistant) -> None:
    """Test Configure links to the editor and shows the public server when none is set."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)

    result = await hass.config_entries.options.async_init(entry.entry_id)

    assert result["type"] is FlowResultType.FORM
    assert result["description_placeholders"] == {"panel_url": f"/{PANEL_URL_PATH}"}
    [field] = result["data_schema"].schema
    assert field == SERVER
    assert field.default() == "https://nominatim.openstreetmap.org"


@pytest.mark.parametrize(
    ("typed", "stored"),
    [
        (" https://search.example.org/ ", "https://search.example.org"),
        ("http://192.168.1.20:8080", "http://192.168.1.20:8080"),
    ],
)
async def test_options_save_an_allowed_server(hass: HomeAssistant, typed: str, stored: str) -> None:
    """Test https anywhere and http on the local network are saved, trimmed, and shown again."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {SERVER: typed})

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == {SERVER: stored}
    result = await hass.config_entries.options.async_init(entry.entry_id)
    [field] = result["data_schema"].schema
    assert field.default() == stored


@pytest.mark.parametrize(
    "typed",
    [
        "http://search.example.org",
        "nominatim.example.org",
    ],
)
async def test_options_refuse_a_server_that_is_not_allowed(hass: HomeAssistant, typed: str) -> None:
    """Test http to a public host and text without a scheme keep the form with the error."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {SERVER: typed})

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {SERVER: "invalid_server"}
    assert entry.options == {}
