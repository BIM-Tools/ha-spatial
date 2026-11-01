"""Checks the geometry against independent references, never against the same formula."""

import math
from typing import Any

import pytest
from homeassistant.util.location import vincenty

from custom_components.spatial.geometry import (
    _clip_to_convex,
    _segments_intersect,
    net_area_m2,
    overlap_area_m2,
    polygon_contains,
    shared_edge_length_m,
    validate_polygon,
)

from .common import lonlat, rect


def test_area_of_rectangle() -> None:
    """Test a 10 m x 5 m rectangle at 52°N measures 50 m²."""
    assert net_area_m2(rect(0, 0, 10, 5), 0) == pytest.approx(50, rel=0.001)


def test_area_subtracts_holes() -> None:
    """Test interior rings are subtracted."""
    polygon = rect(0, 0, 10, 10)
    polygon["coordinates"].append(rect(2, 2, 4, 4)["coordinates"][0])
    assert net_area_m2(polygon, 0) == pytest.approx(96, rel=0.001)


@pytest.mark.parametrize(
    ("x", "y", "inside"),
    [(5, 5, True), (11, 5, False), (3, 3, False), (1, 3, True)],
    ids=["inside", "outside", "in_hole", "beside_hole"],
)
def test_contains(x: float, y: float, inside: bool) -> None:
    """Test point-in-polygon with a hole; points exactly on edges are unspecified."""
    polygon = rect(0, 0, 10, 10)
    polygon["coordinates"].append(rect(2, 2, 4, 4)["coordinates"][0])
    assert polygon_contains(polygon, *lonlat(x, y)) is inside


@pytest.mark.parametrize(
    ("other", "expected_m"),
    [
        (rect(4, 0, 8, 3), 3.0),  # shares the full 3 m centreline edge
        (rect(4, 1, 8, 2), 1.0),  # shares part of the edge
        (rect(4.03, 0, 8, 3), 3.0),  # 3 cm gap: within tolerance
        (rect(4.2, 0, 8, 3), 0.0),  # 20 cm gap: not adjacent
        (rect(4, 3, 8, 6), 0.0),  # touches only at a corner
    ],
    ids=["full_edge", "partial_edge", "small_gap", "large_gap", "corner"],
)
def test_shared_edge_length(other: dict, expected_m: float) -> None:
    """Test shared edge length between neighbouring rooms drawn to wall centrelines."""
    room = rect(0, 0, 4, 3)
    assert shared_edge_length_m(room, other, tolerance_m=0.05) == pytest.approx(
        expected_m, abs=0.01
    )
    assert shared_edge_length_m(other, room, tolerance_m=0.05) == pytest.approx(
        expected_m, abs=0.01
    )


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


@pytest.mark.parametrize("lat", [0.0, 38.0, 52.0, 60.0, 70.0])
def test_area_matches_geodesic_lengths(lat: float) -> None:
    """Test m² against HA's Vincenty geodesic, an independent implementation.

    Vincenty is rounded to whole millimetres, which limits the tolerance.
    """
    lon, d_lon, d_lat = 5.0, 0.0002, 0.0001
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [
                [lon, lat],
                [lon + d_lon, lat],
                [lon + d_lon, lat + d_lat],
                [lon, lat + d_lat],
                [lon, lat],
            ]
        ],
    }
    mid_lat = lat + d_lat / 2
    width_m = vincenty((mid_lat, lon), (mid_lat, lon + d_lon)) * 1000
    height_m = vincenty((lat, lon), (lat + d_lat, lon)) * 1000
    assert net_area_m2(polygon, 0) == pytest.approx(width_m * height_m, rel=1e-4)


def test_net_area_of_rectangle() -> None:
    """Test a 4 m x 3 m rectangle shrunk by 50 mm: 12 - 14 * 0.05 + 4 * 0.05²."""
    assert net_area_m2(rect(0, 0, 4, 3), 0.05) == pytest.approx(11.31, rel=1e-3)


