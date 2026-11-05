// Picks where a drawn or moved point lands, so rooms drawn side by side share their walls exactly and stop at the outline.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Polygon } from "geojson";
import type { LatticePoint, PlanFrame } from "./site-frame";

/** An edge in lattice units. */
export type LatticeEdge = readonly [LatticePoint, LatticePoint];

/** Room edges run along a site axis; outline edges are all of them. */
export interface SnapCandidates {
  roomCorners: LatticePoint[];
  roomEdges: LatticeEdge[];
  outlineCorners: LatticePoint[];
  outlineEdges: LatticeEdge[];
}

/** What a point snapped to: what lights up. */
export type SnapSource =
  | { kind: "corner"; at: LatticePoint }
  | { kind: "edge"; edge: LatticeEdge }
  | { kind: "grid" }
  | { kind: "lattice" };

/** `radius` in lattice units; `free` places on the lattice without snapping. */
export interface SnapOptions {
  radius: number;
  gridUnits: number;
  free: boolean;
}

type Tier = { corners: readonly LatticePoint[] } | { edges: readonly LatticeEdge[] };

interface Hit {
  tier: number;
  distance: number;
  source: { kind: "corner"; at: LatticePoint } | { kind: "edge"; edge: LatticeEdge };
}

// Adding 0 turns -0 into 0, so equal points compare equal.
const whole = (value: number) => Math.round(value) + 0;
const toGrid = (value: number, gridUnits: number) => whole(value / gridUnits) * gridUnits + 0;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
// The coordinate an axis edge keeps fixed: 0 when it runs along y, 1 when it runs along x.
const fixedAxis = ([from, to]: LatticeEdge): 0 | 1 => (from[0] === to[0] ? 0 : 1);
const alongRange = (edge: LatticeEdge, along: 0 | 1): [number, number] => [
  Math.min(edge[0][along], edge[1][along]),
  Math.max(edge[0][along], edge[1][along]),
];

const isAxisEdge = ([from, to]: LatticeEdge) => from[0] === to[0] || from[1] === to[1];

/**
 * Every corner of every ring, outer and inner; of rooms only the edges that run along a site axis,
 * of the outline every edge, since every outline edge stops a moved or resized room.
 */
export function candidatesOf(frame: PlanFrame, rooms: Polygon[], outline: Polygon | undefined): SnapCandidates {
  const of = (shapes: Polygon[]) => {
    const corners: LatticePoint[] = [];
    const edges: LatticeEdge[] = [];
    for (const ring of shapes.flatMap((shape) => shape.coordinates)) {
      const points = ring.slice(0, -1).map((corner) => frame.toLattice(corner));
      corners.push(...points);
      points.forEach((point, index) => edges.push([point, points[(index + 1) % points.length]]));
    }
    return { corners, edges };
  };
  const room = of(rooms);
  const building = of(outline ? [outline] : []);
  return {
    roomCorners: room.corners,
    roomEdges: room.edges.filter(isAxisEdge),
    outlineCorners: building.corners,
    outlineEdges: building.edges,
  };
}

/**
 * The candidates of a gesture: the footprints of the floor's areas and the outline, stored under
 * `outlineId`, without the shape `exclude` names, so a moved or resized shape does not snap to itself.
 */
export function snapCandidatesFor(
  frame: PlanFrame,
  floorAreaIds: readonly string[],
  footprints: ReadonlyMap<string, Polygon>,
  outlineId: string,
  exclude?: string,
): SnapCandidates {
  const rooms = floorAreaIds.filter((areaId) => areaId !== exclude).flatMap((areaId) => footprints.get(areaId) ?? []);
  const outline = exclude === outlineId ? undefined : footprints.get(outlineId);
  return candidatesOf(frame, rooms, outline);
}

const tiersOf = (candidates: SnapCandidates): Tier[] => [
  { corners: candidates.roomCorners },
  { edges: candidates.roomEdges },
  { corners: candidates.outlineCorners },
  { edges: candidates.outlineEdges.filter(isAxisEdge) },
];

