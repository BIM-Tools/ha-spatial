// Checks where the snap engine puts a point, a move and a line, and what it lights up.

import type { Polygon } from "geojson";
import { expect, test } from "vitest";
import { PlanFrame, type LatticePoint } from "../src/site-frame";
import { type LatticeEdge, type SnapCandidates, type SnapSource, candidatesOf, snapCandidatesFor, snapLine, snapMove, snapPoint } from "../src/snap";
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
  expect(snapPoint([10.6, 0.4], candidates, OPTIONS)).toEqual({ point: [10, 0], sources: [{ kind: "corner", at: [10, 0] }] });
});

test("an axis edge snaps onto the edge along the grid", () => {
  const edge = [
    [0, 0],
    [0, 40],
  ] as const;
  const candidates = { ...NONE, roomEdges: [edge] };
  expect(snapPoint([1.2, 17.3], candidates, OPTIONS)).toEqual({ point: [0, 16], sources: [{ kind: "edge", edge }] });
});

test("an edge snap stays on its segment", () => {
  const edge = [
    [0, 0],
    [0, 10],
  ] as const;
  expect(snapPoint([1, 11], { ...NONE, roomEdges: [edge] }, OPTIONS).point).toEqual([0, 10]);
});

test("candidatesOf keeps every outline edge, since every one stops a move", () => {
  const outline = shapeOf([
    [0, 0],
    [30, 10],
    [0, 10],
  ]);
  expect(candidatesOf(FRAME, [], outline).outlineEdges).toHaveLength(3);
  // Only its axis edges snap.
  expect(snapPoint([14.6, 5.4], candidatesOf(FRAME, [], outline), OPTIONS).sources).toEqual([]);
});

test("candidatesOf drops a room's diagonal edges and keeps their corners", () => {
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
  expect(snapPoint([14.6, 5.4], candidates, OPTIONS)).toEqual({ point: [16, 4], sources: [] });
  expect(snapPoint([29.5, 9.6], candidates, OPTIONS)).toEqual({ point: [30, 10], sources: [{ kind: "corner", at: [30, 10] }] });
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
    sources: [
      {
        kind: "edge",
        edge: [
          [40, 60],
          [60, 60],
        ],
      },
    ],
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
  expect(snapPoint([21.5, 10], candidates, OPTIONS).sources).toEqual([
    {
      kind: "edge",
      edge: [
        [20, 0],
        [20, 20],
      ],
    },
  ]);
  expect(snapPoint([23.5, 30], candidates, OPTIONS).sources).toEqual([
    {
      kind: "edge",
      edge: [
        [22, 40],
        [22, 10],
      ],
    },
  ]);
});

test("out of range falls back to the grid", () => {
  const candidates = { ...NONE, roomCorners: [[10, 0] as const] };
  expect(snapPoint([5.9, 1.9], candidates, OPTIONS)).toEqual({ point: [4, 0], sources: [] });
  expect(snapPoint([-6.1, 10.2], candidates, OPTIONS).point).toEqual([-8, 12]);
  expect(snapPoint([-0.4, -1.9], candidates, OPTIONS).point).toEqual([0, 0]);
});

test("free lands on the lattice and ignores candidates", () => {
  const candidates = { ...NONE, roomCorners: [[10, 0] as const] };
  expect(snapPoint([10.6, 0.4], candidates, { ...OPTIONS, free: true })).toEqual({ point: [11, 0], sources: [] });
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
  expect(snapMove([corners], [6.2, 0.1], neighbour, OPTIONS)).toEqual({ delta: [8, 0], sources: [{ kind: "corner", at: [17, 1] }] });
  expect(snapMove([corners], [6.2, 0.1], NONE, OPTIONS)).toEqual({ delta: [8, 0], sources: [] });
  expect(snapMove([corners], [6.2, 0.1], neighbour, { ...OPTIONS, free: true })).toEqual({ delta: [6, 0], sources: [] });
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
  expect(snapMove([corners], [6.5, 5.1], { ...NONE, roomEdges: [wall] }, OPTIONS)).toEqual({
    delta: [8, 4],
    sources: [{ kind: "edge", edge: wall }],
  });
});

test("snapMove ignores a wall the moved corner would pass the end of", () => {
  const corners: LatticePoint[] = [
    [1, 1],
    [9, 1],
    [9, 9],
    [1, 9],
  ];
  const wall = [
    [18, -40],
    [18, 4],
  ] as const;
  expect(snapMove([corners], [7.5, 5.1], { ...NONE, roomEdges: [wall] }, OPTIONS)).toEqual({ delta: [8, 4], sources: [] });
});

const boxRing = (left: number, bottom: number, right: number, top: number): LatticePoint[] => [
  [left, bottom],
  [right, bottom],
  [right, top],
  [left, top],
];

// A square building: where the outline stops a room is in outline-stop.test.ts, here only that snapMove applies it.
const SQUARE_BUILDING = candidatesOf(FRAME, [], shapeOf(boxRing(0, 0, 100, 100)));
const BUILDING_TOP: LatticeEdge = [
  [100, 100],
  [0, 100],
];
const BUILDING_LEFT: LatticeEdge = [
  [0, 100],
  [0, 0],
];

