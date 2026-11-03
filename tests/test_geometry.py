"""Checks the geometry against independent references, never against the same formula."""

import json
import math
import random
from fractions import Fraction

import pytest
from homeassistant.util.location import vincenty

from custom_components.spatial.const import METRIC_GRID, US_CUSTOMARY_GRID, UnitGrid
from custom_components.spatial.geometry import (
    Ring,
    SiteFrame,
    _segments_intersect,
    contains,
    net_area,
    outline_relation,
    shared_edge_length,
    validate_lattice_polygon,
    validate_polygon,
)

from .common import lonlat, rect

METRIC = METRIC_GRID
US = US_CUSTOMARY_GRID


def ring(*corners: tuple[float, float]) -> Ring:
    """Return the corners of a ring given in metres, in centimetre lattice units."""
    return [(round(x * 100), round(y * 100)) for x, y in corners]


def box(x0: float, y0: float, x1: float, y1: float) -> list[Ring]:
    """Return a rectangle given in metres as a polygon on the centimetre lattice."""
    return [ring((x0, y0), (x1, y0), (x1, y1), (x0, y1))]


def with_holes(shell: list[Ring], *holes: list[Ring]) -> list[Ring]:
    """Return the shell with the outer rings of holes added as inner rings."""
    return [*shell, *(hole[0] for hole in holes)]


def circle(corner_count: int) -> Ring:
    """Return the corners of a regular polygon with a 10 m radius."""
    return ring(
        *(
            (
                10 * math.cos(2 * math.pi * k / corner_count),
                10 * math.sin(2 * math.pi * k / corner_count),
            )
            for k in range(corner_count)
        )
    )


@pytest.mark.parametrize("lat", [0.1, 38.0, 52.09, 64.0, 78.2])
@pytest.mark.parametrize("grid", [METRIC, US], ids=["metric", "us"])
def test_snapping_is_idempotent_through_json(lat: float, grid: UnitGrid) -> None:
    """Test a snapped position snaps to the same lattice point, bit for bit, after JSON."""
    frame = SiteFrame([5.12, lat], 71.5, grid.lattice_unit_m)
    rng = random.Random(f"{lat}-{grid.lattice_unit_m}")
    for _ in range(2000):
        position = [5.12 + rng.uniform(-5e-4, 5e-4), lat + rng.uniform(-5e-4, 5e-4)]
        polygon = {"type": "Polygon", "coordinates": [[position] * 4]}
        snapped = frame.to_polygon(frame.snap(polygon))
        again = frame.to_polygon(frame.snap(json.loads(json.dumps(snapped))))
        assert again == snapped


@pytest.mark.parametrize("lat", [0.0, 38.0, 52.0, 60.0, 70.0])
@pytest.mark.parametrize("bearing_deg", [0.0, 33.0, 90.0, 251.5])
def test_frame_lengths_match_geodesic(lat: float, bearing_deg: float) -> None:
    """Test 20 m along each axis against HA's Vincenty geodesic, an independent implementation.

    Vincenty is rounded to whole millimetres, which limits the tolerance.
    """
    frame = SiteFrame([5.0, lat], bearing_deg, METRIC.lattice_unit_m)
    start = frame.to_wgs84((0, 0))
    for end in (frame.to_wgs84((800, 0)), frame.to_wgs84((0, -800))):
        length_km = vincenty((start[1], start[0]), (end[1], end[0]))
        assert length_km is not None
        assert length_km * 1000 == pytest.approx(20, abs=0.0015)


def test_frame_runs_along_the_bearing() -> None:
    """Test x runs along the bearing and y to its left: due east and due north at 90 degrees."""
    frame = SiteFrame([5.0, 52.0], 90.0, METRIC.lattice_unit_m)
    east, north = frame.to_wgs84((1000, 0)), frame.to_wgs84((0, 1000))
    assert east[1] == pytest.approx(52.0, abs=1e-12)
    assert east[0] > 5.0
    assert north[0] == pytest.approx(5.0, abs=1e-12)
    assert north[1] > 52.0


def test_snap_reads_whole_lattice_units_back_unchanged() -> None:
    """Test a rectangle drawn in whole 2.5 cm units along the frame reads back bit for bit."""
    frame = SiteFrame(lonlat(0, 0), 0.0, METRIC.lattice_unit_m)
    assert frame.to_polygon(frame.snap(rect(0, 0, 4.075, 3.5))) == rect(0, 0, 4.075, 3.5)


