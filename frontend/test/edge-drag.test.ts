// Checks where a dragged edge or corner of an axis rectangle or an outline of any shape lands, and which edge or corner a pointer grabs.

import type { Polygon, Position } from "geojson";
import { expect, test } from "vitest";
import { type Pixel, type ResizeTarget, isResizable, resizeCursor, resizePolygon, resizeRectangle, resizeTargetAt } from "../src/edge-drag";
import { PlanFrame, type LatticePoint } from "../src/site-frame";
import type { LatticeEdge, SnapCandidates, SnapSource } from "../src/snap";
import { siteFrameData } from "./site-frame-fixture";

const FRAME = PlanFrame.fromSite(siteFrameData([5, 52], 20));
const OPTIONS = { radius: 3, gridUnits: 4, free: false };
const FREE = { ...OPTIONS, free: true };
const NONE: SnapCandidates = { roomCorners: [], roomEdges: [], outlineCorners: [], outlineEdges: [], lineCorners: [], guideCorners: [], guideEdges: [], roomRings: [] };

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

test.each<[string, ResizeTarget, [number, number], SnapCandidates, typeof OPTIONS, number[][], SnapSource[]]>([
  ["an edge moves onto grid lines", EDGE_1, [53.7, 20], NONE, OPTIONS, box(0, 0, 52, 40), []],
  ["an edge rests on a parallel wall within the radius", EDGE_1, [53.7, 20], { ...NONE, roomEdges: [WALL] }, OPTIONS, box(0, 0, 55, 40), [{ kind: "edge", edge: WALL }]],
  ["an edge stops one grid step from its opposite", EDGE_1, [-10, 20], NONE, OPTIONS, box(0, 0, 4, 40), []],
  ["an edge with Alt moves on the lattice", EDGE_1, [53.7, 20], NONE, FREE, box(0, 0, 54, 40), []],
  ["an edge stops at an outline wall ahead", EDGE_1, [53.7, 20], outline(OUTLINE_AT_48), OPTIONS, box(0, 0, 48, 40), [{ kind: "edge", edge: OUTLINE_AT_48 }]],
  ["a corner keeps its opposite corner", CORNER_2, [57.3, 22.6], NONE, OPTIONS, box(0, 0, 56, 24), []],
  ["a corner snaps to a neighbour corner", CORNER_2, [57.3, 22.6], { ...NONE, roomCorners: [[58, 23]] }, OPTIONS, box(0, 0, 58, 23), [{ kind: "corner", at: [58, 23] }]],
  ["each side of a corner stops at one grid step", CORNER_2, [-20, -20], NONE, OPTIONS, box(0, 0, 4, 4), []],
  ["a corner with Alt lands on the lattice", CORNER_2, [57.3, 22.6], NONE, FREE, box(0, 0, 57, 23), []],
  ["a corner past the outline on one side still follows the pointer on the other", CORNER_2, [57.3, 60], outline(TOP_AT_48), OPTIONS, box(0, 0, 56, 48), [{ kind: "edge", edge: TOP_AT_48 }]],
  ["a corner past two outline walls stops at both", CORNER_2, [57.3, 60], outline(OUTLINE_AT_48, TOP_AT_48), OPTIONS, box(0, 0, 48, 48), [{ kind: "edge", edge: OUTLINE_AT_48 }, { kind: "edge", edge: TOP_AT_48 }]],
])("%s", (_, target, pointer, candidates, options, expected, sources) => {
  const resized = resizeRectangle(FRAME, SQUARE, target, pointer, candidates, options);
  expect(cornersOf(resized.shape)).toEqual(expected);
  expect(resized.sources).toEqual(sources);
});

test.each<[ResizeTarget, [number, number], typeof OPTIONS, boolean]>([
  [EDGE_1, [53.7, 20], OPTIONS, true],
  [EDGE_1, [40.4, 20], OPTIONS, false],
  [CORNER_2, [57.3, 22.6], FREE, true],
  [CORNER_2, [40.3, 39.8], FREE, false],
])("%o dragged to %o counts as changed: %s", (target, pointer, options, changed) => {
  expect(resizeRectangle(FRAME, SQUARE, target, pointer, NONE, options).changed).toBe(changed);
});

// An outline copied from a map, with one slanted wall: edge 1 from [81, 0] to [83, 41].
const SLANTED = shapeOf([0, 0], [81, 0], [83, 41], [0, 41]);
const EDGE_0: ResizeTarget = { kind: "edge", index: 0 };
// The axis lines through the corners that stay when corner 2 moves, from each corner to where it lands.
const LINE_X_81: LatticeEdge = [
  [81, 0],
  [81, 41],
];
const LINE_Y_41: LatticeEdge = [
  [0, 41],
  [81, 41],
];
const ROOM_WALL: LatticeEdge = [
  [-10, -6],
  [90, -6],
];

