// Plan geometry for drawing rooms on the site lattice: boxes, rings of corners, side lengths, resizing, moving and joining shapes.

import difference from "@turf/difference";
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
// A map wall within 3 degrees of a site axis, or at most one map tile unit across it, is taken to lie
// on it; the rest is noise in the map.
const STRAIGHTEN_TANGENT = Math.tan((3 * Math.PI) / 180);
const EQUATOR_M = 40075016.686;

// Home Assistant's map tiles carry buildings at zoom 14 at most, 4096 units across a tile, so a map
// corner is only known to one such unit: a short wall reads several degrees crooked or as a stair step.
const mapTileUnitM = (latitude: number): number => (EQUATOR_M * Math.cos((latitude * Math.PI) / 180)) / 2 ** 14 / 4096;

type FloatRing = [number, number][];

// The site axis an edge runs along, 0 for x and 1 for y, or undefined for a diagonal: within 3 degrees
// of it, or at most `tileUnits` across it from end to end.
const nearAxisOf = (from: LatticePoint, to: LatticePoint, tileUnits: number): 0 | 1 | undefined => {
  const [dx, dy] = [Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])];
  if (dy <= dx && (dy <= dx * STRAIGHTEN_TANGENT || dy <= tileUnits)) return 0;
  if (dx <= dy && (dx <= dy * STRAIGHTEN_TANGENT || dx <= tileUnits)) return 1;
  return undefined;
};

/**
 * Custom. Drops the corner that ends an edge shorter than `shortest`, one at a time until none is
 * left or fewer than three corners remain, so a jog of map noise or a tile seam between two parallel
 * walls leaves one wall to straighten. Limit: a real recess under one grid step disappears.
 */
function withoutShortEdges(corners: FloatRing, shortest: number): FloatRing {
  let ring = corners;
  for (;;) {
    const short = ring.findIndex((corner, index) => edgeUnits(corner, ring[(index + 1) % ring.length]) < shortest);
    if (short < 0 || ring.length < 3) return ring;
    ring = ring.filter((_, index) => index !== (short + 1) % ring.length);
  }
}

/**
 * Custom. Each run of consecutive edges that `nearAxisOf` puts on the same site axis becomes one
 * straight line on that axis: its corners take the length-weighted mean of the run's coordinate across the
 * axis. Only that coordinate moves, so a corner between an x run and a y run takes one from each;
 * diagonal edges keep their corners, apart from what a neighbouring run moves.
 */