def test_net_area_of_l_shape() -> None:
    """Test an L-shape (5 convex corners, 1 reflex): 27 - 24 * 0.05 + 4 * 0.05²."""
    corners = [(0, 0), (6, 0), (6, 3), (3, 3), (3, 6), (0, 6), (0, 0)]
    polygon = {"type": "Polygon", "coordinates": [[lonlat(x, y) for x, y in corners]]}
    assert net_area_m2(polygon, 0.05) == pytest.approx(25.81, rel=1e-3)


def test_net_area_grows_holes() -> None:
    """Test the inset grows a hole: 100 - 40 * 0.05 + 0.01 minus (4 + 8 * 0.05 + 0.01)."""
    polygon = rect(0, 0, 10, 10)
    polygon["coordinates"].append(rect(2, 2, 4, 4)["coordinates"][0])
    assert net_area_m2(polygon, 0.05) == pytest.approx(93.6, rel=1e-3)


def test_net_area_of_thin_strip_is_zero() -> None:
    """Test a strip narrower than twice the inset has no net area, never a negative one."""
    assert net_area_m2(rect(0, 0, 10, 0.05), 0.05) == 0


def with_holes(shell: dict[str, Any], *holes: dict[str, Any]) -> dict[str, Any]:
    """Return the shell polygon with the outer rings of holes added as inner rings."""
    return {
        "type": "Polygon",
        "coordinates": shell["coordinates"] + [hole["coordinates"][0] for hole in holes],
    }


def ring(*corners: tuple[float, float]) -> list[list[float]]:
    """Return a closed ring through corners given in metres from the origin."""
    return [lonlat(x, y) for x, y in (*corners, corners[0])]


def circle(corner_count: int) -> list[tuple[float, float]]:
    """Return the corners of a regular polygon with a 10 m radius."""
    return [
        (
            10 * math.cos(2 * math.pi * k / corner_count),
            10 * math.sin(2 * math.pi * k / corner_count),
        )
        for k in range(corner_count)
    ]


def test_net_area_of_hole_matches_shrunk_rectangles() -> None:
    """Test against the inset drawn by hand: (10 - 0.1)² minus (4 + 0.1) x (2 + 0.1)."""
    polygon = with_holes(rect(0, 0, 10, 10), rect(3, 4, 7, 6))
    assert net_area_m2(polygon, 0) == pytest.approx(100 - 8, rel=1e-4)
    assert net_area_m2(polygon, 0.05) == pytest.approx(9.9 * 9.9 - 4.1 * 2.1, rel=1e-4)


def test_room_filling_a_hole_shares_its_whole_boundary() -> None:
    """Test a room drawn in a 4 m x 2 m hole shares all 12 m of the hole's edges."""
    outer = with_holes(rect(0, 0, 10, 10), rect(3, 4, 7, 6))
    inner = rect(3, 4, 7, 6)
    assert shared_edge_length_m(outer, inner, tolerance_m=0.05) == pytest.approx(12, abs=0.01)
    assert shared_edge_length_m(inner, outer, tolerance_m=0.05) == pytest.approx(12, abs=0.01)


@pytest.mark.parametrize(
    "polygon",
    [
        with_holes(rect(0, 0, 10, 10), rect(2, 2, 4, 4), rect(6, 6, 8, 8)),
        with_holes(rect(0, 0, 10, 10), rect(2, 2, 4, 4), rect(4, 4, 6, 6)),
        {
            "type": "Polygon",
            "coordinates": [rect(0, 0, 10, 10)["coordinates"][0], ring((0, 5), (3, 3), (3, 7))],
        },
        {"type": "Polygon", "coordinates": [ring((0, 0), (5, 0), (10, 0), (10, 10), (0, 10))]},
        {
            "type": "Polygon",
            "coordinates": [
                rect(0, 0, 10, 10)["coordinates"][0],
                ring((0, 5), (3, 3), (5, 5), (3, 7)),
                ring((5, 5), (7, 3), (9, 5), (7, 7)),
            ],
        },
        {"type": "Polygon", "coordinates": [ring(*circle(500))]},
    ],
    ids=[
        "two_holes",
        "holes_touch_at_a_corner",
        "hole_touches_outline",
        "straight_corner",
        "touching_holes_leave_a_way_round",
        "most_corners",
    ],
)
def test_validate_polygon_accepts(polygon: dict) -> None:
    """Test valid polygons with holes, and rings touching in single points, are accepted."""
    assert validate_polygon(polygon) == polygon


