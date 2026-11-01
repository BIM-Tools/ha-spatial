"""All geometry in one place, in pure Python, measured in a local tangent plane.

Each function is a cited canonical algorithm or marked as custom.
"""

from __future__ import annotations

import math
from itertools import combinations, pairwise
from numbers import Real
from typing import Any

type Point = tuple[float, float]
type Ring = list[Point]
type Segment = tuple[Point, Point]

# Bounds the quadratic ring checks, which run on the event loop.
MAX_CORNERS = 500

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


def _direction(pi: Point, pj: Point, pk: Point) -> float:
    """Return (pk - pi) x (pj - pi): zero when pk is on the line through pi and pj.

    Line-for-line port of DIRECTION from Cormen, Leiserson, Rivest and Stein,
    Introduction to Algorithms, 3rd edition (MIT Press, 2009), section 33.1.
    Published as pseudocode, without a licence.
    """
    return (pk[0] - pi[0]) * (pj[1] - pi[1]) - (pj[0] - pi[0]) * (pk[1] - pi[1])


def _on_segment(pi: Point, pj: Point, pk: Point) -> bool:
    """Return True if pk, collinear with pi and pj, lies on the segment between them.

    Line-for-line port of ON-SEGMENT, same source as _direction.
    """
    return min(pi[0], pj[0]) <= pk[0] <= max(pi[0], pj[0]) and min(pi[1], pj[1]) <= pk[1] <= max(
        pi[1], pj[1]
    )


