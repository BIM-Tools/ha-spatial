// Stops a moved room or a stretched side where it first touches the building outline, so a room inside stays inside and one outside stays outside.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Polygon } from "geojson";
import type { LatticePoint } from "./site-frame";
import type { LatticeEdge, SnapCandidates, SnapSource } from "./snap";
import { distinctSources } from "./snap-highlight";

/** The rings of a shape in lattice units, outer ring first. */
export type Rings = readonly (readonly LatticePoint[])[];

/** Where a walk stopped, as an offset from where it started, and the outline edge or corner that stopped it. */
export interface OutlineStop {
  offset: LatticePoint;
  source?: SnapSource;
}

type Point = readonly [number, number];
type Box = readonly [number, number, number, number];

// Adding 0 turns -0 into 0, so equal points compare equal.
const plus = (point: Point, offset: Point): LatticePoint => [point[0] + offset[0] + 0, point[1] + offset[1] + 0];

// Exact on lattice integers: every product stays far below 2^53.
const orientation = (from: Point, to: Point, point: Point) =>
  Math.sign((to[0] - from[0]) * (point[1] - from[1]) - (to[1] - from[1]) * (point[0] - from[0]));

const properlyCross = ([a, b]: LatticeEdge, [c, d]: LatticeEdge) =>
  orientation(a, b, c) * orientation(a, b, d) < 0 && orientation(c, d, a) * orientation(c, d, b) < 0;

const onSegment = (point: Point, [from, to]: LatticeEdge) =>
  orientation(from, to, point) === 0 &&
  point[0] >= Math.min(from[0], to[0]) &&
  point[0] <= Math.max(from[0], to[0]) &&
  point[1] >= Math.min(from[1], to[1]) &&
  point[1] <= Math.max(from[1], to[1]);

const edgesOf = (rings: Rings): LatticeEdge[] => rings.flatMap((ring) => ring.map((corner, index): LatticeEdge => [corner, ring[(index + 1) % ring.length]]));

