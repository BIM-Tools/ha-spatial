"""All geometry in one place, in pure Python, measured on the site's lattice.

Each function is a cited canonical algorithm or marked as custom. Measurement
works on lattice coordinates: whole numbers of lattice units in the site frame,
so equal positions, collinear edges and touching rings are compared exactly.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from fractions import Fraction
from itertools import combinations, pairwise
from numbers import Real
from typing import Any, Literal

from .const import LATTICE_UNITS_PER_STEP

type Point = tuple[float, float]
type Ring = list[Point]
type Segment = tuple[Point, Point]
type OutlineRelation = Literal["inside", "outside", "crossing"]

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


class SiteFrame:
    """A fixed plane for one site, in lattice units, and the way back to WGS84.

    Custom. The local tangent plane at the origin with the WGS84 radii of the
    origin's latitude (metres_per_degree), turned so x runs along the bearing
    (clockwise from north) and y to its left, divided into lattice units. A
    position snaps to the nearest lattice point; snapping a snapped position again
    gives the same lattice point, also after a JSON round trip, because the way
    back is off by far less than half a unit. Distances are exact to the plane,
    which departs from the ellipsoid by well under a millimetre within a few
    hundred metres of the origin.
    """

    def __init__(self, origin: Sequence[float], bearing_deg: float, unit_m: Fraction) -> None:
        """Set up the frame at origin [lon, lat], along the bearing, with lattice unit unit_m."""
        self._lon0, self._lat0 = origin[0], origin[1]
        self._m_per_deg_lon, self._m_per_deg_lat = metres_per_degree(self._lat0)
        bearing = math.radians(bearing_deg)
        self._sin, self._cos = math.sin(bearing), math.cos(bearing)
        self.unit_m = unit_m
        self.bearing_deg = bearing_deg

    def to_lattice_units(self, lon: float, lat: float) -> Point:
        """Return a position in lattice units, not rounded."""
        east = (lon - self._lon0) * self._m_per_deg_lon
        north = (lat - self._lat0) * self._m_per_deg_lat
        along = east * self._sin + north * self._cos
        across = -east * self._cos + north * self._sin
        return along / self.unit_m, across / self.unit_m

    def lattice_transform(self) -> tuple[list[float], list[list[float]]]:
        """Return the origin [lon, lat] and the matrix from degrees to lattice units.

        The matrix is [[a, b], [c, d]] with x = a (lon - lon0) + b (lat - lat0) and
        y = c (lon - lon0) + d (lat - lat0). It is exactly the affine map that
        to_lattice_units applies, so a client that applies it lands on the same
        unrounded lattice position; its inverse is to_wgs84 before the unit scaling.
        """
        unit = float(self.unit_m)
        mlon, mlat = self._m_per_deg_lon, self._m_per_deg_lat
        return (
            [self._lon0, self._lat0],
            [
                [mlon * self._sin / unit, mlat * self._cos / unit],
                [-mlon * self._cos / unit, mlat * self._sin / unit],
            ],
        )

    def _snap(self, position: Sequence[float]) -> Point:
        """Return the lattice point nearest to a [lon, lat] position."""
        along, across = self.to_lattice_units(position[0], position[1])
        return round(along), round(across)

    def to_wgs84(self, point: Point) -> list[float]:
        """Return [lon, lat] of a lattice point."""
        # Multiplying by the exact fraction rounds once, so whole lattice units
        # become the nearest double of their decimal value in metres.
        along = float(point[0] * self.unit_m)
        across = float(point[1] * self.unit_m)
        east = along * self._sin - across * self._cos
        north = along * self._cos + across * self._sin
        return [self._lon0 + east / self._m_per_deg_lon, self._lat0 + north / self._m_per_deg_lat]

    def snap(self, polygon: dict[str, Any]) -> list[Ring]:
        """Return the corners of every ring of a GeoJSON Polygon, snapped to the lattice.

        Corners that snap onto their predecessor are dropped, so an edge shorter
        than half a unit disappears.
        """
        return [
            _corners([self._snap(position) for position in ring]) for ring in polygon["coordinates"]
        ]

    def to_polygon(self, rings: list[Ring]) -> dict[str, Any]:
        """Return a GeoJSON Polygon with closed rings through lattice corners."""
        return {
            "type": "Polygon",
            "coordinates": [
                [self.to_wgs84(point) for point in [*corners, corners[0]]] for corners in rings
            ],
        }


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


def _segments_cross_properly(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """Return True if each segment has its ends strictly on both sides of the other.

    The first case of SEGMENTS-INTERSECT, same source as _direction.
    """
    return (
        _direction(p3, p4, p1) * _direction(p3, p4, p2) < 0
        and _direction(p1, p2, p3) * _direction(p1, p2, p4) < 0
    )


def _segments_cross_or_overlap(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """Return True if two segments cross each other or run along each other.

    Custom, built on _direction: touching in a single point is allowed, as
    rings of a polygon may touch in points. Segments must have a length.
    """
    if _segments_cross_properly(p1, p2, p3, p4):
        return True
    if _direction(p3, p4, p1) != 0 or _direction(p3, p4, p2) != 0:
        return False
    # Collinear: compare extents along the axis on which they are longest, so a
    # vertical pair is not compared on its zero-width x extent.
    widths = abs(p2[0] - p1[0]) + abs(p4[0] - p3[0])
    heights = abs(p2[1] - p1[1]) + abs(p4[1] - p3[1])
    axis = 0 if widths >= heights else 1
    return max(min(p1[axis], p2[axis]), min(p3[axis], p4[axis])) < min(
        max(p1[axis], p2[axis]), max(p3[axis], p4[axis])
    )


def _corners(ring: Sequence[Sequence[float]]) -> Ring:
    """Return the corners of a closed ring, without repeated positions or the closing one."""
    corners: Ring = []
    for x, y, *_ in ring[:-1]:
        if not corners or corners[-1] != (x, y):
            corners.append((x, y))
    if len(corners) > 1 and corners[0] == corners[-1]:
        corners.pop()
    return corners


def _edges(rings: list[Ring]) -> list[Segment]:
    """Return the edges of rings given by their corners."""
    return [edge for corners in rings for edge in pairwise([*corners, corners[0]])]


def _on_edge(edge: Segment, point: Point) -> bool:
    """Return True if the point lies on the edge, its ends included."""
    return _direction(*edge, point) == 0 and _on_segment(*edge, point)


def _on_boundary(point: Point, edges: list[Segment]) -> bool:
    """Return True if the point lies exactly on one of the edges."""
    return any(_on_edge(edge, point) for edge in edges)


def _inside(point: Point, corners: Ring) -> bool:
    """Return True if the point is inside the ring given by its corners."""
    return _pnpoly([c[0] for c in corners], [c[1] for c in corners], *point)


def _midpoint(piece: Segment) -> Point:
    """Return the middle of a segment; exact for lattice points, as halves are exact floats."""
    (x1, y1), (x2, y2) = piece
    return (x1 + x2) / 2, (y1 + y2) / 2


def _edge_pieces(edge: Segment, cut_points: Ring) -> list[Segment]:
    """Return the pieces into which the cut points lying on the edge split it, in order.

    Custom. Cut points are ordered by their exact projection on the edge.
    """
    start, end = edge
    dx, dy = end[0] - start[0], end[1] - start[1]
    cuts = sorted(
        {point for point in cut_points if _on_edge(edge, point)} - {start, end},
        key=lambda point: (point[0] - start[0]) * dx + (point[1] - start[1]) * dy,
    )
    return list(pairwise([start, *cuts, end]))


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


def validate_rings(ring_corners: list[Ring]) -> None:
    """Raise ValueError unless rings, given by their corners, form a valid polygon with holes.

    Custom. Every ring must be simple: no two of its edges meet, except
    neighbours at their shared corner. Two rings must not cross or run along
    each other, and the points where they touch must not split the interior.
    Every hole must lie inside the outline and outside the other holes, probed
    at its corners and at the middle of each piece of its edges between points
    where other rings touch them (the only places an edge can pass to the other
    side), skipping probes on the other ring.

    Exact on lattice coordinates. Time grows with the square of the number of
    corners, hence MAX_CORNERS.
    """
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
            _midpoint(piece) for edge in edges for piece in _edge_pieces(edge, other_corners)
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


def validate_lattice_polygon(ring_corners: list[Ring]) -> None:
    """Raise ValueError unless a snapped polygon is valid and can be built.

    Custom. On top of validate_rings: every corner has an interior angle from 45
    to 315 degrees, so there are no spikes, compared in whole numbers: the turn at a corner
    is beyond 135 degrees exactly when the dot product u.w of its edges is negative
    and 2 (u.w)² > |u|² |w|². Every edge is at least one grid step long
    (LATTICE_UNITS_PER_STEP lattice units), also compared in whole numbers.
    """
    validate_rings(ring_corners)
    for corners in ring_corners:
        for previous, corner, following in zip(
            [corners[-1], *corners[:-1]], corners, [*corners[1:], corners[0]], strict=True
        ):
            ux, uy = corner[0] - previous[0], corner[1] - previous[1]
            wx, wy = following[0] - corner[0], following[1] - corner[1]
            if ux * ux + uy * uy < LATTICE_UNITS_PER_STEP**2:
                raise ValueError("An edge must be at least one grid step")
            dot = ux * wx + uy * wy
            if dot < 0 and 2 * dot * dot > (ux * ux + uy * uy) * (wx * wx + wy * wy):
                raise ValueError("A corner must be between 45 and 315 degrees")


def validate_polygon(value: Any) -> dict[str, Any]:
    """Return value if it is a GeoJSON Polygon in WGS84, else raise ValueError.

    Checks RFC 7946 section 3.1.6 (linear rings: closed, at least four
    positions) and 4 (WGS84 longitude, latitude). Only Polygon is accepted: one
    area is one polygon, holes are inner rings. The rings themselves are checked
    on the lattice, with validate_lattice_polygon. Each message names one problem,
    so a frontend can map it.
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


