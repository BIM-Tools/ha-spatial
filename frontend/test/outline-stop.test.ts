// Checks where the outline stops a moved room or a stretched side, and what it lights up.

import type { Polygon } from "geojson";
import { expect, test } from "vitest";
import { type Rings, stopMoveAtOutline, walkToOutline } from "../src/outline-stop";
import { PlanFrame, type LatticePoint } from "../src/site-frame";
import { type LatticeEdge, type SnapCandidates, type SnapSource, candidatesOf } from "../src/snap";
import { siteFrameData } from "./site-frame-fixture";

const FRAME = PlanFrame.fromSite(siteFrameData([5, 52], 20));
const NONE: SnapCandidates = { roomCorners: [], roomEdges: [], outlineCorners: [], outlineEdges: [] };

const shapeOf = (ring: LatticePoint[]): Polygon => ({
  type: "Polygon",
  coordinates: [[...ring, ring[0]].map((corner) => FRAME.fromLattice(corner))],
});
const building = (ring: LatticePoint[]) => candidatesOf(FRAME, [], shapeOf(ring));
const boxRing = (left: number, bottom: number, right: number, top: number): LatticePoint[] => [
  [left, bottom],
  [right, bottom],
  [right, top],
  [left, top],
];

// A room stored at an older bearing, so its edges tilt one lattice unit in about 150, inside an
// outline traced the same way.
const TILTED = building([
  [0, 0],
  [0, 103],
  [-125, 103],
  [-125, 113],
  [-115, 113],
  [-116, 404],
  [-324, 404],
  [-323, 410],
  [-448, 411],
  [-448, 404],
  [-672, 404],
  [-672, 229],
  [-672, 130],
  [-672, 113],
  [-672, 67],
  [-354, 67],
  [-354, 0],
]);
const TILTED_ROOM: LatticePoint[] = [
  [-485, 292],
  [-549, 292],
  [-635, 293],
  [-634, 403],
  [-484, 402],
];
const TILTED_TOP: LatticeEdge = [
  [-448, 404],
  [-672, 404],
];

// A building whose top wall rises 2 lattice units over 150, through the lattice point [75, 21].
const SLOPED = building([
  [0, 0],
  [150, 0],
  [150, 22],
  [0, 20],
]);
const SLOPED_TOP: LatticeEdge = [
  [150, 22],
  [0, 20],
];

// A building with a diagonal corner on the right, and a notch whose tip points down into it at [45, 90].
const NOTCHED = building([
  [0, 0],
  [100, 0],
  [100, 60],
  [60, 100],
  [50, 100],
  [45, 90],
  [40, 100],
  [0, 100],
]);
const NOTCHED_LEFT: LatticeEdge = [
  [0, 100],
  [0, 0],
];
const NOTCHED_TOP: LatticeEdge = [
  [40, 100],
  [0, 100],
];
const NOTCHED_RIGHT: LatticeEdge = [
  [100, 0],
  [100, 60],
];
const DIAGONAL: LatticeEdge = [
  [100, 60],
  [60, 100],
];

type Moved = { delta: LatticePoint; sources: SnapSource[] } | undefined;

