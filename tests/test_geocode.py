"""Proves the address search keeps to Nominatim's usage policy and never leaks the query."""

import asyncio
import logging
from http import HTTPStatus
from typing import Any
from unittest.mock import patch

import aiohttp
import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser
from pytest_homeassistant_custom_component.test_util.aiohttp import (
    AiohttpClientMocker,
    AiohttpClientMockResponse,
)
from pytest_homeassistant_custom_component.typing import WebSocketGenerator
from yarl import URL

from custom_components.spatial.const import DOMAIN

SEARCH_URL = "https://nominatim.openstreetmap.org/search"
# A fictional address: a real one would be personal data.
QUERY = "Voorbeeldstraat 1, Nergenshuizen"

PLACE = {
    "place_id": 1,
    "licence": "Data (c) OpenStreetMap contributors, ODbL 1.0",
    "osm_type": "way",
    "osm_id": 2,
    "lat": "52.0001",
    "lon": "5.0002",
    "category": "building",
    "type": "house",
    "display_name": "1, Voorbeeldstraat, Nergenshuizen",
    "boundingbox": ["51.9999", "52.0003", "5.0000", "5.0004"],
}


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial."""
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


class FakeClock:
    """Stands in for the monotonic clock; sleeping advances it instead of waiting."""

    def __init__(self) -> None:
        """Start at an arbitrary moment."""
        self.now = 1000.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        """Return the current fake time."""
        return self.now

    async def sleep(self, seconds: float) -> None:
        """Record the wait and move the clock on."""
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture(autouse=True)
def clock() -> Any:
    """Replace the time source of the rate limit, so tests never really wait."""
    fake = FakeClock()
    with (
        patch("custom_components.spatial.geocode.monotonic", fake.monotonic),
        patch("custom_components.spatial.geocode.sleep", fake.sleep),
    ):
        yield fake


def _logged_text(caplog: pytest.LogCaptureFixture) -> str:
    """Return what Spatial logged at any level and everything else logged at info or above.

    Home Assistant's own websocket debug log records every message; that is the
    admin's choice to enable and outside this integration.
    """
    return "\n".join(
        record.getMessage()
        for record in caplog.records
        if record.name.startswith("custom_components.spatial") or record.levelno > logging.DEBUG
    )


async def _call(client: Any, **command: Any) -> dict[str, Any]:
    """Send a command and return the response message."""
    await client.send_json_auto_id(command)
    return await client.receive_json()


async def test_results_are_trimmed_to_what_the_panel_needs(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, aioclient_mock: AiohttpClientMocker
) -> None:
    """Test each result has name, lat, lon and a GeoJSON bbox, plus the attribution."""
    no_bbox = {"display_name": "Nergenshuizen", "lat": "52.1", "lon": "5.1"}
    unusable = [
        {"lat": "52.2", "lon": "5.2"},
        {"display_name": "x", "lat": "north", "lon": "5"},
        {"display_name": 7, "lat": "52.2", "lon": "5.2"},
        {"display_name": "x", "lat": "95", "lon": "5.2"},
        "not a place",
    ]
    bad_bbox = {**no_bbox, "boundingbox": ["a", "b", "c", "d"]}
    infinite_bbox = {**no_bbox, "boundingbox": ["inf", "52", "5", "6"]}
    aioclient_mock.get(SEARCH_URL, json=[PLACE, no_bbox, *unusable, bad_bbox, infinite_bbox])

    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/geocode", query=QUERY)

    assert msg["success"], msg
    place = {"name": "1, Voorbeeldstraat, Nergenshuizen", "lat": 52.0001, "lon": 5.0002}
    plain = {"name": "Nergenshuizen", "lat": 52.1, "lon": 5.1, "bbox": None}
    assert msg["result"] == {
        "results": [
            {**place, "bbox": [5.0, 51.9999, 5.0004, 52.0003]},
            plain,
            plain,
            plain,
        ],
        "attribution": "Search by OpenStreetMap",
    }


async def test_request_identifies_the_integration(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, aioclient_mock: AiohttpClientMocker
) -> None:
    """Test the request carries the query, the limit and an identifying User-Agent."""
    aioclient_mock.get(SEARCH_URL, json=[])
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/geocode", query=f"  {QUERY} ", limit=3)
    assert msg["success"], msg
    assert msg["result"]["results"] == []

    [(method, url, _, headers)] = aioclient_mock.mock_calls
    assert method == "GET"
    assert URL(url).query["q"] == QUERY
    assert URL(url).query["limit"] == "3"
    assert URL(url).query["format"] == "jsonv2"
    assert headers["User-Agent"] == (
        "HomeAssistant-Spatial/0.1.0 (+https://github.com/BIM-Tools/ha-spatial)"
    )


async def test_default_limit_is_five(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, aioclient_mock: AiohttpClientMocker
) -> None:
    """Test a search without limit asks for five results."""
    aioclient_mock.get(SEARCH_URL, json=[])
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/geocode", query=QUERY)
    [(_, url, _, _)] = aioclient_mock.mock_calls
    assert URL(url).query["limit"] == "5"


async def test_searches_are_at_least_a_second_apart(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    aioclient_mock: AiohttpClientMocker,
    clock: FakeClock,
) -> None:
    """Test a search within a second of the last one waits out the rest of that second."""
    aioclient_mock.get(SEARCH_URL, json=[])
    client = await hass_ws_client(hass)

    assert (await _call(client, type="spatial/geocode", query=QUERY))["success"]
    clock.now += 0.25
    assert (await _call(client, type="spatial/geocode", query=QUERY))["success"]
    assert clock.sleeps == [pytest.approx(0.75)]

    clock.now += 2
    assert (await _call(client, type="spatial/geocode", query=QUERY))["success"]
    assert clock.sleeps == [pytest.approx(0.75)]
    assert aioclient_mock.call_count == 3


async def test_search_queued_too_long_is_rate_limited(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, aioclient_mock: AiohttpClientMocker
) -> None:
    """Test a search behind a slow one gives up instead of hanging."""
    release = asyncio.Event()

    async def slow_answer(method: str, url: URL, data: Any) -> AiohttpClientMockResponse:
        await release.wait()
        return AiohttpClientMockResponse(method, url, json=[])

    aioclient_mock.get(SEARCH_URL, side_effect=slow_answer)
    client = await hass_ws_client(hass)
    with patch("custom_components.spatial.geocode.MAX_QUEUE_WAIT_S", 0.01):
        await client.send_json({"id": 1, "type": "spatial/geocode", "query": QUERY})
        await client.send_json({"id": 2, "type": "spatial/geocode", "query": QUERY})
        queued = await client.receive_json()
        release.set()
        first = await client.receive_json()

    assert queued["id"] == 2
    assert queued["error"]["code"] == "geocode_rate_limited"
    assert first["id"] == 1
    assert first["success"]


@pytest.mark.parametrize(
    ("mock", "code"),
    [
        ({"exc": aiohttp.ClientConnectionError()}, "geocode_unavailable"),
        ({"exc": TimeoutError()}, "geocode_unavailable"),
        ({"status": HTTPStatus.TOO_MANY_REQUESTS}, "geocode_rate_limited"),
        ({"status": HTTPStatus.INTERNAL_SERVER_ERROR}, "geocode_failed"),
        ({"text": "<html>not json</html>"}, "geocode_failed"),
        ({"json": {"error": "unexpected"}}, "geocode_failed"),
    ],
    ids=["network", "timeout", "too_many_requests", "http_error", "malformed", "not_a_list"],
)
async def test_failures_return_their_error_code_without_logging_the_query(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    aioclient_mock: AiohttpClientMocker,
    caplog: pytest.LogCaptureFixture,
    mock: dict[str, Any],
    code: str,
) -> None:
    """Test each failure has its own code and neither the reply nor the log holds the query."""
    aioclient_mock.get(SEARCH_URL, **mock)
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/geocode", query=QUERY)
    assert msg["error"]["code"] == code
    assert "Voorbeeldstraat" not in msg["error"]["message"]
    assert "Voorbeeldstraat" not in _logged_text(caplog)


@pytest.mark.parametrize("query", ["", "   ", QUERY * 7], ids=["empty", "blank", "too_long"])
async def test_empty_or_too_long_query_is_invalid(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    aioclient_mock: AiohttpClientMocker,
    caplog: pytest.LogCaptureFixture,
    query: str,
) -> None:
    """Test a bad query is refused before any request, and is not logged."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/geocode", query=query)
    assert msg["error"]["code"] == "invalid_format"
    assert aioclient_mock.call_count == 0
    assert "Voorbeeldstraat" not in _logged_text(caplog)


@pytest.mark.parametrize("limit", [0, 11], ids=["zero", "eleven"])
async def test_limit_out_of_range_is_invalid(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    aioclient_mock: AiohttpClientMocker,
    limit: int,
) -> None:
    """Test the limit stays between 1 and 10."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/geocode", query=QUERY, limit=limit)
    assert msg["error"]["code"] == "invalid_format"
    assert aioclient_mock.call_count == 0


async def test_search_requires_admin(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_admin_user: MockUser,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Test non-admin users cannot search."""
    hass_admin_user.groups = []
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/geocode", query=QUERY)
    assert msg["error"]["code"] == "unauthorized"
    assert aioclient_mock.call_count == 0
