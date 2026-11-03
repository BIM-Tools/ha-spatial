// Picks where a drawn or moved point lands, so rooms drawn side by side share their walls exactly.

import type { Polygon } from "geojson";
import type { LatticePoint, PlanFrame } from "./site-frame";

/** An edge along a site axis, in lattice units. */
export type LatticeEdge = readonly [LatticePoint, LatticePoint];

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

/** Every corner of every ring, outer and inner, and only the edges that run along a site axis. */
export function candidatesOf(frame: PlanFrame, rooms: Polygon[], outline: Polygon | undefined): SnapCandidates {
  const of = (shapes: Polygon[]) => {
    const corners: LatticePoint[] = [];
    const edges: LatticeEdge[] = [];
    for (const ring of shapes.flatMap((shape) => shape.coordinates)) {
      const points = ring.slice(0, -1).map((corner) => frame.toLattice(corner));
      corners.push(...points);
      points.forEach((point, index) => {
        const next = points[(index + 1) % points.length];
        if (point[0] === next[0] || point[1] === next[1]) edges.push([point, next]);
      });
    }
    return { corners, edges };
  };
  const room = of(rooms);
  const building = of(outline ? [outline] : []);
  return { roomCorners: room.corners, roomEdges: room.edges, outlineCorners: building.corners, outlineEdges: building.edges };
}

const tiersOf = (candidates: SnapCandidates): Tier[] => [
  { corners: candidates.roomCorners },
  { edges: candidates.roomEdges },
  { corners: candidates.outlineCorners },
  { edges: candidates.outlineEdges },
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
 * Custom. The delta for a room moved by `delta`: each moved corner is tried as in `snapPoint`, and
 * the best hit (tier, then distance) sets the delta. Onto an edge only the coordinate across it is
 * set; along it, and without a hit, the delta rounds to whole grid steps, so the room keeps its
 * offset to the grid. Known limit: the room's corners align to candidates, not its edges to a
 * neighbour's corners.
 */
export function snapMove(
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
