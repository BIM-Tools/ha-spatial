// Picks where a drawn or moved point lands, so rooms drawn side by side share their walls exactly and stop at the outline.

import type { Polygon } from "geojson";
import { stopMoveAtOutline } from "./outline-stop";
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

/** What a snap lights up: a corner as a dot, a wall as a line. The grid and the lattice light up nothing. */
export type SnapSource = { kind: "corner"; at: LatticePoint } | { kind: "edge"; edge: LatticeEdge };

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
  source: SnapSource;
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

const otherAxis = (axis: 0 | 1): 0 | 1 => (axis === 0 ? 1 : 0);
const within = ([low, high]: [number, number], value: number) => value >= low && value <= high;

const isAxisEdge = ([from, to]: LatticeEdge) => from[0] === to[0] || from[1] === to[1];

// A hit wins over `best` by its tier, then its distance; a tie keeps `best`.
const beats = (hit: Hit, best: Hit | undefined) =>
  !best || hit.tier < best.tier || (hit.tier === best.tier && hit.distance < best.distance);

// Whether `edge` runs through `point` and on past it towards `toward`; any way when `toward` is level with it.
const reachesToward = (edge: LatticeEdge, point: LatticePoint, toward: readonly [number, number]) => {
  const fixed = fixedAxis(edge);
  const along = otherAxis(fixed);
  if (edge[0][fixed] !== point[fixed]) return false;
  const [low, high] = alongRange(edge, along);
  const side = Math.sign(toward[along] - point[along]);
  return point[along] >= low && point[along] <= high && (side > 0 ? point[along] < high : side < 0 ? point[along] > low : true);
};

/**
 * What a snap onto the corner `at` lights up: when a wall along each axis runs from it towards
 * `toward`, the side the pointer or the room is on, those two walls, so a point in an inner corner
 * shows both walls it sits against; else the corner as a dot.
 */
function cornerSources(at: LatticePoint, candidates: SnapCandidates, toward: readonly [number, number]): SnapSource[] {
  const walls = [...candidates.roomEdges, ...candidates.outlineEdges.filter(isAxisEdge)];
  const reaching = walls.filter((edge) => reachesToward(edge, at, toward));
  const upright = reaching.find((edge) => fixedAxis(edge) === 0);
  const level = reaching.find((edge) => fixedAxis(edge) === 1);
  return upright && level
    ? [
        { kind: "edge", edge: upright },
        { kind: "edge", edge: level },
      ]
    : [{ kind: "corner", at }];
}

// Accepts a wall across `wall` that `point`, already on `wall`, may slide onto along it: it spans
// `point`'s coordinate on `wall`'s fixed axis, and `keepOnWall` accepts where it lies.
const crossingWall =
  (wall: LatticeEdge, point: readonly [number, number], keepOnWall: (value: number) => boolean) =>
  (source: SnapSource) => {
    if (source.kind !== "edge") return false;
    const fixed = fixedAxis(wall);
    return fixedAxis(source.edge) === otherAxis(fixed) && within(alongRange(source.edge, fixed), point[fixed]) && keepOnWall(source.edge[0][otherAxis(fixed)]);
  };

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
 * edge's fixed coordinate, and takes the other one from a wall across it within `radius` that it
 * meets, else from the pointer rounded to the grid, clamped to the edge. `sources` is what lights
 * up: the edge, or both walls; on a corner, both walls when the pointer is in the corner they make
 * (`cornerSources`), else the corner; nothing on the grid. Known limits: diagonal edges never snap
 * (their corners do); distances are Euclidean in lattice units, so the caller converts its pixel
 * radius at the pointer.
 */
export function snapPoint(
  pointer: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): { point: LatticePoint; sources: SnapSource[] } {
  if (options.free) return { point: [whole(pointer[0]), whole(pointer[1])], sources: [] };
  const hit = nearestHit(pointer, candidates, options.radius);
  if (!hit) return { point: [toGrid(pointer[0], options.gridUnits), toGrid(pointer[1], options.gridUnits)], sources: [] };
  if (hit.source.kind === "corner") return { point: hit.source.at, sources: cornerSources(hit.source.at, candidates, pointer) };
  const edge = hit.source.edge;
  const fixed = fixedAxis(edge);
  const along = otherAxis(fixed);
  const extent = alongRange(edge, along);
  const point: [number, number] = [0, 0];
  point[fixed] = edge[0][fixed];
  const crossing = nearestHit(pointer, candidates, options.radius, crossingWall(edge, point, (value) => within(extent, value)));
  if (crossing?.source.kind === "edge") {
    point[along] = crossing.source.edge[0][along];
    return { point, sources: [hit.source, crossing.source] };
  }
  point[along] = clamp(toGrid(pointer[along], options.gridUnits), ...extent);
  return { point, sources: [hit.source] };
}

