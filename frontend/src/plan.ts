// Plan geometry for drawing rooms on the site lattice: boxes, side lengths, resizing, moving and joining shapes.

import { polygon } from "@turf/helpers";
import union from "@turf/union";
import type { Polygon, Position } from "geojson";
import type { Change } from "./history";
import type { LatticePoint, PlanFrame } from "./site-frame";
import type { LatticeEdge } from "./snap";
import { type HassUnits, type Refusal, formatArea, formatLength } from "./units";
import { onSegment, properlyCross } from "./wall-stop";

type Ring = LatticePoint[];

// The rings of a shape in lattice units, without their closing corner.
const latticeRings = (frame: PlanFrame, shape: Polygon): Ring[] =>
  shape.coordinates.map((ring) => ring.slice(0, -1).map((corner) => frame.toLattice(corner)));
const outerCorners = (frame: PlanFrame, shape: Polygon): Ring => latticeRings(frame, shape)[0];

const ringToWgs84 = (frame: PlanFrame, corners: Ring): Position[] => {
  const positions = corners.map((corner) => frame.fromLattice(corner));
  return [...positions, positions[0]];
};
const edgeUnits = (from: LatticePoint, to: LatticePoint): number => Math.hypot(to[0] - from[0], to[1] - from[1]);
// Twice the signed area of a ring, by the shoelace formula; positive when counter-clockwise.
const doubleArea = (corners: Ring): number =>
  corners.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = corners[(index + 1) % corners.length];
    return sum + x * nextY - nextX * y;
  }, 0);

/** Outer ring edge lengths in metres. */
export function edgeLengths(frame: PlanFrame, shape: Polygon): number[] {
  const corners = outerCorners(frame, shape);
  return corners.map((corner, index) => edgeUnits(corner, corners[(index + 1) % corners.length]) * frame.unitM);
}

/** The counter-clockwise axis box between two lattice points, or undefined when a side is under one grid step. */
export function boxFromCorners(frame: PlanFrame, a: LatticePoint, b: LatticePoint): Polygon | undefined {
  const [left, right] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [bottom, top] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  if (right - left < frame.unitsPerStep || top - bottom < frame.unitsPerStep) return undefined;
  const corners: Ring = [
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
  ];
  return { type: "Polygon", coordinates: [ringToWgs84(frame, corners)] };
}

// The map shows the outer face of a building's walls; the outline lies on their axis.
const MAP_OUTLINE_INSET_M = 0.15;
// A map wall within 3 degrees of a site axis is taken to lie on it; the rest is noise in the map.
const STRAIGHTEN_TANGENT = Math.tan((3 * Math.PI) / 180);

type FloatRing = [number, number][];

// The site axis an edge runs along within 3 degrees, 0 for x and 1 for y, or undefined for a diagonal.
const nearAxisOf = (from: LatticePoint, to: LatticePoint): 0 | 1 | undefined => {
  const [dx, dy] = [Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])];
  if (dy <= dx * STRAIGHTEN_TANGENT) return 0;
  if (dx <= dy * STRAIGHTEN_TANGENT) return 1;
  return undefined;
};

/**
 * Custom. Each run of consecutive edges within 3 degrees of the same site axis becomes one straight
 * line on that axis: its corners take the length-weighted mean of the run's coordinate across the
 * axis. Only that coordinate moves, so a corner between an x run and a y run takes one from each;
 * diagonal edges keep their corners, apart from what a neighbouring run moves.
 */
function straighten(corners: FloatRing): FloatRing {
  const count = corners.length;
  const axes = corners.map((corner, index) => nearAxisOf(corner, corners[(index + 1) % count]));
  const result = corners.map(([x, y]): [number, number] => [x, y]);
  const start = axes.findIndex((axis, index) => axis !== axes[(index + count - 1) % count]);
  if (start < 0) return result;
  for (let offset = 0; offset < count; ) {
    const first = (start + offset) % count;
    const axis = axes[first];
    let length = 1;
    while (offset + length < count && axes[(first + length) % count] === axis) length++;
    offset += length;
    if (axis === undefined) continue;
    const across = axis === 0 ? 1 : 0;
    let [weighted, total] = [0, 0];
    for (let step = 0; step < length; step++) {
      const [from, to] = [corners[(first + step) % count], corners[(first + step + 1) % count]];
      const edge = edgeUnits(from, to);
      weighted += (edge * (from[across] + to[across])) / 2;
      total += edge;
    }
    for (let step = 0; step <= length; step++) result[(first + step) % count][across] = weighted / total;
  }
  return result;
}