def _segments_intersect(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """Return True if the segments p1-p2 and p3-p4 have at least one point in common.

    Line-for-line port of SEGMENTS-INTERSECT, same source as _direction; the
    noqa markers keep the textbook's branch structure.
    """
    d1 = _direction(p3, p4, p1)
    d2 = _direction(p3, p4, p2)
    d3 = _direction(p1, p2, p3)
    d4 = _direction(p1, p2, p4)
    if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and (  # noqa: SIM114
        (d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)
    ):
        return True
    elif d1 == 0 and _on_segment(p3, p4, p1):  # noqa: SIM114
        return True
    elif d2 == 0 and _on_segment(p3, p4, p2):  # noqa: SIM114
        return True
    elif d3 == 0 and _on_segment(p1, p2, p3):  # noqa: SIM114
        return True
    elif d4 == 0 and _on_segment(p1, p2, p4):  # noqa: SIM103
        return True
    else:
        return False


def _segments_cross_or_overlap(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """Return True if two segments cross each other or run along each other.

    Custom, built on _direction: touching in a single point is allowed, as
    rings of a polygon may touch in points. Segments must have a length.
    """
    d1 = _direction(p3, p4, p1)
    d2 = _direction(p3, p4, p2)
    d3 = _direction(p1, p2, p3)
    d4 = _direction(p1, p2, p4)
    if d1 * d2 < 0 and d3 * d4 < 0:
        return True
    if d1 != 0 or d2 != 0:
        return False
    # Collinear: compare extents along the axis on which they are longest, so a
    # vertical pair is not compared on its zero-width x extent.
    widths = abs(p2[0] - p1[0]) + abs(p4[0] - p3[0])
    heights = abs(p2[1] - p1[1]) + abs(p4[1] - p3[1])
    axis = 0 if widths >= heights else 1
    return max(min(p1[axis], p2[axis]), min(p3[axis], p4[axis])) < min(
        max(p1[axis], p2[axis]), max(p3[axis], p4[axis])
    )


def _corners(ring: list[list[float]]) -> Ring:
    """Return the corners of a closed ring, without repeated positions or the closing one."""
    corners: Ring = []
    for lon, lat, *_ in ring[:-1]:
        if not corners or corners[-1] != (lon, lat):
            corners.append((lon, lat))
    if len(corners) > 1 and corners[0] == corners[-1]:
        corners.pop()
    return corners


def _on_boundary(point: Point, edges: list[Segment]) -> bool:
    """Return True if the point lies exactly on one of the edges."""
    return any(_direction(a, b, point) == 0 and _on_segment(a, b, point) for a, b in edges)


def _inside(point: Point, corners: Ring) -> bool:
    """Return True if the point is inside the ring given by its corners."""
    return _pnpoly([c[0] for c in corners], [c[1] for c in corners], *point)


def _piece_midpoints(edge: tuple[Point, Point], cut_points: Ring) -> Ring:
    """Return the midpoints of the pieces into which the cut points on the edge split it."""
    start, end = edge
    axis = 0 if abs(end[0] - start[0]) >= abs(end[1] - start[1]) else 1
    cuts = sorted(
        {0.0, 1.0}
        | {
            (point[axis] - start[axis]) / (end[axis] - start[axis])
            for point in cut_points
            if _direction(start, end, point) == 0 and _on_segment(start, end, point)
        }
    )
    return [
        (
            start[0] + (end[0] - start[0]) * (low + high) / 2,
            start[1] + (end[1] - start[1]) * (low + high) / 2,
        )
        for low, high in pairwise(cuts)
    ]


def _touches_split_interior(ring_corners: list[Ring], ring_edges: list[list[Segment]]) -> bool:
    """Return True if the points where rings touch cut the polygon's interior in parts.

    Custom. Rings that only touch meet in corners of one ring lying on the other.
    In the graph linking each ring to the points it touches, the interior is
    connected exactly when there is no cycle (the OGC simple features rule for a
    connected interior); a cycle is found with union-find.
    """
    incidences: set[tuple[int, Point]] = set()
    for (a, corners_a), (b, corners_b) in combinations(enumerate(ring_corners), 2):
        touch_points = {p for p in corners_a if _on_boundary(p, ring_edges[b])} | {
            p for p in corners_b if _on_boundary(p, ring_edges[a])
        }
        incidences |= {(ring, p) for p in touch_points for ring in (a, b)}

    parent: dict[object, object] = {}

    def root(node: object) -> object:
        while parent.setdefault(node, node) != node:
            node = parent[node]
        return node

    for ring, point in incidences:
        ring_root, point_root = root(ring), root(point)
        if ring_root == point_root:
            return True
        parent[ring_root] = point_root
    return False


def _validate_rings(rings: list[list[list[float]]]) -> None:
    """Raise ValueError unless the rings form a valid polygon with holes.

    Custom. Every ring must be simple: no two of its edges meet, except
    neighbours at their shared corner. Two rings must not cross or run along
    each other, and the points where they touch must not split the interior.
    Every hole must lie inside the outline and outside the other holes, probed
    at its corners and at the middle of each piece of its edges between points
    where other rings touch them (the only places an edge can pass to the other
    side), skipping probes on the other ring.

    Known limit: tests are exact in longitude and latitude, so a corner meant
    to lie on another ring but off by rounding counts as off it. Time grows with
    the square of the number of corners, hence MAX_CORNERS.
    """
    ring_corners = [_corners(ring) for ring in rings]
    if any(len(corners) < 3 for corners in ring_corners):
        raise ValueError("A ring needs at least three corners")
    if sum(len(corners) for corners in ring_corners) > MAX_CORNERS:
        raise ValueError(f"A polygon may have at most {MAX_CORNERS} corners")
    ring_edges = [list(pairwise([*corners, corners[0]])) for corners in ring_corners]

    for edges in ring_edges:
        last = len(edges) - 1
        for i, j in combinations(range(len(edges)), 2):
            neighbours = j == i + 1 or (i == 0 and j == last)
            meet = _segments_cross_or_overlap if neighbours else _segments_intersect
            if meet(*edges[i], *edges[j]):
                raise ValueError("A ring crosses itself")

    for edges_a, edges_b in combinations(ring_edges, 2):
        if any(_segments_cross_or_overlap(*a, *b) for a in edges_a for b in edges_b):
            raise ValueError("Rings must not cross or share an edge")

    shell_corners, *hole_corners = ring_corners
    shell_edges, *hole_edges = ring_edges
    for index, edges in enumerate(hole_edges):
        other_corners = [
            p for ring, corners in enumerate(ring_corners) if ring != index + 1 for p in corners
        ]
        probes = hole_corners[index] + [
            midpoint for edge in edges for midpoint in _piece_midpoints(edge, other_corners)
        ]
        for probe in probes:
            if not _on_boundary(probe, shell_edges) and not _inside(probe, shell_corners):
                raise ValueError("A hole must lie inside the outline")
            for other in range(len(hole_edges)):
                if (
                    other != index
                    and not _on_boundary(probe, hole_edges[other])
                    and _inside(probe, hole_corners[other])
                ):
                    raise ValueError("A hole must not lie inside another hole")

    if _touches_split_interior(ring_corners, ring_edges):
        raise ValueError("Holes must not split the area")


def validate_polygon(value: Any) -> dict[str, Any]:
    """Return value if it is a valid GeoJSON Polygon, else raise ValueError.

    Checks RFC 7946 section 3.1.6 (linear rings: closed, at least four
    positions) and 4 (WGS84 longitude, latitude), then the rings themselves
    with _validate_rings. Only Polygon is accepted: one area is one polygon,
    holes are inner rings. Each message names one problem, so a frontend can
    map it.
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
    _validate_rings(rings)
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


def _crossing(start: Point, end: Point, start_side: float, end_side: float) -> Point:
    """Return where the segment start-end meets a line, given each end's _direction to it."""
    t = start_side / (start_side - end_side)
    return start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t


def _clip_to_convex(subject: Ring, clip: Ring) -> Ring:
    """Return the part of subject inside clip; open rings, clip convex and counter-clockwise.

    Sutherland-Hodgman reentrant clipping (I. E. Sutherland and G. W. Hodgman,
    "Reentrant polygon clipping", Communications of the ACM 17(1), 1974), written
    from the paper's description: subject is clipped by the line of each edge of
    clip in turn. Points on a line count as inside, so shared edges are kept.
    """
    output = subject
    for edge_start, edge_end in pairwise([*clip, clip[0]]):
        candidates, output = output, []
        if not candidates:
            break
        previous = candidates[-1]
        previous_side = _direction(edge_start, edge_end, previous)
        for current in candidates:
            current_side = _direction(edge_start, edge_end, current)
            if current_side <= 0:
                if previous_side > 0:
                    output.append(_crossing(previous, current, previous_side, current_side))
                output.append(current)
            elif previous_side <= 0:
                output.append(_crossing(previous, current, previous_side, current_side))
            previous, previous_side = current, current_side
    return output


def _signed_area(ring: Ring) -> float:
    """Return the area of a closed ring, positive when it runs counter-clockwise."""
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in pairwise(ring)) / 2


def _edge_triangles(polygon: dict[str, Any], lon0: float, lat0: float) -> list[tuple[Ring, float]]:
    """Return a counter-clockwise triangle from (lon0, lat0) to every edge, with its weight.

    Custom. Summed with their weights (+1 or -1), the triangles cover each point of
    the polygon once and every other point not at all, whatever way the rings run:
    the outer ring counts counter-clockwise, holes clockwise.
    """
    triangles: list[tuple[Ring, float]] = []
    for index, ring in enumerate(_rings_m(polygon, lon0, lat0)):
        ring_weight = 1.0 if (_signed_area(ring) > 0) == (index == 0) else -1.0
        for start, end in pairwise(ring):
            cross = start[0] * end[1] - end[0] * start[1]
            if cross > 0:
                triangles.append(([(0.0, 0.0), start, end], ring_weight))
            elif cross < 0:
                triangles.append(([(0.0, 0.0), end, start], -ring_weight))
    return triangles


def overlap_area_m2(polygon_a: dict[str, Any], polygon_b: dict[str, Any]) -> float:
    """Return the area in square metres that two polygons, holes included, have in common.

    Custom. Each polygon is split into weighted triangles from one common point to
    its edges (_edge_triangles, the decomposition behind the shoelace formula); the
    common area is the weighted sum of the common areas of every pair of triangles,
    each found with Sutherland-Hodgman, which is exact for convex shapes. Works for
    any valid polygons, also non-convex ones and ones that share edges, which polygon
    clippers such as Greiner-Hormann treat as special cases. Measured in the local
    tangent plane at the first vertex of polygon_a.

    Known limit: time grows with the product of the numbers of edges; fine for rooms
    and a building outline, slow (seconds) for two polygons of hundreds of corners.
    """
    origin = _origin(polygon_a)
    triangles_a = _edge_triangles(polygon_a, *origin)
    total = 0.0
    for triangle_b, weight_b in _edge_triangles(polygon_b, *origin):
        for triangle_a, weight_a in triangles_a:
            common = _clip_to_convex(triangle_a, triangle_b)
            if len(common) >= 3:
                total += weight_a * weight_b * _shoelace_area([*common, common[0]])
    return max(total, 0.0)