def test_snap_drops_corners_that_meet() -> None:
    """Test corners closer than half a unit become one, so a tiny edge disappears."""
    frame = SiteFrame(lonlat(0, 0), 0.0, US.lattice_unit_m)
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [lonlat(0, 0), lonlat(0.004, 0), lonlat(4, 0), lonlat(4, 3), lonlat(0, 0)],
            [lonlat(1, 1), lonlat(2, 1), lonlat(2, 2), lonlat(1.003, 1.002), lonlat(1, 1)],
        ],
    }
    assert [len(corners) for corners in frame.snap(polygon)] == [3, 3]


@pytest.mark.parametrize(
    ("room", "outline", "expected_units"),
    [
        (box(0, 0, 4, 3), None, 390 * 290),
        (box(0, 0, 5, 4), box(-10, 0, 10, 10), 490 * 380),
        (box(0, 0, 5, 4), box(0, 0, 10, 10), 480 * 380),
        (box(10, 0, 14, 3), box(0, 0, 10, 10), 380 * 290),
        (box(0, 0, 10, 4), box(0, 0, 10, 4), 970 * 370),
        (
            box(0, 0, 10, 4),
            [ring((0, 0), (5, 0), (5, -2), (20, -2), (20, 10), (0, 10))],
            980 * 390 - 485 * 10,
        ),
        (with_holes(box(0, 0, 10, 10), box(3, 4, 7, 6)), None, 990 * 990 - 410 * 210),
        (
            [ring((0, 0), (6, 0), (6, 3), (3, 3), (3, 6), (0, 6))],
            None,
            590 * 290 + 290 * 300,
        ),
        ([ring((0, 0), (0, 4), (5, 4), (5, 0))], box(-10, 0, 10, 10), 490 * 380),
        (box(0, 0, 10, 0.05), None, 0),
        (box(0, 0, 0.2, 0.2), box(0, 0, 0.2, 0.2), 0),
    ],
    ids=[
        "interior_only",
        "one_facade_edge",
        "corner_room",
        "outdoor_against_the_outline",
        "room_is_the_outline",
        "facade_on_half_an_edge",
        "hole",
        "l_shape",
        "clockwise",
        "thinner_than_two_walls",
        "used_up_by_its_walls",
    ],
)
def test_net_area_of_rooms_shrunk_by_hand(
    room: list[Ring], outline: list[Ring] | None, expected_units: int
) -> None:
    """Test against rooms shrunk by hand: 5 cm off interior axes, 15 cm off outline axes."""
    assert net_area(room, outline, 5, 15) == expected_units


def test_net_area_on_the_inch_lattice() -> None:
    """Test a 10 ft x 8 ft corner room loses 2 in inside and 3 in on the facade."""
    room = [[(0, 0), (120, 0), (120, 96), (0, 96)]]
    outline = [[(0, 0), (480, 0), (480, 480), (0, 480)]]
    assert net_area(room, outline, US.interior_inset_units, US.exterior_inset_units) == (
        (120 - 3 - 2) * (96 - 3 - 2)
    )


def test_net_area_of_triangle_is_exact_at_diagonal_corners() -> None:
    """Test against the similar triangle: shrunk by d it scales by 1 - d / r (inradius r)."""
    legs, inset = 400, 5
    inradius = (2 * legs - legs * math.sqrt(2)) / 2
    expected = legs * legs / 2 * (1 - inset / inradius) ** 2
    assert net_area([[(0, 0), (legs, 0), (0, legs)]], None, inset, inset) == pytest.approx(
        expected, rel=1e-9
    )


def test_net_area_of_a_ring_folding_back_stays_within_the_gross_area() -> None:
    """Test a stored ring that folds straight back, which writes reject, still measures."""
    room = [[(0, 0), (1000, 0), (500, 0), (0, 500)]]
    assert 0 <= net_area(room, None, 5, 15) <= 1000 * 500 / 2