/**
 * Custom. A mitred inset of a counter-clockwise ring: each edge moves `distance` to its left, inward,
 * and each corner goes to where its two moved edges meet. Limits: a very sharp corner moves far, an
 * edge shorter than about twice the inset turns around, and an edge that doubles back on its neighbour
 * has no corner (undefined).
 */
function insetRing(corners: FloatRing, distance: number): FloatRing | undefined {
  const count = corners.length;
  const normals = corners.map((from, index) => {
    const to = corners[(index + 1) % count];
    const length = edgeUnits(from, to);
    return [(from[1] - to[1]) / length, (to[0] - from[0]) / length];
  });
  const inset: FloatRing = [];
  for (const [index, [x, y]] of corners.entries()) {
    const [before, after] = [normals[(index + count - 1) % count], normals[index]];
    const meet = 1 + before[0] * after[0] + before[1] * after[1];
    if (meet < 1e-9) return undefined;
    const scale = distance / meet;
    inset.push([x + (before[0] + after[0]) * scale, y + (before[1] + after[1]) * scale]);
  }
  return inset;
}

// No two edges of the ring cross or touch, apart from neighbours at their shared corner.
function isSimpleRing(corners: Ring): boolean {
  const edges = corners.map((corner, index): LatticeEdge => [corner, corners[(index + 1) % corners.length]]);
  return edges.every((edge, i) =>
    edges.every((other, j) => {
      if (j <= i) return true;
      const [[a, b], [c, d]] = [edge, other];
      if (j === i + 1) return !onSegment(d, edge) && !onSegment(a, other);
      if (i === 0 && j === edges.length - 1) return !onSegment(c, edge) && !onSegment(b, other);
      return !properlyCross(edge, other) && ![a, b].some((end) => onSegment(end, other)) && ![c, d].some((end) => onSegment(end, edge));
    }),
  );
}

/**
 * The outline copied from a map building: the outer ring of its own shape (courtyards dropped), with
 * walls within 3 degrees of a site axis straightened onto it, moved 150 mm inward and rounded to the
 * lattice. Undefined when that is no clean ring: an edge turned around against the map's, an edge
 * under one grid step, or edges that cross or touch.
 */
export function mapOutline(frame: PlanFrame, building: Polygon): Polygon | undefined {
  const corners: FloatRing = building.coordinates[0].slice(0, -1).map((corner) => frame.toLatticeUnits(corner));
  const distinct = corners.filter((corner, index) => edgeUnits(corner, corners[(index + 1) % corners.length]) > 1e-9);
  if (distinct.length < 3) return undefined;
  const source = doubleArea(distinct) > 0 ? distinct : distinct.reverse();
  const inset = insetRing(straighten(source), MAP_OUTLINE_INSET_M / frame.unitM);
  if (!inset) return undefined;
  const outline: Ring = inset.map(([x, y]) => [Math.round(x) + 0, Math.round(y) + 0]);
  const count = outline.length;
  const keepsItsEdges = outline.every((from, index) => {
    const to = outline[(index + 1) % count];
    const [sourceFrom, sourceTo] = [source[index], source[(index + 1) % count]];
    const along = (to[0] - from[0]) * (sourceTo[0] - sourceFrom[0]) + (to[1] - from[1]) * (sourceTo[1] - sourceFrom[1]);
    return along > 0 && edgeUnits(from, to) >= frame.unitsPerStep;
  });
  if (!keepsItsEdges || !isSimpleRing(outline)) return undefined;
  return { type: "Polygon", coordinates: [ringToWgs84(frame, outline)] };
}

