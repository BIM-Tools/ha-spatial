"""Proves footprints are read on the site lattice, walls on its axes, the outline a limit."""

from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN, EVENT_SPATIAL_UPDATED, LATTICES
from custom_components.spatial.geometry import SiteFrame

from .common import FRAME, lonlat, rect

OUTLINE = rect(0, 0, 10, 10)


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial with one floor and three areas, without a site frame."""
    ground = fr.async_get(hass).async_create("Ground floor", level=0)
    areas = ar.async_get(hass)
    areas.async_create("Kitchen", floor_id=ground.floor_id)
    areas.async_create("Hall", floor_id=ground.floor_id)
    areas.async_create("Garden", floor_id=ground.floor_id)
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _call(client: Any, **command: Any) -> dict[str, Any]:
    """Send a command and return the response message."""
    await client.send_json_auto_id(command)
    return await client.receive_json()


async def _write(client: Any, **command: Any) -> dict[str, Any]:
    """Send an update_geometries command and return the response message."""
    return await _call(client, type="spatial/area/update_geometries", **command)


async def _features(client: Any) -> dict[str, dict[str, Any]]:
    """Return the features of the GeoJSON feed by area_id."""
    msg = await _call(client, type="spatial/geojson")
    return {feature["id"]: feature for feature in msg["result"]["features"]}


def polygon(*corners: tuple[float, float]) -> dict[str, Any]:
    """Return a GeoJSON Polygon through corners given in metres from the origin."""
    return {"type": "Polygon", "coordinates": [[lonlat(x, y) for x, y in (*corners, corners[0])]]}


@pytest.mark.parametrize(
    "command",
    [
        {"areas": {"kitchen": rect(0, 0, 4, 3)}},
        {"site": {"outline": OUTLINE}},
        {"site": {"bearing_deg": 0.0, "outline": OUTLINE}},
        {"site": {"origin": FRAME["origin"], "outline": OUTLINE}},
    ],
    ids=["room", "outline", "bearing_only", "origin_only"],
)
async def test_drawing_needs_the_site_frame(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, command: dict[str, Any]
) -> None:
    """Test footprints and outlines are refused until the origin and bearing are set."""
    client = await hass_ws_client(hass)
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    msg = await _write(client, **command)
    await hass.async_block_till_done()

    assert msg["error"] == {
        "code": "invalid_format",
        "message": "Set the site origin and bearing before drawing",
    }
    assert events == []


async def test_frame_and_rooms_in_one_write(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test one write may set the frame, the outline and the rooms together."""
    client = await hass_ws_client(hass)
    msg = await _write(
        client, site={**FRAME, "outline": OUTLINE}, areas={"kitchen": rect(0, 0, 5, 4)}
    )
    assert msg["success"], msg
    # A corner room: 15 cm off the two facade edges, 5 cm off the others.
    assert msg["result"]["area_m2"] == {"kitchen": pytest.approx(4.8 * 3.8)}


