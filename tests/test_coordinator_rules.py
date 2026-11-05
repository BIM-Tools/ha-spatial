"""Checks the rules the coordinator applies to a change and to floors, as plain data in and out."""

from typing import Any

import pytest

from custom_components.spatial.const import METRIC_GRID
from custom_components.spatial.coordinator import change_problem, floors_above, occupied_floor_ids
from custom_components.spatial.geometry import Ring

# Metres to units of the metric lattice (2.5 cm).
UNITS_PER_M = 40


def ring(*corners: tuple[float, float]) -> Ring:
    """Return the corners of a ring given in metres, in metric lattice units."""
    return [(round(x * UNITS_PER_M), round(y * UNITS_PER_M)) for x, y in corners]


def box(x0: float, y0: float, x1: float, y1: float) -> list[Ring]:
    """Return a rectangle given in metres as a polygon on the metric lattice."""
    return [ring((x0, y0), (x1, y0), (x1, y1), (x0, y1))]


OUTLINE = box(0, 0, 10, 10)
SPIKE = [ring((1, 1), (5, 1), (1, 4.9))]


def problem(**change: Any) -> tuple[str, str] | None:
    """Return change_problem for a change, with nothing stored, written or overridden by default."""
    arguments: dict[str, Any] = {
        "stored": {},
        "written": {},
        "outline": None,
        "on_facade_overrides": {},
        "grid": METRIC_GRID,
        "outline_written": False,
        "frame_changed": False,
        **change,
    }
    return change_problem(**arguments)


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"written": {"kitchen": SPIKE}}, "kitchen"),
        ({"written": {"hall": box(0, 0, 4, 3), "kitchen": SPIKE}}, "kitchen"),
        ({"written": {"outline": SPIKE}, "outline": OUTLINE, "outline_written": True}, "outline"),
        ({"outline": SPIKE, "outline_written": True}, "outline"),
        ({"written": {"kitchen": SPIKE}, "outline": SPIKE, "outline_written": True}, "kitchen"),
    ],
    ids=[
        "room",
        "the_bad_room_of_two",
        "area_named_outline",
        "outline",
        "rooms_before_the_outline",
    ],
)
def test_invalid_rings_are_named(change: dict[str, Any], expected: str) -> None:
    """Test a footprint or outline written that fails on the lattice is named in the message."""
    assert problem(**change) == (
        "invalid_format",
        f"A corner must be between 45 and 315 degrees ({expected})",
    )


@pytest.mark.parametrize(
    "change",
    [
        {"stored": {"kitchen": SPIKE}, "written": {"hall": box(0, 0, 4, 3)}},
        {"outline": SPIKE},
        {"written": {"kitchen": None}},
    ],
    ids=["stored_room", "outline_not_written", "removal"],
)
def test_only_rings_written_are_validated(change: dict[str, Any]) -> None:
    """Test stored footprints, an outline left as it is and removals are not validated again."""
    assert problem(**change) is None