@pytest.mark.parametrize(
    ("polygon", "message"),
    [
        (
            {"type": "Polygon", "coordinates": [ring((0, 0), (4, 0), (0, 3), (4, 3))]},
            "A ring crosses itself",
        ),
        (
            {"type": "Polygon", "coordinates": [ring((0, 0), (4, 0), (4, 3), (2, 0), (0, 3))]},
            "A ring crosses itself",
        ),
        (
            {"type": "Polygon", "coordinates": [ring((0, 0), (4, 0), (2, 0))]},
            "A ring crosses itself",
        ),
        (
            {"type": "Polygon", "coordinates": [ring((0, 0), (4, 0), (0, 0), (0, 0))]},
            "A ring needs at least three corners",
        ),
        (
            with_holes(rect(0, 0, 10, 10), rect(8, 2, 12, 4)),
            "Rings must not cross or share an edge",
        ),
        (
            with_holes(rect(0, 0, 10, 10), rect(0, 2, 2, 4)),
            "Rings must not cross or share an edge",
        ),
        (
            with_holes(rect(0, 0, 10, 10), rect(2, 2, 4, 4), rect(3, 3, 5, 5)),
            "Rings must not cross or share an edge",
        ),
        (
            with_holes(rect(0, 0, 10, 10), rect(2, 2, 4, 4), rect(2, 2, 4, 4)),
            "Rings must not cross or share an edge",
        ),
        (
            with_holes(rect(0, 0, 10, 10), rect(12, 2, 14, 4)),
            "A hole must lie inside the outline",
        ),
        (
            # Corners on the L's inner walls, the edge between them across the notch.
            {
                "type": "Polygon",
                "coordinates": [
                    ring((0, 0), (6, 0), (6, 3), (3, 3), (3, 6), (0, 6)),
                    ring((1, 1), (4.5, 3), (3, 4.5)),
                ],
            },
            "A hole must lie inside the outline",
        ),
        (
            with_holes(rect(0, 0, 10, 10), rect(2, 2, 6, 6), rect(3, 3, 4, 4)),
            "A hole must not lie inside another hole",
        ),
        (
            # The top edge passes through the corners of a V-shaped notch; its
            # corners and midpoint are inside, the piece across the notch is not.
            {
                "type": "Polygon",
                "coordinates": [
                    ring(
                        (0, 0), (10, 0), (10, 10), (6, 10), (6, 5), (5, 3), (4, 5), (4, 10), (0, 10)
                    ),
                    ring((1, 5), (6.5, 5), (6.5, 1), (1, 1)),
                ],
            },
            "A hole must lie inside the outline",
        ),
        (
            {
                "type": "Polygon",
                "coordinates": [
                    rect(0, 0, 10, 10)["coordinates"][0],
                    ring((5, 0), (7, 5), (5, 10), (3, 5)),
                ],
            },
            "Holes must not split the area",
        ),
        (
            {
                "type": "Polygon",
                "coordinates": [
                    rect(0, 0, 10, 10)["coordinates"][0],
                    ring((0, 5), (3, 3), (5, 5), (3, 7)),
                    ring((5, 5), (7, 3), (10, 5), (7, 7)),
                ],
            },
            "Holes must not split the area",
        ),
        (
            {"type": "Polygon", "coordinates": [ring(*circle(501))]},
            "A polygon may have at most 500 corners",
        ),
    ],
    ids=[
        "bowtie",
        "ring_touches_itself",
        "ring_folds_back",
        "repeated_corners",
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
    ],
)
def test_validate_polygon_rejects_bad_rings(polygon: dict, message: str) -> None:
    """Test each kind of invalid ring is rejected with its own message."""
    with pytest.raises(ValueError, match=f"^{message}$"):
        validate_polygon(polygon)


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


