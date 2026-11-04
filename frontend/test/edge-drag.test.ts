// Checks where a dragged edge or corner of an axis rectangle lands, and which edge or corner a pointer grabs.

import type { Polygon, Position } from "geojson";
import { expect, test } from "vitest";
import { CornerDrag, EdgeDrag, cornerAt, edgeAt } from "../src/edge-drag";
import { PlanFrame, type LatticePoint } from "../src/site-frame";
import type { SnapCandidates } from "../src/snap";
import { siteFrameData } from "./site-frame-fixture";

const FRAME = PlanFrame.fromSite(siteFrameData([5, 52], 20));
const OPTIONS = { radius: 3, gridUnits: 4, free: false };
const FREE = { ...OPTIONS, free: true };
const NONE: SnapCandidates = { roomCorners: [], roomEdges: [], outlineCorners: [], outlineEdges: [] };

const shapeOf = (...corners: LatticePoint[]): Polygon => ({
  type: "Polygon",
  coordinates: [[...corners, corners[0]].map((corner) => FRAME.fromLattice(corner))],
});
const cornersOf = (shape: Polygon) => shape.coordinates[0].slice(0, -1).map((corner) => FRAME.toLattice(corner));
const box = (left: number, bottom: number, right: number, top: number) => [
  [left, bottom],
  [right, bottom],
  [right, top],
  [left, top],
];

// Edge 1 runs from [40, 0] to [40, 40], corner 2 is [40, 40].
const SQUARE = shapeOf([0, 0], [40, 0], [40, 40], [0, 40]);
// Screen pixels are lattice units with y down.
const project = (position: Position) => {
  const [x, y] = FRAME.toLatticeUnits(position);
  return { x, y: -y };
};

test("the edge moves onto grid lines", () => {
  const { shape, source } = new EdgeDrag(FRAME, SQUARE, 1).drag([53.7, 20], NONE, OPTIONS);
  expect(cornersOf(shape)).toEqual(box(0, 0, 52, 40));
  expect(source).toEqual({ kind: "grid" });
});

test("the edge rests on a parallel wall within the radius", () => {
  const wall = [
    [55, -10],
    [55, 50],
  ] as const;
  const { shape, source } = new EdgeDrag(FRAME, SQUARE, 1).drag([53.7, 20], { ...NONE, roomEdges: [wall] }, OPTIONS);
  expect(cornersOf(shape)).toEqual(box(0, 0, 55, 40));
  expect(source).toEqual({ kind: "edge", edge: wall });
});

test("the edge stops one grid step from its opposite", () => {
  const { shape } = new EdgeDrag(FRAME, SQUARE, 1).drag([-10, 20], NONE, OPTIONS);
  expect(cornersOf(shape)).toEqual(box(0, 0, 4, 40));
});

test("free moves on the lattice", () => {
  const { shape, source } = new EdgeDrag(FRAME, SQUARE, 1).drag([53.7, 20], NONE, FREE);
  expect(cornersOf(shape)).toEqual(box(0, 0, 54, 40));
  expect(source).toEqual({ kind: "lattice" });
});

test("changed is false when released where it started", () => {
  const drag = new EdgeDrag(FRAME, SQUARE, 1);
  drag.drag([53.7, 20], NONE, OPTIONS);
  expect(drag.changed).toBe(true);
  drag.drag([40.4, 20], NONE, OPTIONS);
  expect(drag.changed).toBe(false);
});

test("edgeAt picks the nearest edge within the radius and nothing beyond", () => {
  expect(edgeAt({ x: 42, y: -20 }, SQUARE, project, 3)).toBe(1);
  expect(edgeAt({ x: 20, y: -1 }, SQUARE, project, 3)).toBe(0);
  expect(edgeAt({ x: 38, y: -1.5 }, SQUARE, project, 3)).toBe(0);
  expect(edgeAt({ x: 50, y: -20 }, SQUARE, project, 3)).toBeUndefined();
  expect(edgeAt({ x: 20, y: -20 }, SQUARE, project, 3)).toBeUndefined();
});

test("CornerDrag keeps the opposite corner", () => {
  const { shape, source } = new CornerDrag(FRAME, SQUARE, 2).drag([57.3, 22.6], NONE, OPTIONS);
  expect(cornersOf(shape)).toEqual(box(0, 0, 56, 24));
  expect(source).toEqual({ kind: "grid" });
});

test("the corner snaps to a neighbour corner", () => {
  const { shape, source } = new CornerDrag(FRAME, SQUARE, 2).drag([57.3, 22.6], { ...NONE, roomCorners: [[58, 23]] }, OPTIONS);
  expect(cornersOf(shape)).toEqual(box(0, 0, 58, 23));
  expect(source).toEqual({ kind: "corner", at: [58, 23] });
});

test("each side stops at one grid step", () => {
  const { shape } = new CornerDrag(FRAME, SQUARE, 2).drag([-20, -20], NONE, OPTIONS);
  expect(cornersOf(shape)).toEqual(box(0, 0, 4, 4));
});

test("free puts the corner on the lattice", () => {
  const drag = new CornerDrag(FRAME, SQUARE, 2);
  const { shape, source } = drag.drag([57.3, 22.6], NONE, FREE);
  expect(cornersOf(shape)).toEqual(box(0, 0, 57, 23));
  expect(source).toEqual({ kind: "lattice" });
  expect(drag.changed).toBe(true);
  drag.drag([40.3, 39.8], NONE, FREE);
  expect(drag.changed).toBe(false);
});

test("cornerAt wins only within the radius", () => {
  expect(cornerAt({ x: 41, y: -41 }, SQUARE, project, 3)).toBe(2);
  expect(cornerAt({ x: -1, y: 1 }, SQUARE, project, 3)).toBe(0);
  expect(cornerAt({ x: 44, y: -44 }, SQUARE, project, 3)).toBeUndefined();
  expect(cornerAt({ x: 20, y: -1 }, SQUARE, project, 3)).toBeUndefined();
});
