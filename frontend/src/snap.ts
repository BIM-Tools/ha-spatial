// Picks where a drawn or moved point lands, so rooms drawn side by side share their walls exactly and stop at the outline.

import type { Polygon } from "geojson";
import { stopMoveAtOutline } from "./outline-stop";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { distinctSources } from "./snap-highlight";

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

/** A wall or a corner across an axis that a coordinate can land on, within the radius of `reach` along the other axis. */
interface Guide {
  value: number;
  reach: readonly [number, number];
  source: SnapSource;
}

/** A coordinate looking for a guide, and the span it covers along the other axis. */
interface Probe {
  value: number;
  along: readonly [number, number];
}

// Adding 0 turns -0 into 0, so equal points compare equal.
const whole = (value: number) => Math.round(value) + 0;
const toGrid = (value: number, gridUnits: number) => whole(value / gridUnits) * gridUnits + 0;
const otherAxis = (axis: 0 | 1): 0 | 1 => (axis === 0 ? 1 : 0);
const spanAt = (value: number): [number, number] => [value, value];
const isAxisEdge = ([from, to]: LatticeEdge) => from[0] === to[0] || from[1] === to[1];
// How far apart two spans lie, 0 when they overlap.
const gapBetween = (a: readonly [number, number], b: readonly [number, number]) => Math.max(0, a[0] - b[1], b[0] - a[1]);

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

/**
 * The guides across `axis` in tiers, rooms before the outline: each wall that runs across `axis` and
 * each corner. Walls list first, so on a tie with their own end corner the wall lights up.
 */
function guidesAcross(axis: 0 | 1, candidates: SnapCandidates): Guide[][] {
  const along = otherAxis(axis);
  const walls = (edges: readonly LatticeEdge[]) =>
    edges
      .filter((edge) => edge[0][axis] === edge[1][axis])
      .map((edge): Guide => {
        const reach = [Math.min(edge[0][along], edge[1][along]), Math.max(edge[0][along], edge[1][along])] as const;
        return { value: edge[0][axis], reach, source: { kind: "edge", edge } };
      });
  const corners = (points: readonly LatticePoint[]) =>
    points.map((at): Guide => ({ value: at[axis], reach: spanAt(at[along]), source: { kind: "corner", at } }));
  return [
    [...walls(candidates.roomEdges), ...corners(candidates.roomCorners)],
    [...walls(candidates.outlineEdges), ...corners(candidates.outlineCorners)],
  ];
}

/**
 * Custom. In the first tier that has one, the guide nearest any of `probes` across, within `radius`
 * across and along, then nearest along, so the corner nearest the pointer lights up; a tie keeps the
 * earlier guide and probe. `probe` is the index of the probe it snaps.
 */
function nearestGuide(tiers: Guide[][], probes: readonly Probe[], radius: number): { guide: Guide; probe: number } | undefined {
  for (const guides of tiers) {
    let best: { guide: Guide; probe: number; across: number; along: number } | undefined;
    probes.forEach(({ value, along: span }, probe) => {
      for (const guide of guides) {
        const across = Math.abs(value - guide.value);
        const along = gapBetween(guide.reach, span);
        if (across > radius || along > radius) continue;
        if (!best || across < best.across || (across === best.across && along < best.along)) best = { guide, probe, across, along };
      }
    });
    if (best) return best;
  }
  return undefined;
}

/**
 * Custom, per axis like the smart guides of drawing programs. Where a pointer lands: each coordinate
 * on its own, as `snapLine` puts it, so x may rest on one wall and y on another. `sources` is what
 * lights up: the guide of each axis, once. Near a corner both its walls light up, inside or outside
 * it, since a wall wins a tie with its own end corner; a corner lights up as a dot only for an axis
 * that no wall through it reaches, as at the end of a diagonal wall. Nothing lights up on the grid.
 * Known limit: `radius` is in lattice units, so the caller converts its pixel radius at the pointer.
 */
export function snapPoint(
  pointer: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): { point: LatticePoint; sources: SnapSource[] } {
  const x = snapLine(pointer[0], 0, candidates, options, spanAt(pointer[1]));
  const y = snapLine(pointer[1], 1, candidates, options, spanAt(pointer[0]));
  return { point: [x.value, y.value], sources: distinctSources([...x.sources, ...y.sources]) };
}

/**
 * Custom. The delta for a room, given by its rings, moved by `delta`: per axis, the guide nearest
 * any moved corner (tier, then distance, as in `snapLine`) sets the delta; an axis without one moves
 * by whole grid steps, so the room keeps its offset to the grid. A room pushed into a corner thus
 * rests against both walls. Then the move stops at the outline (`stopMoveAtOutline`), with Alt too.
 * `sources` is what lights up, as in `snapPoint`.
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
  const corners = rings.flat();
  const moved: [number, number] = [0, 0];
  const sources: SnapSource[] = [];
  for (const axis of [0, 1] as const) {
    const along = otherAxis(axis);
    const probes = corners.map((corner) => ({ value: corner[axis] + delta[axis], along: spanAt(corner[along] + delta[along]) }));
    const hit = nearestGuide(guidesAcross(axis, candidates), probes, options.radius);
    moved[axis] = hit ? hit.guide.value - corners[hit.probe][axis] + 0 : toGrid(delta[axis], options.gridUnits);
    if (hit) sources.push(hit.guide.source);
  }
  return { delta: moved, sources: distinctSources(sources) };
}

/**
 * Custom. Where a line across `axis` at `value`, spanning `along` on the other axis, lands: on the
 * nearest guide within `radius` (`guidesAcross`), a room's before the outline's; a wall or corner
 * counts only where it comes within `radius` of `along`. Else on a grid line; with `free` on the
 * lattice. Walls at other angles never count, their corners do. Known limit: a corner further along
 * the line does not align it; that waits for a drawn guide line.
 */
export function snapLine(
  value: number,
  axis: 0 | 1,
  candidates: SnapCandidates,
  options: SnapOptions,
  along: readonly [number, number],
): { value: number; sources: SnapSource[] } {
  if (options.free) return { value: whole(value), sources: [] };
  const hit = nearestGuide(guidesAcross(axis, candidates), [{ value, along }], options.radius);
  return hit ? { value: hit.guide.value, sources: [hit.guide.source] } : { value: toGrid(value, options.gridUnits), sources: [] };
}