def _twice_signed_area(corners: Ring) -> float:
    """Return twice the area of a ring, positive when it runs counter-clockwise (shoelace)."""
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in pairwise([*corners, corners[0]]))


def _interior_on_the_left(ring_corners: list[Ring]) -> list[Ring]:
    """Return the rings turned so the polygon's interior lies on their left.

    The outer ring then runs counter-clockwise and holes run clockwise.
    """
    return [
        corners if (_twice_signed_area(corners) > 0) == (index == 0) else corners[::-1]
        for index, corners in enumerate(ring_corners)
    ]


def contains(ring_corners: list[Ring], point: Point) -> bool:
    """Return True if the point is inside the polygon and not inside a hole (PNPOLY).

    A point exactly on an edge may fall either way; on a shared wall axis a point
    belongs to both rooms anyway.
    """
    inside = False
    for corners in ring_corners:
        if _inside(point, corners):
            inside = not inside
    return inside


def shared_edge_length(rings_a: list[Ring], rings_b: list[Ring]) -> float:
    """Return the length in lattice units along which the boundaries of two polygons coincide.

    Custom (no library equivalent without shapely): an edge of b lies on an edge
    of a when both its ends are on the line through that edge (exact on the
    lattice); the shared length is their overlap along it, measured as the
    difference of the projections on the edge divided by its length.
    """
    total = 0.0
    edges_b = _edges(rings_b)
    for start, end in _edges(rings_a):
        dx, dy = end[0] - start[0], end[1] - start[1]
        squared_length = dx * dx + dy * dy
        for b1, b2 in edges_b:
            if _direction(start, end, b1) != 0 or _direction(start, end, b2) != 0:
                continue
            along = [(x - start[0]) * dx + (y - start[1]) * dy for x, y in (b1, b2)]
            overlap = min(squared_length, max(along)) - max(0, min(along))
            if overlap > 0:
                total += overlap / math.sqrt(squared_length)
    return total


