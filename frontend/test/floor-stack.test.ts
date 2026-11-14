// Checks the stack of floors and the camera that frames it, as pure functions in the site frame.
import type { Feature, Polygon } from "geojson";
import { expect, test } from "vitest";
import {
  CARD_FIELD_OF_VIEW_DEG,
  FIT_MARGIN,
  FLOOR_SPACING_M,
  type StackPoint,
  type StackScreen,
  fitStack,
  floorBase,
  floorLabel,
  floorStack,
  labelSide,
  LABEL_SIDE_FREE_PX,
  OUTLINE_PX,
  ROOM_EDGE_PX,
  edgeStrips,
  labelAnchor,
  metresForPixels,
  pixelsPerMetre,
  projectPoint,
  roomCount,
  stackFloors,
  stackView,
  turnFromFrame,
} from "../src/floor-stack";
import { PlanFrame } from "../src/site-frame";
import { siteFrameData } from "./site-frame-fixture";

const FRAME = PlanFrame.fromSite(siteFrameData([5, 52], 30));

// A rectangle in the site frame, from metres.
const rectangle = (west: number, south: number, east: number, north: number): Polygon => {
  const at = (x: number, y: number) => FRAME.fromLattice([x / FRAME.unitM, y / FRAME.unitM]);
  return { type: "Polygon", coordinates: [[at(west, south), at(east, south), at(east, north), at(west, north), at(west, south)]] };
};

// Rounded to the millimetre; adding 0 turns -0 into 0.
const millimetres = (metres: number) => Math.round(metres * 1000) / 1000 + 0;

const room = (geometry: Polygon, floor_id: string | null, floor_ids?: string[]): Feature<Polygon> => ({
  type: "Feature",
  geometry,
  properties: { floor_id, floor_ids: floor_ids ?? (floor_id ? [floor_id] : []) },
});

const LEVELS: Record<string, number | null> = { cellar: -1, ground: 0, first: 1, attic: null };
const levelOf = (floorId: string) => LEVELS[floorId] ?? null;

test.each([
  { name: "by level, lowest first", rooms: [room(rectangle(0, 0, 1, 1), "first"), room(rectangle(0, 0, 1, 1), "cellar")], floors: ["cellar", "first"] },
  { name: "a floor without a level above those with one", rooms: [room(rectangle(0, 0, 1, 1), "attic"), room(rectangle(0, 0, 1, 1), "ground")], floors: ["ground", "attic"] },
  { name: "a floor a room only reaches into", rooms: [room(rectangle(0, 0, 1, 1), "ground", ["ground", "first"])], floors: ["ground", "first"] },
  { name: "No floor is not in the stack", rooms: [room(rectangle(0, 0, 1, 1), null)], floors: [] },
])("stackFloors orders the floors $name", ({ rooms, floors }) => {
  expect(stackFloors(rooms, levelOf)).toEqual(floors);
});

test.each([
  [0, 0],
  [1, 3.2],
  [3, 9.6],
])("the floor at place %i in the stack lies at %f m", (index, base) => {
  expect(floorBase(index)).toBeCloseTo(base, 9);
});

// A screen pixel of 1 cm.
const PIXEL_M = 0.01;

// Each kind of feature with the height it stands on, once per height, rounded to the millimetre.
const bases = (rooms: Feature<Polygon>[], outline: Polygon | undefined, floors: string[]): string[] => [
  ...new Set(
    floorStack(rooms, outline, floors, FRAME, PIXEL_M).features.features.map(
      (feature) => `${feature.properties!.kind} ${millimetres(feature.properties!.base_m)}`,
    ),
  ),
];

const upper = FLOOR_SPACING_M;

