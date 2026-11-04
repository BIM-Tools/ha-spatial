// Plan geometry for drawing rooms on the site lattice: boxes, side lengths, resizing, moving and joining shapes.

import { polygon } from "@turf/helpers";
import union from "@turf/union";
import type { Polygon, Position } from "geojson";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { type HassUnits, formatArea, formatLength } from "./units";

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
  const rings = joined.geometry.coordinates.map((ring) => ring.map((corner) => frame.fromLattice([corner[0], corner[1]])));
  return { type: "Polygon", coordinates: rings };
}
