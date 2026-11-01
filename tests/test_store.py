"""Proves data from older releases loads complete and writes based on stale data are refused."""

from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import floor_registry as fr
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.spatial.const import DOMAIN, EVENT_SPATIAL_UPDATED

from .common import lonlat, rect


@pytest.fixture(autouse=True)
async def setup_integration(hass: HomeAssistant) -> MockConfigEntry:
    """Set up Spatial with one floor and two areas."""
    ground = fr.async_get(hass).async_create("Ground floor", level=0)
    areas = ar.async_get(hass)
    areas.async_create("Kitchen", floor_id=ground.floor_id)
    areas.async_create("Hallway", floor_id=ground.floor_id)
    entry = MockConfigEntry(domain=DOMAIN, title="Spatial")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _call(client: Any, **command: Any) -> dict[str, Any]:
    """Send a command and return the response message."""
    await client.send_json_auto_id(command)
    return await client.receive_json()


async def _reload_with(
    hass: HomeAssistant, hass_storage: dict[str, Any], entry: MockConfigEntry, stored: Any
) -> None:
    """Reload the entry with the given file content in `.storage/spatial`."""
    hass_storage[DOMAIN] = stored
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()


async def _revs(client: Any) -> tuple[dict[str, str], str]:
    """Return the rev of every footprint and the rev of the site."""
    features = (await _call(client, type="spatial/geojson"))["result"]["features"]
    site = (await _call(client, type="spatial/site"))["result"]
    return {f["id"]: f["properties"]["rev"] for f in features}, site["rev"]