const boxOf = (rings: Rings): Box => {
  const corners = rings.flat();
  const [xs, ys] = [corners.map(([x]) => x), corners.map(([, y]) => y)];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

const touchesBox = ([left, bottom, right, top]: Box, points: readonly Point[]) =>
  Math.max(...points.map(([x]) => x)) >= left &&
  Math.min(...points.map(([x]) => x)) <= right &&
  Math.max(...points.map(([, y]) => y)) >= bottom &&
  Math.min(...points.map(([, y]) => y)) <= top;

/**
 * Custom. What of the outline reaches inside a shape: each outline edge that properly crosses one of
 * its edges or whose middle lies strictly inside it, then each outline corner strictly inside it.
 * Touching and lying along a wall are not inside. Exact: orientation tests on lattice integers, and
 * turf's point in polygon, which is exact on them too. Known limit: an outline edge that enters and
 * leaves a room only through its corners, with its middle outside, does not count.
 */
function outlineInside(rings: Rings, candidates: SnapCandidates): SnapSource[] {
  const edges = edgesOf(rings);
  const shape: Polygon = { type: "Polygon", coordinates: rings.map((ring) => [...ring, ring[0]].map(([x, y]) => [x, y])) };
  const strictlyInside = (point: Point) => booleanPointInPolygon([point[0], point[1]], shape, { ignoreBoundary: true });
  const inside: SnapSource[] = [];
  for (const edge of candidates.outlineEdges) {
    const middle: Point = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
    if (edges.some((side) => properlyCross(edge, side)) || strictlyInside(middle)) inside.push({ kind: "edge", edge });
  }
  for (const at of candidates.outlineCorners) if (strictlyInside(at)) inside.push({ kind: "corner", at });
  return inside;
}

/**
 * The lattice offsets on the straight line from [0, 0] to `to`, without the start, in order: one
 * step per offset, diagonal where the line needs it. Bresenham's line algorithm (1965), all octants,
 * as given at https://en.wikipedia.org/wiki/Bresenham%27s_line_algorithm#All_cases.
 */
function lineOffsets(to: LatticePoint): LatticePoint[] {
  const [dx, dy] = [Math.abs(to[0]), -Math.abs(to[1])];
  const [sx, sy] = [Math.sign(to[0]), Math.sign(to[1])];
  const offsets: LatticePoint[] = [];
  let [x, y] = [0, 0];
  let error = dx + dy;
  while (x !== to[0] || y !== to[1]) {
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
    offsets.push([x + 0, y + 0]);
  }
  return offsets;
}

// What a walk names as its stop: of what reaches inside at the first blocked offset, an outline edge
// a corner of the stopped shape lies on, else an outline corner on one of its edges, else the first.
const stoppedBy = (blockers: SnapSource[], stopped: Rings): SnapSource => {
  const corners = stopped.flat();
  const edges = edgesOf(stopped);
  const touched = blockers.find((source) => source.kind === "edge" && corners.some((corner) => onSegment(corner, source.edge)));
  return touched ?? blockers.find((source) => source.kind === "corner" && edges.some((edge) => onSegment(source.at, edge))) ?? blockers[0];
};

/**
 * Custom. Walks a shape from offset [0, 0] to `to` over the lattice offsets of the straight line
 * (`lineOffsets`), and stops before the first one where the outline reaches inside it
 * (`outlineInside`); `shapeAt` gives the shape at an offset. Undefined when it reaches `to`, or when
 * the outline already reaches inside at the start, so a shape past the outline moves freely. The walk
 * is not monotone in what it meets (a room can pass the tip of a notch), so it checks every offset,
 * against only the outline within the box the shape sweeps. Known limit: only lattice offsets are
 * checked, so a feature thinner than one lattice unit can slip between two of them.
 */
export function walkToOutline(shapeAt: (offset: LatticePoint) => Rings, to: LatticePoint, candidates: SnapCandidates): OutlineStop | undefined {
  if (!to[0] && !to[1]) return undefined;
  const [first, last] = [boxOf(shapeAt([0, 0])), boxOf(shapeAt(to))];
  const swept: Box = [Math.min(first[0], last[0]), Math.min(first[1], last[1]), Math.max(first[2], last[2]), Math.max(first[3], last[3])];
  const near: SnapCandidates = {
    ...candidates,
    outlineEdges: candidates.outlineEdges.filter((edge) => touchesBox(swept, edge)),
    outlineCorners: candidates.outlineCorners.filter((corner) => touchesBox(swept, [corner])),
  };
  if (outlineInside(shapeAt([0, 0]), near).length) return undefined;
  let offset: LatticePoint = [0, 0];
  for (const next of lineOffsets(to)) {
    const blockers = outlineInside(shapeAt(next), near);
    if (blockers.length) return { offset, source: stoppedBy(blockers, shapeAt(offset)) };
    offset = next;
  }
  return undefined;
}

const translated = (rings: Rings, offset: Point): Rings => rings.map((ring) => ring.map((corner) => plus(corner, offset)));

/**
 * Custom. A move against the outline stops at first contact: the room walks the straight line to
 * `delta` (`walkToOutline`) and stops on the last lattice offset before the outline reaches inside
 * it, so the rest stays inside, or outside for a room outside. What is left of the move then follows
 * each site axis in turn, across first, so a room against a wall still slides along it. What lights
 * up is each wall or corner that stopped it, so a room pushed into an inner corner lights both
 * walls. Undefined when nothing stops the move. Known limit: the straight line runs from where the
 * room was grabbed, so a move around an outline corner stops at it.
 */
export function stopMoveAtOutline(rings: Rings, delta: LatticePoint, candidates: SnapCandidates): { delta: LatticePoint; sources: SnapSource[] } | undefined {
  const first = walkToOutline((offset) => translated(rings, offset), delta, candidates);
  if (!first) return undefined;
  let offset = first.offset;
  const sources = [first.source];
  for (const axis of [0, 1] as const) {
    const rest: [number, number] = [0, 0];
    rest[axis] = delta[axis] - offset[axis];
    const from = offset;
    const stop = walkToOutline((step) => translated(rings, plus(from, step)), rest, candidates);
    sources.push(stop?.source);
    offset = plus(from, stop?.offset ?? rest);
  }
  return { delta: offset, sources: distinctSources(sources) };
}
