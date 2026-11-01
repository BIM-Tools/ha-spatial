"""Proves the websocket API behaves as documented, for admins and other users."""

from datetime import timedelta
from typing import Any
from unittest.mock import ANY, patch

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    MockUser,
    async_capture_events,
    async_fire_time_changed,
)
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import (
    BOT_SPACE,
    DOMAIN,
    EVENT_SPATIAL_UPDATED,
    JSONFG_CORE,
    JSONFG_TYPES_SCHEMAS,
    SAVE_DELAY_S,
)

from .common import lonlat, rect

WRITE_COMMANDS: list[dict[str, Any]] = [
    {"type": "spatial/area/update_geometries", "areas": {"kitchen": rect(0, 0, 4, 3)}},
    {"type": "spatial/floor/update", "floor_id": "ground_floor"},
]


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial with two floors and three areas."""
    floors = fr.async_get(hass)
    ground = floors.async_create("Ground floor", level=0)
    first = floors.async_create("First floor", level=1)
    areas = ar.async_get(hass)
    areas.async_create("Kitchen", floor_id=ground.floor_id)
    areas.async_create("Hallway", floor_id=ground.floor_id)
    areas.async_create("Bedroom", floor_id=first.floor_id)

    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _call(client: Any, **command: Any) -> dict[str, Any]:
    """Send a command and return the response message."""
    await client.send_json_auto_id(command)
    return await client.receive_json()


async def _set_geometry(client: Any, area_id: str, polygon: dict[str, Any]) -> None:
    """Attach a polygon to an area and assert success."""
    msg = await _call(client, type="spatial/area/update_geometries", areas={area_id: polygon})
    assert msg["success"], msg


async def test_geojson_declares_json_fg_and_bot_types(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test the feed declares JSON-FG conformance and types each feature as a BOT space."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/geojson")
    assert msg["result"]["conformsTo"] == [JSONFG_CORE, JSONFG_TYPES_SCHEMAS]

    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))
    msg = await _call(client, type="spatial/geojson")
    assert msg["result"]["conformsTo"] == [JSONFG_CORE, JSONFG_TYPES_SCHEMAS]
    assert msg["result"]["features"][0]["featureType"] == BOT_SPACE


async def test_set_geometry_and_geojson(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test area footprints appear in the GeoJSON feed, ready for extrusion."""
    client = await hass_ws_client(hass)
    msg = await _call(
        client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)}
    )
    assert msg["success"], msg
    assert msg["result"]["area_m2"] == {"kitchen": pytest.approx(11.31, rel=0.001)}

    msg = await _call(
        client,
        type="spatial/floor/update",
        floor_id="ground_floor",
        elevation_m=-0.5,
        height_m=2.7,
    )
    assert msg["success"], msg

    msg = await _call(client, type="spatial/geojson")
    assert msg["success"], msg
    [feature] = msg["result"]["features"]
    assert feature["id"] == "kitchen"
    assert feature["geometry"] == rect(0, 0, 4, 3)
    assert feature["properties"] == {
        "area_id": "kitchen",
        "name": "Kitchen",
        "floor_id": "ground_floor",
        "level": 0,
        "area_m2": pytest.approx(11.31, rel=0.001),
        "base_m": -0.5,
        "top_m": pytest.approx(2.2),
        "floors_up": 0,
        "floor_ids": ["ground_floor"],
        "on_facade_override": None,
        "on_facade": False,
        "is_external": False,
        "rev": ANY,
    }


