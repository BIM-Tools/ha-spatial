// Stretches a rectangular room by one of its edges or corners, snapped like a drawn box and stopped at the outline, so resizing needs no typing.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Polygon, Position } from "geojson";
import { boxFromCorners } from "./plan";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { walkToOutline } from "./outline-stop";
import { type SnapCandidates, type SnapOptions, type SnapSource, snapLine, snapPoint } from "./snap";
import { distinctSources } from "./snap-highlight";

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
  sources: SnapSource[];
  changed: boolean;
}

type Project = (position: Position) => Pixel;

// Adding 0 turns -0 into 0, so equal points compare equal.
const span = (a: number, b: number): [number, number] => [Math.min(a, b) + 0, Math.max(a, b) + 0];

// `value` kept at least `step` from `opposite`, on the side where `start` lies.
const keepApart = (value: number, start: number, opposite: number, step: number) =>
  start > opposite ? Math.max(value, opposite + step) : Math.min(value, opposite - step);

/**
 * Where the side across `axis` through `corner` of the rectangle from `opposite` to `corner` stops
 * when it moves to `target`: on the last lattice line before the outline reaches inside the
 * rectangle (`walkToOutline`), so a room inside the outline stays inside and one outside stays outside.
 */
function stopAtOutline(
  candidates: SnapCandidates,
  axis: 0 | 1,
  opposite: LatticePoint,
  corner: LatticePoint,
  target: number,
): { value: number; source?: SnapSource } {
  const rectangleAt = (offset: LatticePoint) => {
    const [left, right] = span(opposite[0], corner[0] + offset[0]);
    const [bottom, top] = span(opposite[1], corner[1] + offset[1]);
    return [[[left, bottom], [right, bottom], [right, top], [left, top]] as LatticePoint[]];
  };
  const path: LatticePoint = axis === 0 ? [target - corner[0], 0] : [0, target - corner[1]];
  const stop = walkToOutline(rectangleAt, path, candidates);
  return stop ? { value: corner[axis] + stop.offset[axis] + 0, source: stop.source } : { value: target };
}

/**
 * Custom. Drags an edge (from corner `index` to the next) of an axis rectangle across its line, or a
 * corner while the opposite corner stays. The edge lands where `snapLine` puts it and the corner where
 * `snapPoint` does; then each moved side stops at the outline (`stopAtOutline`) and one grid step
 * from its opposite side, and a stopped side shows what stopped it, a side that follows the snap the
 * wall it rests on. A corner's two sides stop one after the other, across first, so a corner past
 * the outline in one direction still follows the pointer in the other, and a corner in an inner
 * corner lights both walls. Known limits: axis rectangles only; a rectangle with a side under one
 * grid step stays as it is; a corner side stops at outline walls along the room's old extent, also
 * when the other side shrinks.
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
  let sources: SnapSource[];
  // Each moved side: the snapped `value` on `axis`, for the rectangle as far as it is resized yet,
  // and what lights it: what stopped it, nothing when kept apart, else `snappedTo`.
  const moveSide = (axis: 0 | 1, value: number, snappedTo: SnapSource[]) => {
    const stopped = stopAtOutline(candidates, axis, opposite, corner, value);
    corner[axis] = keepApart(stopped.value, start[axis], opposite[axis], step);
    if (corner[axis] !== stopped.value) return [];
    return stopped.source ? [stopped.source] : snappedTo;
  };
  if (kind === "edge") {
    const next = corners[(index + 1) % 4];
    const axis = start[0] === next[0] ? 0 : 1;
    const snapped = snapLine(pointer[axis], axis, candidates, options, span(start[1 - axis], next[1 - axis]));
    sources = moveSide(axis, snapped.value, snapped.sources);
  } else {
    const snapped = snapPoint(pointer, candidates, options);
    // The walls the snapped point rests on across `axis`.
    const wallsAcross = (axis: 0 | 1) => snapped.sources.filter((source) => source.kind === "edge" && source.edge[0][axis] === source.edge[1][axis]);
    const across = moveSide(0, snapped.point[0], wallsAcross(0));
    const down = moveSide(1, snapped.point[1], wallsAcross(1));
    const kept = corner[0] === snapped.point[0] && corner[1] === snapped.point[1];
    sources = kept ? snapped.sources : distinctSources([...across, ...down]);
  }
  const shape = boxFromCorners(frame, opposite, corner);
  return {
    shape: shape ?? rectangle,
    sources,
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

/**
 * Custom. Where a side's length chip goes on a touch screen, as an offset in pixels from the middle of
 * its edge, where the grab handle sits: across the edge, `clearancePx` past it plus the chip's own half
 * size, outward from `centre`; inward instead when the outward chip would cover a neighbouring room and
 * the inward one would not. Rooms are polygons in screen pixels. Known limit: a chip counts as covering
 * a room when one of its corners or its centre lies inside it, or a corner of the room inside the chip,
 * so a room thinner than the chip that crosses it without a corner in it is missed.
 */
export function sideChipOffset(
  [from, to]: readonly [Pixel, Pixel],
  centre: Pixel,
  chip: { width: number; height: number },
  clearancePx: number,
  neighbours: readonly Polygon[],
): [number, number] {
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const length = Math.hypot(middle.x - centre.x, middle.y - centre.y) || 1;
  const [normalX, normalY] = [(middle.x - centre.x) / length, (middle.y - centre.y) / length];
  const distance = clearancePx + (Math.abs(normalX) * chip.width + Math.abs(normalY) * chip.height) / 2;
  // Adding 0 turns -0 into 0.
  const outward: [number, number] = [normalX * distance + 0, normalY * distance + 0];
  const inward: [number, number] = [-outward[0] + 0, -outward[1] + 0];
  const covers = ([dx, dy]: [number, number]) => {
    const [x, y] = [middle.x + dx, middle.y + dy];
    const [left, right, top, bottom] = [x - chip.width / 2, x + chip.width / 2, y - chip.height / 2, y + chip.height / 2];
    const chipPoints = [[x, y], [left, top], [right, top], [right, bottom], [left, bottom]];
    return neighbours.some(
      (room) =>
        chipPoints.some((point) => booleanPointInPolygon(point, room, { ignoreBoundary: true })) ||
        room.coordinates[0].some(([px, py]) => px > left && px < right && py > top && py < bottom),
    );
  };
  return covers(outward) && !covers(inward) ? inward : outward;
}
