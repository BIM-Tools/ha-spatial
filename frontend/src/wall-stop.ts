// Stops a moved room or a stretched side where it first meets a wall it may not pass: the building outline, so a room inside stays inside and one outside stays outside, and the rooms beside it, so what exists keeps its space.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Polygon } from "geojson";
import type { LatticePoint } from "./site-frame";
import type { LatticeEdge, SnapCandidates, SnapSource } from "./snap";
import { distinctSources } from "./snap-highlight";

/** The rings of a shape in lattice units, outer ring first. */
export type Rings = readonly (readonly LatticePoint[])[];

/** Where a walk stopped, as an offset from where it started, and the wall or corner that stopped it. */
export interface WallStop {
  offset: LatticePoint;
  source?: SnapSource;
}

type Point = readonly [number, number];
type Box = readonly [number, number, number, number];

/** What a walk may not reach into: the outline's walls, which only count where they reach inside the shape, or a room, whose inside counts too. */
type Obstacle = { kind: "outline"; edges: LatticeEdge[]; corners: LatticePoint[] } | { kind: "room"; rings: Rings };

// Adding 0 turns -0 into 0, so equal points compare equal.
const plus = (point: Point, offset: Point): LatticePoint => [point[0] + offset[0] + 0, point[1] + offset[1] + 0];

// Exact on lattice integers and their halves: every product stays far below 2^53.
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

// How far `point` lies along `edge`, in units of its squared length.
const along = (point: Point, [from, to]: LatticeEdge) => (point[0] - from[0]) * (to[0] - from[0]) + (point[1] - from[1]) * (to[1] - from[1]);

// Two edges on one line that share more than a point; `direction` is 1 when they run the same way, else -1.
const overlapAlong = (edge: LatticeEdge, other: LatticeEdge): number => {
  if (orientation(edge[0], edge[1], other[0]) || orientation(edge[0], edge[1], other[1])) return 0;
  const [a, b] = [along(other[0], edge), along(other[1], edge)];
  const shared = Math.min(Math.max(a, b), along(edge[1], edge)) - Math.max(Math.min(a, b), 0);
  return shared > 0 ? Math.sign(b - a) : 0;
};

const edgesOf = (rings: Rings): LatticeEdge[] => rings.flatMap((ring) => ring.map((corner, index): LatticeEdge => [corner, ring[(index + 1) % ring.length]]));

// Each edge of `rings` with 1 when the shape lies to its left, -1 when to its right: an outer ring
// runs counterclockwise or not, inner rings the other way.
const sidedEdgesOf = (rings: Rings): { edge: LatticeEdge; side: number }[] =>
  rings.flatMap((ring, index) => {
    const turn = Math.sign(ring.reduce((sum, [x, y], at) => sum + x * ring[(at + 1) % ring.length][1] - ring[(at + 1) % ring.length][0] * y, 0));
    const side = index === 0 ? turn : -turn;
    return ring.map((corner, at) => ({ edge: [corner, ring[(at + 1) % ring.length]] as LatticeEdge, side }));
  });

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

const strictlyInsideOf = (rings: Rings) => {
  const shape: Polygon = { type: "Polygon", coordinates: rings.map((ring) => [...ring, ring[0]].map(([x, y]) => [x, y])) };
  return (point: Point) => booleanPointInPolygon([point[0], point[1]], shape, { ignoreBoundary: true });
};

// The middles of `edge` cut at each of `cuts` that lies on it, so each part lies wholly inside, outside or on a shape whose corners the cuts are.
const middlesOf = (edge: LatticeEdge, cuts: readonly Point[]): Point[] => {
  const points = [edge[0], edge[1], ...cuts.filter((cut) => onSegment(cut, edge))].sort((a, b) => along(a, edge) - along(b, edge));
  return points.slice(1).flatMap(([x, y], index): Point[] => {
    const [fromX, fromY] = points[index];
    return x === fromX && y === fromY ? [] : [[(fromX + x) / 2, (fromY + y) / 2]];
  });
};

/**
 * Custom. What of `edges` and `corners` reaches inside a shape: each edge that properly crosses one
 * of its edges or of which a part, cut at the shape's corners, lies strictly inside it; then each
 * corner strictly inside it. Touching and lying along a wall are not inside. Exact: orientation
 * tests on lattice integers, and turf's point in polygon, which is exact on them and their halves.
 */
function reachingInside(rings: Rings, edges: readonly LatticeEdge[], corners: readonly LatticePoint[]): SnapSource[] {
  const sides = edgesOf(rings);
  const cuts = rings.flat();
  const strictlyInside = strictlyInsideOf(rings);
  const inside: SnapSource[] = [];
  for (const edge of edges) {
    if (sides.some((side) => properlyCross(edge, side)) || middlesOf(edge, cuts).some(strictlyInside)) inside.push({ kind: "edge", edge });
  }
  for (const at of corners) if (strictlyInside(at)) inside.push({ kind: "corner", at });
  return inside;
}

/**
 * Custom. What of an obstacle stops a shape. Of the outline, what reaches inside the shape
 * (`reachingInside`). Of a room, where the two insides overlap: what of the room reaches inside the
 * shape, then each wall of the room that a wall of the shape lies along with both insides on one
 * side, as two identical rooms on top of each other; and when only the shape reaches inside the room,
 * every wall of the room. Sharing a wall with the insides on either side, or touching, is no overlap.
 */
