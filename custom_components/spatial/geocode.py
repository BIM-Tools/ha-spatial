"""Lets onboarding find the home by address when no map building lies under the home pin."""

from __future__ import annotations

import asyncio
import math
from asyncio import sleep
from dataclasses import dataclass, field
from time import monotonic
from typing import Any, Final

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.loader import async_get_integration
from homeassistant.util.hass_dict import HassKey

from .const import DOMAIN

NOMINATIM_SEARCH_URL: Final = "https://nominatim.openstreetmap.org/search"
ATTRIBUTION: Final = "Search by OpenStreetMap"

# Nominatim's usage policy allows at most one request per second per application.
MIN_REQUEST_INTERVAL_S: Final = 1.0
# A search queued behind others gives up after this long instead of hanging the panel.
MAX_QUEUE_WAIT_S: Final = 5.0
REQUEST_TIMEOUT_S: Final = 10.0

MAX_QUERY_LENGTH: Final = 200
DEFAULT_LIMIT: Final = 5
MAX_LIMIT: Final = 10

# Websocket error codes of spatial/geocode.
ERR_GEOCODE_UNAVAILABLE: Final = "geocode_unavailable"
ERR_GEOCODE_FAILED: Final = "geocode_failed"
ERR_GEOCODE_RATE_LIMITED: Final = "geocode_rate_limited"

NOMINATIM_CLIENT_KEY: HassKey[NominatimClient] = HassKey(f"{DOMAIN}_nominatim")


class GeocodeError(HomeAssistantError):
    """A search that failed; the message never contains the query."""

    def __init__(self, code: str, message: str) -> None:
        """Keep the websocket error code with the message."""
        super().__init__(message)
        self.code = code


@dataclass
class NominatimClient:
    """Searches Nominatim, one request per second across all callers."""

    hass: HomeAssistant
    user_agent: str
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _last_request_at: float | None = None

    async def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        """Return up to limit places matching the query, trimmed to what the panel shows."""
        try:
            async with asyncio.timeout(MAX_QUEUE_WAIT_S):
                await self._wait_for_turn()
        except TimeoutError as err:
            raise GeocodeError(ERR_GEOCODE_RATE_LIMITED, "Too many searches, try again") from err
        try:
            self._last_request_at = monotonic()
            places = await self._request(query, limit)
        finally:
            self._lock.release()
        return [place for item in places if (place := _trim_place(item)) is not None]

    async def _wait_for_turn(self) -> None:
        """Take the lock and wait until a second has passed since the last request."""
        await self._lock.acquire()
        try:
            if self._last_request_at is not None:
                wait_s = self._last_request_at + MIN_REQUEST_INTERVAL_S - monotonic()
                if wait_s > 0:
                    await sleep(wait_s)
        except BaseException:
            self._lock.release()
            raise

    async def _request(self, query: str, limit: int) -> list[Any]:
        """Send one search request and return the decoded result list."""
        params = {
            "q": query,
            "format": "jsonv2",
            "limit": str(limit),
            "accept-language": self.hass.config.language,
        }
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                NOMINATIM_SEARCH_URL,
                params=params,
                headers={"User-Agent": self.user_agent},
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S),
            ) as response:
                if response.status == 429:
                    raise GeocodeError(
                        ERR_GEOCODE_RATE_LIMITED, "OpenStreetMap asks to search less often"
                    )
                if response.status >= 400:
                    raise GeocodeError(
                        ERR_GEOCODE_FAILED, f"OpenStreetMap search failed ({response.status})"
                    )
                places = await response.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise GeocodeError(ERR_GEOCODE_UNAVAILABLE, "OpenStreetMap cannot be reached") from err
        except ValueError as err:
            raise GeocodeError(
                ERR_GEOCODE_FAILED, "OpenStreetMap sent an unreadable answer"
            ) from err
        if not isinstance(places, list):
            raise GeocodeError(ERR_GEOCODE_FAILED, "OpenStreetMap sent an unreadable answer")
        return places


def _trim_place(item: Any) -> dict[str, Any] | None:
    """Return name, lat, lon and bbox ([west, south, east, north] or None), or None if unusable."""
    try:
        name = item["display_name"]
        lat = float(item["lat"])
        lon = float(item["lon"])
    except KeyError, TypeError, ValueError:
        return None
    if not isinstance(name, str) or not (abs(lat) <= 90 and abs(lon) <= 180):
        return None
    return {"name": name, "lat": lat, "lon": lon, "bbox": _bbox(item.get("boundingbox"))}


def _bbox(value: Any) -> list[float] | None:
    """Turn Nominatim's [south, north, west, east] strings into a GeoJSON bbox, or None."""
    try:
        south, north, west, east = (float(edge) for edge in value)
    except TypeError, ValueError:
        return None
    if not all(math.isfinite(edge) for edge in (south, north, west, east)):
        return None
    return [west, south, east, north]


async def async_get_nominatim_client(hass: HomeAssistant) -> NominatimClient:
    """Return the one client of this Home Assistant, so the rate limit holds for all callers."""
    if (client := hass.data.get(NOMINATIM_CLIENT_KEY)) is None:
        integration = await async_get_integration(hass, DOMAIN)
        user_agent = f"HomeAssistant-Spatial/{integration.version} (+{integration.documentation})"
        client = hass.data.setdefault(NOMINATIM_CLIENT_KEY, NominatimClient(hass, user_agent))
    return client
