"""Proves address search asks the search server politely and never leaks the query."""

import logging
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from aiohttp import ClientError
from homeassistant.core import HomeAssistant
from pytest_homeassistant.common import MockUser
from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker
from pytest_homeassistant.typing import WebSocketGenerator

from custom_components.spatial.address_search import (
    AddressSearchError,
    is_allowed_search_server,
    parse_results,
)
from custom_components.spatial.const import ADDRESS_SEARCH_USER_AGENT, DOMAIN

from .common import call, setup_entry

QUERY = "Example Street 1, Exampletown"
SEARCH_URL = "https://nominatim.openstreetmap.org/search"

TOWER = {
    "display_name": "Tower, Square, Town",
    "lat": "52.0905",
    "lon": "5.1214",
    "boundingbox": ["52.0904", "52.0906", "5.1212", "5.1216"],
}


def _logged_outside_the_websocket(caplog: pytest.LogCaptureFixture) -> str:
    """Return the log, without Home Assistant's websocket debug log of every message."""
    return "\n".join(
        record.getMessage()
        for record in caplog.records
        if record.levelno > logging.DEBUG
        or not record.name.startswith("homeassistant.components.websocket_api")
    )


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> None:
    """Set up Spatial with its home near the test places."""
    hass.config.longitude, hass.config.latitude = 5.04, 52.03
    await setup_entry(hass)


@pytest.mark.parametrize(
    ("payload", "places"),
    [
        (
            [TOWER],
            [
                {
                    "label": "Tower, Square, Town",
                    "lat": 52.0905,
                    "lon": 5.1214,
                    "bbox": [5.1212, 52.0904, 5.1216, 52.0906],
                }
            ],
        ),
        (
            [{**TOWER, "boundingbox": None}],
            [{"label": "Tower, Square, Town", "lat": 52.0905, "lon": 5.1214, "bbox": None}],
        ),
        ([{**TOWER, "lat": None}, {"display_name": "No position"}, "text"], []),
        ([], []),
    ],
    ids=["with box", "without box", "without position", "nothing found"],
)
def test_parse_results(payload: Any, places: list[dict[str, Any]]) -> None:
    """Test a Nominatim answer becomes places with numbers and a west, south, east, north box."""
    assert parse_results(payload) == places


def test_parse_results_refuses_a_non_list() -> None:
    """Test an answer that is not a list of places is an error, not an empty result."""
    with pytest.raises(AddressSearchError):
        parse_results({"error": "busy"})


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://search.example.org", True),
        ("https://search.example.org:8443/nominatim", True),
        ("http://192.168.1.20:8080", True),
        ("http://10.0.0.5", True),
        ("http://127.0.0.1:8080", True),
        ("http://169.254.10.1", True),
        ("http://[fd00::20]/nominatim", True),
        ("http://[::1]", True),
        ("http://nominatim.local", True),
        ("http://nominatim:8080", True),
        ("http://search.example.org", False),
        ("http://8.8.8.8", False),
        ("http://[2001:4860::8888]", False),
        ("nominatim.example.org", False),
        ("ftp://nominatim.local", False),
        ("javascript:alert(1)", False),
        ("https://", False),
        ("https://search.example.org:port", False),
        ("https://search.example.org/?q=x", False),
        ("https://search.example.org/#top", False),
        ("https://search example.org", False),
    ],
)
def test_is_allowed_search_server(url: str, allowed: bool) -> None:
    """Test https is allowed anywhere, plain http only for a host on the local network."""
    assert is_allowed_search_server(url) is allowed


