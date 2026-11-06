// Plan geometry for drawing rooms on the site lattice: boxes, side lengths, resizing, moving and joining shapes.

import { polygon } from "@turf/helpers";
import union from "@turf/union";
import type { Polygon, Position } from "geojson";
import type { Change } from "./history";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { type HassUnits, type Refusal, formatArea, formatLength } from "./units";

type Ring = LatticePoint[];

// The rings of a shape in lattice units, without their closing corner.
const latticeRings = (frame: PlanFrame, shape: Polygon): Ring[] =>
  shape.coordinates.map((ring) => ring.slice(0, -1).map((corner) => frame.toLattice(corner)));
const outerCorners = (frame: PlanFrame, shape: Polygon): Ring => latticeRings(frame, shape)[0];

const liesOnStraightLine = (corners: Ring, index: number): boolean => {
  const [x, y] = corners[index];
  const [previousX, previousY] = corners.at(index - 1)!;
  const [nextX, nextY] = corners[(index + 1) % corners.length];
  return (x - previousX) * (nextY - y) - (y - previousY) * (nextX - x) === 0;
};

/**
 * Custom. The ring without its corners that lie exactly on the line through their neighbours (a
 * zero cross product on lattice integers), also the tip of a spike back on itself and a repeated
 * corner, so the shape never changes. Near-straight corners stay.
 */
export function dropStraightCorners(corners: readonly LatticePoint[]): LatticePoint[] {
  const ring = [...corners];
  for (let index = ring.findIndex((_, at) => liesOnStraightLine(ring, at)); index >= 0 && ring.length > 3; ) {
    ring.splice(index, 1);
    index = ring.findIndex((_, at) => liesOnStraightLine(ring, at));
  }
  return ring;
}

// Every footprint the panel writes leaves the lattice here, so none keeps a straight corner.
const ringToWgs84 = (frame: PlanFrame, corners: Ring): Position[] => {
  const positions = dropStraightCorners(corners).map((corner) => frame.fromLattice(corner));
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

/** Gross area of a draft, holes taken out; saved areas come from the integration. */
export function areaLabel(frame: PlanFrame, shape: Polygon, units: HassUnits): string {
  const [outer, ...holes] = latticeRings(frame, shape).map((corners) => Math.abs(doubleArea(corners)) / 2);
  const squareUnits = holes.reduce((rest, hole) => rest - hole, outer);
  return formatArea(squareUnits * frame.unitM * frame.unitM, units);
}

/** Where the area label goes: the middle of the shape's bounding box on the plan. */
export function centreOf(frame: PlanFrame, shape: Polygon): Position {
  const corners = outerCorners(frame, shape);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return frame.fromLattice([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
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