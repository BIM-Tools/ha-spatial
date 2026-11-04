// Stretches a rectangular room by one of its edges or corners, snapped like a drawn box, so resizing needs no typing.

import type { Polygon, Position } from "geojson";
import { boxFromCorners } from "./plan";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { type SnapCandidates, type SnapOptions, type SnapSource, snapLine, snapPoint } from "./snap";

interface Pixel {
  x: number;
  y: number;
}

type Project = (position: Position) => Pixel;

const cornersOf = (frame: PlanFrame, rectangle: Polygon): LatticePoint[] =>
  rectangle.coordinates[0].slice(0, 4).map((corner) => frame.toLattice(corner));

// `value` kept at least `step` from `opposite`, on the side where `start` lies.
const keepApart = (value: number, start: number, opposite: number, step: number) =>
  start > opposite ? Math.max(value, opposite + step) : Math.min(value, opposite - step);

/**
 * Custom. Drags edge `edgeIndex` (from corner `edgeIndex` to the next) of an axis rectangle across
 * its line: the line lands where `snapLine` puts it and stops one grid step from the opposite edge,
 * where it shows no source. Known limits: axis rectangles only; a rectangle with a side under one
 * grid step stays as it is.
 */
export class EdgeDrag {
  private readonly _corners: LatticePoint[];
  private readonly _axis: 0 | 1;
  private _changed = false;

  constructor(
    private readonly _frame: PlanFrame,
    private readonly _rectangle: Polygon,
    private readonly _edgeIndex: number,
  ) {
    this._corners = cornersOf(_frame, _rectangle);
    const [from, to] = [this._corners[_edgeIndex], this._corners[(_edgeIndex + 1) % 4]];
    this._axis = from[0] === to[0] ? 0 : 1;
  }

  /** Whether the last drag left the edge somewhere else than where it started. */
  get changed() {
    return this._changed;
  }

  drag(pointer: readonly [number, number], candidates: SnapCandidates, options: SnapOptions): { shape: Polygon; source: SnapSource } {
    const axis = this._axis;
    const start = this._corners[this._edgeIndex];
    const opposite = this._corners[(this._edgeIndex + 2) % 4];
    const snapped = snapLine(pointer[axis], axis, candidates, options);
    const value = keepApart(snapped.value, start[axis], opposite[axis], this._frame.unitsPerStep);
    const corner: [number, number] = [start[0], start[1]];
    corner[axis] = value;
    const shape = boxFromCorners(this._frame, opposite, corner);
    this._changed = Boolean(shape) && value !== start[axis];
    return { shape: shape ?? this._rectangle, source: value === snapped.value ? snapped.source : { kind: "grid" } };
  }
}

/**
 * Custom. Drags corner `cornerIndex` of an axis rectangle while the opposite corner stays: the
 * corner lands where `snapPoint` puts it, each side at least one grid step, the clamped point
 * showing no source. Known limits: axis rectangles only; a rectangle with a side under one grid
 * step stays as it is.
 */
export class CornerDrag {
  private readonly _corners: LatticePoint[];
  private _changed = false;

  constructor(
    private readonly _frame: PlanFrame,
    private readonly _rectangle: Polygon,
    private readonly _cornerIndex: number,
  ) {
    this._corners = cornersOf(_frame, _rectangle);
  }

  /** Whether the last drag left the corner somewhere else than where it started. */
  get changed() {
    return this._changed;
  }

  drag(pointer: readonly [number, number], candidates: SnapCandidates, options: SnapOptions): { shape: Polygon; source: SnapSource } {
    const start = this._corners[this._cornerIndex];
    const opposite = this._corners[(this._cornerIndex + 2) % 4];
    const snapped = snapPoint(pointer, candidates, options);
    const step = this._frame.unitsPerStep;
    const corner = [0, 1].map((axis) => keepApart(snapped.point[axis], start[axis], opposite[axis], step)) as [number, number];
    const shape = boxFromCorners(this._frame, opposite, corner);
    this._changed = Boolean(shape) && (corner[0] !== start[0] || corner[1] !== start[1]);
    const clamped = corner[0] !== snapped.point[0] || corner[1] !== snapped.point[1];
    return { shape: shape ?? this._rectangle, source: clamped ? { kind: "grid" } : snapped.source };
  }
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

/** The edge of the rectangle's outer ring nearest `pixel` on screen within `radiusPx`, by its start corner. */
export function edgeAt(pixel: Pixel, rectangle: Polygon, project: Project, radiusPx: number): number | undefined {
  const corners = rectangle.coordinates[0].slice(0, 4).map(project);
  return nearest(
    corners.map((corner, index) => toSegment(pixel, corner, corners[(index + 1) % 4])),
    radiusPx,
  );
}

/** The corner of the rectangle's outer ring nearest `pixel` on screen within `radiusPx`. */
export function cornerAt(pixel: Pixel, rectangle: Polygon, project: Project, radiusPx: number): number | undefined {
  const corners = rectangle.coordinates[0].slice(0, 4).map(project);
  return nearest(
    corners.map((corner) => Math.hypot(pixel.x - corner.x, pixel.y - corner.y)),
    radiusPx,
  );
}
