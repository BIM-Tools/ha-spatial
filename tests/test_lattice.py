"""Proves footprints are read on the site lattice, walls on its axes, the outline a limit."""

from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN, EVENT_SPATIAL_UPDATED, METRIC_GRID
from custom_components.spatial.geometry import SiteFrame

from .common import FRAME, lonlat, rect

OUTLINE = rect(0, 0, 10, 10)


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial with one floor and three areas, on a fresh site."""
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


async def test_a_fresh_site_can_be_drawn_on_before_align(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the first room on a fresh site stores the home location as origin, still unaligned."""
    await hass.config.async_update(longitude=lonlat(-3, -2)[0], latitude=lonlat(-3, -2)[1])
    client = await hass_ws_client(hass)

    msg = await _write(client, areas={"kitchen": rect(0, 0, 4, 3)})

    assert msg["result"]["area_m2"] == {"kitchen": 11.31}
    site = (await _call(client, type="spatial/site"))["result"]
    assert (site["origin"], site["bearing_deg"]) == (
        [hass.config.longitude, hass.config.latitude],
        None,
    )


async def test_first_write_puts_the_origin_on_the_outline(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a first write with an outline takes the outline's first corner as origin."""
    client = await hass_ws_client(hass)
    msg = await _write(client, site={"bearing_deg": 10.0, "outline": rect(2, 3, 10, 10)})
    assert msg["success"], msg
    assert (await _call(client, type="spatial/site"))["result"]["origin"] == lonlat(2, 3)


async def test_cleared_origin_reads_on_the_default_one(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a site whose origin was cleared still measures and finds its rooms."""
    client = await hass_ws_client(hass)
    await _write(client, site=FRAME, areas={"kitchen": rect(0, 0, 4, 3)})

    assert (await _call(client, type="spatial/site/update", origin=None))["success"]

    assert (await _call(client, type="spatial/site"))["result"]["origin"] is None
    assert (await _features(client))["kitchen"]["properties"]["area_m2"] == 11.31
    lon, lat = lonlat(1, 1)
    msg = await _call(client, type="spatial/query_point", lon=lon, lat=lat)
    assert msg["result"] == {"area_id": "kitchen"}


async def test_unit_switch_reads_on_the_new_grid(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a unit switch is announced and measures on the lattice of the new grid.

    By hand: 3.048 m x 2.4384 m is 120 in x 96 in, less 2 in on every side; on
    the 2.5 cm lattice it reads 3.05 m x 2.45 m, less 5 cm on every side.
    """
    client = await hass_ws_client(hass)
    await hass.config.async_update(unit_system="us_customary")
    msg = await _write(client, site=FRAME, areas={"kitchen": rect(0, 0, 3.048, 2.4384)})
    inch_m = 0.0254
    assert msg["result"]["area_m2"] == {"kitchen": round(116 * inch_m * 92 * inch_m, 2)}
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    await hass.config.async_update(unit_system="metric")
    await hass.async_block_till_done()

    assert events
    assert (await _features(client))["kitchen"]["properties"]["area_m2"] == round(2.95 * 2.35, 2)


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

    frame = SiteFrame(site["origin"], site["bearing_deg"], METRIC_GRID.lattice_unit_m)
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
        (
            polygon((0, 0), (4, 0), (4, 3), (2.004, 0.003), (0, 3)),
            "A ring crosses itself",
        ),
    ],
    ids=["spike", "collapsed", "touches_itself_once_snapped"],
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
    msg = await _write(client, site={**FRAME, "outline": polygon((0, 0), (10, 0), (0, 9.9))})
    assert msg["error"] == {
        "code": "invalid_format",
        "message": "A corner must be between 45 and 315 degrees (outline)",
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
        (rect(0, 0, 10.025, 3), False),
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
        (rect(4.025, 0, 6, 3), False),
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


def notched(stub: float) -> dict[str, Any]:
    """Return a 4 m x 3 m room whose top left corner has a stub of two edges of `stub` metres."""
    return polygon((0, 0), (4, 0), (4, 3), (stub, 3), (stub, 3 - stub), (0, 3 - stub))


async def test_an_edge_under_one_grid_step_is_refused(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a room with an edge of 7.5 cm is refused on the 10 cm grid."""
    client = await hass_ws_client(hass)
    msg = await _write(client, site=FRAME, areas={"kitchen": notched(0.075)})
    assert msg["error"]["code"] == "invalid_format"
    assert msg["error"]["message"] == "An edge must be at least one grid step (kitchen)"


async def test_an_edge_of_one_grid_step_is_accepted(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test an edge of exactly one grid step is kept."""
    client = await hass_ws_client(hass)
    msg = await _write(client, site=FRAME, areas={"kitchen": notched(0.1)})
    assert msg["success"], msg


async def test_a_short_outline_edge_is_refused(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the outline is held to the same minimum edge."""
    client = await hass_ws_client(hass)
    msg = await _write(client, site={**FRAME, "outline": rect(0, 0, 0.075, 10)})
    assert msg["error"]["code"] == "invalid_format"
    assert msg["error"]["message"] == "An edge must be at least one grid step (outline)"


async def test_us_customary_minimum_edge(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the minimum is 4 in on the inch lattice: 3 in is refused, 0.1016 m is kept."""
    client = await hass_ws_client(hass)
    await hass.config.async_update(unit_system="us_customary")
    msg = await _write(client, site=FRAME, areas={"kitchen": notched(3 * 0.0254)})
    assert msg["error"]["code"] == "invalid_format"
    msg = await _write(client, site=FRAME, areas={"kitchen": notched(0.1016)})
    assert msg["success"], msg