def _with_hole(shell: dict[str, Any], hole: dict[str, Any]) -> dict[str, Any]:
    """Return the shell polygon with the outer ring of hole added as an inner ring."""
    return {"type": "Polygon", "coordinates": shell["coordinates"] + hole["coordinates"]}


def _reversed(polygon: dict[str, Any]) -> dict[str, Any]:
    """Return the polygon with every ring walked the other way round."""
    return {"type": "Polygon", "coordinates": [ring[::-1] for ring in polygon["coordinates"]]}


L_SHAPE = {
    "type": "Polygon",
    "coordinates": [
        [
            lonlat(0, 0),
            lonlat(10, 0),
            lonlat(10, 4),
            lonlat(4, 4),
            lonlat(4, 10),
            lonlat(0, 10),
            lonlat(0, 0),
        ]
    ],
}
COURTYARD = _with_hole(rect(0, 0, 10, 10), rect(3, 3, 6, 5))


@pytest.mark.parametrize(
    ("room", "outline", "expected_m2"),
    [
        (rect(0, 0, 4, 3), rect(2, 1, 10, 10), 2 * 2),
        (rect(0, 0, 4, 3), rect(0, 0, 4, 3), 4 * 3),
        (rect(0, 0, 4, 3), rect(4, 0, 8, 3), 0),
        (rect(0, 0, 4, 3), rect(20, 20, 30, 30), 0),
        (rect(1, 1, 3, 2), rect(0, 0, 10, 10), 2 * 1),
        (rect(2, 2, 8, 8), L_SHAPE, 2 * 6 + 4 * 2),
        (rect(-2, -2, 12, 12), L_SHAPE, 10 * 4 + 4 * 6),
        (rect(0, 0, 10, 10), COURTYARD, 10 * 10 - 3 * 2),
        (rect(4, 4, 8, 8), COURTYARD, 4 * 4 - 2 * 1),
        (COURTYARD, rect(0, 0, 5, 10), 5 * 10 - 2 * 2),
        (_reversed(rect(0, 0, 4, 3)), _reversed(rect(2, 1, 10, 10)), 2 * 2),
    ],
    ids=[
        "corner_overlap",
        "identical",
        "shared_edge_only",
        "apart",
        "inside",
        "rect_in_l_shape",
        "l_shape_in_rect",
        "outline_with_courtyard",
        "room_over_courtyard",
        "room_with_hole",
        "clockwise_rings",
    ],
)
def test_overlap_area_of_hand_computed_rectangles(
    room: dict[str, Any], outline: dict[str, Any], expected_m2: float
) -> None:
    """Test the common area of two polygons against rectangles summed by hand."""
    assert overlap_area_m2(room, outline) == pytest.approx(expected_m2, rel=1e-4, abs=1e-6)
    assert overlap_area_m2(outline, room) == pytest.approx(expected_m2, rel=1e-4, abs=1e-6)


@pytest.mark.parametrize(
    ("subject", "expected"),
    [
        ([(5.0, 5.0), (6.0, 5.0), (5.0, 6.0)], []),
        (
            [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)],
            [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
        ),
    ],
    ids=["apart", "square_over_corner"],
)
def test_clip_to_convex(
    subject: list[tuple[float, float]], expected: list[tuple[float, float]]
) -> None:
    """Test Sutherland-Hodgman on shapes drawn by hand, against the triangle (0,0) (2,0) (0,2)."""
    clipped = _clip_to_convex(subject, [(0.0, 0.0), (2.0, 0.0), (0.0, 2.0)])
    assert sorted(set(clipped)) == sorted(expected)