export function sideLabels(
  frame: PlanFrame,
  shape: Polygon,
  units: HassUnits,
): { at: Position; edgeIndex: number; text: string }[] {
  const corners = outerCorners(frame, shape);
  return edgeLengths(frame, shape).map((length, edgeIndex) => {
    const [x, y] = corners[edgeIndex];
    const [nextX, nextY] = corners[(edgeIndex + 1) % corners.length];
    return { at: frame.fromLattice([(x + nextX) / 2, (y + nextY) / 2]), edgeIndex, text: formatLength(length, units) };
  });
}

/** Where an edge of an axis rectangle lies in the site-aligned view, in which lattice x runs right and y up. */
export type AxisSide = "bottom" | "right" | "top" | "left";

/** The place of each edge of an axis rectangle, given by its four lattice corners, by its start corner. */
export function axisSides(corners: readonly LatticePoint[]): AxisSide[] {
  const left = Math.min(...corners.map(([x]) => x));
  const bottom = Math.min(...corners.map(([, y]) => y));
  return corners.map(([x, y], index) => {
    const [, nextY] = corners[(index + 1) % corners.length];
    if (y === nextY) return y === bottom ? "bottom" : "top";
    return x === left ? "left" : "right";
  });
}

/** What a side of the active rectangle carries: the length of its axis, or only a grip. */
export type SideHandle = "length" | "grip";

// Whether an axis edge lies on one of `walls` over more than a point.
const sharesWall = ([from, to]: LatticeEdge, walls: readonly LatticeEdge[]): boolean => {
  const across = from[0] === to[0] ? 0 : 1;
  const along = across === 0 ? 1 : 0;
  const [start, end] = [Math.min(from[along], to[along]), Math.max(from[along], to[along])];
  return walls.some(
    ([a, b]) =>
      a[across] === from[across] &&
      b[across] === from[across] &&
      Math.min(end, Math.max(a[along], b[along])) - Math.max(start, Math.min(a[along], b[along])) > 0,
  );
};

/**
 * Custom. Per edge of an axis rectangle (its four lattice corners), whether it carries the length of
 * its axis or a grip. Opposite sides have the same length, so each length shows once: on the side of
 * the pair that shares no stretch of wall with `roomEdges`, the other rooms of the floor, so it never
 * covers a neighbour; when both or neither do, on the bottom for the width and the left for the depth.
 */
export function sideHandles(corners: readonly LatticePoint[], roomEdges: readonly LatticeEdge[]): SideHandle[] {
  const sides = axisSides(corners);
  const shared = corners.map((from, index) => sharesWall([from, corners[(index + 1) % corners.length]], roomEdges));
  const isShared = (side: AxisSide) => shared[sides.indexOf(side)];
  const lengthOn = (usual: AxisSide, opposite: AxisSide) => (isShared(usual) && !isShared(opposite) ? opposite : usual);
  const carriers = [lengthOn("bottom", "top"), lengthOn("left", "right")];
  return sides.map((side) => (carriers.includes(side) ? "length" : "grip"));
}

/** Gross area of a draft, holes taken out; saved areas come from the integration. */
export function areaLabel(frame: PlanFrame, shape: Polygon, units: HassUnits): string {
  const [outer, ...holes] = latticeRings(frame, shape).map((corners) => Math.abs(doubleArea(corners)) / 2);
  const squareUnits = holes.reduce((rest, hole) => rest - hole, outer);
  return formatArea(squareUnits * frame.unitM * frame.unitM, units);
}

// The extent of the outer ring along the site axes, in lattice units.
const latticeBounds = (frame: PlanFrame, shape: Polygon) => {
  const corners = outerCorners(frame, shape);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
};

/** Where the area label goes: the middle of the shape's bounding box on the plan. */
export function centreOf(frame: PlanFrame, shape: Polygon): Position {
  const { left, bottom, right, top } = latticeBounds(frame, shape);
  return frame.fromLattice([(left + right) / 2, (bottom + top) / 2]);
}

/** The width and depth of the shape along the site axes, in metres. */
export function overallSize(frame: PlanFrame, shape: Polygon): [number, number] {
  const { left, bottom, right, top } = latticeBounds(frame, shape);
  return [(right - left) * frame.unitM, (top - bottom) * frame.unitM];
}

