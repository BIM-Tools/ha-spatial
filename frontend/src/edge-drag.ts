// Stretches a rectangular room by one of its edges or corners, snapped like a drawn box and stopped at the outline, so resizing needs no typing.

import type { Polygon, Position } from "geojson";
import { boxFromCorners } from "./plan";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { type LatticeEdge, type SnapCandidates, type SnapOptions, type SnapSource, snapLine, snapPoint } from "./snap";

/** A point on the map's canvas, in pixels from its top left. */
export interface Pixel {
  x: number;
  y: number;
}

/** An edge of a rectangle by its start corner, or one of its corners. */
export interface ResizeTarget {
  kind: "edge" | "corner";
  index: number;
}

/** A resized rectangle, what lights up, and whether it differs from the rectangle it started as. */
export interface Resized {
  shape: Polygon;
  source: SnapSource;
  changed: boolean;
}

type Project = (position: Position) => Pixel;

// Adding 0 turns -0 into 0, so equal points compare equal.
const span = (a: number, b: number): [number, number] => [Math.min(a, b) + 0, Math.max(a, b) + 0];

// `value` kept at least `step` from `opposite`, on the side where `start` lies.
const keepApart = (value: number, start: number, opposite: number, step: number) =>
  start > opposite ? Math.max(value, opposite + step) : Math.min(value, opposite - step);

/**
 * Custom. Where a side across `axis`, from `low` to `high` on the other axis, stops when it grows
 * from `start` (away from `opposite`) towards `target`: at the first outline wall or corner strictly
 * within that span, so a room inside the outline stays inside and one outside stays outside. A wall
 * that only touches the span's ends runs along the room and does not stop it; a shrinking side never
 * stops. Known limit: a diagonal outline edge stops the side only at its corners.
 */
function stopAtOutline(
  candidates: SnapCandidates,
  axis: 0 | 1,
  start: number,
  opposite: number,
  target: number,
  [low, high]: [number, number],
): { value: number; source?: SnapSource } {
  const outward = start > opposite ? 1 : -1;
  if ((target - start) * outward <= 0) return { value: target };
  const along = axis === 0 ? 1 : 0;
  const walls: [LatticeEdge, SnapSource][] = [
    ...candidates.outlineEdges.map((edge): [LatticeEdge, SnapSource] => [edge, { kind: "edge", edge }]),
    ...candidates.outlineCorners.map((at): [LatticeEdge, SnapSource] => [[at, at], { kind: "corner", at }]),
  ];
  let stop: { value: number; source: SnapSource } | undefined;
  for (const [[from, to], source] of walls) {
    const [wallLow, wallHigh] = span(from[along], to[along]);
    if (wallHigh <= low || wallLow >= high) continue;
    const [near, far] = span(from[axis] * outward, to[axis] * outward);
    if (far < start * outward) continue;
    const value = Math.max(near, start * outward) * outward + 0;
    if (!stop || (value - stop.value) * outward < 0) stop = { value, source };
  }
  return stop && (target - stop.value) * outward > 0 ? stop : { value: target };
}

/**
 * Custom. Drags an edge (from corner `index` to the next) of an axis rectangle across its line, or a
 * corner while the opposite corner stays. The edge lands where `snapLine` puts it and the corner where
 * `snapPoint` does; then each moved side stops at the outline (`stopAtOutline`) and one grid step
 * from its opposite side, and a stopped side shows what stopped it. A corner's two sides stop one
 * after the other, across first, so a corner past the outline in one direction still follows the
 * pointer in the other. Known limits: axis rectangles only; a rectangle with a side under one grid
 * step stays as it is; a corner side stops at outline walls along the room's old extent, also when
 * the other side shrinks.
 */
export function resizeRectangle(
  frame: PlanFrame,
  rectangle: Polygon,
  { kind, index }: ResizeTarget,
  pointer: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): Resized {
  const corners = rectangle.coordinates[0].slice(0, 4).map((corner) => frame.toLattice(corner));
  const start = corners[index];
  const opposite = corners[(index + 2) % 4];
  const step = frame.unitsPerStep;
  const corner: [number, number] = [start[0], start[1]];
  let source: SnapSource;
  // Each moved side: snapped `value` on `axis`, spanning `extent` on the other axis.
  const moveSide = (axis: 0 | 1, value: number, extent: [number, number]) => {
    const stopped = stopAtOutline(candidates, axis, start[axis], opposite[axis], value, extent);
    corner[axis] = keepApart(stopped.value, start[axis], opposite[axis], step);
    return corner[axis] !== stopped.value ? { kind: "grid" as const } : stopped.source;
  };
  if (kind === "edge") {
    const next = corners[(index + 1) % 4];
    const axis = start[0] === next[0] ? 0 : 1;
    const snapped = snapLine(pointer[axis], axis, candidates, options);
    const other = axis === 0 ? 1 : 0;
    source = moveSide(axis, snapped.value, span(start[other], opposite[other])) ?? snapped.source;
  } else {
    const snapped = snapPoint(pointer, candidates, options);
    const across = moveSide(0, snapped.point[0], span(start[1], opposite[1]));
    const down = moveSide(1, snapped.point[1], span(corner[0], opposite[0]));
    const kept = corner[0] === snapped.point[0] && corner[1] === snapped.point[1];
    source = kept ? snapped.source : (down ?? across ?? { kind: "grid" });
  }
  const shape = boxFromCorners(frame, opposite, corner);
  return {
    shape: shape ?? rectangle,
    source,
    changed: Boolean(shape) && (corner[0] !== start[0] || corner[1] !== start[1]),
  };
}

// The distance from `pixel` to the segment between `from` and `to`.
const toSegment = (pixel: Pixel, from: Pixel, to: Pixel) => {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const squared = dx * dx + dy * dy;
  const along = squared ? Math.min(Math.max(((pixel.x - from.x) * dx + (pixel.y - from.y) * dy) / squared, 0), 1) : 0;
  return Math.hypot(pixel.x - (from.x + along * dx), pixel.y - (from.y + along * dy));
};

// The index of the nearest entry within `radiusPx`, else undefined.
const nearest = (distances: number[], radiusPx: number) => {
  let best: number | undefined;
  distances.forEach((distance, index) => {
    if (distance <= radiusPx && (best === undefined || distance < distances[best])) best = index;
  });
  return best;
};

/** The corner of the rectangle's outer ring nearest `pixel` on screen within `radiusPx`, else the nearest edge. */
export function resizeTargetAt(pixel: Pixel, rectangle: Polygon, project: Project, radiusPx: number): ResizeTarget | undefined {
  const corners = rectangle.coordinates[0].slice(0, 4).map(project);
  const corner = nearest(
    corners.map(({ x, y }) => Math.hypot(pixel.x - x, pixel.y - y)),
    radiusPx,
  );
  if (corner !== undefined) return { kind: "corner", index: corner };
  const edge = nearest(
    corners.map((from, index) => toSegment(pixel, from, corners[(index + 1) % 4])),
    radiusPx,
  );
  return edge === undefined ? undefined : { kind: "edge", index: edge };
}

/** The resize cursor for a target, from the rectangle's corners on screen: across an edge, or corner to corner. */
export function resizeCursor({ kind, index }: ResizeTarget, corners: Pixel[]): string {
  const from = corners[index];
  if (kind === "edge") {
    const to = corners[(index + 1) % 4];
    return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? "ns-resize" : "ew-resize";
  }
  const opposite = corners[(index + 2) % 4];
  return (from.x - opposite.x) * (from.y - opposite.y) > 0 ? "nwse-resize" : "nesw-resize";
}