test.each<[string, SnapCandidates, LatticePoint[], LatticePoint, Moved]>([
  ["a tilted room stops where it first touches the wall above", TILTED, TILTED_ROOM, [0, 4], { delta: [0, 1], sources: [{ kind: "edge", edge: TILTED_TOP }] }],
  ["a tilted room moved far stops there too", TILTED, TILTED_ROOM, [0, 20], { delta: [0, 1], sources: [{ kind: "edge", edge: TILTED_TOP }] }],
  ["a room touches a tilted wall where a lattice point lies on it", SLOPED, boxRing(75, 1, 105, 11), [0, 15], { delta: [0, 10], sources: [{ kind: "edge", edge: SLOPED_TOP }] }],
  ["a room stops on the last lattice line below a tilted wall", SLOPED, boxRing(10, 1, 40, 11), [0, 15], { delta: [0, 9], sources: [{ kind: "edge", edge: SLOPED_TOP }] }],
  ["a corner stops on a diagonal wall", NOTCHED, boxRing(70, 40, 90, 60), [20, 20], { delta: [5, 5], sources: [{ kind: "edge", edge: DIAGONAL }] }],
  ["an edge stops on an outline corner", NOTCHED, boxRing(30, 40, 60, 60), [0, 40], { delta: [0, 30], sources: [{ kind: "corner", at: [45, 90] }] }],
  ["a room touching a notch tip passes under it", NOTCHED, boxRing(10, 70, 30, 90), [40, 0], undefined],
  ["a room outside stays outside", NOTCHED, boxRing(110, 20, 130, 40), [-20, 0], { delta: [-10, 0], sources: [{ kind: "edge", edge: NOTCHED_RIGHT }] }],
  ["a room against a wall slides along it", NOTCHED, boxRing(4, 80, 24, 100), [8, 8], { delta: [8, 0], sources: [{ kind: "edge", edge: NOTCHED_TOP }] }],
  ["a room pushed into an inner corner stops at both walls", NOTCHED, boxRing(10, 70, 30, 90), [-20, 20], { delta: [-10, 10], sources: [{ kind: "edge", edge: NOTCHED_TOP }, { kind: "edge", edge: NOTCHED_LEFT }] }],
  ["a room already across the outline moves freely", NOTCHED, boxRing(90, 20, 110, 40), [5, 0], undefined],
])("stopMoveAtOutline: %s", (_name, candidates, room, delta, moved) => {
  expect(stopMoveAtOutline([room], delta, candidates)).toEqual(moved);
});

// Outline walls with their corners, as `candidatesOf` lists them.
const walls = (...edges: LatticeEdge[]): SnapCandidates => ({ ...NONE, outlineEdges: edges, outlineCorners: edges.flat() });
const RIGHT_AT_48: LatticeEdge = [
  [48, -20],
  [48, 60],
];
const TOP_AT_48: LatticeEdge = [
  [-10, 48],
  [60, 48],
];
const RIGHT_AT_40: LatticeEdge = [
  [40, -10],
  [40, 50],
];
const TOP_AT_40: LatticeEdge = [
  [-10, 40],
  [60, 40],
];
// The square from [0, 0] to [40, 40] stretched by its top right corner.
const stretched = ([x, y]: LatticePoint): Rings => [boxRing(0, 0, 40 + x, 40 + y)];

test.each<[string, SnapCandidates, LatticePoint, ReturnType<typeof walkToOutline>]>([
  ["a side stops at an outline wall ahead", walls(RIGHT_AT_48), [20, 0], { offset: [8, 0], source: { kind: "edge", edge: RIGHT_AT_48 } }],
  ["a side stops at an outline corner within its span", { ...NONE, outlineCorners: [[46, 20]] }, [20, 0], { offset: [6, 0], source: { kind: "corner", at: [46, 20] } }],
  ["a side on the outline cannot pass it", walls(RIGHT_AT_40), [20, 0], { offset: [0, 0], source: { kind: "edge", edge: RIGHT_AT_40 } }],
  ["a side on the outline still moves in", walls(RIGHT_AT_40), [-12, 0], undefined],
  ["an outline wall along the stretched side does not stop it", walls(TOP_AT_40), [20, 0], undefined],
  ["a corner stops where it first touches either wall", walls(RIGHT_AT_48, TOP_AT_48), [20, 10], { offset: [8, 4], source: { kind: "edge", edge: RIGHT_AT_48 } }],
  ["a corner stops in the corner of two walls", walls(RIGHT_AT_48, TOP_AT_48), [20, 20], { offset: [8, 8], source: { kind: "edge", edge: RIGHT_AT_48 } }],
])("walkToOutline stretching a square: %s", (_name, candidates, to, stop) => {
  expect(walkToOutline(stretched, to, candidates)).toEqual(stop);
});
