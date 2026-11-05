// Checks where a dragged edge or corner of an axis rectangle lands, and which edge or corner a pointer grabs.

import type { Polygon, Position } from "geojson";
import { expect, test } from "vitest";
import { type Pixel, type ResizeTarget, resizeCursor, resizeRectangle, resizeTargetAt } from "../src/edge-drag";
import { PlanFrame, type LatticePoint } from "../src/site-frame";
import type { LatticeEdge, SnapCandidates, SnapSource } from "../src/snap";
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
// Outline walls with their corners, as `candidatesOf` lists them.
const outline = (...edges: LatticeEdge[]): SnapCandidates => ({
  ...NONE,
  outlineEdges: edges,
  outlineCorners: edges.flat(),
});

// Edge 1 runs from [40, 0] to [40, 40], corner 2 is [40, 40].
const SQUARE = shapeOf([0, 0], [40, 0], [40, 40], [0, 40]);
const EDGE_1: ResizeTarget = { kind: "edge", index: 1 };
const CORNER_2: ResizeTarget = { kind: "corner", index: 2 };
const WALL: LatticeEdge = [
  [55, -10],
  [55, 50],
];
const OUTLINE_AT_48: LatticeEdge = [
  [48, -20],
  [48, 60],
];
const TOP_AT_48: LatticeEdge = [
  [-10, 48],
  [60, 48],
];
const FACADE_AT_40: LatticeEdge = [
  [40, -10],
  [40, 50],
];
const TOP_FACADE: LatticeEdge = [
  [-10, 40],
  [60, 40],
];

test.each<[string, ResizeTarget, [number, number], SnapCandidates, typeof OPTIONS, number[][], SnapSource]>([
  ["an edge moves onto grid lines", EDGE_1, [53.7, 20], NONE, OPTIONS, box(0, 0, 52, 40), { kind: "grid" }],
  ["an edge rests on a parallel wall within the radius", EDGE_1, [53.7, 20], { ...NONE, roomEdges: [WALL] }, OPTIONS, box(0, 0, 55, 40), { kind: "edge", edge: WALL }],
  ["an edge stops one grid step from its opposite", EDGE_1, [-10, 20], NONE, OPTIONS, box(0, 0, 4, 40), { kind: "grid" }],
  ["an edge with Alt moves on the lattice", EDGE_1, [53.7, 20], NONE, FREE, box(0, 0, 54, 40), { kind: "lattice" }],
  ["an edge stops at an outline wall ahead", EDGE_1, [53.7, 20], outline(OUTLINE_AT_48), OPTIONS, box(0, 0, 48, 40), { kind: "edge", edge: OUTLINE_AT_48 }],
  ["an edge with Alt stops at the outline too", EDGE_1, [53.7, 20], outline(OUTLINE_AT_48), FREE, box(0, 0, 48, 40), { kind: "edge", edge: OUTLINE_AT_48 }],
  ["an edge stops at an outline corner within its span", EDGE_1, [53.7, 20], { ...NONE, outlineCorners: [[46, 20]] }, OPTIONS, box(0, 0, 46, 40), { kind: "corner", at: [46, 20] }],
  ["an edge on the outline cannot pass it", EDGE_1, [53.7, 20], outline(FACADE_AT_40), OPTIONS, box(0, 0, 40, 40), { kind: "edge", edge: FACADE_AT_40 }],
  ["an edge on the outline still moves in", EDGE_1, [29.7, 20], outline(FACADE_AT_40), OPTIONS, box(0, 0, 28, 40), { kind: "grid" }],
  ["an outline wall along the room's side does not stop its edge", EDGE_1, [53.7, 20], outline(TOP_FACADE), OPTIONS, box(0, 0, 52, 40), { kind: "grid" }],
  ["a corner keeps its opposite corner", CORNER_2, [57.3, 22.6], NONE, OPTIONS, box(0, 0, 56, 24), { kind: "grid" }],
  ["a corner snaps to a neighbour corner", CORNER_2, [57.3, 22.6], { ...NONE, roomCorners: [[58, 23]] }, OPTIONS, box(0, 0, 58, 23), { kind: "corner", at: [58, 23] }],
  ["each side of a corner stops at one grid step", CORNER_2, [-20, -20], NONE, OPTIONS, box(0, 0, 4, 4), { kind: "grid" }],
  ["a corner with Alt lands on the lattice", CORNER_2, [57.3, 22.6], NONE, FREE, box(0, 0, 57, 23), { kind: "lattice" }],
  ["a corner past the outline on one side still follows the pointer on the other", CORNER_2, [57.3, 60], outline(TOP_AT_48), OPTIONS, box(0, 0, 56, 48), { kind: "edge", edge: TOP_AT_48 }],
  ["a corner past two outline walls stops at both", CORNER_2, [57.3, 60], outline(OUTLINE_AT_48, TOP_AT_48), OPTIONS, box(0, 0, 48, 48), { kind: "edge", edge: TOP_AT_48 }],
])("%s", (_, target, pointer, candidates, options, expected, source) => {
  const resized = resizeRectangle(FRAME, SQUARE, target, pointer, candidates, options);
  expect(cornersOf(resized.shape)).toEqual(expected);
  expect(resized.source).toEqual(source);
});

test.each<[ResizeTarget, [number, number], typeof OPTIONS, boolean]>([
  [EDGE_1, [53.7, 20], OPTIONS, true],
  [EDGE_1, [40.4, 20], OPTIONS, false],
  [CORNER_2, [57.3, 22.6], FREE, true],
  [CORNER_2, [40.3, 39.8], FREE, false],
])("%o dragged to %o counts as changed: %s", (target, pointer, options, changed) => {
  expect(resizeRectangle(FRAME, SQUARE, target, pointer, NONE, options).changed).toBe(changed);
});

// Screen pixels are lattice units with y down.
const project = (position: Position) => {
  const [x, y] = FRAME.toLatticeUnits(position);
  return { x, y: -y };
};

test.each<[Pixel, ResizeTarget | undefined]>([
  [{ x: 42, y: -20 }, { kind: "edge", index: 1 }],
  [{ x: 20, y: -1 }, { kind: "edge", index: 0 }],
  [{ x: 38, y: -1.5 }, { kind: "corner", index: 1 }],
  [{ x: 41, y: -41 }, { kind: "corner", index: 2 }],
  [{ x: -1, y: 1 }, { kind: "corner", index: 0 }],
  [{ x: 44, y: -44 }, undefined],
  [{ x: 50, y: -20 }, undefined],
  [{ x: 20, y: -20 }, undefined],
])("a pointer at %o within 3 px grabs %o, a corner before its edges", (pixel, target) => {
  expect(resizeTargetAt(pixel, SQUARE, project, 3)).toEqual(target);
});

// SQUARE on screen: corner 0 bottom left, corner 2 top right.
const ON_SCREEN = cornersOf(SQUARE).map(([x, y]) => ({ x, y: -y }));

test.each<[ResizeTarget, string]>([
  [{ kind: "edge", index: 0 }, "ns-resize"],
  [{ kind: "edge", index: 1 }, "ew-resize"],
  [{ kind: "corner", index: 0 }, "nesw-resize"],
  [{ kind: "corner", index: 1 }, "nwse-resize"],
])("%o shows the %s cursor", (target, cursor) => {
  expect(resizeCursor(target, ON_SCREEN)).toBe(cursor);
});
