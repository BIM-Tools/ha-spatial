// Checks where the snap engine puts a point, a move and a line, and which source it names.

import type { Polygon } from "geojson";
import { expect, test } from "vitest";
import { PlanFrame, type LatticePoint } from "../src/site-frame";
import { type SnapCandidates, candidatesOf, snapLine, snapMove, snapPoint } from "../src/snap";
import { siteFrameData } from "./site-frame-fixture";

const FRAME = PlanFrame.fromSite(siteFrameData([5, 52], 20));
const OPTIONS = { radius: 3, gridUnits: 4, free: false };
const NONE: SnapCandidates = { roomCorners: [], roomEdges: [], outlineCorners: [], outlineEdges: [] };

const shapeOf = (...rings: LatticePoint[][]): Polygon => ({
  type: "Polygon",
  coordinates: rings.map((ring) => [...ring, ring[0]].map((corner) => FRAME.fromLattice(corner))),
});

test("a room corner in range wins over an edge and the outline", () => {
  const candidates: SnapCandidates = {
    roomCorners: [[10, 0]],
    roomEdges: [
      [
        [11, -10],
        [11, 10],
      ],
    ],
    outlineCorners: [[11, 1]],
    outlineEdges: [],
  };
  expect(snapPoint([10.6, 0.4], candidates, OPTIONS)).toEqual({ point: [10, 0], source: { kind: "corner", at: [10, 0] } });
});

test("an axis edge snaps onto the edge along the grid", () => {
  const edge = [
    [0, 0],
    [0, 40],
  ] as const;
  const candidates = { ...NONE, roomEdges: [edge] };
  expect(snapPoint([1.2, 17.3], candidates, OPTIONS)).toEqual({ point: [0, 16], source: { kind: "edge", edge } });
});

test("an edge snap stays on its segment", () => {
  const edge = [
    [0, 0],
    [0, 10],
  ] as const;
  expect(snapPoint([1, 11], { ...NONE, roomEdges: [edge] }, OPTIONS).point).toEqual([0, 10]);
});

test("candidatesOf drops diagonal edges and keeps their corners", () => {
  const room = shapeOf([
    [0, 0],
    [30, 10],
    [0, 10],
  ]);
  const candidates = candidatesOf(FRAME, [room], undefined);
  expect(candidates.roomCorners).toEqual([
    [0, 0],
    [30, 10],
    [0, 10],
  ]);
  expect(candidates.roomEdges).toEqual([
    [
      [30, 10],
      [0, 10],
    ],
    [
      [0, 10],
      [0, 0],
    ],
  ]);
  expect(snapPoint([14.6, 5.4], candidates, OPTIONS)).toEqual({ point: [16, 4], source: { kind: "grid" } });
  expect(snapPoint([29.5, 9.6], candidates, OPTIONS)).toEqual({ point: [30, 10], source: { kind: "corner", at: [30, 10] } });
});

test("candidatesOf includes inner rings", () => {
  const room = shapeOf(
    [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
    [
      [40, 40],
      [40, 60],
      [60, 60],
      [60, 40],
    ],
  );
  const candidates = candidatesOf(FRAME, [room], undefined);
  expect(candidates.roomCorners).toContainEqual([60, 60]);
  expect(candidates.roomEdges).toContainEqual([
    [40, 60],
    [60, 60],
  ]);
  expect(snapPoint([49.2, 61], candidates, OPTIONS)).toEqual({
    point: [48, 60],
    source: {
      kind: "edge",
      edge: [
        [40, 60],
        [60, 60],
      ],
    },
  });
});

test("the outline counts after rooms", () => {
  const room = shapeOf([
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
  ]);
  const outline = shapeOf([
    [22, 10],
    [60, 10],
    [60, 40],
    [22, 40],
  ]);
  const candidates = candidatesOf(FRAME, [room], outline);
  expect(candidates.outlineCorners).toContainEqual([22, 10]);
  // The outline's corner is nearer, the room's edge still wins.
  expect(snapPoint([21.5, 10], candidates, OPTIONS).source).toEqual({
    kind: "edge",
    edge: [
      [20, 0],
      [20, 20],
    ],
  });
  expect(snapPoint([23.5, 30], candidates, OPTIONS).source).toEqual({
    kind: "edge",
    edge: [
      [22, 40],
      [22, 10],
    ],
  });
});

test("out of range falls back to the grid", () => {
  const candidates = { ...NONE, roomCorners: [[10, 0] as const] };
  expect(snapPoint([5.9, 1.9], candidates, OPTIONS)).toEqual({ point: [4, 0], source: { kind: "grid" } });
});

test("free lands on the lattice and ignores candidates", () => {
  const candidates = { ...NONE, roomCorners: [[10, 0] as const] };
  expect(snapPoint([10.6, 0.4], candidates, { ...OPTIONS, free: true })).toEqual({ point: [11, 0], source: { kind: "lattice" } });
});

test("ties go to the earlier candidate", () => {
  const candidates = { ...NONE, roomCorners: [[10, 2] as const, [10, -2] as const] };
  expect(snapPoint([10, 0], candidates, OPTIONS).point).toEqual([10, 2]);
});

test("snapMove aligns a moved corner to a neighbour, else moves by whole grid steps", () => {
  const corners: LatticePoint[] = [
    [1, 1],
    [9, 1],
    [9, 9],
    [1, 9],
  ];
  const neighbour = { ...NONE, roomCorners: [[17, 1] as const] };
  expect(snapMove(corners, [6.2, 0.1], neighbour, OPTIONS)).toEqual({ delta: [8, 0], source: { kind: "corner", at: [17, 1] } });
  expect(snapMove(corners, [6.2, 0.1], NONE, OPTIONS)).toEqual({ delta: [8, 0], source: { kind: "grid" } });
  expect(snapMove(corners, [6.2, 0.1], neighbour, { ...OPTIONS, free: true })).toEqual({ delta: [6, 0], source: { kind: "lattice" } });
});

test("snapMove onto a wall keeps whole grid steps along it", () => {
  const corners: LatticePoint[] = [
    [1, 1],
    [9, 1],
    [9, 9],
    [1, 9],
  ];
  const wall = [
    [17, -40],
    [17, 40],
  ] as const;
  expect(snapMove(corners, [6.5, 5.1], { ...NONE, roomEdges: [wall] }, OPTIONS)).toEqual({
    delta: [8, 4],
    source: { kind: "edge", edge: wall },
  });
});

test("snapLine prefers a parallel edge, then corners, then grid lines", () => {
  const wall = [
    [20, 0],
    [20, 40],
  ] as const;
  const across = [
    [0, 21],
    [40, 21],
  ] as const;
  const candidates: SnapCandidates = {
    roomCorners: [[21, 50]],
    roomEdges: [across, wall],
    outlineCorners: [],
    outlineEdges: [],
  };
  expect(snapLine(20.8, 0, candidates, OPTIONS)).toEqual({ value: 20, source: { kind: "edge", edge: wall } });
  expect(snapLine(20.8, 0, { ...candidates, roomEdges: [across] }, OPTIONS)).toEqual({
    value: 21,
    source: { kind: "corner", at: [21, 50] },
  });
  expect(snapLine(9.1, 0, candidates, OPTIONS)).toEqual({ value: 8, source: { kind: "grid" } });
  expect(snapLine(20.8, 0, candidates, { ...OPTIONS, free: true })).toEqual({ value: 21, source: { kind: "lattice" } });
});
