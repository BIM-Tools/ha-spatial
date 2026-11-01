"""Proves the site centre follows the footprints and the site can be aligned and outlined."""

from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN

from .common import lonlat, rect


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial with two areas."""
    areas = ar.async_get(hass)
    areas.async_create("Kitchen")
    areas.async_create("Garden")
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _call(client: Any, **command: Any) -> dict[str, Any]:
    """Send a command and return the response message."""
    await client.send_json_auto_id(command)
    return await client.receive_json()


async def test_site_defaults_to_home_location(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test without footprints the site is the home location, with no direction until Align."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site")
    assert msg["result"] == {
        "lon": hass.config.longitude,
        "lat": hass.config.latitude,
        "bearing_deg": None,
        "outline": None,
    }


async def test_site_centre_is_the_middle_of_all_footprints(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the centre is the middle of the combined bounds of all footprints."""
    client = await hass_ws_client(hass)
    areas = {"kitchen": rect(0, 0, 4, 3), "garden": rect(10, -6, 20, 0)}
    msg = await _call(client, type="spatial/area/update_geometries", areas=areas)
    assert msg["success"], msg

    msg = await _call(client, type="spatial/site")
    lon, lat = lonlat(10, -1.5)  # x from 0 to 20, y from -6 to 3
    assert msg["result"]["lon"] == pytest.approx(lon, abs=1e-9)
    assert msg["result"]["lat"] == pytest.approx(lat, abs=1e-9)
    assert msg["result"]["bearing_deg"] is None


