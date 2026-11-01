"""Proves rooms can reach over floors and know whether they are outdoors or on the facade."""

from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN, EVENT_SPATIAL_UPDATED

from .common import lonlat, rect

OUTLINE = rect(0, 0, 10, 10)
ROOM_PROPERTY_KEYS = ("floors_up", "floor_ids", "on_facade_override", "on_facade", "is_external")


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial with three floors, created out of level order, and five areas."""
    floors = fr.async_get(hass)
    ground = floors.async_create("Ground floor", level=0)
    second = floors.async_create("Second floor", level=2)
    first = floors.async_create("First floor", level=1)
    areas = ar.async_get(hass)
    areas.async_create("Hall", floor_id=ground.floor_id)
    areas.async_create("Kitchen", floor_id=ground.floor_id)
    areas.async_create("Landing", floor_id=first.floor_id)
    areas.async_create("Study", floor_id=second.floor_id)
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


async def _write(client: Any, **command: Any) -> dict[str, Any]:
    """Send an update_geometries command, assert success and return its result."""
    msg = await _call(client, type="spatial/area/update_geometries", **command)
    assert msg["success"], msg
    result: dict[str, Any] = msg["result"]
    return result


async def _properties(client: Any, floor_id: str | None = None) -> dict[str, dict[str, Any]]:
    """Return the feature properties of the GeoJSON feed by area_id."""
    command = {"floor_id": floor_id} if floor_id else {}
    msg = await _call(client, type="spatial/geojson", **command)
    return {f["id"]: f["properties"] for f in msg["result"]["features"]}


async def _adjacent(client: Any, area_id: str) -> list[str]:
    """Return the areas adjacent to an area."""
    msg = await _call(client, type="spatial/area/adjacent", area_id=area_id)
    area_ids: list[str] = msg["result"]["area_ids"]
    return area_ids


async def test_defaults_without_properties(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a new footprint is on its own floor, indoors and off the facade without an outline."""
    client = await hass_ws_client(hass)
    await _write(client, areas={"hall": rect(0, 0, 4, 3), "garden": rect(20, 0, 30, 10)})

    properties = await _properties(client)
    assert {key: properties["hall"][key] for key in ROOM_PROPERTY_KEYS} == {
        "floors_up": 0,
        "floor_ids": ["ground_floor"],
        "on_facade_override": None,
        "on_facade": False,
        "is_external": False,
    }
    assert properties["garden"]["floor_ids"] == []
    assert properties["garden"]["is_external"] is False