/** One ring of four corners whose edges all run along the site axes. */
export function isAxisRectangle(frame: PlanFrame, shape: Polygon): boolean {
  const corners = outerCorners(frame, shape);
  return (
    shape.coordinates.length === 1 &&
    corners.length === 4 &&
    corners.every(([x, y], index) => {
      const [nextX, nextY] = corners[(index + 1) % 4];
      return x === nextX || y === nextY;
    })
  );
}

/**
 * Gives edge `edgeIndex` and its opposite the length, rounded to whole lattice units; the edge's
 * start corner and the other two lengths stay. Undefined under one grid step.
 */
export function resizeSide(frame: PlanFrame, rectangle: Polygon, edgeIndex: number, lengthM: number): Polygon | undefined {
  const units = Math.round(lengthM / frame.unitM);
  if (units < frame.unitsPerStep) return undefined;
  const corners = outerCorners(frame, rectangle);
  const at = (offset: number) => (edgeIndex + offset) % 4;
  const [startX, startY] = corners[at(0)];
  const [endX, endY] = corners[at(1)];
  const direction = [Math.sign(endX - startX), Math.sign(endY - startY)];
  const stretched = ([x, y]: LatticePoint): LatticePoint => [x + direction[0] * units, y + direction[1] * units];
  const result = [...corners];
  result[at(1)] = stretched(corners[at(0)]);
  result[at(2)] = stretched(corners[at(3)]);
  return { type: "Polygon", coordinates: [ringToWgs84(frame, result)] };
}

/** Moves every corner by a lattice delta. */
export function movePolygon(frame: PlanFrame, shape: Polygon, delta: LatticePoint): Polygon {
  const moved = latticeRings(frame, shape).map((corners) =>
    ringToWgs84(frame, corners.map(([x, y]) => [x + delta[0], y + delta[1]] as const)),
  );
  return { type: "Polygon", coordinates: moved };
}

/**
 * The footprint with the box added, or undefined when the result is not one Polygon. Joined on
 * lattice units, where shared walls are exact; in lon/lat a partly shared edge can open a gap.
 */
export function addToFootprint(frame: PlanFrame, existing: Polygon | undefined, box: Polygon): Polygon | undefined {
  if (!existing) return box;
  const onLattice = (shape: Polygon) =>
    polygon(latticeRings(frame, shape).map((corners) => [...corners, corners[0]].map(([x, y]) => [x, y])));
  const joined = union({ type: "FeatureCollection", features: [onLattice(existing), onLattice(box)] });
  if (joined?.geometry.type !== "Polygon") return undefined;
  const rings = joined.geometry.coordinates.map((ring) =>
    ringToWgs84(frame, ring.slice(0, -1).map((corner) => [corner[0], corner[1]] as const)),
  );
  return { type: "Polygon", coordinates: rings };
}

/** What saving a gesture changes, or why it saves nothing. */
export type ChangeOrRefusal = { change: Change } | { refusal: Refusal };

const footprintChange = (areaId: string, before: Polygon | null, after: Polygon | null): Change => ({
  before: { [areaId]: before },
  after: { [areaId]: after },
});

/** A drawn box joins the area's footprint, or starts it; a box the footprint cannot join is refused. */
export function boxChange(frame: PlanFrame, areaId: string, current: Polygon | undefined, box: Polygon): ChangeOrRefusal {
  const footprint = addToFootprint(frame, current, box);
  if (!footprint) return { refusal: "apart" };
  return { change: footprintChange(areaId, current ?? null, footprint) };
}

/** A typed side length resizes the rectangle; an unreadable length or one under a grid step is refused. */
export function resizeChange(
  frame: PlanFrame,
  areaId: string,
  rectangle: Polygon,
  edgeIndex: number,
  lengthM: number | undefined,
): ChangeOrRefusal {
  const resized = lengthM === undefined ? undefined : resizeSide(frame, rectangle, edgeIndex, lengthM);
  if (!resized) return { refusal: "too_small" };
  return { change: footprintChange(areaId, rectangle, resized) };
}