// The first tier with a candidate within the radius, and in it the nearest; a tie keeps the earlier one.
const nearestHit = (
  pointer: readonly [number, number],
  candidates: SnapCandidates,
  radius: number,
  accept: (source: Hit["source"]) => boolean = () => true,
): Hit | undefined => {
  const tiers = tiersOf(candidates);
  for (const [tier, entries] of tiers.entries()) {
    let best: Hit | undefined;
    const consider = (distance: number, source: Hit["source"]) => {
      if (distance <= radius && (!best || distance < best.distance) && accept(source)) best = { tier, distance, source };
    };
    if ("corners" in entries) {
      for (const at of entries.corners) consider(Math.hypot(pointer[0] - at[0], pointer[1] - at[1]), { kind: "corner", at });
    } else {
      for (const edge of entries.edges) {
        const fixed = fixedAxis(edge);
        const along = fixed === 0 ? 1 : 0;
        const [low, high] = alongRange(edge, along);
        const across = pointer[fixed] - edge[0][fixed];
        consider(Math.hypot(across, pointer[along] - clamp(pointer[along], low, high)), { kind: "edge", edge });
      }
    }
    if (best) return best;
  }
  return undefined;
};

/**
 * Custom. Where a pointer lands: on a room corner, else a room's axis edge, else an outline corner,
 * else an outline axis edge, each within `radius`; else on the grid. On an edge the point keeps the
 * edge's fixed coordinate and the pointer's other coordinate rounded to the grid, clamped to the
 * edge. Known limits: diagonal edges never snap (their corners do); distances are Euclidean in
 * lattice units, so the caller converts its pixel radius at the pointer.
 */
export function snapPoint(
  pointer: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): { point: LatticePoint; source: SnapSource } {
  if (options.free) return { point: [whole(pointer[0]), whole(pointer[1])], source: { kind: "lattice" } };
  const hit = nearestHit(pointer, candidates, options.radius);
  if (!hit) return { point: [toGrid(pointer[0], options.gridUnits), toGrid(pointer[1], options.gridUnits)], source: { kind: "grid" } };
  if (hit.source.kind === "corner") return { point: hit.source.at, source: hit.source };
  const edge = hit.source.edge;
  const fixed = fixedAxis(edge);
  const along = fixed === 0 ? 1 : 0;
  const [low, high] = alongRange(edge, along);
  const point: [number, number] = [0, 0];
  point[fixed] = edge[0][fixed];
  point[along] = clamp(toGrid(pointer[along], options.gridUnits), low, high);
  return { point, source: hit.source };
}

/**
 * Custom. The delta for a room, given by its rings, moved by `delta`: each moved corner is tried as
 * in `snapPoint`, and the best hit (tier, then distance) sets the delta. Onto an edge only the
 * coordinate across it is set; along it, and without a hit, the delta rounds to whole grid steps, so
 * the room keeps its offset to the grid. Then the move stops at the outline (`stopMoveAtOutline`),
 * with Alt too. Known limit: the room's corners align to candidates, not its edges to a neighbour's
 * corners.
 */
export function snapMove(
  rings: readonly (readonly LatticePoint[])[],
  delta: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): { delta: LatticePoint; source: SnapSource } {
  const aligned = alignMove(rings.flat(), delta, candidates, options);
  return stopMoveAtOutline(rings, aligned.delta, candidates) ?? aligned;
}

function alignMove(
  corners: readonly LatticePoint[],
  delta: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): { delta: LatticePoint; source: SnapSource } {
  if (options.free) return { delta: [whole(delta[0]), whole(delta[1])], source: { kind: "lattice" } };
  const onGrid: [number, number] = [toGrid(delta[0], options.gridUnits), toGrid(delta[1], options.gridUnits)];
  let best: { hit: Hit; corner: LatticePoint } | undefined;
  for (const corner of corners) {
    // Along a wall the corner moves by whole grid steps, which must keep it on the wall.
    const staysOnEdge = (source: Hit["source"]) => {
      if (source.kind !== "edge") return true;
      const along = fixedAxis(source.edge) === 0 ? 1 : 0;
      const [low, high] = alongRange(source.edge, along);
      const movedTo = corner[along] + onGrid[along];
      return movedTo >= low && movedTo <= high;
    };
    const hit = nearestHit([corner[0] + delta[0], corner[1] + delta[1]], candidates, options.radius, staysOnEdge);
    if (hit && (!best || hit.tier < best.hit.tier || (hit.tier === best.hit.tier && hit.distance < best.hit.distance))) {
      best = { hit, corner };
    }
  }
  if (!best) return { delta: onGrid, source: { kind: "grid" } };
  const { hit, corner } = best;
  if (hit.source.kind === "corner") {
    return { delta: [hit.source.at[0] - corner[0] + 0, hit.source.at[1] - corner[1] + 0], source: hit.source };
  }
  const fixed = fixedAxis(hit.source.edge);
  onGrid[fixed] = hit.source.edge[0][fixed] - corner[fixed] + 0;
  return { delta: onGrid, source: hit.source };
}

