"""Tests for the pure-Python geometry helpers."""

import pytest
from homeassistant.util.location import vincenty

from custom_components.spatial.geometry import (
    net_area_m2,
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