test.each([
  {
    name: "the outline lies on the ground under the lowest floor only, each room on its own floor",
    rooms: [room(rectangle(0, 0, 4, 4), "ground"), room(rectangle(0, 0, 4, 4), "first")],
    outline: rectangle(0, 0, 8, 6),
    expected: ["outline 0", "room 0", "edge 0", `room ${upper}`, `edge ${upper}`],
  },
  {
    name: "without an outline only the rooms",
    rooms: [room(rectangle(0, 0, 4, 4), "ground")],
    outline: undefined,
    expected: ["room 0", "edge 0"],
  },
  {
    name: "a room on two floors lies on both",
    rooms: [room(rectangle(0, 0, 4, 4), "ground", ["ground", "first"])],
    outline: undefined,
    expected: ["room 0", "edge 0", `room ${upper}`, `edge ${upper}`],
  },
  {
    name: "a room on No floor lies on the ground with the outline",
    rooms: [room(rectangle(1, 1, 3, 3), null)],
    outline: rectangle(0, 0, 8, 6),
    expected: ["outline 0", "room 0", "edge 0"],
  },
])("floorStack: $name", ({ rooms, outline, expected }) => {
  expect(bases(rooms, outline, stackFloors(rooms, levelOf))).toEqual(expected);
});

test.each([0.001, 0.01, 0.1])(
  "floorStack lifts the outline, the room fill and the room edges above the ground in that order within a pixel of %f m",
  (pixelM) => {
    const stack = floorStack([room(rectangle(0, 0, 4, 3), "ground")], rectangle(0, 0, 8, 6), ["ground"], FRAME, pixelM);
    const raiseOf = (kind: string) => {
      const features = stack.features.features.filter((feature) => feature.properties!.kind === kind);
      expect(features.length).toBeGreaterThan(0);
      const raises = new Set(features.map((feature) => feature.properties!.top_m - feature.properties!.base_m));
      expect(raises.size).toBe(1);
      return [...raises][0];
    };
    const raises = ["outline", "room", "edge"].map(raiseOf);
    expect(raises[0]).toBeGreaterThan(0);
    raises.slice(1).forEach((raise, index) => expect(raise).toBeGreaterThan(raises[index]));
    expect(raises[2]).toBeLessThan(pixelM);
  },
);

test("floorStack gives each floor its room count and the corners drawn on it, the outline's on the lowest, and frames them all", () => {
  const rooms = [room(rectangle(0, 0, 4, 3), "ground"), room(rectangle(4, 0, 8, 3), "ground", ["ground", "first"])];
  const stack = floorStack(rooms, rectangle(0, 0, 8, 6), ["ground", "first"], FRAME, PIXEL_M);
  expect(stack.floors.map((floor) => [floor.floorId, floor.rooms])).toEqual([["ground", 2], ["first", 1]]);
  const rounded = (corners: StackPoint[]) => [...new Set(corners.map((corner) => corner.map(millimetres).join(" ")))].sort();
  const plan = (z: number, corners: [number, number][]) => corners.map(([x, y]) => [x, y, millimetres(z)].join(" "));
  const ground = plan(0, [[0, 0], [8, 0], [8, 6], [0, 6], [4, 0], [4, 3], [0, 3], [8, 3]]);
  const first = plan(upper, [[4, 0], [8, 0], [8, 3], [4, 3]]);
  expect(rounded(stack.floors[0].corners)).toEqual([...ground].sort());
  expect(rounded(stack.floors[1].corners)).toEqual([...first].sort());
  expect(rounded(stack.corners)).toEqual([...ground, ...first].sort());
});

// The across-edge width of a strip in metres: the narrower side of its box in the frame.
const stripWidth = (strip: Polygon) => {
  const metres = strip.coordinates[0].map((position) => FRAME.toLatticeUnits(position).map((unit) => unit * FRAME.unitM));
  const xs = metres.map(([x]) => x);
  const ys = metres.map(([, y]) => y);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

test.each([
  { kind: "outline", pixels: OUTLINE_PX, count: 4 },
  { kind: "edge", pixels: ROOM_EDGE_PX, count: 4 },
])("floorStack draws $kind as $count lines $pixels pixels wide", ({ kind, pixels, count }) => {
  const stack = floorStack([room(rectangle(0, 0, 4, 3), "ground")], rectangle(0, 0, 8, 6), ["ground"], FRAME, PIXEL_M);
  const edges = stack.features.features.filter((feature) => feature.properties!.kind === kind);
  expect(edges).toHaveLength(count);
  for (const edge of edges) expect(stripWidth(edge.geometry)).toBeCloseTo(pixels * PIXEL_M, 6);
});

test("edgeStrips draws each edge as a strip of the given width that runs past both corners by half that", () => {
  const strips = edgeStrips(rectangle(0, 0, 4, 3), FRAME, 0.1);
  expect(strips).toHaveLength(4);
  const metres = strips[0].coordinates[0].map((position) => FRAME.toLatticeUnits(position).map((unit) => millimetres(unit * FRAME.unitM)));
  const xs = metres.map(([x]) => x);
  const ys = metres.map(([, y]) => y);
  expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-0.05, 4.05, -0.05, 0.05]);
});