function straighten(corners: FloatRing, tileUnits: number): FloatRing {
  const count = corners.length;
  const axes = corners.map((corner, index) => nearAxisOf(corner, corners[(index + 1) % count], tileUnits));
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

const closedRing = (corners: FloatRing): Position[] => [...corners, corners[0]];

/**
 * The ring moved `distance` inward, as GEOS buffers by a negative distance with square end caps: the
 * ring minus a band of width twice `distance` centred on every edge and a square of that side, along
 * the site axes, centred on every corner. Axis corners get an exact mitre, diagonal ones a close
 * bevel; parts narrower than twice `distance` disappear. Custom only in the construction of the bands
 * and squares; the boolean difference is polyclip-ts through turf. The largest part by area, without
 * holes, or undefined when nothing is left.
 */
function insetShell(corners: FloatRing, distance: number): FloatRing | undefined {
  const band = (from: [number, number], to: [number, number]) => {
    const length = edgeUnits(from, to);
    const [nx, ny] = [((from[1] - to[1]) / length) * distance, ((to[0] - from[0]) / length) * distance];
    return polygon([closedRing([[from[0] + nx, from[1] + ny], [to[0] + nx, to[1] + ny], [to[0] - nx, to[1] - ny], [from[0] - nx, from[1] - ny]])]);
  };
  const square = ([x, y]: [number, number]) =>
    polygon([closedRing([[x - distance, y - distance], [x + distance, y - distance], [x + distance, y + distance], [x - distance, y + distance]])]);
  const cuts = corners.flatMap((corner, index) => [band(corner, corners[(index + 1) % corners.length]), square(corner)]);
  const left = difference({ type: "FeatureCollection", features: [polygon([closedRing(corners)]), ...cuts] })?.geometry;
  if (!left) return undefined;
  const shells = (left.type === "Polygon" ? [left.coordinates] : left.coordinates).map((rings) =>
    rings[0].slice(0, -1).map(([x, y]): [number, number] => [x, y]),
  );
  return shells.reduce((largest, shell) => (Math.abs(doubleArea(shell)) > Math.abs(doubleArea(largest)) ? shell : largest));
}

// Custom. The boolean engine leaves corners a hair apart where cuts meet; on the lattice they fall on one
// point or on one straight line. Drops a corner equal to the one before it, then a corner the ring
// runs straight through.
function withoutSpareCorners(corners: Ring): Ring {
  const at = <T>(ring: T[], index: number): T => ring[(index + ring.length) % ring.length];
  const distinct = corners.filter(([x, y], index) => {
    const [px, py] = at(corners, index - 1);
    return x !== px || y !== py;
  });
  return distinct.filter(([x, y], index) => {
    const [[px, py], [nx, ny]] = [at(distinct, index - 1), at(distinct, index + 1)];
    const cross = (x - px) * (ny - y) - (y - py) * (nx - x);
    const along = (x - px) * (nx - x) + (y - py) * (ny - y);
    return cross !== 0 || along <= 0;
  });
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
 * The outline copied from a map building: the outer ring of its own shape (courtyards dropped),
 * without edges under one grid step, with walls within 3 degrees of a site axis or at most one map
 * tile unit across it straightened onto it, moved 150 mm inward (its largest part when the inset splits it) and rounded to the lattice.
 * It may have fewer or more corners than the map's. Undefined when nothing is left, or when the
 * rounded ring has an edge under one grid step or edges that cross or touch.
 */
export function mapOutline(frame: PlanFrame, building: Polygon): Polygon | undefined {
  const corners: FloatRing = building.coordinates[0].slice(0, -1).map((corner) => frame.toLatticeUnits(corner));
  const kept = withoutShortEdges(corners, frame.unitsPerStep);
  if (kept.length < 3) return undefined;
  const tileUnits = mapTileUnitM(building.coordinates[0][0][1]) / frame.unitM;
  const inset = insetShell(straighten(kept, tileUnits), MAP_OUTLINE_INSET_M / frame.unitM);
  if (!inset) return undefined;
  const outline = withoutSpareCorners(inset.map(([x, y]) => [Math.round(x) + 0, Math.round(y) + 0]));
  if (outline.length < 3) return undefined;
  const edgesLongEnough = outline.every((from, index) => edgeUnits(from, outline[(index + 1) % outline.length]) >= frame.unitsPerStep);
  // Rounding to the lattice can bring two parts of the ring together that the inset kept apart.
  if (!edgesLongEnough || !isSimpleRing(outline)) return undefined;
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

/** The corners of an open ring with `point` added; a repeat of the last corner, as from a double click, adds nothing. */
export function addCorner(corners: readonly LatticePoint[], point: LatticePoint): LatticePoint[] {
  const last = corners[corners.length - 1];
  return last && last[0] === point[0] && last[1] === point[1] ? [...corners] : [...corners, point];
}

/** Whether a click at `pointer`, in lattice units, lands on the first corner of an open ring, within `radius`. */
export function closesRing(corners: readonly LatticePoint[], pointer: readonly [number, number], radius: number): boolean {
  const [first] = corners;
  return first !== undefined && Math.hypot(pointer[0] - first[0], pointer[1] - first[1]) <= radius;
}

/**
 * A ring of clicked corners becomes the area's first shape, counter-clockwise; refused with fewer
 * than three corners, a side under one grid step, or sides that cross or touch.
 */
export function ringChange(frame: PlanFrame, areaId: string, corners: readonly LatticePoint[]): ChangeOrRefusal {
  if (corners.length < 3) return { refusal: "too_few_corners" };
  const ring = [...corners];
  if (ring.some((corner, index) => edgeUnits(corner, ring[(index + 1) % ring.length]) < frame.unitsPerStep)) return { refusal: "too_small" };
  if (!isSimpleRing(ring)) return { refusal: "crossing" };
  if (doubleArea(ring) < 0) ring.reverse();
  return { change: footprintChange(areaId, null, { type: "Polygon", coordinates: [ringToWgs84(frame, ring)] }) };
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