@pytest.mark.parametrize(
    ("other", "expected_units"),
    [
        (box(4, 0, 8, 3), 300),
        (box(4, 1, 8, 2), 100),
        ([[(401, 0), (800, 0), (800, 300), (401, 300)]], 0),
        (box(4, 3, 8, 6), 0),
        ([[(400, -100), (800, -100), (800, 400), (400, 400)]], 300),
    ],
    ids=["full_edge", "partial_edge", "one_unit_apart", "corner", "longer_neighbour"],
)
def test_shared_edge_length(other: list[Ring], expected_units: int) -> None:
    """Test shared wall axes between neighbouring rooms, exact on the lattice."""
    room = box(0, 0, 4, 3)
    assert shared_edge_length(room, other) == expected_units
    assert shared_edge_length(other, room) == expected_units


def test_room_filling_a_hole_shares_its_whole_boundary() -> None:
    """Test a room drawn in a 4 m x 2 m hole shares all 12 m of the hole's edges."""
    outer = with_holes(box(0, 0, 10, 10), box(3, 4, 7, 6))
    assert shared_edge_length(outer, box(3, 4, 7, 6)) == 1200
    assert shared_edge_length(box(3, 4, 7, 6), outer) == 1200


def test_diagonal_shared_edge_length() -> None:
    """Test a shared diagonal wall measures its Euclidean length: 3-4-5."""
    room = [[(0, 0), (300, 400), (0, 400)]]
    other = [[(0, 0), (300, 0), (300, 400)]]
    assert shared_edge_length(room, other) == pytest.approx(500)


COURTYARD = with_holes(box(0, 0, 10, 10), box(3, 3, 6, 5))
L_OUTLINE = [ring((0, 0), (10, 0), (10, 4), (4, 4), (4, 10), (0, 10))]


@pytest.mark.parametrize(
    ("room", "outline", "relation"),
    [
        (box(1, 1, 3, 2), box(0, 0, 10, 10), "inside"),
        (box(0, 0, 4, 3), box(0, 0, 10, 10), "inside"),
        (box(0, 0, 10, 10), box(0, 0, 10, 10), "inside"),
        (box(10, 0, 14, 3), box(0, 0, 10, 10), "outside"),
        (box(10, 10, 14, 13), box(0, 0, 10, 10), "outside"),
        (box(20, 20, 30, 30), box(0, 0, 10, 10), "outside"),
        (box(8, 0, 14, 3), box(0, 0, 10, 10), "crossing"),
        (box(-2, -2, 12, 12), box(0, 0, 10, 10), "crossing"),
        (box(3, 3, 6, 5), COURTYARD, "outside"),
        (box(2, 2, 7, 6), COURTYARD, "crossing"),
        (box(0, 0, 3, 3), COURTYARD, "inside"),
        (box(4, 4, 8, 8), L_OUTLINE, "outside"),
        (box(2, 2, 8, 8), L_OUTLINE, "crossing"),
        ([ring((0, 0), (2, 0), (6, 8), (4, 10), (0, 10))], L_OUTLINE, "crossing"),
        (box(0, 0, 4, 4), L_OUTLINE, "inside"),
    ],
    ids=[
        "inside",
        "inside_touching_two_edges",
        "is_the_outline",
        "outside_along_an_edge",
        "outside_touching_a_corner",
        "apart",
        "across_an_edge",
        "around_the_building",
        "fills_the_courtyard",
        "around_the_courtyard",
        "beside_the_courtyard",
        "in_the_notch",
        "over_the_notch",
        "edge_through_the_reflex_corner",
        "in_the_corner_of_the_l",
    ],
)
def test_outline_relation(room: list[Ring], outline: list[Ring], relation: str) -> None:
    """Test rooms against outlines drawn by hand; touching is allowed on either side."""
    assert outline_relation(room, outline) == relation


@pytest.mark.parametrize(
    ("x", "y", "inside"),
    [(5, 5, True), (11, 5, False), (3, 3, False), (1, 3, True)],
    ids=["inside", "outside", "in_hole", "beside_hole"],
)
def test_contains(x: float, y: float, inside: bool) -> None:
    """Test point-in-polygon with a hole; points exactly on edges are unspecified."""
    polygon = with_holes(box(0, 0, 10, 10), box(2, 2, 4, 4))
    assert contains(polygon, (x * 100 + 0.5, y * 100 + 0.5)) is inside