async def _snapshot(client: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return everything a client can read, to show that nothing changed."""
    features = (await _call(client, type="spatial/geojson"))["result"]["features"]
    site = (await _call(client, type="spatial/site"))["result"]
    return features, site


async def test_release_1_1_data_is_migrated(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    setup_integration: MockConfigEntry,
) -> None:
    """Test 1.1 data with legacy fields and missing keys is saved complete as 1.2."""
    await _reload_with(
        hass,
        hass_storage,
        setup_integration,
        {
            "version": 1,
            "key": DOMAIN,
            "data": {
                "areas": {"kitchen": {"polygon": rect(0, 0, 4, 3), "area_m2": 12.0}},
                "floors": {"ground_floor": {"height_m": 2.6}},
                "site": {"lon": 4.9, "lat": 52.0, "bearing_deg": 0.0},
            },
        },
    )

    stored = hass_storage[DOMAIN]
    assert (stored["version"], stored["minor_version"]) == (1, 2)
    assert stored["data"] == {
        "site": {"bearing_deg": 0.0, "origin": None, "outline": None},
        "floors": {"ground_floor": {"elevation_m": None, "height_m": 2.6}},
        "areas": {
            "kitchen": {"polygon": rect(0, 0, 4, 3), "floors_up": 0, "on_facade_override": None}
        },
        "onboarding": {"home_pin": None},
    }


@pytest.mark.parametrize(
    "data",
    [{}, {"site": None, "areas": None, "floors": None}],
    ids=["missing_keys", "null_values"],
)
async def test_release_1_1_data_without_content_is_migrated(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_storage: dict[str, Any],
    setup_integration: MockConfigEntry,
    data: dict[str, Any],
) -> None:
    """Test a 1.1 file without areas, floors or site loads as an unaligned, empty plan."""
    await _reload_with(
        hass, hass_storage, setup_integration, {"version": 1, "key": DOMAIN, "data": data}
    )

    assert hass_storage[DOMAIN]["data"] == {
        "site": {"bearing_deg": None, "origin": None, "outline": None},
        "floors": {},
        "areas": {},
        "onboarding": {"home_pin": None},
    }
    client = await hass_ws_client(hass)
    site = (await _call(client, type="spatial/site"))["result"]
    assert site["bearing_deg"] is None
    assert site["origin"] is None


async def test_new_writes_are_saved_complete(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    hass_storage: dict[str, Any],
    setup_integration: MockConfigEntry,
) -> None:
    """Test a fresh install saves every key of the current version."""
    client = await hass_ws_client(hass)
    msg = await _call(
        client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)}
    )
    assert msg["success"], msg
    assert await hass.config_entries.async_unload(setup_integration.entry_id)
    await hass.async_block_till_done()

    stored = hass_storage[DOMAIN]
    assert stored["minor_version"] == 2
    assert stored["data"] == {
        "site": {"bearing_deg": None, "origin": None, "outline": None},
        "floors": {},
        "areas": {
            "kitchen": {"polygon": rect(0, 0, 4, 3), "floors_up": 0, "on_facade_override": None}
        },
        "onboarding": {"home_pin": None},
    }


async def test_rev_follows_content(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, setup_integration: MockConfigEntry
) -> None:
    """Test a rev changes with its own content only, and survives a reload."""
    client = await hass_ws_client(hass)
    await _call(
        client,
        type="spatial/area/update_geometries",
        areas={"kitchen": rect(0, 0, 4, 3), "hallway": rect(4, 0, 6, 3)},
    )
    area_revs, site_rev = await _revs(client)
    assert all(len(rev) == 12 for rev in [*area_revs.values(), site_rev])

    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 5, 3)})
    changed_area_revs, unchanged_site_rev = await _revs(client)
    assert changed_area_revs["kitchen"] != area_revs["kitchen"]
    assert changed_area_revs["hallway"] == area_revs["hallway"]
    assert unchanged_site_rev == site_rev

    await _call(client, type="spatial/site/update", bearing_deg=15.0)
    same_area_revs, changed_site_rev = await _revs(client)
    assert same_area_revs == changed_area_revs
    assert changed_site_rev != site_rev

    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})
    assert (await _revs(client))[0] == area_revs

    revs_before_reload = await _revs(client)
    assert await hass.config_entries.async_reload(setup_integration.entry_id)
    await hass.async_block_till_done()
    assert await _revs(client) == revs_before_reload


async def test_write_with_matching_revs_returns_new_revs(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a write based on current revs succeeds and returns the revs a client reads next."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})
    area_revs, site_rev = await _revs(client)

    msg = await _call(
        client,
        type="spatial/area/update_geometries",
        areas={"kitchen": None, "hallway": rect(4, 0, 6, 3)},
        site={"bearing_deg": 20.0},
        expected_rev={"kitchen": area_revs["kitchen"], "hallway": None},
        expected_site_rev=site_rev,
    )

    assert msg["success"], msg
    new_area_revs, new_site_rev = await _revs(client)
    assert msg["result"] == {
        "area_m2": {"hallway": pytest.approx(5.51, rel=0.001)},
        "rev": {"kitchen": None, "hallway": new_area_revs["hallway"]},
        "site_rev": new_site_rev,
    }
    assert new_site_rev != site_rev


@pytest.mark.parametrize(
    "expectation",
    [
        {"expected_rev": {"kitchen": "000000000000"}},
        {"expected_rev": {"hallway": "000000000000"}},
        {"expected_rev": {"kitchen": None}},
        {"expected_site_rev": "000000000000"},
    ],
    ids=["stale_area", "area_without_footprint", "expected_none_has_one", "stale_site"],
)
async def test_write_with_stale_revs_changes_nothing(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, expectation: dict[str, Any]
) -> None:
    """Test a write based on old revs returns conflict, writes nothing and fires no event."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})
    before = await _snapshot(client)
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)

    msg = await _call(
        client,
        type="spatial/area/update_geometries",
        areas={"kitchen": rect(0, 0, 8, 3), "hallway": rect(8, 0, 10, 3)},
        site={"bearing_deg": 45.0, "outline": rect(0, 0, 10, 3), "origin": lonlat(0, 0)},
        **expectation,
    )
    await hass.async_block_till_done()

    assert msg["error"]["code"] == "conflict"
    conflicting = [*expectation.get("expected_rev", {})] or ["site"]
    assert all(name in msg["error"]["message"] for name in conflicting)
    assert events == []
    assert await _snapshot(client) == before


@pytest.mark.parametrize(
    "references",
    [
        {"areas": {"kitchen": rect(0, 0, 4, 3), "nowhere": rect(0, 0, 1, 1)}},
        {"areas": {"kitchen": rect(0, 0, 4, 3)}, "expected_rev": {"nowhere": None}},
        {"expected_rev": {"nowhere": None}},
    ],
    ids=["in_areas", "in_expected_rev", "site_only"],
)
async def test_unknown_area_rejects_the_site_change_too(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, references: dict[str, Any]
) -> None:
    """Test an unknown area anywhere in a write returns not_found and writes nothing."""
    client = await hass_ws_client(hass)
    before = await _snapshot(client)

    msg = await _call(
        client, type="spatial/area/update_geometries", site={"bearing_deg": 45.0}, **references
    )

    assert msg["error"]["code"] == "not_found"
    assert "nowhere" in msg["error"]["message"]
    assert await _snapshot(client) == before