async def test_lattice_is_fixed_by_the_first_origin(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the lattice follows the unit system at the first origin, and no later switch."""
    client = await hass_ws_client(hass)
    await hass.config.async_update(unit_system="us_customary")
    assert (await _call(client, type="spatial/site/update", **FRAME))["success"]

    await hass.config.async_update(unit_system="metric")
    await _call(client, type="spatial/site/update", origin=None)
    await _call(client, type="spatial/site/update", origin=lonlat(1, 1))

    site = (await _call(client, type="spatial/site"))["result"]
    assert site["lattice"] == "us"


async def test_inch_lattice_measures_in_inches(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a 10 ft x 8 ft room on the inch lattice loses 2 in on every interior side."""
    client = await hass_ws_client(hass)
    await hass.config.async_update(unit_system="us_customary")
    await _write(client, site=FRAME)

    msg = await _write(client, areas={"kitchen": rect(0, 0, 3.048, 2.4384)})

    inch_m = 0.0254
    expected_m2 = (120 - 4) * inch_m * (96 - 4) * inch_m
    assert msg["result"]["area_m2"] == {"kitchen": round(expected_m2, 2)}


async def test_reads_are_on_the_lattice_and_storage_keeps_the_written_coordinates(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_storage: dict[str, Any],
    setup_integration: MockConfigEntry,
) -> None:
    """Test a footprint off the lattice reads snapped and stable, but is stored as sent."""
    client = await hass_ws_client(hass)
    site = {"origin": lonlat(0.123, 0.456), "bearing_deg": 71.5}
    written = polygon((1.0012, 1.0034), (5.0071, 1.0029), (5.0063, 4.0088), (1.0041, 4.0013))
    outline = polygon((-0.0049, -0.0021), (10.0033, 0.0011), (9.9971, 9.9964), (0.0022, 10.0047))
    assert (await _write(client, site={**site, "outline": outline}))["success"]
    assert (await _write(client, areas={"kitchen": written}))["success"]

    frame = SiteFrame(site["origin"], site["bearing_deg"], LATTICES["metric"].unit_m)
    read = (await _features(client))["kitchen"]["geometry"]
    assert read != written
    assert frame.to_polygon(frame.snap(read)) == read
    assert read == frame.to_polygon(frame.snap(written))
    read_outline = (await _call(client, type="spatial/site"))["result"]["outline"]
    assert read_outline == frame.to_polygon(frame.snap(outline))

    assert await hass.config_entries.async_unload(setup_integration.entry_id)
    await hass.async_block_till_done()
    stored = hass_storage[DOMAIN]["data"]
    assert stored["areas"]["kitchen"]["polygon"] == written
    assert stored["site"]["outline"] == outline


async def test_bearing_change_reads_the_same_data_on_the_new_lattice(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a new bearing moves nothing stored: the old reading comes back with the old bearing."""
    client = await hass_ws_client(hass)
    await _write(client, site=FRAME, areas={"kitchen": rect(0, 0, 4.07, 3)})
    before = await _features(client)

    await _call(client, type="spatial/site/update", bearing_deg=33.0)
    turned = await _features(client)
    await _call(client, type="spatial/site/update", bearing_deg=0.0)

    assert turned["kitchen"]["geometry"] != before["kitchen"]["geometry"]
    assert await _features(client) == before


@pytest.mark.parametrize(
    ("room", "message"),
    [
        (polygon((0, 0), (4, 0), (0, 3.9)), "A corner must be between 45 and 315 degrees"),
        (polygon((0, 0), (0.003, 0), (0, 0.003)), "A ring needs at least three corners"),
        (rect(0, 0, 0.09, 1), "An edge is shorter than the drawing grid"),
        (
            polygon((0, 0), (4, 0), (4, 3), (2.004, 0.003), (0, 3)),
            "A ring crosses itself",
        ),
    ],
    ids=["spike", "collapsed", "short_edge", "touches_itself_once_snapped"],
)
async def test_footprints_are_checked_as_snapped(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, room: dict[str, Any], message: str
) -> None:
    """Test a footprint is checked on the lattice, as it will be read, naming the area."""
    client = await hass_ws_client(hass)
    await _write(client, site=FRAME)

    msg = await _write(client, areas={"kitchen": room})

    assert msg["error"] == {"code": "invalid_format", "message": f"{message} (kitchen)"}


async def test_bad_outline_is_named(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test an outline that fails on the lattice names the outline."""
    client = await hass_ws_client(hass)
    msg = await _write(client, site={**FRAME, "outline": rect(0, 0, 10, 0.05)})
    assert msg["error"] == {
        "code": "invalid_format",
        "message": "An edge is shorter than the drawing grid (outline)",
    }


async def test_room_without_net_area_is_refused(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a room no wider than its two half walls is refused."""
    client = await hass_ws_client(hass)
    await _write(client, site=FRAME)
    msg = await _write(client, areas={"kitchen": rect(0, 0, 4, 0.1), "hall": rect(0, 1, 4, 3)})
    assert msg["error"] == {"code": "invalid_format", "message": "No net area: kitchen"}


@pytest.mark.parametrize(
    ("room", "accepted"),
    [
        (rect(2, 2, 4, 4), True),
        (rect(0, 0, 4, 3), True),
        (rect(10, 0, 14, 3), True),
        (rect(12, 12, 14, 14), True),
        (rect(8, 0, 14, 3), False),
        (rect(-1, -1, 11, 11), False),
        (rect(0, 0, 10.01, 3), False),
    ],
    ids=[
        "inside",
        "inside_touching",
        "outside_touching",
        "outside",
        "across_the_facade",
        "around_the_building",
        "one_unit_beyond",
    ],
)
async def test_rooms_may_not_cross_the_outline(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, room: dict[str, Any], accepted: bool
) -> None:
    """Test a room lies inside or outside the outline, touching allowed, never across it."""
    client = await hass_ws_client(hass)
    await _write(client, site={**FRAME, "outline": OUTLINE})
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    msg = await _write(client, areas={"garden": room, "hall": rect(0, 5, 2, 7)})
    await hass.async_block_till_done()

    if accepted:
        assert msg["success"], msg
    else:
        assert msg["error"] == {
            "code": "outside_outline",
            "message": "Beyond the building outline: garden",
        }
        assert events == []


async def test_outline_may_not_cut_a_room(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a new outline is refused when it would cut existing rooms; removing it is not."""
    client = await hass_ws_client(hass)
    await _write(
        client,
        site={**FRAME, "outline": OUTLINE},
        areas={"kitchen": rect(0, 0, 4, 3), "hall": rect(4, 0, 8, 3)},
    )

    msg = await _write(client, site={"outline": rect(0, 0, 6, 10)})
    assert msg["error"] == {
        "code": "outside_outline",
        "message": "Beyond the building outline: hall",
    }

    msg = await _write(client, site={"outline": rect(0, 0, 6, 10)}, areas={"hall": None})
    assert msg["success"], msg
    msg = await _call(client, type="spatial/site/update", outline=None)
    assert msg["success"], msg


@pytest.mark.parametrize(
    ("hall", "adjacent"),
    [
        (rect(4, 0, 6, 3), True),
        (rect(4, 2.5, 6, 6), True),
        (rect(4, 2.75, 6, 6), False),
        (rect(4.01, 0, 6, 3), False),
    ],
    ids=["whole_wall", "half_a_metre", "a_quarter_metre", "one_unit_apart"],
)
async def test_adjacency_is_exact_on_the_lattice(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, hall: dict[str, Any], adjacent: bool
) -> None:
    """Test rooms are adjacent when their axes coincide over 0.3 m, without any tolerance."""
    client = await hass_ws_client(hass)
    await _write(client, site=FRAME, areas={"kitchen": rect(0, 0, 4, 3), "hall": hall})

    msg = await _call(client, type="spatial/area/adjacent", area_id="kitchen")
    assert msg["result"] == {"area_ids": ["hall"] if adjacent else []}


@pytest.mark.parametrize(
    ("room", "override", "area_m2", "on_facade"),
    [
        (rect(0, 0, 5, 4), None, 4.8 * 3.8, True),
        (rect(0, 0, 5, 4), False, 4.9 * 3.9, False),
        (rect(2, 2, 7, 6), True, 4.9 * 3.9, True),
        (rect(2, 0, 2.2, 4), None, 0.1 * 3.8, False),
        (rect(10, 0, 14, 3), None, 3.8 * 2.9, True),
    ],
    ids=["corner_room", "marked_off_the_facade", "marked_on_the_facade", "short_facade", "outdoor"],
)
async def test_facade_insets_follow_the_outline(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    room: dict[str, Any],
    override: bool | None,
    area_m2: float,
    on_facade: bool,
) -> None:
    """Test rooms lose 15 cm along the outline, 5 cm elsewhere, as shrunk by hand."""
    client = await hass_ws_client(hass)
    msg = await _write(
        client,
        site={**FRAME, "outline": OUTLINE},
        areas={"garden": room},
        properties={"garden": {"on_facade_override": override}},
    )
    assert msg["success"], msg

    properties = (await _features(client))["garden"]["properties"]
    assert properties["area_m2"] == pytest.approx(area_m2, abs=0.005)
    assert properties["on_facade"] is on_facade


@pytest.mark.parametrize(
    ("bearing_deg", "accepted"),
    [(45.0, True), (33.0, False)],
    ids=["still_inside", "corner_read_beyond_the_outline"],
)
async def test_new_bearing_keeps_rooms_within_the_outline(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, bearing_deg: float, accepted: bool
) -> None:
    """Test a new bearing is refused when a room corner on an outline edge would read beyond it."""
    client = await hass_ws_client(hass)
    await _write(client, site={**FRAME, "outline": OUTLINE}, areas={"kitchen": rect(0, 0, 5, 4)})

    msg = await _call(client, type="spatial/site/update", bearing_deg=bearing_deg)

    if accepted:
        assert msg["success"], msg
    else:
        assert msg["error"] == {
            "code": "outside_outline",
            "message": "Beyond the building outline: kitchen",
        }


async def test_area_named_outline_is_checked_too(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test an area whose id is "outline" is validated beside the site outline."""
    ar.async_get(hass).async_create("Outline")
    client = await hass_ws_client(hass)

    msg = await _write(
        client,
        site={**FRAME, "outline": OUTLINE},
        areas={"outline": polygon((1, 1), (5, 1), (1, 4.9))},
    )

    assert msg["error"] == {
        "code": "invalid_format",
        "message": "A corner must be between 45 and 315 degrees (outline)",
    }