/** A corner of a swept shape: at `at` when the sweep starts, at `at` plus `velocity` when it ends. */
export interface SweptCorner {
  at: LatticePoint;
  velocity: LatticePoint;
}

/** Where a swept shape first touches the outline, as the progress of the sweep from 0 to 1. */
export interface OutlineContact {
  progress: number;
  source?: SnapSource;
}

// c0 + c1 t + c2 t^2 in the sweep's progress t.
type Polynomial = readonly [number, number, number];

// Contacts are found in floating point between lattice integers; this much counts as equal.
const SLACK = 1e-9;
const STILL: LatticePoint = [0, 0];
const still = (at: LatticePoint): SweptCorner => ({ at, velocity: STILL });
const cross = (a: readonly [number, number], b: readonly [number, number]) => a[0] * b[1] - a[1] * b[0];
const positionAt = ({ at, velocity }: SweptCorner, t: number): [number, number] => [at[0] + t * velocity[0], at[1] + t * velocity[1]];
const edgesOf = (ring: readonly SweptCorner[]) => ring.map((corner, index) => [corner, ring[(index + 1) % ring.length]] as const);

// The side of the line from `from` to `to` that `point` lies on during the sweep. The coefficients
// are integers, so a contact that lasts the whole sweep is exactly zero.
const sideOf = (from: SweptCorner, to: SweptCorner, point: SweptCorner): Polynomial => {
  const line: LatticePoint = [to.at[0] - from.at[0], to.at[1] - from.at[1]];
  const turn: LatticePoint = [to.velocity[0] - from.velocity[0], to.velocity[1] - from.velocity[1]];
  const offset: LatticePoint = [point.at[0] - from.at[0], point.at[1] - from.at[1]];
  const drift: LatticePoint = [point.velocity[0] - from.velocity[0], point.velocity[1] - from.velocity[1]];
  return [cross(line, offset), cross(line, drift) + cross(turn, offset), cross(turn, drift)];
};
const valueAt = ([c0, c1, c2]: Polynomial, t: number) => c0 + t * (c1 + t * c2);
const signAt = (polynomial: Polynomial, t: number) => Math.sign(valueAt(polynomial, t));

// Where a polynomial is zero; none when it always is, which is a contact that only slides.
const rootsOf = ([c0, c1, c2]: Polynomial): number[] => {
  if (c2 === 0) return c1 === 0 ? [] : [-c0 / c1];
  const discriminant = c1 * c1 - 4 * c2 * c0;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-c1 - root) / (2 * c2), (-c1 + root) / (2 * c2)];
};

// Whether a point already on the line from `from` to `to` lies between them.
const withinSegment = (point: readonly [number, number], from: readonly [number, number], to: readonly [number, number]) => {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const squared = dx * dx + dy * dy;
  const along = squared ? ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / squared : 0;
  return along >= -SLACK && along <= 1 + SLACK;
};

