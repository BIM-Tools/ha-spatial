// Checks where the snap engine puts a point, a move and a line, and what it lights up.

import type { Polygon } from "geojson";
import { expect, test } from "vitest";
import { PlanFrame, type LatticePoint } from "../src/site-frame";
import { type LatticeEdge, type SnapSource, candidatesOf, snapCandidatesFor, snapLine, snapMove, snapPoint } from "../src/snap";
import { siteFrameData } from "./site-frame-fixture";

const FRAME = PlanFrame.fromSite(siteFrameData([5, 52], 20));
const OPTIONS = { radius: 3, gridUnits: 4, free: false };
const FREE = { ...OPTIONS, free: true };

const shapeOf = (...rings: LatticePoint[][]): Polygon => ({
  type: "Polygon",
  coordinates: rings.map((ring) => [...ring, ring[0]].map((corner) => FRAME.fromLattice(corner))),
});
const boxRing = (left: number, bottom: number, right: number, top: number): LatticePoint[] => [
  [left, bottom],
  [right, bottom],
  [right, top],
  [left, top],
];
const wall = (edge: LatticeEdge): SnapSource => ({ kind: "edge", edge });
const corner = (at: LatticePoint): SnapSource => ({ kind: "corner", at });

// A room, a second room up and to the right of it, and an outline wall just left of the first.
const PLAN = candidatesOf(FRAME, [shapeOf(boxRing(0, 0, 40, 40)), shapeOf(boxRing(43, 60, 80, 100))], shapeOf(boxRing(-2, -40, 200, 200)));
const RIGHT: LatticeEdge = [
  [40, 0],
  [40, 40],
];
const BOTTOM: LatticeEdge = [
  [0, 0],
  [40, 0],
];
const TOP: LatticeEdge = [
  [40, 40],
  [0, 40],
];
const OUTLINE_LEFT: LatticeEdge = [
  [-2, 200],
  [-2, -40],
];

test.each<[string, number, 0 | 1, [number, number], number, SnapSource[]]>([
  ["a wall within its span", 41.2, 0, [17, 17], 40, [wall(RIGHT)]],
  ["a wall across", 38.9, 1, [20, 20], 40, [wall(TOP)]],
  ["a wall reached by the line's span within the radius", 41.2, 0, [43, 80], 40, [wall(RIGHT)]],
  ["the grid when walls and corners lie further along than the radius", 42.2, 0, [50, 50], 44, []],
])("snapLine lands on %s", (_name, value, axis, along, expected, sources) => {
  expect(snapLine(value, axis, PLAN, OPTIONS, along)).toEqual({ value: expected, sources });
});

test.each<[string, number, [number, number], number, SnapSource[]]>([
  ["a room wall beats a nearer outline wall", -1.5, [17, 17], 0, [wall([[0, 40], [0, 0]])]],
  ["the outline counts without a room guide in range", -3.5, [17, 17], -2, [wall(OUTLINE_LEFT)]],
  ["within the rooms the nearest wins", 41.8, [38, 62], 43, [wall([[43, 100], [43, 60]])]],
])("snapLine tiers: %s", (_name, value, along, expected, sources) => {
  expect(snapLine(value, 0, PLAN, OPTIONS, along)).toEqual({ value: expected, sources });
});

test.each<[string, number, 0 | 1, number]>([
  ["across", 9.1, 0, 8],
  ["across, below zero", -6.1, 0, -8],
  ["down", 21.9, 1, 20],
])("snapLine without a guide in range rounds to the grid %s", (_name, value, axis, expected) => {
  expect(snapLine(value, axis, PLAN, OPTIONS, [17, 17])).toEqual({ value: expected, sources: [] });
});