test.each([
  [0, "0 rooms"],
  [1, "1 room"],
  [4, "4 rooms"],
])("a floor with %i rooms is labelled %s", (rooms, text) => {
  expect(roomCount(rooms)).toBe(text);
});

test("metresForPixels is a number of pixels at the map's scale", () => {
  expect(metresForPixels(3, 20, 52)).toBeCloseTo(3 / pixelsPerMetre(20, 52), 12);
});

test.each([
  { zoom: 0, latitude: 0, expected: 512 / (2 * Math.PI * 6371008.8) },
  { zoom: 1, latitude: 0, expected: 1024 / (2 * Math.PI * 6371008.8) },
  { zoom: 0, latitude: 60, expected: 1024 / (2 * Math.PI * 6371008.8) },
])("pixelsPerMetre at zoom $zoom and latitude $latitude", ({ zoom, latitude, expected }) => {
  expect(pixelsPerMetre(zoom, latitude)).toBeCloseTo(expected, 12);
});

const SCREEN: StackScreen = { width: 800, height: 600, fovDeg: 36.87, latitude: 0 };
// At zoom 20 on the equator a metre is about 13.4 pixels.
const PPM = pixelsPerMetre(20, 0);
const camera = (turnDeg: number, pitchDeg: number) => ({ centre: [10, 20] as [number, number], zoom: 20, turnDeg, pitchDeg });

test.each([
  { name: "the centre is the middle of the screen", point: [10, 20, 0], turn: 0, pitch: 55, expected: [400, 300] },
  { name: "x runs right at turn 0", point: [11, 20, 0], turn: 0, pitch: 0, expected: [400 + PPM, 300] },
  { name: "y runs up at turn 0", point: [10, 21, 0], turn: 0, pitch: 0, expected: [400, 300 - PPM] },
  { name: "x runs up at turn 90", point: [11, 20, 0], turn: 90, pitch: 0, expected: [400, 300 - PPM] },
  { name: "x runs down to the right at turn -45", point: [10 + Math.SQRT2, 20, 0], turn: -45, pitch: 0, expected: [400 + PPM, 300 + PPM] },
])("projectPoint: $name", ({ point, turn, pitch, expected }) => {
  const [x, y] = projectPoint(point as StackPoint, camera(turn, pitch), SCREEN)!;
  expect(x).toBeCloseTo(expected[0], 6);
  expect(y).toBeCloseTo(expected[1], 6);
});

test("projectPoint: a raised point rises on screen under a tilted camera and looms nearer under a flat one", () => {
  const raised: StackPoint = [11, 20, 3];
  const tilted = projectPoint(raised, camera(0, 55), SCREEN)!;
  expect(tilted[1]).toBeLessThan(300);
  const flat = projectPoint(raised, camera(0, 0), SCREEN)!;
  expect(flat[1]).toBeCloseTo(300, 9);
  expect(flat[0]).toBeGreaterThan(400 + PPM);
});

test("projectPoint: a point behind the camera has no pixel", () => {
  expect(projectPoint([10, -1e6, 0], camera(0, 80), SCREEN)).toBeUndefined();
});

test.each([
  [270, 0, 0],
  [225, 0, -45],
  [0, 90, 0],
])("turnFromFrame: map bearing %i over a frame bearing %i is a turn of %i", (mapBearingDeg, frameBearingDeg, turn) => {
  expect(turnFromFrame(mapBearingDeg, frameBearingDeg)).toBe(turn);
});

// A house 9 m by 7 m with three floors.
const HOUSE: StackPoint[] = [0, 5, 10, 10.3].flatMap((z) =>
  [[0, 0], [9, 0], [9, 7], [0, 7]].map(([x, y]) => [x, y, z] as StackPoint),
);

