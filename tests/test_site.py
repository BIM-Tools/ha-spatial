"""Proves the site centre follows the footprints and the site can be aligned and gridded."""

from typing import Any
from unittest.mock import ANY

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.util.location import vincenty
from homeassistant.util.unit_system import US_CUSTOMARY_SYSTEM
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    MockUser,
    async_capture_events,
)
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN, EVENT_SPATIAL_UPDATED

from .common import FRAME, lonlat, rect, set_frame


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
        "origin": None,
        "outline": None,
        "rev": ANY,
        "frame": ANY,
    }


async def test_site_centre_is_the_middle_of_all_footprints(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the centre is the middle of the combined bounds of all footprints."""
    client = await hass_ws_client(hass)
    await set_frame(hass, hass_ws_client)
    areas = {"kitchen": rect(0, 0, 4, 3), "garden": rect(10, -6, 20, 0)}
    msg = await _call(client, type="spatial/area/update_geometries", areas=areas)
    assert msg["success"], msg

    msg = await _call(client, type="spatial/site")
    lon, lat = lonlat(10, -1.5)  # x from 0 to 20, y from -6 to 3
    assert msg["result"]["lon"] == pytest.approx(lon, abs=1e-9)
    assert msg["result"]["lat"] == pytest.approx(lat, abs=1e-9)


async def test_site_centre_follows_footprint_edits(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the centre moves when a footprint changes or is removed."""
    client = await hass_ws_client(hass)
    await set_frame(hass, hass_ws_client)
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
    """Test the bearing can be set and survives a reload; without footprints the origin is home."""
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
        "origin": [hass.config.longitude, hass.config.latitude],
        "outline": None,
        "rev": ANY,
        "frame": ANY,
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
    """Test stored data loads: no bearing means not aligned, a stored 0 stays a direction.

    Every site gets an origin, here the home location as there is nothing drawn.
    """
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
        "origin": [hass.config.longitude, hass.config.latitude],
        "outline": None,
        "rev": ANY,
        "frame": ANY,
    }


async def test_legacy_footprint_is_measured_from_its_own_corner(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_storage: dict[str, Any],
    setup_integration: MockConfigEntry,
) -> None:
    """Test a footprint stored before origins existed is measured from its first corner."""
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
    assert feature["geometry"] == rect(0, 0, 4, 3)
    assert feature["properties"]["area_m2"] == 11.31
    assert (await _call(client, type="spatial/site"))["result"]["origin"] == lonlat(0, 0)