function blockersOf(rings: Rings, obstacle: Obstacle): SnapSource[] {
  if (obstacle.kind === "outline") return reachingInside(rings, obstacle.edges, obstacle.corners);
  const walls = edgesOf(obstacle.rings);
  const blockers = reachingInside(rings, walls, obstacle.rings.flat());
  const sides = sidedEdgesOf(rings);
  for (const { edge, side } of sidedEdgesOf(obstacle.rings)) {
    if (sides.some((own) => overlapAlong(own.edge, edge) * own.side * side > 0)) blockers.push({ kind: "edge", edge });
  }
  if (blockers.length || !reachingInside(obstacle.rings, edgesOf(rings), []).length) return distinctSources(blockers);
  return walls.map((edge): SnapSource => ({ kind: "edge", edge }));
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

// What a walk names as its stop: of what stops it at the first blocked offset, a wall that a side of
// the stopped shape lies along, else one a corner of it lies on, else a corner on one of its sides,
// else the first.
const stoppedBy = (blockers: SnapSource[], stopped: Rings): SnapSource => {
  const corners = stopped.flat();
  const edges = edgesOf(stopped);
  const walls = blockers.filter((source) => source.kind === "edge");
  return (
    walls.find((source) => edges.some((edge) => overlapAlong(edge, source.edge))) ??
    walls.find((source) => corners.some((corner) => onSegment(corner, source.edge))) ??
    blockers.find((source) => source.kind === "corner" && edges.some((edge) => onSegment(source.at, edge))) ??
    blockers[0]
  );
};

/**
 * Custom. Walks a shape from offset [0, 0] to `to` over the lattice offsets of the straight line
 * (`lineOffsets`), and stops before the first one where it would reach into an obstacle
 * (`blockersOf`): the outline in `candidates`, or a room of `roomRings`; `shapeAt` gives the shape
 * at an offset. Undefined when it reaches `to`. An obstacle the shape already reaches into at the
 * start does not count, so a room past the outline or on top of a neighbour moves freely. The walk
 * is not monotone in what it meets (a room can pass the tip of a notch), so it checks every offset,
 * against only the obstacles within the box the shape sweeps. Known limit: only lattice offsets are
 * checked, so a feature thinner than one lattice unit can slip between two of them.
 */
export function walkToWall(shapeAt: (offset: LatticePoint) => Rings, to: LatticePoint, candidates: SnapCandidates): WallStop | undefined {
  if (!to[0] && !to[1]) return undefined;
  const start = shapeAt([0, 0]);
  const [first, last] = [boxOf(start), boxOf(shapeAt(to))];
  const swept: Box = [Math.min(first[0], last[0]), Math.min(first[1], last[1]), Math.max(first[2], last[2]), Math.max(first[3], last[3])];
  const outline: Obstacle = {
    kind: "outline",
    edges: candidates.outlineEdges.filter((edge) => touchesBox(swept, edge)),
    corners: candidates.outlineCorners.filter((corner) => touchesBox(swept, [corner])),
  };
  const rooms = candidates.roomRings.filter((rings) => touchesBox(swept, rings.flat())).map((rings): Obstacle => ({ kind: "room", rings }));
  const obstacles = [outline, ...rooms].filter((obstacle) => !blockersOf(start, obstacle).length);
  let offset: LatticePoint = [0, 0];
  for (const next of lineOffsets(to)) {
    const shape = shapeAt(next);
    const blockers = obstacles.flatMap((obstacle) => blockersOf(shape, obstacle));
    if (blockers.length) return { offset, source: stoppedBy(blockers, shapeAt(offset)) };
    offset = next;
  }
  return undefined;
}

const translated = (rings: Rings, offset: Point): Rings => rings.map((ring) => ring.map((corner) => plus(corner, offset)));

/**
 * Custom. A move against a wall stops at first contact: the room walks the straight line to `delta`
 * (`walkToWall`) and stops on the last lattice offset before it reaches past the outline or into a
 * neighbour. What is left of the move then follows each site axis in turn, across first, so a room
 * against a wall still slides along it. What lights up is each wall or corner that stopped it, so a
 * room pushed into an inner corner lights both walls. Undefined when nothing stops the move. Known
 * limit: the straight line runs from where the room was grabbed, so a move around a corner stops at it.
 */
export function stopMoveAtWalls(rings: Rings, delta: LatticePoint, candidates: SnapCandidates): { delta: LatticePoint; sources: SnapSource[] } | undefined {
  const first = walkToWall((offset) => translated(rings, offset), delta, candidates);
  if (!first) return undefined;
  let offset = first.offset;
  const sources = [first.source];
  for (const axis of [0, 1] as const) {
    const rest: [number, number] = [0, 0];
    rest[axis] = delta[axis] - offset[axis];
    const from = offset;
    const stop = walkToWall((step) => translated(rings, plus(from, step)), rest, candidates);
    sources.push(stop?.source);
    offset = plus(from, stop?.offset ?? rest);
  }
  return { delta: offset, sources: distinctSources(sources) };
}
