// Stretches a rectangular room, or reshapes the outline, by one of its edges or corners, snapped like a drawn box, so resizing needs no typing.

import type { Polygon, Position } from "geojson";
import { boxFromCorners, isAxisRectangle } from "./plan";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { type SnapCandidates, type SnapOptions, type SnapSource, snapLine, snapPoint, withAxisLinesThrough } from "./snap";
import { distinctSources } from "./snap-highlight";
import { walkToWall } from "./wall-stop";

/** A point on the map's canvas, in pixels from its top left. */
export interface Pixel {
  x: number;
  y: number;
}

/** An edge of a shape's outer ring by its start corner, or one of its corners. */
export interface ResizeTarget {
  kind: "edge" | "corner";
  index: number;
}

/** A resized shape, what lights up, and whether it differs from the shape it started as. */
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
 * when it moves to `target`: on the last lattice line before the rectangle reaches past the outline
 * or into a neighbour (`walkToWall`), so a room inside the outline stays inside, one outside stays
 * outside, and the rooms beside it keep their space.
 */
function stopAtWalls(
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
  const stop = walkToWall(rectangleAt, path, candidates);
  return stop ? { value: corner[axis] + stop.offset[axis] + 0, source: stop.source } : { value: target };
}

/**
 * Custom. Drags an edge (from corner `index` to the next) of an axis rectangle across its line, or a
 * corner while the opposite corner stays. The edge lands where `snapLine` puts it and the corner where
 * `snapPoint` does; then each moved side stops at the outline and the neighbours (`stopAtWalls`) and
 * one grid step from its opposite side, and a stopped side shows what stopped it, a side that follows
 * the snap the wall it rests on. A corner's two sides stop one after the other, across first, so a
 * corner past a wall in one direction still follows the pointer in the other, and a corner in an
 * inner corner lights both walls. Known limits: axis rectangles only; a rectangle with a side under
 * one grid step stays as it is; a corner side stops at walls along the room's old extent, also when
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
  let sources: SnapSource[];
  // Each moved side: the snapped `value` on `axis`, for the rectangle as far as it is resized yet,
  // and what lights it: what stopped it, nothing when kept apart, else `snappedTo`.
  const moveSide = (axis: 0 | 1, value: number, snappedTo: SnapSource[]) => {
    const stopped = stopAtWalls(candidates, axis, opposite, corner, value);
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
    // The walls and axis lines the snapped point rests on across `axis`.
    const wallsAcross = (axis: 0 | 1) => snapped.sources.filter((source) => source.kind !== "corner" && source.edge[0][axis] === source.edge[1][axis]);
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

/**
 * Whether the edges and corners of a shape can be dragged: an axis rectangle, or the outline in any
 * shape of one ring; rooms of other shapes keep their shape.
 */
export function isResizable(frame: PlanFrame, shape: Polygon, isOutline: boolean): boolean {
  return isAxisRectangle(frame, shape) || (isOutline && shape.coordinates.length === 1);
}

/**
 * Custom. Drags corner `index` of a shape's outer ring to where `snapPoint` puts the pointer, so its two
 * edges follow, or edge `index` (from that corner to the next) across itself: an edge along a site axis
 * lands where `snapLine` puts it, any other moves along its normal by the pointer's distance from its
 * line, rounded to the lattice, both corners by the same offset so it stays parallel. Besides the usual
 * candidates, both snap to the site axis lines through the ring's corners that stay
 * (`withAxisLinesThrough`), so a slanted wall's corner lands on the line of the others. Nothing stops it, so
 * the ring may come out crossing itself or with a short edge: the save refuses those (`reshapeChange`).
 * Known limits: the outer ring only; a diagonal edge snaps to nothing.
 */