async def test_floor_defaults_stack_by_level(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test floors without spatial data stack 3 m per level."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "bedroom", rect(0, 0, 4, 3))

    msg = await _call(client, type="spatial/geojson", floor_id="first_floor")
    [feature] = msg["result"]["features"]
    assert feature["properties"]["base_m"] == 3.0
    assert feature["properties"]["top_m"] == 6.0


async def test_query_point(hass: HomeAssistant, hass_ws_client: WebSocketGenerator) -> None:
    """Test point lookup, filtered by floor where floors overlap in plan."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))
    await _set_geometry(client, "bedroom", rect(0, 0, 4, 3))
    lon, lat = lonlat(1, 1)

    msg = await _call(client, type="spatial/query_point", lon=lon, lat=lat, floor_id="first_floor")
    assert msg["result"] == {"area_id": "bedroom"}

    msg = await _call(client, type="spatial/query_point", lon=lon, lat=lat, floor_id="ground_floor")
    assert msg["result"] == {"area_id": "kitchen"}

    lon, lat = lonlat(10, 10)
    msg = await _call(client, type="spatial/query_point", lon=lon, lat=lat)
    assert msg["result"] == {"area_id": None}


async def test_query_point_prefers_smallest_area(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test overlapping areas on a floor resolve to the smallest one."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "hallway", rect(0, 0, 10, 10))
    await _set_geometry(client, "kitchen", rect(1, 1, 3, 3))

    msg = await _call(client, type="spatial/query_point", lon=lonlat(2, 2)[0], lat=lonlat(2, 2)[1])
    assert msg["result"] == {"area_id": "kitchen"}


async def test_adjacent_areas_from_shared_edges(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test adjacency is derived from shared centreline edges on the same floor."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))
    await _set_geometry(client, "hallway", rect(4, 0, 6, 3))
    # Same footprint as the hallway's neighbour, but on another floor.
    await _set_geometry(client, "bedroom", rect(-4, 0, 0, 3))

    msg = await _call(client, type="spatial/area/adjacent", area_id="kitchen")
    assert msg["result"] == {"area_ids": ["hallway"]}

    msg = await _call(client, type="spatial/area/adjacent", area_id="bedroom")
    assert msg["result"] == {"area_ids": []}


async def test_adjacent_unknown_area(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test adjacency of an area without geometry is empty, and unknown areas fail."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/area/adjacent", area_id="kitchen")
    assert msg["result"] == {"area_ids": []}

    msg = await _call(client, type="spatial/area/adjacent", area_id="nowhere")
    assert msg["error"]["code"] == "not_found"


async def test_remove_geometry(hass: HomeAssistant, hass_ws_client: WebSocketGenerator) -> None:
    """Test removing a footprint."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))

    msg = await _call(client, type="spatial/area/update_geometries", areas={"kitchen": None})
    assert msg["success"], msg
    assert msg["result"]["area_m2"] == {}
    msg = await _call(client, type="spatial/geojson")
    assert msg["result"]["features"] == []


async def test_update_geometries_applies_a_batch_with_one_event(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test several areas change together: set, replace and remove, one event."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "hallway", rect(4, 0, 6, 3))
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    msg = await _call(
        client,
        type="spatial/area/update_geometries",
        areas={"kitchen": rect(0, 0, 4, 3), "hallway": None, "bedroom": rect(0, 0, 2, 2)},
    )
    await hass.async_block_till_done()

    assert msg["result"]["area_m2"] == {
        "kitchen": pytest.approx(11.31, rel=0.001),
        "bedroom": pytest.approx(3.61, rel=0.001),
    }
    assert len(events) == 1
    msg = await _call(client, type="spatial/geojson")
    assert sorted(f["id"] for f in msg["result"]["features"]) == ["bedroom", "kitchen"]


@pytest.mark.parametrize(
    ("areas", "code"),
    [
        ({"kitchen": rect(0, 0, 4, 3), "nowhere": rect(0, 0, 1, 1)}, "not_found"),
        (
            {"kitchen": rect(0, 0, 4, 3), "bedroom": {"type": "Point", "coordinates": [5, 52]}},
            "invalid_format",
        ),
        ({}, "invalid_format"),
    ],
    ids=["unknown_area", "bad_polygon", "empty"],
)
async def test_update_geometries_is_atomic(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, areas: dict[str, Any], code: str
) -> None:
    """Test an invalid entry rejects the whole batch and changes nothing."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "hallway", rect(4, 0, 6, 3))
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    msg = await _call(client, type="spatial/area/update_geometries", areas=areas)
    await hass.async_block_till_done()

    assert msg["error"]["code"] == code
    if code == "not_found":
        assert "nowhere" in msg["error"]["message"]
        assert "kitchen" not in msg["error"]["message"]
    assert events == []
    msg = await _call(client, type="spatial/geojson")
    assert [f["id"] for f in msg["result"]["features"]] == ["hallway"]


async def test_registry_removal_drops_spatial_data(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test deleting an area or floor in Home Assistant removes its spatial data."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))
    await _call(client, type="spatial/floor/update", floor_id="first_floor", elevation_m=9)

    ar.async_get(hass).async_delete("kitchen")
    fr.async_get(hass).async_delete("first_floor")
    await hass.async_block_till_done()

    msg = await _call(client, type="spatial/geojson")
    assert msg["result"]["features"] == []

    # Re-creating the floor starts from defaults again. Deleting the floor
    # detached the bedroom from it, so attach it to the new floor.
    floor = fr.async_get(hass).async_create("First floor", level=1)
    ar.async_get(hass).async_update("bedroom", floor_id=floor.floor_id)
    await _set_geometry(client, "bedroom", rect(0, 0, 4, 3))
    msg = await _call(client, type="spatial/geojson")
    [feature] = msg["result"]["features"]
    assert feature["properties"]["base_m"] == 3.0


async def test_data_survives_reload(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test spatial data is persisted and loaded again after a reload."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))

    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()

    msg = await _call(client, type="spatial/geojson")
    assert [feature["id"] for feature in msg["result"]["features"]] == ["kitchen"]


async def test_unload_after_the_delayed_save_does_not_write_again(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test a save that already happened is not repeated on unload."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=SAVE_DELAY_S + 1))
    await hass.async_block_till_done()

    with patch("homeassistant.helpers.storage.Store.async_save") as save:
        assert await hass.config_entries.async_unload(setup_integration.entry_id)
        await hass.async_block_till_done()

    save.assert_not_called()


async def test_unload_right_after_a_write_persists_it(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_storage: dict[str, Any],
    setup_integration: MockConfigEntry,
) -> None:
    """Test the delayed save is flushed when the entry unloads."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))
    assert DOMAIN not in hass_storage

    assert await hass.config_entries.async_unload(setup_integration.entry_id)
    await hass.async_block_till_done()

    assert list(hass_storage[DOMAIN]["data"]["areas"]) == ["kitchen"]


async def test_commands_error_when_unloaded_and_work_after_reload(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test commands return an error while unloaded and work after setup."""
    client = await hass_ws_client(hass)
    assert await hass.config_entries.async_unload(setup_integration.entry_id)
    await hass.async_block_till_done()

    msg = await _call(client, type="spatial/geojson")
    assert msg["error"]["code"] == "home_assistant_error"

    assert await hass.config_entries.async_setup(setup_integration.entry_id)
    await hass.async_block_till_done()
    msg = await _call(client, type="spatial/geojson")
    assert msg["success"], msg


@pytest.mark.parametrize("command", WRITE_COMMANDS, ids=lambda c: c["type"])
async def test_write_commands_require_admin(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_admin_user: MockUser,
    command: dict[str, Any],
) -> None:
    """Test non-admin users cannot modify spatial data."""
    hass_admin_user.groups = []
    client = await hass_ws_client(hass)
    msg = await _call(client, **command)
    assert msg["error"]["code"] == "unauthorized"


@pytest.mark.parametrize(
    "command",
    [
        {"type": "spatial/geojson"},
        {"type": "spatial/query_point", "lon": 5.0, "lat": 52.0},
        {"type": "spatial/area/adjacent", "area_id": "kitchen"},
    ],
    ids=lambda c: c["type"],
)
async def test_read_commands_allowed_for_non_admin(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_admin_user: MockUser,
    command: dict[str, Any],
) -> None:
    """Test non-admin users can read spatial data."""
    hass_admin_user.groups = []
    client = await hass_ws_client(hass)
    msg = await _call(client, **command)
    assert msg["success"], msg


async def test_subscribe_notifies_non_admin_until_unsubscribed(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, hass_admin_user: MockUser
) -> None:
    """Test a non-admin user gets an event per change until unsubscribing."""
    client = await hass_ws_client(hass)
    await _set_geometry(client, "kitchen", rect(0, 0, 4, 3))
    await _set_geometry(client, "hallway", rect(4, 0, 6, 3))
    hass_admin_user.groups = []
    subscribed = await _call(client, type="spatial/subscribe")
    assert subscribed["success"], subscribed
    areas = ar.async_get(hass)

    areas.async_delete("kitchen")
    msg = await client.receive_json()
    assert msg == {"id": subscribed["id"], "type": "event", "event": {}}

    msg = await _call(client, type="unsubscribe_events", subscription=subscribed["id"])
    assert msg["success"], msg
    areas.async_delete("hallway")
    msg = await _call(client, type="spatial/site")
    assert msg["type"] == "result", msg


@pytest.mark.parametrize(
    ("command", "code"),
    [
        ({"type": "spatial/floor/update", "floor_id": "attic"}, "not_found"),
        (
            {"type": "spatial/floor/update", "floor_id": "ground_floor", "height_m": 0},
            "invalid_format",
        ),
    ],
    ids=["unknown_floor", "zero_height"],
)
async def test_invalid_writes(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, command: dict[str, Any], code: str
) -> None:
    """Test writes are validated against the registries and the schema."""
    client = await hass_ws_client(hass)
    msg = await _call(client, **command)
    assert msg["error"]["code"] == code


def _with_hole(shell: dict[str, Any], hole: dict[str, Any]) -> dict[str, Any]:
    """Return the shell polygon with the outer ring of hole added as an inner ring."""
    return {"type": "Polygon", "coordinates": shell["coordinates"] + hole["coordinates"]}


async def test_footprint_with_a_hole(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a hole is stored, excluded from the area, from points and shared as a wall."""
    client = await hass_ws_client(hass)
    hallway = _with_hole(rect(0, 0, 10, 10), rect(3, 4, 7, 6))
    msg = await _call(client, type="spatial/area/update_geometries", areas={"hallway": hallway})
    assert msg["success"], msg
    # Shrunk by hand: a 9.9 m square minus the hole grown to 4.1 m x 2.1 m.
    assert msg["result"]["area_m2"] == {"hallway": pytest.approx(9.9 * 9.9 - 4.1 * 2.1, abs=0.01)}

    msg = await _call(client, type="spatial/geojson")
    [feature] = msg["result"]["features"]
    assert feature["geometry"] == hallway

    in_hole = lonlat(5, 5)
    msg = await _call(client, type="spatial/query_point", lon=in_hole[0], lat=in_hole[1])
    assert msg["result"] == {"area_id": None}

    await _set_geometry(client, "kitchen", rect(3, 4, 7, 6))
    msg = await _call(client, type="spatial/query_point", lon=in_hole[0], lat=in_hole[1])
    assert msg["result"] == {"area_id": "kitchen"}
    beside_hole = lonlat(1, 5)
    msg = await _call(client, type="spatial/query_point", lon=beside_hole[0], lat=beside_hole[1])
    assert msg["result"] == {"area_id": "hallway"}

    msg = await _call(client, type="spatial/area/adjacent", area_id="kitchen")
    assert msg["result"] == {"area_ids": ["hallway"]}
    msg = await _call(client, type="spatial/area/adjacent", area_id="hallway")
    assert msg["result"] == {"area_ids": ["kitchen"]}


@pytest.mark.parametrize(
    ("polygon", "message"),
    [
        (
            {
                "type": "Polygon",
                "coordinates": [
                    [lonlat(0, 0), lonlat(4, 0), lonlat(0, 3), lonlat(4, 3), lonlat(0, 0)]
                ],
            },
            "A ring crosses itself",
        ),
        (
            _with_hole(rect(0, 0, 10, 10), rect(8, 2, 12, 4)),
            "Rings must not cross or share an edge",
        ),
        (_with_hole(rect(0, 0, 10, 10), rect(12, 2, 14, 4)), "A hole must lie inside the outline"),
        (
            _with_hole(_with_hole(rect(0, 0, 10, 10), rect(2, 2, 6, 6)), rect(3, 3, 4, 4)),
            "A hole must not lie inside another hole",
        ),
    ],
    ids=["crosses_itself", "rings_cross", "hole_outside", "hole_in_hole"],
)
async def test_update_geometries_explains_bad_rings(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, polygon: dict[str, Any], message: str
) -> None:
    """Test a bad ring returns invalid_format with a message a frontend can map."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/area/update_geometries", areas={"kitchen": polygon})
    assert msg["error"]["code"] == "invalid_format"
    assert msg["error"]["message"].startswith(message)