def test_validate_polygon_accepts_rectangle() -> None:
    """Test a valid polygon is returned unchanged."""
    polygon = rect(0, 0, 4, 3)
    assert validate_polygon(polygon) == polygon


@pytest.mark.parametrize(
    "polygon",
    [
        {"type": "MultiPolygon", "coordinates": [rect(0, 0, 1, 1)["coordinates"]]},
        {"type": "Polygon", "coordinates": []},
        {"type": "Polygon", "coordinates": [[lonlat(0, 0), lonlat(1, 0), lonlat(0, 0)]]},
        {
            "type": "Polygon",
            "coordinates": [[lonlat(0, 0), lonlat(1, 0), lonlat(1, 1), lonlat(0, 1)]],
        },
        {"type": "Polygon", "coordinates": [[[200, 0], [201, 0], [201, 1], [200, 0]]]},
        {"type": "Polygon", "coordinates": [[["a", 0], [1, 0], [1, 1], ["a", 0]]]},
    ],
    ids=["multipolygon", "empty", "too_few_points", "not_closed", "out_of_range", "not_numeric"],
)
def test_validate_polygon_rejects(polygon: dict) -> None:
    """Test invalid polygons are rejected."""
    with pytest.raises(ValueError):
        validate_polygon(polygon)


@pytest.mark.parametrize(
    "polygon",
    [
        with_holes(box(0, 0, 10, 10), box(2, 2, 4, 4), box(6, 6, 8, 8)),
        with_holes(box(0, 0, 10, 10), box(2, 2, 4, 4), box(4, 4, 6, 6)),
        [box(0, 0, 10, 10)[0], ring((0, 5), (3, 3), (3, 7))],
        [ring((0, 0), (5, 0), (10, 0), (10, 10), (0, 10))],
        [
            box(0, 0, 10, 10)[0],
            ring((0, 5), (3, 3), (5, 5), (3, 7)),
            ring((5, 5), (7, 3), (9, 5), (7, 7)),
        ],
        [circle(500)],
        [ring((0, 0), (4, 0), (0, 4))],
        [ring((0, 0), (4, 0), (4, 4), (2, 2), (0, 4))],
        [ring((0, 0), (0.1, 0), (0.1, 0.1), (0, 0.1))],
    ],
    ids=[
        "two_holes",
        "holes_touch_at_a_corner",
        "hole_touches_outline",
        "straight_corner",
        "touching_holes_leave_a_way_round",
        "most_corners",
        "corners_of_45_degrees",
        "reflex_corner_of_270_degrees",
        "edges_of_one_grid_step",
    ],
)
def test_validate_lattice_polygon_accepts(polygon: list[Ring]) -> None:
    """Test valid polygons with holes, and rings touching in single points, are accepted."""
    validate_lattice_polygon(polygon)