export function resizePolygon(
  frame: PlanFrame,
  shape: Polygon,
  { kind, index }: ResizeTarget,
  pointer: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): Resized {
  const corners = shape.coordinates[0].slice(0, -1).map((corner) => frame.toLattice(corner));
  const count = corners.length;
  const at = (offset: number) => (index + offset + count) % count;
  // The candidates with the lines through the corners that stay, from `first` on up to the moved ones.
  const keptFrom = (first: number) =>
    withAxisLinesThrough(
      candidates,
      Array.from({ length: (index - first + count) % count }, (_, step) => corners[(first + step) % count]),
    );
  const moved = [...corners];
  let sources: SnapSource[] = [];
  let offset: LatticePoint = [0, 0];
  if (kind === "corner") {
    const snapped = snapPoint(pointer, keptFrom(at(1)), options);
    offset = [snapped.point[0] - corners[index][0], snapped.point[1] - corners[index][1]];
    moved[index] = snapped.point;
    sources = snapped.sources;
  } else {
    const [start, end] = [corners[index], corners[at(1)]];
    if (start[0] === end[0] || start[1] === end[1]) {
      const axis = start[0] === end[0] ? 0 : 1;
      const snapped = snapLine(pointer[axis], axis, keptFrom(at(2)), options, span(start[1 - axis], end[1 - axis]));
      offset = axis === 0 ? [snapped.value - start[0], 0] : [0, snapped.value - start[1]];
      sources = snapped.sources;
    } else {
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      const normal = [(start[1] - end[1]) / length, (end[0] - start[0]) / length];
      const distance = (pointer[0] - start[0]) * normal[0] + (pointer[1] - start[1]) * normal[1];
      offset = [Math.round(distance * normal[0]) + 0, Math.round(distance * normal[1]) + 0];
    }
    moved[index] = [start[0] + offset[0], start[1] + offset[1]];
    moved[at(1)] = [end[0] + offset[0], end[1] + offset[1]];
  }
  const ring = [...moved, moved[0]].map((corner) => frame.fromLattice(corner));
  return { shape: { type: "Polygon", coordinates: [ring] }, sources, changed: offset[0] !== 0 || offset[1] !== 0 };
}

/** Resizes a shape `isResizable` allows: a rectangle as `resizeRectangle` does, any other shape as `resizePolygon`. */
export function resizeShape(
  frame: PlanFrame,
  shape: Polygon,
  target: ResizeTarget,
  pointer: readonly [number, number],
  candidates: SnapCandidates,
  options: SnapOptions,
): Resized {
  const resize = isAxisRectangle(frame, shape) ? resizeRectangle : resizePolygon;
  return resize(frame, shape, target, pointer, candidates, options);
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

/** The corner of the shape's outer ring nearest `pixel` on screen within `radiusPx`, else the nearest edge. */
export function resizeTargetAt(pixel: Pixel, shape: Polygon, project: Project, radiusPx: number): ResizeTarget | undefined {
  const corners = shape.coordinates[0].slice(0, -1).map(project);
  const corner = nearest(
    corners.map(({ x, y }) => Math.hypot(pixel.x - x, pixel.y - y)),
    radiusPx,
  );
  if (corner !== undefined) return { kind: "corner", index: corner };
  const edge = nearest(
    corners.map((from, index) => toSegment(pixel, from, corners[(index + 1) % corners.length])),
    radiusPx,
  );
  return edge === undefined ? undefined : { kind: "edge", index: edge };
}

// Across an edge that runs along the screen, at 45 degrees down to the right, down the screen, and at 135 degrees.
const ACROSS_EDGE_CURSORS = ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"];

/**
 * The cursor for a target, from the shape's corners on screen: across an edge the resize arrow nearest
 * its normal, a diagonal one for a slanted edge; corner to corner for a rectangle's corner, and the move
 * cross for a corner that `cornerMovesFreely`, as on an outline of any shape.
 */
export function resizeCursor({ kind, index }: ResizeTarget, corners: Pixel[], cornerMovesFreely = false): string {
  const from = corners[index];
  if (kind === "edge") {
    const to = corners[(index + 1) % corners.length];
    const degrees = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    return ACROSS_EDGE_CURSORS[Math.round((degrees + 180) / 45) % 4];
  }
  if (cornerMovesFreely) return "move";
  const opposite = corners[(index + 2) % 4];
  return (from.x - opposite.x) * (from.y - opposite.y) > 0 ? "nwse-resize" : "nesw-resize";
}