async def test_site_centre_follows_footprint_edits(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the centre moves when a footprint changes or is removed."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["lon"] == pytest.approx(lonlat(2, 0)[0], abs=1e-9)

    await _call(
        client, type="spatial/area/update_geometries", areas={"kitchen": rect(10, 0, 14, 3)}
    )
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["lon"] == pytest.approx(lonlat(12, 0)[0], abs=1e-9)
    assert msg["result"]["lat"] == pytest.approx(lonlat(0, 1.5)[1], abs=1e-9)

    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": None})
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["lon"] == hass.config.longitude


async def test_update_site_persists_bearing(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test the bearing can be set and survives a reload."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", bearing_deg=12.5)
    assert msg["success"], msg

    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    msg = await _call(client, type="spatial/site")
    assert msg["result"] == {
        "lon": hass.config.longitude,
        "lat": hass.config.latitude,
        "bearing_deg": 12.5,
        "outline": None,
    }


@pytest.mark.parametrize(
    "fields",
    [
        {"bearing_deg": 360.0},
        {"bearing_deg": -1.0},
        {"bearing_deg": 10.0, "lon": 4.9},
        {"bearing_deg": 10.0, "lat": 52.0},
    ],
    ids=["bearing_too_big", "bearing_negative", "lon_not_accepted", "lat_not_accepted"],
)
async def test_update_site_validates(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, fields: dict[str, float]
) -> None:
    """Test invalid input is rejected, including the removed lon and lat."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", **fields)
    assert msg["error"]["code"] == "invalid_format"


async def test_update_site_requires_admin(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, hass_admin_user: MockUser
) -> None:
    """Test non-admin users cannot set the bearing but can read the site."""
    hass_admin_user.groups = []
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", bearing_deg=10.0)
    assert msg["error"]["code"] == "unauthorized"
    msg = await _call(client, type="spatial/site")
    assert msg["success"], msg


@pytest.mark.parametrize(
    ("legacy_site", "bearing_deg"),
    [
        (None, None),
        ({"outline": None}, None),
        ({"lon": 4.9, "lat": 52.0, "bearing_deg": 20.0}, 20.0),
        ({"bearing_deg": 0.0, "outline": None}, 0.0),
    ],
    ids=["null", "without_bearing", "with_origin", "north_running_wall"],
)
async def test_legacy_stored_site_loads(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_storage: dict[str, Any],
    setup_integration: MockConfigEntry,
    legacy_site: dict[str, float | None] | None,
    bearing_deg: float | None,
) -> None:
    """Test stored data loads: no bearing means not aligned, a stored 0 stays a direction."""
    hass_storage[DOMAIN] = {
        "version": 1,
        "key": DOMAIN,
        "data": {"areas": {}, "floors": {}, "site": legacy_site},
    }
    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site")
    assert msg["result"] == {
        "lon": hass.config.longitude,
        "lat": hass.config.latitude,
        "bearing_deg": bearing_deg,
        "outline": None,
    }


async def test_legacy_stored_area_size_is_recomputed(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_storage: dict[str, Any],
    setup_integration: MockConfigEntry,
) -> None:
    """Test a footprint stored with an old gross area reports the net area."""
    hass_storage[DOMAIN] = {
        "version": 1,
        "key": DOMAIN,
        "data": {
            "areas": {"kitchen": {"polygon": rect(0, 0, 4, 3), "area_m2": 12.0}},
            "floors": {},
            "site": None,
        },
    }
    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/geojson")
    [feature] = msg["result"]["features"]
    assert feature["properties"]["area_m2"] == pytest.approx(11.31, rel=0.001)


async def test_site_outline_round_trip(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test the outline and bearing are stored together and survive a reload."""
    client = await hass_ws_client(hass)
    outline = rect(0, 0, 10, 8)
    msg = await _call(client, type="spatial/site/update", bearing_deg=30.0, outline=outline)
    assert msg["success"], msg

    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    msg = await _call(client, type="spatial/site")
    assert msg["result"]["outline"] == outline
    assert msg["result"]["bearing_deg"] == 30.0


async def test_site_centre_uses_outline_without_footprints(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the centre is the middle of the outline's bounds when there are no footprints."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/site/update", outline=rect(0, 0, 10, 8))
    msg = await _call(client, type="spatial/site")
    lon, lat = lonlat(5, 4)
    assert msg["result"]["lon"] == pytest.approx(lon, abs=1e-9)
    assert msg["result"]["lat"] == pytest.approx(lat, abs=1e-9)


async def test_site_centre_prefers_footprints(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test footprints decide the centre when there is also an outline."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/site/update", outline=rect(0, 0, 10, 8))
    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})
    msg = await _call(client, type="spatial/site")
    lon, lat = lonlat(2, 1.5)
    assert msg["result"]["lon"] == pytest.approx(lon, abs=1e-9)
    assert msg["result"]["lat"] == pytest.approx(lat, abs=1e-9)


@pytest.mark.parametrize(
    "outline",
    [
        {"type": "Point", "coordinates": [5.0, 52.0]},
        {"type": "Polygon", "coordinates": [[[5, 52], [5.1, 52], [5.1, 52.1], [5, 52.1]]]},
    ],
    ids=["point", "open_ring"],
)
async def test_site_update_rejects_bad_outline(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, outline: dict[str, Any]
) -> None:
    """Test an outline that is not a closed Polygon is rejected."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", outline=outline)
    assert msg["error"]["code"] == "invalid_format"


async def test_site_update_needs_a_field(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test an update without bearing or outline is rejected."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update")
    assert msg["error"]["code"] == "invalid_format"


async def test_site_bearing_cleared_with_null(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test null removes the bearing and leaves the outline alone."""
    client = await hass_ws_client(hass)
    outline = rect(0, 0, 10, 8)
    await _call(client, type="spatial/site/update", bearing_deg=30.0, outline=outline)
    msg = await _call(client, type="spatial/site/update", bearing_deg=None)
    assert msg["success"], msg
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["bearing_deg"] is None
    assert msg["result"]["outline"] == outline


async def test_site_outline_cleared_with_null(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test null removes the outline and leaves the bearing alone."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/site/update", bearing_deg=30.0, outline=rect(0, 0, 10, 8))
    msg = await _call(client, type="spatial/site/update", outline=None)
    assert msg["success"], msg
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["outline"] is None
    assert msg["result"]["bearing_deg"] == 30.0