/**
 * Custom. The delta for a room, given by its rings, moved by `delta`: each moved corner is tried as
 * in `snapPoint`, and the best hit (tier, then distance) sets the delta. Onto an edge only the
 * coordinate across it is set; along it another corner may meet a wall across it within the radius,
 * so a room pushed into an inner corner rests against both walls; else, and without a hit, the delta
 * rounds to whole grid steps, so the room keeps its offset to the grid. Then the move stops at the
 * outline (`stopMoveAtOutline`), with Alt too. `sources` is what lights up, as in `snapPoint`, with
 * the room's side of a corner taken from the corner's neighbours in its ring. Known limit: the
 * room's corners align to candidates, not its edges to a neighbour's corners.
 */
export function snapMove(
  rings: readonly (readonly LatticePoint[])[],
  delta: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): { delta: LatticePoint; sources: SnapSource[] } {
  const aligned = alignMove(rings, delta, candidates, options);
  return stopMoveAtOutline(rings, aligned.delta, candidates) ?? aligned;
}

function alignMove(
  rings: readonly (readonly LatticePoint[])[],
  delta: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): { delta: LatticePoint; sources: SnapSource[] } {
  if (options.free) return { delta: [whole(delta[0]), whole(delta[1])], sources: [] };
  const onGrid: [number, number] = [toGrid(delta[0], options.gridUnits), toGrid(delta[1], options.gridUnits)];
  const movedBy = (corner: LatticePoint, by: readonly [number, number]): [number, number] => [corner[0] + by[0], corner[1] + by[1]];
  let best: { hit: Hit; corner: LatticePoint; inward: [number, number] } | undefined;
  for (const ring of rings) {
    ring.forEach((corner, index) => {
      // Along a wall the corner moves by whole grid steps, which must keep it on the wall.
      const staysOnEdge = (source: SnapSource) => {
        if (source.kind !== "edge") return true;
        const along = otherAxis(fixedAxis(source.edge));
        return within(alongRange(source.edge, along), corner[along] + onGrid[along]);
      };
      const hit = nearestHit(movedBy(corner, delta), candidates, options.radius, staysOnEdge);
      if (!hit || !beats(hit, best?.hit)) return;
      // Halfway between the corner's neighbours lies on the room's side of it.
      const [before, after] = [ring[(index + ring.length - 1) % ring.length], ring[(index + 1) % ring.length]];
      best = { hit, corner, inward: [(before[0] + after[0]) / 2, (before[1] + after[1]) / 2] };
    });
  }
  if (!best) return { delta: onGrid, sources: [] };
  const { hit, corner, inward } = best;
  if (hit.source.kind === "corner") {
    const moved: LatticePoint = [hit.source.at[0] - corner[0] + 0, hit.source.at[1] - corner[1] + 0];
    return { delta: moved, sources: cornerSources(hit.source.at, candidates, movedBy(inward, moved)) };
  }
  const wall = hit.source.edge;
  const fixed = fixedAxis(wall);
  const along = otherAxis(fixed);
  onGrid[fixed] = wall[0][fixed] - corner[fixed] + 0;
  let crossing: { hit: Hit; corner: LatticePoint } | undefined;
  for (const other of rings.flat()) {
    const at = movedBy(other, delta);
    at[fixed] = other[fixed] + onGrid[fixed];
    const keepOnWall = (value: number) => within(alongRange(wall, along), corner[along] + value - other[along]);
    const across = nearestHit(at, candidates, options.radius, crossingWall(wall, at, keepOnWall));
    if (across && beats(across, crossing?.hit)) crossing = { hit: across, corner: other };
  }
  if (crossing?.hit.source.kind !== "edge") return { delta: onGrid, sources: [hit.source] };
  onGrid[along] = crossing.hit.source.edge[0][along] - crossing.corner[along] + 0;
  return { delta: onGrid, sources: [hit.source, crossing.hit.source] };
}

/** Each source once, in order, without the missing ones. */
export function distinctSources(sources: readonly (SnapSource | undefined)[]): SnapSource[] {
  const keys = sources.map((source) => JSON.stringify(source));
  return sources.filter((source, index): source is SnapSource => source !== undefined && keys.indexOf(keys[index]) === index);
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
): { value: number; sources: SnapSource[] } {
  if (options.free) return { value: whole(value), sources: [] };
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
    if (best) return { value: best.value, sources: [best.source] };
  }
  return { value: toGrid(value, options.gridUnits), sources: [] };
}