async def test_set_and_clear_properties_keeps_the_polygon(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test properties are set and cleared in place, with one event and a new rev each time."""
    client = await hass_ws_client(hass)
    first = await _write(client, areas={"hall": rect(0, 0, 4, 3)})
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    second = await _write(client, properties={"hall": {"floors_up": 2, "on_facade_override": True}})
    await hass.async_block_till_done()
    assert len(events) == 1
    assert second["area_m2"] == {}
    assert second["rev"]["hall"] != first["rev"]["hall"]
    hall = (await _properties(client))["hall"]
    assert hall["floors_up"] == 2
    assert hall["floor_ids"] == ["ground_floor", "first_floor", "second_floor"]
    assert hall["on_facade_override"] is True
    assert hall["on_facade"] is True

    msg = await _call(client, type="spatial/geojson")
    assert msg["result"]["features"][0]["geometry"] == rect(0, 0, 4, 3)

    third = await _write(client, properties={"hall": {"floors_up": 0, "on_facade_override": None}})
    assert third["rev"]["hall"] == first["rev"]["hall"]
    hall = (await _properties(client))["hall"]
    assert hall["floor_ids"] == ["ground_floor"]
    assert hall["on_facade_override"] is None


async def test_one_property_keeps_the_other(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a property left out of a write keeps its value, also when the polygon changes."""
    client = await hass_ws_client(hass)
    await _write(client, areas={"hall": rect(0, 0, 4, 3)}, properties={"hall": {"floors_up": 1}})
    await _write(client, properties={"hall": {"on_facade_override": False}})
    await _write(client, areas={"hall": rect(0, 0, 5, 3)})

    hall = (await _properties(client))["hall"]
    assert hall["floors_up"] == 1
    assert hall["on_facade_override"] is False


@pytest.mark.parametrize(
    "properties",
    [
        {"hall": {"floors_up": -1}},
        {"hall": {"floors_up": 1.5}},
        {"hall": {"floors_up": "1"}},
        {"hall": {"floors_up": True}},
        {"hall": {"on_facade_override": "yes"}},
        {"hall": {"on_facade_override": 1}},
        {"hall": {"colour": "red"}},
        {"hall": {}},
        {"hall": {"floors_up": 3}},
        {"garden": {"floors_up": 1}},
        {"kitchen": {"floors_up": 0}},
        {"hall": {"floors_up": 1}, "kitchen": {"on_facade_override": True}},
    ],
    ids=[
        "negative",
        "fraction",
        "text",
        "boolean_floors",
        "text_override",
        "number_override",
        "unknown_property",
        "nothing",
        "above_the_top_floor",
        "site_level_reaching_up",
        "no_footprint",
        "one_bad_area",
    ],
)
async def test_invalid_properties_change_nothing(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, properties: dict[str, Any]
) -> None:
    """Test bad values, floors that do not exist and areas without a footprint are rejected."""
    client = await hass_ws_client(hass)
    await _write(client, areas={"hall": rect(0, 0, 4, 3), "garden": rect(20, 0, 30, 10)})
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    msg = await _call(client, type="spatial/area/update_geometries", properties=properties)
    await hass.async_block_till_done()

    assert msg["error"]["code"] == "invalid_format"
    assert events == []
    assert (await _properties(client))["hall"]["floors_up"] == 0


async def test_properties_with_a_new_footprint(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test properties may come with the first footprint, not with its removal."""
    client = await hass_ws_client(hass)
    result = await _write(
        client, areas={"kitchen": rect(0, 0, 4, 3)}, properties={"kitchen": {"floors_up": 1}}
    )
    assert list(result["rev"]) == ["kitchen"]
    assert (await _properties(client))["kitchen"]["floors_up"] == 1

    msg = await _call(
        client,
        type="spatial/area/update_geometries",
        areas={"kitchen": None},
        properties={"kitchen": {"floors_up": 0}},
    )
    assert msg["error"]["code"] == "invalid_format"


async def test_properties_of_an_unknown_area(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test properties of an area that is not in the registry return not_found."""
    client = await hass_ws_client(hass)
    msg = await _call(
        client, type="spatial/area/update_geometries", properties={"nowhere": {"floors_up": 0}}
    )
    assert msg["error"]["code"] == "not_found"


async def test_stale_rev_conflicts(hass: HomeAssistant, hass_ws_client: WebSocketGenerator) -> None:
    """Test a property write based on an old rev changes nothing; the current rev writes."""
    client = await hass_ws_client(hass)
    old = await _write(client, areas={"hall": rect(0, 0, 4, 3)})
    current = await _write(client, properties={"hall": {"floors_up": 1}})

    msg = await _call(
        client,
        type="spatial/area/update_geometries",
        properties={"hall": {"floors_up": 2}},
        expected_rev={"hall": old["rev"]["hall"]},
    )
    assert msg["error"]["code"] == "conflict"
    assert (await _properties(client))["hall"]["floors_up"] == 1

    await _write(
        client, properties={"hall": {"floors_up": 2}}, expected_rev={"hall": current["rev"]["hall"]}
    )
    assert (await _properties(client))["hall"]["floors_up"] == 2


async def test_room_reaching_up_is_adjacent_on_the_floors_it_occupies(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a stairwell on two floors meets the landing beside it, not the study higher up."""
    client = await hass_ws_client(hass)
    await _write(
        client,
        areas={
            "hall": rect(0, 0, 2, 4),
            "kitchen": rect(2, 0, 6, 4),
            "landing": rect(2, 0, 6, 4),
            "study": rect(2, 0, 6, 4),
        },
    )
    assert await _adjacent(client, "hall") == ["kitchen"]
    assert await _adjacent(client, "landing") == []

    await _write(client, properties={"hall": {"floors_up": 1}})

    assert await _adjacent(client, "hall") == ["kitchen", "landing"]
    assert await _adjacent(client, "landing") == ["hall"]
    assert await _adjacent(client, "study") == []
    assert await _adjacent(client, "kitchen") == ["hall"]


async def test_room_reaching_up_appears_on_the_floors_it_occupies(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test floor filters and the extrusion height follow the occupied floors."""
    client = await hass_ws_client(hass)
    await _write(
        client,
        areas={"hall": rect(0, 0, 2, 4), "landing": rect(2, 0, 6, 4)},
        properties={"hall": {"floors_up": 1}},
    )

    assert sorted(await _properties(client, "first_floor")) == ["hall", "landing"]
    assert sorted(await _properties(client, "second_floor")) == []
    hall = (await _properties(client, "ground_floor"))["hall"]
    assert (hall["floor_id"], hall["base_m"], hall["top_m"]) == ("ground_floor", 0.0, 6.0)

    lon, lat = lonlat(1, 1)
    msg = await _call(client, type="spatial/query_point", lon=lon, lat=lat, floor_id="first_floor")
    assert msg["result"] == {"area_id": "hall"}
    msg = await _call(client, type="spatial/query_point", lon=lon, lat=lat, floor_id="second_floor")
    assert msg["result"] == {"area_id": None}


async def test_floors_up_counts_only_floors_with_a_higher_level(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test floors without a level, and the floors of a level-less floor, are not above."""
    client = await hass_ws_client(hass)
    floors = fr.async_get(hass)
    loft = floors.async_create("Loft")
    ar.async_get(hass).async_create("Attic", floor_id=loft.floor_id)
    await _write(client, areas={"study": rect(0, 0, 4, 3), "attic": rect(0, 0, 4, 3)})

    msg = await _call(
        client, type="spatial/area/update_geometries", properties={"study": {"floors_up": 1}}
    )
    assert msg["error"]["code"] == "invalid_format"
    msg = await _call(
        client, type="spatial/area/update_geometries", properties={"attic": {"floors_up": 1}}
    )
    assert msg["error"]["code"] == "invalid_format"


async def test_floor_ids_shrink_when_a_floor_above_is_deleted(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a stored floors_up beyond the floors that remain reaches only the remaining ones."""
    client = await hass_ws_client(hass)
    await _write(client, areas={"hall": rect(0, 0, 4, 3)}, properties={"hall": {"floors_up": 2}})
    fr.async_get(hass).async_delete("second_floor")
    await hass.async_block_till_done()

    hall = (await _properties(client))["hall"]
    assert hall["floors_up"] == 2
    assert hall["floor_ids"] == ["ground_floor", "first_floor"]


@pytest.mark.parametrize(
    ("room", "outline", "is_external"),
    [
        (rect(8, 0, 14, 3), OUTLINE, True),
        (rect(6, 0, 11, 3), OUTLINE, False),
        (rect(5, 0, 14.9, 3), OUTLINE, False),
        (rect(10, 0, 14, 3), OUTLINE, True),
        (rect(8, 0, 14, 3), None, False),
    ],
    ids=["mostly_outside", "mostly_inside", "just_more_inside", "against_the_facade", "no_outline"],
)
async def test_is_external_follows_where_most_of_the_room_lies(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    room: dict[str, Any],
    outline: dict[str, Any] | None,
    is_external: bool,
) -> None:
    """Test a room is outdoor when most of its area lies outside the building outline."""
    client = await hass_ws_client(hass)
    await _write(client, areas={"garden": room}, site={"outline": outline})

    assert (await _properties(client))["garden"]["is_external"] is is_external


@pytest.mark.parametrize(
    ("room", "outline", "override", "on_facade"),
    [
        (rect(0, 0, 4, 3), OUTLINE, None, True),
        (rect(10, 0, 14, 3), OUTLINE, None, True),
        (rect(2, 2, 4, 4), OUTLINE, None, False),
        (rect(0, 0, 4, 3), None, None, False),
        (rect(0, 0, 4, 3), OUTLINE, False, False),
        (rect(2, 2, 4, 4), OUTLINE, True, True),
        (rect(2, 2, 4, 4), None, True, True),
    ],
    ids=[
        "inside_on_the_outline",
        "outside_on_the_outline",
        "inside_off_the_outline",
        "no_outline",
        "overridden_off",
        "overridden_on",
        "overridden_on_without_outline",
    ],
)
async def test_on_facade_is_derived_unless_overridden(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    room: dict[str, Any],
    outline: dict[str, Any] | None,
    override: bool | None,
    on_facade: bool,
) -> None:
    """Test a room is on the facade when an edge lies on the outline, or when overridden."""
    client = await hass_ws_client(hass)
    await _write(
        client,
        areas={"hall": room},
        properties={"hall": {"on_facade_override": override}},
        site={"outline": outline},
    )

    assert (await _properties(client))["hall"]["on_facade"] is on_facade


async def test_floor_changes_are_announced(hass: HomeAssistant) -> None:
    """Test every floor change is announced, as it can change the floors rooms occupy."""
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)
    floors = fr.async_get(hass)

    floors.async_create("Roof", level=3)
    floors.async_update("roof", level=4)
    floors.async_delete("roof")
    await hass.async_block_till_done()

    assert len(events) == 3


@pytest.mark.parametrize(
    ("room", "outline", "unit_system", "area_m2"),
    [
        (rect(2, 0, 7, 4), OUTLINE, "metric", (5 - 0.05 - 0.05) * (4 - 0.25 - 0.05)),
        (rect(0, 0, 5, 4), OUTLINE, "metric", (5 - 0.25 - 0.05) * (4 - 0.25 - 0.05)),
        (rect(0, 0, 5, 4), OUTLINE, "us_customary", (5 - 0.11 - 0.05) * (4 - 0.11 - 0.05)),
        (rect(2, 2, 7, 6), OUTLINE, "metric", (5 - 0.05 - 0.05) * (4 - 0.05 - 0.05)),
        (rect(0, 0, 5, 4), None, "metric", (5 - 0.05 - 0.05) * (4 - 0.05 - 0.05)),
    ],
    ids=["one_facade_edge", "corner_room", "us_customary", "off_the_outline", "no_outline"],
)
async def test_net_area_moves_facade_edges_by_the_exterior_wall_offset(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    room: dict[str, Any],
    outline: dict[str, Any] | None,
    unit_system: str,
    area_m2: float,
) -> None:
    """Test edges on the outline move in by the unit system's wall offset, others by 50 mm."""
    await hass.config.async_update(unit_system=unit_system)
    client = await hass_ws_client(hass)
    written = await _write(client, areas={"hall": room}, site={"outline": outline})

    assert written["area_m2"]["hall"] == pytest.approx(area_m2, abs=0.01)
    assert (await _properties(client))["hall"]["area_m2"] == pytest.approx(area_m2, abs=0.01)


async def test_net_area_of_a_room_with_a_hole_on_the_facade(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test only the outer ring's facade edge moves in by the offset; the hole grows by 50 mm."""
    room = rect(0, 0, 5, 4)
    room["coordinates"].append(rect(2, 1, 3, 2)["coordinates"][0])
    client = await hass_ws_client(hass)
    await _write(client, areas={"hall": room}, site={"outline": rect(-5, 0, 10, 10)})

    expected_m2 = (5 - 0.05 - 0.05) * (4 - 0.25 - 0.05) - (1 + 0.1) * (1 + 0.1)
    assert (await _properties(client))["hall"]["area_m2"] == pytest.approx(expected_m2, abs=0.01)


async def test_switching_the_unit_system_recalculates_net_areas(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a unit system change shows new net areas at once and is announced to clients."""
    client = await hass_ws_client(hass)
    await _write(client, areas={"hall": rect(0, 0, 5, 4)}, site={"outline": OUTLINE})
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    await hass.config.async_update(unit_system="us_customary")
    await hass.async_block_till_done()

    assert len(events) == 1
    hall = (await _properties(client))["hall"]
    assert hall["area_m2"] == pytest.approx((5 - 0.11 - 0.05) * (4 - 0.11 - 0.05), abs=0.01)