test.each<[string, [number, number], LatticePoint, SnapSource[]]>([
  ["inside a corner lands on both walls", [38.8, 1.2], [40, 0], [wall(RIGHT), wall(BOTTOM)]],
  ["outside a corner lands on both walls", [41, -1], [40, 0], [wall(RIGHT), wall(BOTTOM)]],
  ["by one wall keeps the grid along it", [41.2, 17.3], [40, 16], [wall(RIGHT)]],
  ["away from every guide lands on the grid", [21.9, 21.9], [20, 20], []],
])("snapPoint %s", (_name, pointer, point, sources) => {
  expect(snapPoint(pointer, PLAN, OPTIONS)).toEqual({ point, sources });
});

test("snapPoint lights a corner that sets both axes once, as a dot", () => {
  // The top of a triangle: its two diagonal walls never count, its corner does.
  const triangle = candidatesOf(FRAME, [shapeOf([[0, 0], [20, 0], [10, 30]])], undefined);
  expect(snapPoint([10.8, 29.1], triangle, OPTIONS)).toEqual({ point: [10, 30], sources: [corner([10, 30])] });
});

test.each<[string, () => unknown, unknown]>([
  ["snapLine", () => snapLine(40.6, 0, PLAN, FREE, [17, 17]), { value: 41, sources: [] }],
  ["snapPoint", () => snapPoint([40.6, 0.4], PLAN, FREE), { point: [41, 0], sources: [] }],
  ["snapMove", () => snapMove([boxRing(1, 1, 9, 9)], [6.2, 0.1], PLAN, FREE), { delta: [6, 0], sources: [] }],
])("Alt places %s on the lattice without snapping", (_name, snap, expected) => {
  expect(snap()).toEqual(expected);
});

// Two rooms that meet along y 17 to 40 at x 17, so their walls make an inner corner at [17, 17].
const BESIDE = candidatesOf(FRAME, [shapeOf(boxRing(17, -40, 40, 40)), shapeOf(boxRing(-40, 17, 17, 40))], undefined);
const BESIDE_LEFT: LatticeEdge = [
  [17, 40],
  [17, -40],
];
const BESIDE_BOTTOM: LatticeEdge = [
  [-40, 17],
  [17, 17],
];

test.each<[string, [number, number], LatticePoint, SnapSource[]]>([
  ["without a guide moves by whole grid steps", [2.2, -10.1], [4, -12], []],
  ["onto one wall keeps whole grid steps along it", [6.5, -5.1], [8, -4], [wall(BESIDE_LEFT)]],
  ["pushed into a corner rests against both walls", [6.5, 6.6], [8, 8], [wall(BESIDE_LEFT), wall(BESIDE_BOTTOM)]],
])("snapMove of a room off the grid by 1 %s", (_name, delta, expected, sources) => {
  expect(snapMove([boxRing(1, 1, 9, 9)], delta, BESIDE, OPTIONS)).toEqual({ delta: expected, sources });
});

test("candidatesOf keeps every outline edge, since every one stops a move", () => {
  const outline = shapeOf([
    [0, 0],
    [30, 10],
    [0, 10],
  ]);
  expect(candidatesOf(FRAME, [], outline).outlineEdges).toHaveLength(3);
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
});

// A square building: where the outline stops a room is in wall-stop.test.ts, here only that snapMove applies it.
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

test.each<[string, string | undefined, Polygon[], Polygon | undefined, boolean]>([
  ["the floor's rooms and the outline, not rooms on other floors", undefined, [KITCHEN, BATH], HOUSE, true],
  ["without the moved room", "kitchen", [BATH], HOUSE, true],
  ["without the moved outline, which rooms do not stop", "#outline", [KITCHEN, BATH], undefined, false],
])("snapCandidatesFor takes %s", (_name, exclude, rooms, outline, roomsStop) => {
  // The floor lists an area without a footprint too, which adds nothing.
  const floorAreaIds = ["kitchen", "hall", "bath"];
  const expected = candidatesOf(FRAME, rooms, outline);
  expect(snapCandidatesFor(FRAME, floorAreaIds, FOOTPRINTS, "#outline", exclude)).toEqual(roomsStop ? expected : { ...expected, roomRings: [] });
});