// Every progress at which a corner of the shape meets an outline edge, an outline corner meets an
// edge of the shape, or two corners meet: only there can the shape start to cross the outline.
function contactsOf(rings: readonly (readonly SweptCorner[])[], candidates: SnapCandidates): OutlineContact[] {
  const contacts: OutlineContact[] = [];
  const add = (progress: number, source: SnapSource) => {
    if (progress >= -SLACK && progress <= 1 + SLACK) contacts.push({ progress, source });
  };
  const corners = rings.flat();
  const edges = rings.flatMap(edgesOf);
  for (const edge of candidates.outlineEdges) {
    for (const corner of corners) {
      for (const t of rootsOf(sideOf(still(edge[0]), still(edge[1]), corner))) {
        if (withinSegment(positionAt(corner, t), edge[0], edge[1])) add(t, { kind: "edge", edge });
      }
    }
  }
  for (const at of candidates.outlineCorners) {
    for (const [from, to] of edges) {
      for (const t of rootsOf(sideOf(from, to, still(at)))) {
        if (withinSegment(at, positionAt(from, t), positionAt(to, t))) add(t, { kind: "corner", at });
      }
    }
    for (const { at: start, velocity } of corners) {
      const offset: LatticePoint = [at[0] - start[0], at[1] - start[1]];
      const speed = velocity[0] * velocity[0] + velocity[1] * velocity[1];
      if (speed && cross(offset, velocity) === 0) add((offset[0] * velocity[0] + offset[1] * velocity[1]) / speed, { kind: "corner", at });
    }
  }
  return contacts.sort((a, b) => a.progress - b.progress);
}

// Whether the outline reaches inside the shape at progress t: an outline edge crossing one of its
// edges, or an outline corner strictly inside it. Touching and sliding along a wall are not crossing.
function crossesAt(rings: readonly (readonly SweptCorner[])[], candidates: SnapCandidates, t: number): boolean {
  const edges = rings.flatMap(edgesOf);
  for (const [a, b] of candidates.outlineEdges.map(([from, to]) => [still(from), still(to)])) {
    for (const [from, to] of edges) {
      const apart = signAt(sideOf(a, b, from), t) * signAt(sideOf(a, b, to), t);
      if (apart < 0 && signAt(sideOf(from, to, a), t) * signAt(sideOf(from, to, b), t) < 0) return true;
    }
  }
  const shape: Polygon = { type: "Polygon", coordinates: rings.map((ring) => [...ring, ring[0]].map((corner) => positionAt(corner, t))) };
  return candidates.outlineCorners.some((at) => {
    const onEdge = edges.some(
      ([from, to]) => valueAt(sideOf(from, to, still(at)), t) === 0 && withinSegment(at, positionAt(from, t), positionAt(to, t)),
    );
    return !onEdge && booleanPointInPolygon([at[0], at[1]], shape);
  });
}

/**
 * Custom. How far a shape whose corners move along their velocities gets before the outline reaches
 * inside it: the progress of its first contact and the outline edge or corner it touches there,
 * preferring an edge. Undefined when it never crosses, or crosses already at the start, so a room
 * past the outline moves freely. The shape only crosses after a contact, so each stretch between
 * contacts is checked once, in its middle. Known limit: the shape's edges must stay straight, and
 * each corner moves in a straight line.
 */
export function outlineContact(rings: readonly (readonly SweptCorner[])[], candidates: SnapCandidates): OutlineContact | undefined {
  if (crossesAt(rings, candidates, 0)) return undefined;
  const contacts = contactsOf(rings, candidates);
  const stops = [0, ...contacts.map(({ progress }) => progress).filter((t) => t > SLACK && t < 1 - SLACK), 1];
  for (let index = 0; index + 1 < stops.length; index++) {
    const [low, high] = [stops[index], stops[index + 1]];
    if (high - low <= SLACK || !crossesAt(rings, candidates, (low + high) / 2)) continue;
    const touching = contacts.filter(({ progress }) => Math.abs(progress - low) <= SLACK);
    return { progress: low, source: (touching.find(({ source }) => source?.kind === "edge") ?? touching[0])?.source };
  }
  return undefined;
}

/** How near a lattice integer a contact found in floating point counts as on it: contacts are rationals with small denominators. */
export const NEAR_LATTICE = 1e-7;
const latticeAround = (value: number) =>
  Math.abs(value - Math.round(value)) <= NEAR_LATTICE ? [whole(value)] : [Math.floor(value) + 0, Math.ceil(value) + 0];

const translated = (rings: readonly (readonly LatticePoint[])[], offset: LatticePoint, velocity: LatticePoint) =>
  rings.map((ring) => ring.map((corner): SweptCorner => ({ at: [corner[0] + offset[0], corner[1] + offset[1]], velocity })));