@pytest.mark.parametrize(
    ("room", "accepted"),
    [
        (box(2, 2, 4, 4), True),
        (box(0, 0, 4, 3), True),
        (box(10, 0, 14, 3), True),
        (box(12, 12, 14, 14), True),
        (box(8, 0, 14, 3), False),
        (box(-1, -1, 11, 11), False),
        (box(0, 0, 10.025, 3), False),
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
def test_rooms_may_not_cross_the_outline(room: list[Ring], accepted: bool) -> None:
    """Test a room lies inside or outside the outline, touching allowed, never across it."""
    result = problem(written={"garden": room, "hall": box(0, 5, 2, 7)}, outline=OUTLINE)
    assert result == (
        None if accepted else ("outside_outline", "Beyond the building outline: garden")
    )


CUT_HALL = {
    "stored": {"kitchen": box(0, 0, 4, 3), "hall": box(4, 0, 8, 3)},
    "outline": box(0, 0, 6, 10),
}


@pytest.mark.parametrize(
    ("change", "beyond"),
    [
        ({**CUT_HALL, "outline_written": True}, "hall"),
        ({**CUT_HALL, "frame_changed": True}, "hall"),
        ({**CUT_HALL, "outline_written": True, "written": {"kitchen": box(0, 0, 5, 3)}}, "hall"),
        ({**CUT_HALL, "written": {"kitchen": box(0, 0, 7, 3)}}, "kitchen"),
        ({**CUT_HALL, "outline_written": True, "written": {"hall": None}}, None),
        ({**CUT_HALL, "written": {"kitchen": box(0, 0, 5, 3)}}, None),
        ({**CUT_HALL, "outline": None, "frame_changed": True}, None),
    ],
    ids=[
        "new_outline_cuts_a_stored_room",
        "new_frame_reads_a_stored_room_across",
        "stored_rooms_checked_beside_the_written",
        "written_room_across",
        "room_removed_in_the_same_change",
        "stored_rooms_unchecked_without_outline_or_frame_change",
        "no_outline",
    ],
)
def test_outline_and_frame_changes_check_every_room(
    change: dict[str, Any], beyond: str | None
) -> None:
    """Test all rooms are checked when the outline or frame changes, else only the rooms written."""
    expected = ("outside_outline", f"Beyond the building outline: {beyond}") if beyond else None
    assert problem(**change) == expected


@pytest.mark.parametrize(
    ("change", "empty"),
    [
        ({"written": {"kitchen": box(0, 0, 4, 0.1), "hall": box(0, 1, 4, 3)}}, "kitchen"),
        ({"written": {"hall": box(0, 0, 4, 0.15)}}, None),
        ({"written": {"hall": box(0, 0, 4, 0.2)}, "outline": box(0, 0, 4, 10)}, "hall"),
        (
            {
                "written": {"hall": box(0, 0, 4, 0.2)},
                "outline": box(0, 0, 4, 10),
                "on_facade_overrides": {"hall": False},
            },
            None,
        ),
        ({"written": {"b": box(0, 0, 4, 0.1), "a": box(0, 1, 4, 1.1)}}, "a, b"),
    ],
    ids=["two_half_walls", "wider", "facade_walls", "marked_off_the_facade", "sorted"],
)
def test_rooms_written_keep_a_net_area(change: dict[str, Any], empty: str | None) -> None:
    """Test a room written no wider than its half walls is refused, insets per its facade."""
    expected = ("invalid_format", f"No net area: {empty}") if empty else None
    assert problem(**change) == expected


def test_crossing_is_reported_before_net_area() -> None:
    """Test a change both across the outline and without net area names the crossing."""
    written = {"garden": box(8, 0, 14, 3), "hall": box(0, 0, 4, 0.1)}
    assert problem(written=written, outline=OUTLINE) == (
        "outside_outline",
        "Beyond the building outline: garden",
    )


LEVELS: dict[str, int | None] = {
    "ground": 0,
    "second": 2,
    "first": 1,
    "mezzanine": 1,
    "loft": None,
}


@pytest.mark.parametrize(
    ("floor_id", "above"),
    [
        ("ground", ["first", "mezzanine", "second"]),
        ("first", ["second"]),
        ("second", []),
        ("loft", []),
        ("deleted", []),
        (None, []),
    ],
    ids=["by_level_then_id", "higher_only", "top", "without_level", "unknown", "no_floor"],
)
def test_floors_above(floor_id: str | None, above: list[str]) -> None:
    """Test only floors with a higher level are above, lowest first, never a level-less one."""
    assert floors_above(floor_id, LEVELS) == above


@pytest.mark.parametrize(
    ("floor_id", "floors_up", "floor_ids"),
    [
        ("ground", 0, ["ground"]),
        ("ground", 2, ["ground", "first", "mezzanine"]),
        ("first", 2, ["first", "second"]),
        ("loft", 1, ["loft"]),
        (None, 1, []),
    ],
    ids=["own_floor", "floors_up", "beyond_the_remaining_floors", "without_level", "site_level"],
)
def test_occupied_floor_ids(floor_id: str | None, floors_up: int, floor_ids: list[str]) -> None:
    """Test a room occupies its own floor and floors_up above it, as far as floors remain."""
    assert occupied_floor_ids(floor_id, floors_up, LEVELS) == floor_ids