@pytest.mark.parametrize(
    ("polygon", "message"),
    [
        ([ring((0, 0), (4, 0), (0, 3), (4, 3))], "A ring crosses itself"),
        ([ring((0, 0), (4, 0), (4, 3), (2, 0), (0, 3))], "A ring crosses itself"),
        ([ring((0, 0), (4, 0), (2, 0))], "A ring crosses itself"),
        ([ring((0, 0), (4, 0))], "A ring needs at least three corners"),
        (with_holes(box(0, 0, 10, 10), box(8, 2, 12, 4)), "Rings must not cross or share an edge"),
        (with_holes(box(0, 0, 10, 10), box(0, 2, 2, 4)), "Rings must not cross or share an edge"),
        (
            with_holes(box(0, 0, 10, 10), box(2, 2, 4, 4), box(3, 3, 5, 5)),
            "Rings must not cross or share an edge",
        ),
        (
            with_holes(box(0, 0, 10, 10), box(2, 2, 4, 4), box(2, 2, 4, 4)),
            "Rings must not cross or share an edge",
        ),
        (with_holes(box(0, 0, 10, 10), box(12, 2, 14, 4)), "A hole must lie inside the outline"),
        (
            # Corners on the L's inner walls, the edge between them across the notch.
            [
                ring((0, 0), (6, 0), (6, 3), (3, 3), (3, 6), (0, 6)),
                ring((1, 1), (4.5, 3), (3, 4.5)),
            ],
            "A hole must lie inside the outline",
        ),
        (
            with_holes(box(0, 0, 10, 10), box(2, 2, 6, 6), box(3, 3, 4, 4)),
            "A hole must not lie inside another hole",
        ),
        (
            # The top edge passes through the corners of a V-shaped notch; its
            # corners and midpoint are inside, the piece across the notch is not.
            [
                ring((0, 0), (10, 0), (10, 10), (6, 10), (6, 5), (5, 3), (4, 5), (4, 10), (0, 10)),
                ring((1, 5), (6.5, 5), (6.5, 1), (1, 1)),
            ],
            "A hole must lie inside the outline",
        ),
        (
            [box(0, 0, 10, 10)[0], ring((5, 0), (7, 5), (5, 10), (3, 5))],
            "Holes must not split the area",
        ),
        (
            [
                box(0, 0, 10, 10)[0],
                ring((0, 5), (3, 3), (5, 5), (3, 7)),
                ring((5, 5), (7, 3), (10, 5), (7, 7)),
            ],
            "Holes must not split the area",
        ),
        ([circle(501)], "A polygon may have at most 500 corners"),
        ([ring((0, 0), (4, 0), (0, 3.9))], "A corner must be between 45 and 315 degrees"),
        (
            [ring((0, 0), (10, 0), (10, 10), (6, 10), (5, 2), (4, 10), (0, 10))],
            "A corner must be between 45 and 315 degrees",
        ),
    ],
    ids=[
        "bowtie",
        "ring_touches_itself",
        "ring_folds_back",
        "collapsed",
        "hole_crosses_outline",
        "hole_shares_outline_edge",
        "holes_cross",
        "same_hole_twice",
        "hole_outside",
        "hole_between_outline_corners",
        "hole_in_hole",
        "hole_edge_crosses_notch",
        "hole_touches_outline_twice",
        "touching_holes_bridge_outline",
        "too_many_corners",
        "spike",
        "reflex_spike",
    ],
)
def test_validate_lattice_polygon_rejects(polygon: list[Ring], message: str) -> None:
    """Test each kind of invalid ring is rejected with its own message."""
    with pytest.raises(ValueError, match=f"^{message}$"):
        validate_lattice_polygon(polygon)


def test_minimum_edge_on_the_lattice() -> None:
    """Test an edge is kept from 4 lattice units, on a diagonal too (3, 3 is 4.24 long)."""
    validate_lattice_polygon([[(0, 0), (10, 0), (10, 10), (3, 10), (0, 7)]])
    with pytest.raises(ValueError, match="^An edge must be at least one grid step$"):
        validate_lattice_polygon([[(0, 0), (10, 0), (10, 10), (2, 10), (0, 7)]])


@pytest.mark.parametrize(
    ("p1", "p2", "p3", "p4", "meet"),
    [
        ((0, 0), (2, 2), (0, 2), (2, 0), True),
        ((1, 0), (1, 2), (0, 0), (2, 0), True),
        ((1, 2), (1, 0), (0, 0), (2, 0), True),
        ((0, 0), (2, 0), (1, 0), (1, 2), True),
        ((0, 0), (2, 0), (1, 2), (1, 0), True),
        ((0, 0), (2, 0), (3, 0), (4, 0), False),
        ((0, 0), (2, 0), (0, 1), (2, 1), False),
    ],
    ids=["cross", "p1_on", "p2_on", "p3_on", "p4_on", "collinear_apart", "parallel"],
)
def test_segments_intersect(
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    p4: tuple[float, float],
    meet: bool,
) -> None:
    """Test the port of SEGMENTS-INTERSECT on segments drawn by hand, each touch case once.

    Ring validation cannot reach every branch: an earlier pair of edges always meets first.
    """
    assert _segments_intersect(p1, p2, p3, p4) is meet


def test_lattice_and_half_walls_follow_the_grid() -> None:
    """Test the lattice is a quarter grid step and the half walls whole units of it."""
    assert METRIC.lattice_unit_m == Fraction(1, 40)
    assert US.lattice_unit_m * 10000 == 254
    assert (METRIC.interior_inset_units, METRIC.exterior_inset_units) == (2, 6)
    assert (US.interior_inset_units, US.exterior_inset_units) == (2, 3)