test.each([
  { name: "a wide card from the front corner", screen: { width: 800, height: 400 }, padding: { top: 0, right: 0, bottom: 0, left: 0 }, turn: -45, fov: CARD_FIELD_OF_VIEW_DEG },
  { name: "a phone with controls on top and bottom", screen: { width: 390, height: 700 }, padding: { top: 120, right: 0, bottom: 90, left: 0 }, turn: -45, fov: 36.87 },
  { name: "a panel with labels on the right", screen: { width: 1440, height: 800 }, padding: { top: 80, right: 200, bottom: 100, left: 0 }, turn: 30, fov: 36.87 },
])("fitStack fits the whole stack in the free space with its margin: $name", ({ screen, padding, turn, fov }) => {
  const full: StackScreen = { ...screen, fovDeg: fov, latitude: 52 };
  const fit = fitStack(HOUSE, turn, 55, full, padding)!;
  const pixels = HOUSE.map((point) => projectPoint(point, { ...fit, turnDeg: turn, pitchDeg: 55 }, full)!);
  const xs = pixels.map(([x]) => x);
  const ys = pixels.map(([, y]) => y);
  const freeWidth = screen.width - padding.left - padding.right;
  const freeHeight = screen.height - padding.top - padding.bottom;
  const [width, height] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  // One side is full to its margin; the other fits.
  expect(Math.max(width / freeWidth, height / freeHeight)).toBeCloseTo(1 / (1 + FIT_MARGIN), 2);
  expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(padding.left + freeWidth / 2, 0);
  expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(padding.top + freeHeight / 2, 0);
});

test("fitStack has nothing to fit without points", () => {
  expect(fitStack([], 0, 55, SCREEN, { top: 0, right: 0, bottom: 0, left: 0 })).toBeUndefined();
});

test("labelAnchor is the floor's rightmost corner on screen", () => {
  const corners: StackPoint[] = [[0, 0, 0.3], [9, 0, 0.3], [9, 7, 0.3], [0, 7, 0.3]];
  const view = { centre: [4.5, 3.5] as [number, number], zoom: 20, turnDeg: -45, pitchDeg: 55 };
  const pixels = corners.map((corner) => projectPoint(corner, view, SCREEN)!);
  // From the front corner the back right corner of the plan is the rightmost.
  expect(labelAnchor(corners, view, SCREEN)).toEqual(pixels[2]);
});

test("stackView looks from 45 degrees left of the site axis, 35 degrees above the horizon", () => {
  const stack = floorStack([room(rectangle(0, 0, 4, 3), "ground")], undefined, ["ground"], FRAME, PIXEL_M);
  const view = stackView(stack, FRAME, 30, { width: 800, height: 600, fovDeg: 36.87 }, { top: 0, right: 0, bottom: 0, left: 0 })!;
  // Site axis 30 lies to the right at map bearing 300.
  expect(view).toMatchObject({ bearing: 255, pitch: 55 });
});

test.each([
  { name: "a drawn floor", rooms: 2, expected: { name: "Ground", count: "2 rooms", dashed: false } },
  { name: "an undrawn floor", rooms: 0, expected: { name: "Ground \u00b7 not drawn", count: undefined, dashed: true } },
])("floorLabel names $name", ({ rooms, expected }) => {
  expect(floorLabel("Ground", rooms)).toEqual(expected);
});

test.each([
  [119, "left"],
  [120, "right"],
  [121, "right"],
])("labels go %i px free on the right: %s", (free, side) => {
  expect(LABEL_SIDE_FREE_PX).toBe(120);
  expect(labelSide(free)).toBe(side);
});

test("an undrawn floor joins the stack at its level and is labelled at the outline", () => {
  const rooms = [room(rectangle(0, 0, 4, 3), "ground"), room(rectangle(0, 0, 4, 3), "attic")];
  const floors = stackFloors(rooms, levelOf, ["first"]);
  expect(floors).toEqual(["ground", "first", "attic"]);
  const stack = floorStack(rooms, rectangle(0, 0, 8, 6), floors, FRAME, PIXEL_M);
  const first = stack.floors[1];
  expect(first.rooms).toBe(0);
  expect(first.corners.length).toBeGreaterThan(0);
  expect(first.corners.every((corner) => millimetres(corner[2]) === FLOOR_SPACING_M)).toBe(true);
});