def net_area(
    room: list[Ring], outline: list[Ring] | None, interior_inset: int, exterior_inset: int
) -> float:
    """Return the net area of a room in square lattice units: its axial polygon inset by half walls.

    Custom, from Steiner's formula for a parallel body with one inset per edge:
    net = A - sum(d_i L_i) + sum over corners of d_in d_out tan(theta / 2), where
    theta is the turn at the corner (plus at a convex corner, minus at a reflex
    one, zero at a straight joint), computed as cross / (|u| |w| + dot) of the
    edges u and w meeting there. Edges are split at outline corners lying on them;
    a piece lying on the outline is inset by exterior_inset, every other piece by
    interior_inset. Holes grow the same way, as their rings run with the interior
    on the left. The result is clamped between zero and the gross area, and is zero
    when every edge of the outer ring is used up by the corners at its ends (each
    corner shortens an edge by the other inset times tan(theta / 2)): there the
    formula would multiply two negative widths into a positive area.

    Exact for right angles and for diagonal corners between equal insets. Known
    limits: at a diagonal corner between unequal insets the corner term is an
    approximation, off by (d_in - d_out)² cot(theta) / 2; a part narrower than the
    two insets across it is miscounted, as the formula assumes the shape keeps its
    topology.
    """
    outline_edges = _edges(outline) if outline else []
    outline_corners = [point for corners in outline or [] for point in corners]
    twice_gross = 0.0
    removed = 0.0
    corner_terms = 0.0
    for index, corners in enumerate(_interior_on_the_left(room)):
        twice_gross += _twice_signed_area(corners)
        pieces = [
            (
                piece,
                exterior_inset
                if any(
                    _on_edge(edge, piece[0]) and _on_edge(edge, piece[1]) for edge in outline_edges
                )
                else interior_inset,
            )
            for edge in pairwise([*corners, corners[0]])
            for piece in _edge_pieces(edge, outline_corners)
        ]
        lengths = [math.hypot(end[0] - start[0], end[1] - start[1]) for (start, end), _ in pieces]
        shortened = [0.0] * len(pieces)
        for k, (((start, end), inset), ((_, following), next_inset)) in enumerate(
            pairwise([*pieces, pieces[0]])
        ):
            ux, uy = end[0] - start[0], end[1] - start[1]
            wx, wy = following[0] - end[0], following[1] - end[1]
            removed += inset * lengths[k]
            denominator = math.sqrt((ux * ux + uy * uy) * (wx * wx + wy * wy)) + ux * wx + uy * wy
            # Zero only where a ring folds straight back, which validation rejects.
            if denominator > 0:
                tan_half_turn = (ux * wy - uy * wx) / denominator
                corner_terms += inset * next_inset * tan_half_turn
                shortened[k] += next_inset * tan_half_turn
                shortened[(k + 1) % len(pieces)] += inset * tan_half_turn
        if index == 0 and all(
            length <= used for length, used in zip(lengths, shortened, strict=True)
        ):
            return 0.0
    gross = twice_gross / 2
    return min(max(gross - removed + corner_terms, 0.0), gross)


