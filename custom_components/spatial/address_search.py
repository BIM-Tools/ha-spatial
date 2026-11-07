"""Finds a house by its address, for owners whose house is not under Home Assistant's home.

Queries and results are personal data: nothing here logs them, keeps them after the
request, or puts them in an exception message.
"""

from __future__ import annotations

from asyncio import Lock, sleep
from time import monotonic
from typing import Any

from aiohttp import ClientError, ClientTimeout
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util.hass_dict import HassKey

from .const import (
    ADDRESS_SEARCH_BIAS_DEG,
    ADDRESS_SEARCH_INTERVAL_S,
    ADDRESS_SEARCH_LIMIT,
    ADDRESS_SEARCH_TIMEOUT_S,
    ADDRESS_SEARCH_URL,
    ADDRESS_SEARCH_USER_AGENT,
    DOMAIN,
)

DATA_ADDRESS_SEARCH: HassKey[AddressSearch] = HassKey(f"{DOMAIN}_address_search")


class AddressSearchError(HomeAssistantError):
    """The search server could not be reached or gave no usable answer."""


def parse_results(payload: Any) -> list[dict[str, Any]]:
    """Return the places of a Nominatim jsonv2 answer, skipping entries without a position.

    Each place has `label`, `lat`, `lon` and `bbox` (`[west, south, east, north]`, or
    null). Nominatim sends numbers as strings and its box as south, north, west, east.
    """
    if not isinstance(payload, list):
        raise AddressSearchError("The search server gave an unreadable answer")
    places = []
    for entry in payload:
        try:
            place = {
                "label": str(entry["display_name"]),
                "lat": float(entry["lat"]),
                "lon": float(entry["lon"]),
                "bbox": None,
            }
        except KeyError, TypeError, ValueError:
            continue
        try:
            south, north, west, east = (float(value) for value in entry["boundingbox"])
            place["bbox"] = [west, south, east, north]
        except KeyError, TypeError, ValueError:
            pass
        places.append(place)
    return places


class AddressSearch:
    """Sends address searches one at a time, at most one per second, as Nominatim asks."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Start without a previous request."""
        self._hass = hass
        self._lock = Lock()
        self._last_request: float | None = None

    def _params(self, query: str) -> dict[str, str]:
        """Return the search parameters: the query, the language, and a bias towards home."""
        # Rounded, so the box centre does not give the home location away.
        lon = round(self._hass.config.longitude, 1)
        lat = round(self._hass.config.latitude, 1)
        bias = ADDRESS_SEARCH_BIAS_DEG
        return {
            "q": query,
            "format": "jsonv2",
            "limit": str(ADDRESS_SEARCH_LIMIT),
            "accept-language": self._hass.config.language,
            # Without bounded=1 the box only ranks results near home first.
            "viewbox": f"{lon - bias},{lat + bias},{lon + bias},{lat - bias}",
        }

    async def async_search(self, query: str) -> list[dict[str, Any]]:
        """Return up to five places for a query, or raise AddressSearchError."""
        async with self._lock:
            if self._last_request is not None:
                wait = ADDRESS_SEARCH_INTERVAL_S - (monotonic() - self._last_request)
                if wait > 0:
                    await sleep(wait)
            try:
                return await self._async_request(query)
            finally:
                self._last_request = monotonic()

    async def _async_request(self, query: str) -> list[dict[str, Any]]:
        """Send one request; errors keep their reason but never the query or the URL."""
        session = async_get_clientsession(self._hass)
        try:
            async with session.get(
                ADDRESS_SEARCH_URL,
                params=self._params(query),
                headers={"User-Agent": ADDRESS_SEARCH_USER_AGENT},
                timeout=ClientTimeout(total=ADDRESS_SEARCH_TIMEOUT_S),
            ) as response:
                if response.status != 200:
                    raise AddressSearchError(
                        f"The search server answered with status {response.status}"
                    )
                payload = await response.json(content_type=None)
        except ClientError, TimeoutError:
            raise AddressSearchError("The search server could not be reached") from None
        except ValueError:
            raise AddressSearchError("The search server gave an unreadable answer") from None
        return parse_results(payload)


def address_search(hass: HomeAssistant) -> AddressSearch:
    """Return the one address search of this Home Assistant, so the rate limit holds for all."""
    if DATA_ADDRESS_SEARCH not in hass.data:
        hass.data[DATA_ADDRESS_SEARCH] = AddressSearch(hass)
    return hass.data[DATA_ADDRESS_SEARCH]