// Where a room at `offset` moved by `delta` stops at the outline: the lattice offset nearest its
// first contact from which the straight path from `offset` stays clear; undefined when nothing stops it.
function latticeStop(
  rings: readonly (readonly LatticePoint[])[],
  offset: LatticePoint,
  delta: LatticePoint,
  candidates: SnapCandidates,
): { offset: LatticePoint; source?: SnapSource } | undefined {
  if (!delta[0] && !delta[1]) return undefined;
  const contact = outlineContact(translated(rings, offset, delta), candidates);
  if (!contact) return undefined;
  const reached = [offset[0] + contact.progress * delta[0], offset[1] + contact.progress * delta[1]];
  const around = latticeAround(reached[0])
    .flatMap((x) => latticeAround(reached[1]).map((y): LatticePoint => [x, y]))
    .sort((a, b) => Math.hypot(a[0] - reached[0], a[1] - reached[1]) - Math.hypot(b[0] - reached[0], b[1] - reached[1]));
  const clear = around.find((to) => !outlineContact(translated(rings, offset, [to[0] - offset[0], to[1] - offset[1]]), candidates));
  return { offset: clear ?? offset, source: contact.source };
}

/**
 * Custom. A move against the outline stops at first contact: the room travels in a straight line to
 * `delta` and stops where its first corner or edge touches an outline wall or corner, so the rest
 * stays inside, or outside for a room outside. What is left of the move then follows each site axis
 * in turn, across first, so a room against a wall still slides along it. Undefined when nothing
 * stops the move. Known limits: the straight line runs from where the room was grabbed, so a move
 * around an outline corner stops at it; a contact between lattice points lands on the nearest
 * lattice offset with a clear path, which can leave a gap under one lattice unit.
 */
function stopMoveAtOutline(
  rings: readonly (readonly LatticePoint[])[],
  delta: LatticePoint,
  candidates: SnapCandidates,
): { delta: LatticePoint; source: SnapSource } | undefined {
  const first = latticeStop(rings, [0, 0], delta, candidates);
  if (!first) return undefined;
  let offset = first.offset;
  for (const axis of [0, 1] as const) {
    const rest: [number, number] = [0, 0];
    rest[axis] = delta[axis] - offset[axis];
    offset = latticeStop(rings, offset, rest, candidates)?.offset ?? [offset[0] + rest[0], offset[1] + rest[1]];
  }
  return { delta: offset, source: first.source ?? { kind: "grid" } };
}

/**
 * Custom. Where a line across `axis` at `value` lands, for an edge drag: on a room edge parallel to
 * it, a room corner, an outline parallel edge or an outline corner within `radius`, else on a grid
 * line. An edge lists before its end corners, so the wall lights up rather than a corner. Known
 * limit: candidates count by their coordinate on `axis` alone, however far along the line they lie.
 */
export function snapLine(
  value: number,
  axis: 0 | 1,
  candidates: SnapCandidates,
  options: SnapOptions,
): { value: number; source: SnapSource } {
  if (options.free) return { value: whole(value), source: { kind: "lattice" } };
  const parallel = (edges: LatticeEdge[]) => edges.filter((edge) => edge[0][axis] === edge[1][axis]);
  const tiers: Tier[] = [
    { edges: parallel(candidates.roomEdges) },
    { corners: candidates.roomCorners },
    { edges: parallel(candidates.outlineEdges) },
    { corners: candidates.outlineCorners },
  ];
  for (const entries of tiers) {
    let best: { distance: number; value: number; source: SnapSource } | undefined;
    const consider = (line: number, source: SnapSource) => {
      const distance = Math.abs(value - line);
      if (distance <= options.radius && (!best || distance < best.distance)) best = { distance, value: line, source };
    };
    if ("corners" in entries) for (const at of entries.corners) consider(at[axis], { kind: "corner", at });
    else for (const edge of entries.edges) consider(edge[0][axis], { kind: "edge", edge });
    if (best) return { value: best.value, source: best.source };
  }
  return { value: toGrid(value, options.gridUnits), source: { kind: "grid" } };
}