def _side_of_outline(piece: Segment, outline: list[Ring], outline_edges: list[Segment]) -> bool:
    """Return True if the room along a piece of its boundary lies inside the outline.

    The piece touches the outline at most at its ends or runs along one of its
    edges. Along an edge, with both rings running with their interior on the
    left, the room is inside exactly when both run the same way.
    """
    middle = _midpoint(piece)
    for edge in outline_edges:
        if _on_edge(edge, middle):
            (x1, y1), (x2, y2) = piece
            (ex1, ey1), (ex2, ey2) = edge
            return (x2 - x1) * (ex2 - ex1) + (y2 - y1) * (ey2 - ey1) > 0
    return contains(outline, middle)


def outline_relation(room: list[Ring], outline: list[Ring]) -> OutlineRelation:
    """Return whether a room lies inside the outline, outside it, or crosses it.

    Custom, exact on the lattice. Touching, also along a whole edge, is allowed
    on either side. The room crosses when an edge of each crosses the other's, or
    when the outline runs through the room's interior: the middle of a piece of an
    outline edge, between room corners on it, lies inside the room. Otherwise the
    whole room lies on one side, which any piece of its boundary, split at outline
    corners, tells (_side_of_outline). Pieces split this way touch the other
    boundary only at their ends or run along it, so their middles decide.
    """
    room = _interior_on_the_left(room)
    outline = _interior_on_the_left(outline)
    room_edges, outline_edges = _edges(room), _edges(outline)
    if any(_segments_cross_properly(*a, *b) for a in room_edges for b in outline_edges):
        return "crossing"
    room_corners = [point for corners in room for point in corners]
    for edge in outline_edges:
        for piece in _edge_pieces(edge, room_corners):
            middle = _midpoint(piece)
            if not _on_boundary(middle, room_edges) and contains(room, middle):
                return "crossing"
    outline_corners = [point for corners in outline for point in corners]
    first_piece = _edge_pieces(room_edges[0], outline_corners)[0]
    return "inside" if _side_of_outline(first_piece, outline, outline_edges) else "outside"