async def test_site_only_write(hass: HomeAssistant, hass_ws_client: WebSocketGenerator) -> None:
    """Test a write with only a site change sets origin, outline and bearing, once."""
    client = await hass_ws_client(hass)
    events = async_capture_events(hass, EVENT_SPATIAL_UPDATED)
    origin = lonlat(1, 2)

    msg = await _call(
        client,
        type="spatial/area/update_geometries",
        site={"bearing_deg": 0.0, "origin": origin, "outline": rect(0, 0, 10, 8)},
    )
    await hass.async_block_till_done()

    assert msg["success"], msg
    assert msg["result"]["area_m2"] == {}
    assert msg["result"]["rev"] == {}
    assert len(events) == 1
    site = (await _call(client, type="spatial/site"))["result"]
    assert (site["bearing_deg"], site["origin"], site["outline"]) == (
        0.0,
        origin,
        rect(0, 0, 10, 8),
    )
    assert site["rev"] == msg["result"]["site_rev"]

    msg = await _call(
        client, type="spatial/area/update_geometries", areas={}, site={"origin": None}
    )
    assert msg["success"], msg
    site = (await _call(client, type="spatial/site"))["result"]
    assert site["origin"] is None
    assert site["bearing_deg"] == 0.0


@pytest.mark.parametrize(
    "command",
    [
        {"areas": {}},
        {"site": {}},
        {"site": {"origin": [200.0, 52.0]}},
        {"site": {"origin": [5.0, 95.0]}},
        {"site": {"origin": [5.0]}},
        {"site": {"bearing_deg": 360.0}},
        {"site": {"lon": 5.0}},
        {"areas": {"kitchen": rect(0, 0, 4, 3)}, "expected_rev": {"kitchen": 3}},
    ],
    ids=[
        "nothing",
        "empty_site",
        "origin_lon",
        "origin_lat",
        "origin_short",
        "bearing",
        "unknown_site_field",
        "rev_not_text",
    ],
)
async def test_update_geometries_validates_site_and_revs(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, command: dict[str, Any]
) -> None:
    """Test bad site fields and revs are rejected as invalid_format."""
    client = await hass_ws_client(hass)
    msg = await _call(client, type="spatial/area/update_geometries", **command)
    assert msg["error"]["code"] == "invalid_format"


CROSSED_RING = {
    "type": "Polygon",
    "coordinates": [[lonlat(0, 0), lonlat(4, 0), lonlat(0, 3), lonlat(4, 3), lonlat(0, 0)]],
}


@pytest.mark.parametrize(
    "command",
    [
        {"type": "spatial/site/update", "outline": CROSSED_RING},
        {"type": "spatial/area/update_geometries", "site": {"outline": CROSSED_RING}},
    ],
    ids=["site_update", "update_geometries"],
)
async def test_bad_outline_names_the_reason(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, command: dict[str, Any]
) -> None:
    """Test a bad outline returns the same reason as a bad footprint."""
    client = await hass_ws_client(hass)
    msg = await _call(client, **command)
    assert msg["error"]["code"] == "invalid_format"
    assert msg["error"]["message"].startswith("A ring crosses itself")


async def test_floor_update_keeps_omitted_fields(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Test a floor update changes only the given fields; null clears one."""
    client = await hass_ws_client(hass)
    await _call(client, type="spatial/area/update_geometries", areas={"kitchen": rect(0, 0, 4, 3)})

    async def bounds() -> tuple[float, float]:
        [feature] = (await _call(client, type="spatial/geojson"))["result"]["features"]
        return feature["properties"]["base_m"], feature["properties"]["top_m"]

    await _call(client, type="spatial/floor/update", floor_id="ground_floor", elevation_m=-0.5)
    await _call(client, type="spatial/floor/update", floor_id="ground_floor", height_m=2.5)
    assert await bounds() == (-0.5, pytest.approx(2.0))

    msg = await _call(
        client, type="spatial/floor/update", floor_id="ground_floor", elevation_m=None
    )
    assert msg["success"], msg
    assert await bounds() == (0.0, 2.5)