test.each<[string, ResizeTarget, [number, number], SnapCandidates, typeof OPTIONS, number[][], SnapSource[], boolean]>([
  ["a corner lands on the lines of the corners that stay, however far along", CORNER_2, [81.8, 40.3], NONE, OPTIONS, [[0, 0], [81, 0], [81, 41], [0, 41]], [{ kind: "aligned", edge: LINE_X_81 }, { kind: "aligned", edge: LINE_Y_41 }], true],
  ["a corner away from every line lands on the grid", CORNER_2, [90.6, 50.9], NONE, OPTIONS, [[0, 0], [81, 0], [92, 52], [0, 41]], [], true],
  ["a corner snaps to a room corner before the outline's own lines", CORNER_2, [81.8, 40.3], { ...NONE, roomCorners: [[82, 40]] }, OPTIONS, [[0, 0], [81, 0], [82, 40], [0, 41]], [{ kind: "corner", at: [82, 40] }], true],
  ["a corner with Alt lands on the lattice", CORNER_2, [81.8, 40.3], NONE, FREE, [[0, 0], [81, 0], [82, 40], [0, 41]], [], true],
  ["a corner dropped on its own place is unchanged", CORNER_2, [83.2, 40.8], NONE, FREE, [[0, 0], [81, 0], [83, 41], [0, 41]], [], false],
  ["an edge along an axis moves across onto the grid, its neighbours follow", EDGE_0, [40, -5.2], NONE, OPTIONS, [[0, -4], [81, -4], [83, 41], [0, 41]], [], true],
  ["an edge along an axis rests on a parallel room wall", EDGE_0, [40, -5.2], { ...NONE, roomEdges: [ROOM_WALL] }, OPTIONS, [[0, -6], [81, -6], [83, 41], [0, 41]], [{ kind: "edge", edge: ROOM_WALL }], true],
  ["a slanted edge moves along its normal, rounded to the lattice, and stays parallel", EDGE_1, [91, 20], NONE, OPTIONS, [[0, 0], [90, 0], [92, 41], [0, 41]], [], true],
])("on an outline of any shape %s", (_, target, pointer, candidates, options, expected, sources, changed) => {
  const resized = resizePolygon(FRAME, SLANTED, target, pointer, candidates, options);
  expect(cornersOf(resized.shape)).toEqual(expected);
  expect(resized.sources).toEqual(sources);
  expect(resized.changed).toBe(changed);
});

test.each<[string, Polygon, boolean, boolean]>([
  ["a rectangle room", SQUARE, false, true],
  ["a room of another shape", SLANTED, false, false],
  ["an outline of any shape", SLANTED, true, true],
  ["an outline with a hole", { type: "Polygon", coordinates: [...SQUARE.coordinates, ...shapeOf([10, 10], [10, 20], [20, 20]).coordinates] }, true, false],
])("isResizable: %s", (_, shape, isOutline, resizable) => {
  expect(isResizable(FRAME, shape, isOutline)).toBe(resizable);
});

// Screen pixels are lattice units with y down.
const project = (position: Position) => {
  const [x, y] = FRAME.toLatticeUnits(position);
  return { x, y: -y };
};

test.each<[string, Polygon, Pixel, ResizeTarget | undefined]>([
  ["the square", SQUARE, { x: 42, y: -20 }, { kind: "edge", index: 1 }],
  ["the square", SQUARE, { x: 20, y: -1 }, { kind: "edge", index: 0 }],
  ["the square", SQUARE, { x: 38, y: -1.5 }, { kind: "corner", index: 1 }],
  ["the square", SQUARE, { x: 41, y: -41 }, { kind: "corner", index: 2 }],
  ["the square", SQUARE, { x: -1, y: 1 }, { kind: "corner", index: 0 }],
  ["the square", SQUARE, { x: 44, y: -44 }, undefined],
  ["the square", SQUARE, { x: 50, y: -20 }, undefined],
  ["the square", SQUARE, { x: 20, y: -20 }, undefined],
  ["the slanted outline", SLANTED, { x: 83, y: -20.5 }, { kind: "edge", index: 1 }],
  ["the slanted outline", SLANTED, { x: 82, y: -42 }, { kind: "corner", index: 2 }],
  ["the slanted outline", SLANTED, { x: 40, y: -42 }, { kind: "edge", index: 2 }],
])("a pointer on %s at %o within 3 px grabs %o, a corner before its edges", (_, shape, pixel, target) => {
  expect(resizeTargetAt(pixel, shape, project, 3)).toEqual(target);
});

// SQUARE on screen: corner 0 bottom left, corner 2 top right.
const ON_SCREEN = cornersOf(SQUARE).map(([x, y]) => ({ x, y: -y }));
// A triangle on screen whose edge 1 runs down to the left and edge 2 up the left side.
const TRIANGLE: Pixel[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 0, y: 40 },
];
// A triangle on screen whose edge 0 runs down to the right.
const FALLING: Pixel[] = [
  { x: 0, y: 0 },
  { x: 40, y: 40 },
  { x: 0, y: 40 },
];

test.each<[ResizeTarget, Pixel[], boolean, string]>([
  [{ kind: "edge", index: 0 }, ON_SCREEN, false, "ns-resize"],
  [{ kind: "edge", index: 1 }, ON_SCREEN, false, "ew-resize"],
  [{ kind: "corner", index: 0 }, ON_SCREEN, false, "nesw-resize"],
  [{ kind: "corner", index: 1 }, ON_SCREEN, false, "nwse-resize"],
  [{ kind: "edge", index: 1 }, TRIANGLE, true, "nwse-resize"],
  [{ kind: "edge", index: 2 }, TRIANGLE, true, "ew-resize"],
  [{ kind: "edge", index: 0 }, FALLING, true, "nesw-resize"],
  [{ kind: "corner", index: 1 }, TRIANGLE, true, "move"],
])("%o on %j, corners moving freely: %s, shows the %s cursor", (target, corners, cornerMovesFreely, cursor) => {
  expect(resizeCursor(target, corners, cornerMovesFreely)).toBe(cursor);
});