async def test_search_returns_places_and_identifies_itself(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    aioclient_mock: AiohttpClientMocker,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Test a search sends the identifying agent, language and home bias, and logs nothing of it."""
    caplog.set_level(logging.DEBUG)
    aioclient_mock.get(SEARCH_URL, json=[TOWER])
    msg = await call(await hass_ws_client(hass), type="spatial/address/search", query=f" {QUERY} ")

    assert msg["success"], msg
    assert msg["result"] == {"places": parse_results([TOWER])}
    (_, url, _, headers) = aioclient_mock.mock_calls[0]
    assert headers["User-Agent"] == ADDRESS_SEARCH_USER_AGENT
    assert dict(url.query) == {
        "q": QUERY,
        "format": "jsonv2",
        "limit": "5",
        "accept-language": "en",
        "viewbox": "4.75,52.25,5.25,51.75",
    }
    assert QUERY not in _logged_outside_the_websocket(caplog)
    assert "Tower" not in _logged_outside_the_websocket(caplog)


@pytest.mark.parametrize("query", ["Zq", "   Zq   ", "Zq" * 101, 123])
async def test_search_refuses_a_bad_query(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    aioclient_mock: AiohttpClientMocker,
    caplog: pytest.LogCaptureFixture,
    query: Any,
) -> None:
    """Test a query is text of 3 to 200 characters trimmed, else nothing is sent or logged."""
    caplog.set_level(logging.DEBUG)
    msg = await call(await hass_ws_client(hass), type="spatial/address/search", query=query)
    assert msg["error"]["code"] == "invalid_format"
    assert aioclient_mock.call_count == 0
    assert "Zq" not in _logged_outside_the_websocket(caplog)


async def test_search_requires_admin(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_admin_user: MockUser,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Test non-admin users cannot send searches to the outside world."""
    hass_admin_user.groups = []
    msg = await call(await hass_ws_client(hass), type="spatial/address/search", query=QUERY)
    assert msg["error"]["code"] == "unauthorized"
    assert aioclient_mock.call_count == 0


@pytest.mark.parametrize(
    "answer",
    [
        {"status": 503},
        {"status": 429},
        {"exc": ClientError(f"failed for {QUERY}")},
        {"exc": TimeoutError()},
        {"text": "<html>busy</html>"},
        {"json": {"error": "busy"}},
    ],
    ids=["unavailable", "too many requests", "unreachable", "timeout", "not json", "not a list"],
)
async def test_search_failure_is_an_error_without_the_query(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    aioclient_mock: AiohttpClientMocker,
    caplog: pytest.LogCaptureFixture,
    answer: dict[str, Any],
) -> None:
    """Test an upstream failure returns search_failed with a reason, and nowhere the query."""
    caplog.set_level(logging.DEBUG)
    aioclient_mock.get(SEARCH_URL, **answer)
    msg = await call(await hass_ws_client(hass), type="spatial/address/search", query=QUERY)

    assert msg["error"]["code"] == "search_failed"
    assert msg["error"]["message"].startswith("The search server")
    assert QUERY not in msg["error"]["message"]
    assert QUERY not in _logged_outside_the_websocket(caplog)


async def test_searches_are_one_second_apart(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, aioclient_mock: AiohttpClientMocker
) -> None:
    """Test a search right after another waits out the second Nominatim asks for, failed or not."""
    aioclient_mock.get(SEARCH_URL, status=503)
    client = await hass_ws_client(hass)
    with (
        patch(
            "custom_components.spatial.address_search.monotonic", side_effect=[100.0, 100.25, 101.0]
        ),
        patch("custom_components.spatial.address_search.sleep", new=AsyncMock()) as sleep,
    ):
        await call(client, type="spatial/address/search", query=QUERY)
        sleep.assert_not_awaited()
        await call(client, type="spatial/address/search", query=QUERY)
    sleep.assert_awaited_once_with(0.75)
    assert aioclient_mock.call_count == 2


async def test_search_uses_the_configured_server(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, aioclient_mock: AiohttpClientMocker
) -> None:
    """Test a server set under Configure is asked, with no restart, instead of the public one."""
    [entry] = hass.config_entries.async_entries(DOMAIN)
    hass.config_entries.async_update_entry(
        entry, options={"address_search_server": "http://192.168.1.20:8080"}
    )
    aioclient_mock.get("http://192.168.1.20:8080/search", json=[TOWER])

    msg = await call(await hass_ws_client(hass), type="spatial/address/search", query=QUERY)

    assert msg["success"], msg
    assert aioclient_mock.call_count == 1