async def test_site_outline_round_trip(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test the outline, origin and bearing are stored together and survive a reload."""
    client = await hass_ws_client(hass)
    outline = rect(0, 0, 10, 8)
    msg = await _call(client, type="spatial/site/update", **FRAME, outline=outline)
    assert msg["success"], msg

    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    msg = await _call(client, type="spatial/site")
    assert msg["result"]["outline"] == outline
    assert msg["result"]["bearing_deg"] == 0.0


async def test_site_centre_uses_outline_without_footprints(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the centre is the middle of the outline's bounds when there are no footprints."""
    client = await hass_ws_client(hass)
    await set_frame(hass, hass_ws_client)
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
    await set_frame(hass, hass_ws_client)
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
    await set_frame(hass, hass_ws_client)
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
    await set_frame(hass, hass_ws_client)
    await _call(client, type="spatial/site/update", bearing_deg=30.0, outline=rect(0, 0, 10, 8))
    msg = await _call(client, type="spatial/site/update", outline=None)
    assert msg["success"], msg
    msg = await _call(client, type="spatial/site")
    assert msg["result"]["outline"] is None
    assert msg["result"]["bearing_deg"] == 30.0


async def test_site_origin_set_and_cleared_with_null(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test the origin survives a reload, null clears it, and the bearing is left alone."""
    client = await hass_ws_client(hass)
    origin = lonlat(1, 2)
    await _call(client, type="spatial/site/update", bearing_deg=30.0)
    msg = await _call(client, type="spatial/site/update", origin=origin)
    assert msg["success"], msg

    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    site = (await _call(client, type="spatial/site"))["result"]
    assert (site["origin"], site["bearing_deg"]) == (origin, 30.0)
    assert msg["result"] == {"site_rev": site["rev"]}

    msg = await _call(client, type="spatial/site/update", origin=None)
    assert msg["success"], msg
    site = (await _call(client, type="spatial/site"))["result"]
    assert (site["origin"], site["bearing_deg"]) == (None, 30.0)


@pytest.mark.parametrize(
    "origin",
    [[5.0], [5.0, 52.0, 3.0], [200.0, 52.0], [5.0, 95.0], ["east", 52.0], [5.0, None], 5.0],
    ids=["short", "long", "lon_out_of_range", "lat_out_of_range", "text", "none", "not_a_list"],
)
async def test_site_update_rejects_bad_origin(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, origin: Any
) -> None:
    """Test an origin that is not a [lon, lat] pair in range is rejected."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/site/update", origin=origin)
    assert msg["error"]["code"] == "invalid_format"


async def test_site_update_with_current_rev_writes(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a write based on the current site rev succeeds."""
    client = await hass_ws_client(hass)
    rev = (await _call(client, type="spatial/site"))["result"]["rev"]
    msg = await _call(client, type="spatial/site/update", origin=lonlat(0, 0), expected_rev=rev)
    assert msg["success"], msg
    site = (await _call(client, type="spatial/site"))["result"]
    assert site["origin"] == lonlat(0, 0)
    assert site["rev"] != rev


async def test_site_update_with_stale_rev_changes_nothing(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a write based on an old site rev returns conflict and fires no event."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/site/update", bearing_deg=30.0)
    before = (await _call(client, type="spatial/site"))["result"]
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    msg = await _call(
        client,
        type="spatial/site/update",
        origin=lonlat(0, 0),
        bearing_deg=10.0,
        expected_rev="000000000000",
    )
    await hass.async_block_till_done()

    assert msg["error"]["code"] == "conflict"
    assert "site" in msg["error"]["message"]
    assert events == []
    assert (await _call(client, type="spatial/site"))["result"] == before


def _to_lattice(frame: dict[str, Any], position: list[float]) -> tuple[float, float]:
    """Apply a published frame to a [lon, lat] position with plain arithmetic."""
    a, b = frame["to_lattice"][0]
    c, d = frame["to_lattice"][1]
    dlon, dlat = position[0] - frame["origin"][0], position[1] - frame["origin"][1]
    return a * dlon + b * dlat, c * dlon + d * dlat


async def test_site_publishes_a_frame_that_maps_stored_corners_to_lattice_units(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test every corner read back is a whole number of lattice units in the published frame."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/site/update", origin=FRAME["origin"], bearing_deg=30.0)
    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})
    await _call(client, type="spatial/site/update", outline=rect(-1, -1, 6, 5))

    site = (await _call(client, type="spatial/site"))["result"]
    room = (await _call(client, type="spatial/geojson"))["result"]["features"][0]["geometry"]
    corners = [*room["coordinates"][0], *site["outline"]["coordinates"][0]]
    assert len(corners) == 10
    for corner in corners:
        x, y = _to_lattice(site["frame"], corner)
        assert abs(x - round(x)) < 1e-6
        assert abs(y - round(y)) < 1e-6


async def test_the_published_frame_measures_like_vincenty(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a 4 m edge measures the same in lattice units times unit_m as by Vincenty."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/site/update", origin=FRAME["origin"], bearing_deg=30.0)
    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})

    frame = (await _call(client, type="spatial/site"))["result"]["frame"]
    room = (await _call(client, type="spatial/geojson"))["result"]["features"][0]["geometry"]
    first, second = room["coordinates"][0][:2]
    (x0, y0), (x1, y1) = _to_lattice(frame, first), _to_lattice(frame, second)
    lattice_length_m = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 * frame["unit_m"]
    reference_m = vincenty((first[1], first[0]), (second[1], second[0])) * 1000
    assert lattice_length_m == pytest.approx(reference_m, abs=0.002)


async def test_a_fresh_site_publishes_home_and_north(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test without writes the frame is at home, facing north, on the metric lattice."""
    client = await hass_ws_client(hass)
    frame = (await _call(client, type="spatial/site"))["result"]["frame"]
    assert frame["origin"] == [hass.config.longitude, hass.config.latitude]
    assert frame["bearing_deg"] == 0.0
    assert frame["unit_m"] == 0.025
    assert frame["units_per_step"] == 4


async def test_us_customary_publishes_an_inch_lattice(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the lattice unit follows the unit system, which is read live."""
    hass.config.units = US_CUSTOMARY_SYSTEM
    client = await hass_ws_client(hass)
    frame = (await _call(client, type="spatial/site"))["result"]["frame"]
    assert frame["unit_m"] == 0.0254
