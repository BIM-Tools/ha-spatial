"""Pure-Python geometry for GeoJSON polygons in WGS84.

Each function is either a canonical algorithm (source cited, kept close to
the reference so it can be checked against it) or marked as custom.
Lengths and areas are measured in a local tangent plane around the polygon,
never in a map projection.
"""

from __future__ import annotations

import math
from itertools import pairwise
from numbers import Real
from typing import Any

type Point = tuple[float, float]
type Ring = list[Point]

# WGS84 semi-major axis and first eccentricity squared (EPSG:7030).
WGS84_A = 6378137.0
WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)


def metres_per_degree(lat: float) -> tuple[float, float]:
    """Return metres per degree of longitude and latitude on the WGS84 ellipsoid.

    Standard radii of curvature: prime vertical N = a / sqrt(1 - e² sin²φ) and
    meridian M = a (1 - e²) / (1 - e² sin²φ)^(3/2); see IOGP Guidance Note 7-2
    (EPSG), section on ellipsoid radii.
    """
    sin_lat = math.sin(math.radians(lat))
    w = 1 - WGS84_E2 * sin_lat * sin_lat
    prime_vertical_radius = WGS84_A / math.sqrt(w)
    meridian_radius = WGS84_A * (1 - WGS84_E2) / (w * math.sqrt(w))
    return (
        math.radians(prime_vertical_radius * math.cos(math.radians(lat))),
        math.radians(meridian_radius),
    )


def _origin(polygon: dict[str, Any]) -> tuple[float, float]:
    """Return the first vertex of a polygon."""
    return polygon["coordinates"][0][0][0], polygon["coordinates"][0][0][1]


def _rings_m(polygon: dict[str, Any], lon0: float, lat0: float) -> list[Ring]:
    """Return the polygon's rings in metres east/north of (lon0, lat0)."""
    m_per_deg_lon, m_per_deg_lat = metres_per_degree(lat0)
    return [
        [((lon - lon0) * m_per_deg_lon, (lat - lat0) * m_per_deg_lat) for lon, lat, *_ in ring]
        for ring in polygon["coordinates"]
    ]


def _shoelace_area(ring: Ring) -> float:
    """Return the unsigned area of a closed ring (shoelace formula)."""
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in pairwise(ring))) / 2


def _pnpoly(vertx: list[float], verty: list[float], testx: float, testy: float) -> bool:
    """Return True if the test point is inside the polygon (even-odd rule).

    Line-for-line port of PNPOLY, https://wrfranklin.org/Research/Short_Notes/pnpoly.html

    Copyright (c) 1970-2003, Wm. Randolph Franklin

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to
    deal in the Software without restriction, including without limitation the
    rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
    sell copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
    1. Redistributions of source code must retain the above copyright notice,
       this list of conditions and the following disclaimers.
    2. Redistributions in binary form must reproduce the above copyright notice
       in the documentation and/or other materials provided with the
       distribution.
    3. The name of W. Randolph Franklin may not be used to endorse or promote
       products derived from this Software without specific prior written
       permission.
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
    IN THE SOFTWARE.
    """
    nvert = len(vertx)
    c = False
    j = nvert - 1
    for i in range(nvert):
        if (verty[i] > testy) != (verty[j] > testy) and (
            testx < (vertx[j] - vertx[i]) * (testy - verty[i]) / (verty[j] - verty[i]) + vertx[i]
        ):
            c = not c
        j = i
    return c


def validate_polygon(value: Any) -> dict[str, Any]:
    """Return value if it is a valid GeoJSON Polygon, else raise ValueError.

    Checks RFC 7946 section 3.1.6 (linear rings: closed, at least four
    positions) and 4 (WGS84 longitude, latitude). Only Polygon is accepted:
    one area is one polygon.
    """
    if not isinstance(value, dict) or value.get("type") != "Polygon":
        raise ValueError("Expected a GeoJSON Polygon")
    rings = value.get("coordinates")
    if not isinstance(rings, list) or not rings:
        raise ValueError("A polygon needs at least one ring")
    for ring in rings:
        if not isinstance(ring, list) or len(ring) < 4:
            raise ValueError("A ring needs at least four positions")
        for position in ring:
            if (
                not isinstance(position, list)
                or len(position) not in (2, 3)
                or not all(isinstance(c, Real) and not isinstance(c, bool) for c in position)
            ):
                raise ValueError("A position must be [longitude, latitude]")
            if not (-180 <= position[0] <= 180 and -90 <= position[1] <= 90):
                raise ValueError("Coordinates must be WGS84 longitude and latitude")
        if ring[0] != ring[-1]:
            raise ValueError("A ring must be closed")
    return value


def _perimeter(ring: Ring) -> float:
    """Return the length of a closed ring."""
    return sum(math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in pairwise(ring))


def net_area_m2(polygon: dict[str, Any], inset_m: float) -> float:
    """Return the area in square metres of a polygon shrunk by inset_m on every side.

    Custom, from Steiner's formula for a parallel body: shrinking a polygon with
    area A and perimeter P by d leaves A - P * d + 4 * d * d (convex minus reflex
    corners is always four for a simple ring; the d² term is exact for right
    angles). A hole grows by d, so it takes away A + P * d + 4 * d * d. Exact for
    right-angled polygons; with diagonal walls the corner term is an approximation.
    A shape thinner than twice inset_m has no net area: the result is clamped to zero.
    A part narrower than twice inset_m within a larger shape is miscounted, because the
    formula assumes the shape keeps its topology.
    """
    exterior, *holes = _rings_m(polygon, *_origin(polygon))
    corners = 4 * inset_m * inset_m
    area = _shoelace_area(exterior) - _perimeter(exterior) * inset_m + corners
    for hole in holes:
        area -= _shoelace_area(hole) + _perimeter(hole) * inset_m + corners
    return max(area, 0.0)


def polygon_contains(polygon: dict[str, Any], lon: float, lat: float) -> bool:
    """Return True if the point is inside the polygon and not inside a hole.

    Uses PNPOLY directly on longitude/latitude, which is exact enough at the
    scale of a building. Points exactly on an edge may fall either way; on a
    shared wall centreline a point belongs to both rooms anyway.
    """
    inside = False
    for ring in polygon["coordinates"]:
        if _pnpoly([p[0] for p in ring], [p[1] for p in ring], lon, lat):
            inside = not inside
    return inside


def shared_edge_length_m(
    polygon_a: dict[str, Any], polygon_b: dict[str, Any], tolerance_m: float
) -> float:
    """Return the length in metres along which the boundaries of two polygons coincide.

    Custom (no library equivalent without shapely): an edge of polygon_b lies
    on an edge of polygon_a when both its end points are within tolerance_m of
    the line through that edge; the shared length is their overlap along it.
    """
    origin = _origin(polygon_a)
    edges_a = [edge for ring in _rings_m(polygon_a, *origin) for edge in pairwise(ring)]
    edges_b = [edge for ring in _rings_m(polygon_b, *origin) for edge in pairwise(ring)]

    total = 0.0
    for (ax1, ay1), (ax2, ay2) in edges_a:
        length = math.hypot(ax2 - ax1, ay2 - ay1)
        if length == 0:
            continue
        ux, uy = (ax2 - ax1) / length, (ay2 - ay1) / length
        for b1, b2 in edges_b:
            along = [(bx - ax1) * ux + (by - ay1) * uy for bx, by in (b1, b2)]
            across = [abs((by - ay1) * ux - (bx - ax1) * uy) for bx, by in (b1, b2)]
            if max(across) <= tolerance_m:
                total += max(0.0, min(length, max(along)) - max(0.0, min(along)))
    return total