test.each<[string, [number, number], typeof OPTIONS, LatticePoint, SnapSource[]]>([
  ["stops a room at the outline", [0, 20.3], OPTIONS, [0, 10], [{ kind: "edge", edge: BUILDING_TOP }]],
  ["stops a room at the outline with Alt too", [0, 20.3], { ...OPTIONS, free: true }, [0, 10], [{ kind: "edge", edge: BUILDING_TOP }]],
  ["snaps a room moved near an inner corner into it", [-8.6, 8.7], OPTIONS, [-10, 10], [{ kind: "edge", edge: BUILDING_LEFT }, { kind: "edge", edge: BUILDING_TOP }]],
])("snapMove at the outline %s", (_name, delta, options, expected, sources) => {
  expect(snapMove([boxRing(10, 70, 30, 90)], delta, SQUARE_BUILDING, options)).toEqual({ delta: expected, sources });
});

// Two walls that meet at [0, 40], given without their corner, so only the walls themselves snap.
const LEFT_WALL: LatticeEdge = [
  [0, 0],
  [0, 40],
];
const TOP_WALL_AT_40: LatticeEdge = [
  [0, 40],
  [40, 40],
];

test.each<[string, LatticeEdge[], LatticePoint, SnapSource[]]>([
  ["both walls within the radius set both axes", [LEFT_WALL, TOP_WALL_AT_40], [0, 40], [{ kind: "edge", edge: LEFT_WALL }, { kind: "edge", edge: TOP_WALL_AT_40 }]],
  ["one wall sets one axis, the grid the other", [LEFT_WALL], [0, 36], [{ kind: "edge", edge: LEFT_WALL }]],
])("snapPoint near two walls: %s", (_name, roomEdges, point, sources) => {
  expect(snapPoint([2.1, 37.6], { ...NONE, roomEdges }, OPTIONS)).toEqual({ point, sources });
});

test.each<[string, LatticeEdge[], LatticePoint, SnapSource[]]>([
  ["a room pushed into the corner of two walls rests against both", [LEFT_WALL, TOP_WALL_AT_40], [-4, 4], [{ kind: "edge", edge: TOP_WALL_AT_40 }, { kind: "edge", edge: LEFT_WALL }]],
  ["a room against one wall moves along it by grid steps", [TOP_WALL_AT_40], [0, 4], [{ kind: "edge", edge: TOP_WALL_AT_40 }]],
])("snapMove near two walls: %s", (_name, roomEdges, delta, sources) => {
  expect(snapMove([boxRing(4, 24, 12, 36)], [-1.9, 2.6], { ...NONE, roomEdges }, OPTIONS)).toEqual({ delta, sources });
});

// An L-shaped room whose inner corner is [20, 20].
const L_ROOM = candidatesOf(FRAME, [shapeOf([[0, 0], [40, 0], [40, 20], [20, 20], [20, 40], [0, 40]])], undefined);
const L_INNER_UP: LatticeEdge = [
  [20, 20],
  [20, 40],
];
const L_INNER_ACROSS: LatticeEdge = [
  [40, 20],
  [20, 20],
];

test.each<[string, [number, number], SnapSource[]]>([
  ["in the inner corner lights both walls", [21.5, 21.2], [{ kind: "edge", edge: L_INNER_UP }, { kind: "edge", edge: L_INNER_ACROSS }]],
  ["behind the inner corner lights the corner", [18.5, 18.8], [{ kind: "corner", at: [20, 20] }]],
  ["outside a corner lights the corner", [41, -1], [{ kind: "corner", at: [40, 0] }]],
  ["inside a corner lights both walls", [38.8, 1.2], [{ kind: "edge", edge: [[40, 0], [40, 20]] }, { kind: "edge", edge: [[0, 0], [40, 0]] }]],
])("a corner snap with the pointer %s", (_name, pointer, sources) => {
  expect(snapPoint(pointer, L_ROOM, OPTIONS).sources).toEqual(sources);
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
  expect(snapLine(20.8, 0, candidates, OPTIONS)).toEqual({ value: 20, sources: [{ kind: "edge", edge: wall }] });
  expect(snapLine(20.8, 0, { ...candidates, roomEdges: [across] }, OPTIONS)).toEqual({
    value: 21,
    sources: [{ kind: "corner", at: [21, 50] }],
  });
  expect(snapLine(9.1, 0, candidates, OPTIONS)).toEqual({ value: 8, sources: [] });
  expect(snapLine(20.8, 0, candidates, { ...OPTIONS, free: true })).toEqual({ value: 21, sources: [] });
});

const KITCHEN = shapeOf([
  [0, 0],
  [40, 0],
  [40, 40],
  [0, 40],
]);
const BATH = shapeOf([
  [40, 0],
  [80, 0],
  [80, 40],
  [40, 40],
]);
const ATTIC = shapeOf([
  [200, 0],
  [240, 0],
  [240, 40],
  [200, 40],
]);
const HOUSE = shapeOf([
  [0, 0],
  [400, 0],
  [400, 400],
  [0, 400],
]);
const FOOTPRINTS = new Map([
  ["kitchen", KITCHEN],
  ["bath", BATH],
  ["attic", ATTIC],
  ["#outline", HOUSE],
]);

test.each<[string, string | undefined, Polygon[], Polygon | undefined]>([
  ["the floor's rooms and the outline, not rooms on other floors", undefined, [KITCHEN, BATH], HOUSE],
  ["without the moved room", "kitchen", [BATH], HOUSE],
  ["without the moved outline", "#outline", [KITCHEN, BATH], undefined],
])("snapCandidatesFor takes %s", (_name, exclude, rooms, outline) => {
  // The floor lists an area without a footprint too, which adds nothing.
  const floorAreaIds = ["kitchen", "hall", "bath"];
  expect(snapCandidatesFor(FRAME, floorAreaIds, FOOTPRINTS, "#outline", exclude)).toEqual(candidatesOf(FRAME, rooms, outline));
});