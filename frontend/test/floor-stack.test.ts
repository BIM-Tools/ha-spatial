// Checks the stack of floor slabs and the camera that frames it, as pure functions in the site frame.
import type { Feature, Polygon } from "geojson";
import { expect, test } from "vitest";
import {
  FIT_MARGIN,
  SLAB_SPACING_M,
  type StackPoint,
  type StackScreen,
  fitStack,
  floorStack,
  ROOM_EDGE_PX,
  SLAB_EDGE_PX,
  edgeStrips,
  labelAnchor,
  metresForPixels,
  pixelsPerMetre,
  projectPoint,
  roomCount,
  slabBase,
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
  { name: "No floor gets no slab", rooms: [room(rectangle(0, 0, 1, 1), null)], floors: [] },
])("stackFloors orders the floors $name", ({ rooms, floors }) => {
  expect(stackFloors(rooms, levelOf)).toEqual(floors);
});

test.each([
  [0, 0],
  [1, 3.2],
  [3, 9.6],
])("the slab at place %i in the stack lies at %f m", (index, base) => {
  expect(slabBase(index)).toBeCloseTo(base, 9);
});

type Bases = [kind: string, base: number][];

// A screen pixel of 1 cm.
const PIXEL_M = 0.01;

const bases = (rooms: Feature<Polygon>[], outline: Polygon | undefined, floors: string[]): Bases =>
  floorStack(rooms, outline, floors, FRAME, PIXEL_M)
    .features.features.filter((feature) => !feature.properties!.kind.endsWith("edge"))
    .map((feature) => [feature.properties!.kind, feature.properties!.base_m]);

const upper = SLAB_SPACING_M;

test.each([
  {
    name: "a slab per floor under the outline, each room on its own slab",
    rooms: [room(rectangle(0, 0, 4, 4), "ground"), room(rectangle(0, 0, 4, 4), "first")],
    outline: rectangle(0, 0, 8, 6),
    expected: [
      ["slab", 0],
      ["slab", upper],
      ["room", 0],
      ["room", upper],
    ],
  },
  {
    name: "without an outline the floor's rooms are its slab",
    rooms: [room(rectangle(0, 0, 4, 4), "ground")],
    outline: undefined,
    expected: [
      ["slab", 0],
      ["room", 0],
    ],
  },
  {
    name: "a room on two floors lies on both slabs",
    rooms: [room(rectangle(0, 0, 4, 4), "ground", ["ground", "first"])],
    outline: undefined,
    expected: [
      ["slab", 0],
      ["slab", upper],
      ["room", 0],
      ["room", upper],
    ],
  },
  {
    name: "a room on No floor lies on the ground without a slab",
    rooms: [room(rectangle(10, 0, 12, 2), null)],
    outline: undefined,
    expected: [["room", 0]],
  },
])("floorStack: $name", ({ rooms, outline, expected }) => {
  const floors = stackFloors(rooms, levelOf);
  const actual = bases(rooms, outline, floors);
  expect(actual.map(([kind]) => kind)).toEqual(expected.map(([kind]) => kind));
  actual.forEach(([, base], index) => expect(base).toBeCloseTo(expected[index][1] as number, 9));
});

test.each([0.001, 0.01, 0.1])(
  "floorStack keeps the slab flat and lifts its edge, the room fill and the room edges in that order within a pixel of %f m",
  (pixelM) => {
    const stack = floorStack([room(rectangle(0, 0, 4, 3), "first")], rectangle(0, 0, 8, 6), ["ground", "first"], FRAME, pixelM);
    const raiseOf = (kind: string) => {
      const features = stack.features.features.filter((feature) => feature.properties!.kind === kind && feature.properties!.base_m === upper);
      expect(features.length).toBeGreaterThan(0);
      const raises = new Set(features.map((feature) => feature.properties!.top_m - upper));
      expect(raises.size).toBe(1);
      return [...raises][0];
    };
    const raises = ["slab", "slab-edge", "room", "edge"].map(raiseOf);
    expect(raises[0]).toBe(0);
    raises.slice(1).forEach((raise, index) => expect(raise).toBeGreaterThan(raises[index]));
    expect(raises[3]).toBeLessThan(pixelM);
  },
);

test("floorStack gives each slab its room count and top corners, and frames every slab and room corner", () => {
  const rooms = [room(rectangle(0, 0, 4, 3), "ground"), room(rectangle(4, 0, 8, 3), "ground", ["ground", "first"])];
  const stack = floorStack(rooms, rectangle(0, 0, 8, 6), ["ground", "first"], FRAME, PIXEL_M);
  expect(stack.slabs.map((slab) => [slab.floorId, slab.rooms])).toEqual([["ground", 2], ["first", 1]]);
  const top = stack.slabs[0].top.map(([x, y, z]) => [millimetres(x), millimetres(y), z]);
  expect(top.slice(0, 4)).toEqual([[0, 0, 0], [8, 0, 0], [8, 6, 0], [0, 6, 0]]);
  const zs = new Set(stack.corners.map(([, , z]) => millimetres(z)));
  expect([...zs]).toEqual([0, upper].map(millimetres));
});

// The across-edge width of a strip in metres: the narrower side of its box in the frame.
const stripWidth = (strip: Polygon) => {
  const metres = strip.coordinates[0].map((position) => FRAME.toLatticeUnits(position).map((unit) => unit * FRAME.unitM));
  const xs = metres.map(([x]) => x);
  const ys = metres.map(([, y]) => y);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

test.each([
  { kind: "slab-edge", pixels: SLAB_EDGE_PX, count: 4 },
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

// A house 9 m by 7 m with three slabs.
const HOUSE: StackPoint[] = [0, 5, 10, 10.3].flatMap((z) =>
  [[0, 0], [9, 0], [9, 7], [0, 7]].map(([x, y]) => [x, y, z] as StackPoint),
);

test.each([
  { name: "a wide card from the front corner", screen: { width: 800, height: 400 }, padding: { top: 0, right: 0, bottom: 0, left: 0 }, turn: -45 },
  { name: "a phone with controls on top and bottom", screen: { width: 390, height: 700 }, padding: { top: 120, right: 0, bottom: 90, left: 0 }, turn: -45 },
  { name: "a panel with labels on the right", screen: { width: 1440, height: 800 }, padding: { top: 80, right: 200, bottom: 100, left: 0 }, turn: 30 },
])("fitStack fits the whole stack in the free space with its margin: $name", ({ screen, padding, turn }) => {
  const full: StackScreen = { ...screen, fovDeg: 36.87, latitude: 52 };
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

test("labelAnchor is the slab's rightmost top corner on screen", () => {
  const top: StackPoint[] = [[0, 0, 0.3], [9, 0, 0.3], [9, 7, 0.3], [0, 7, 0.3]];
  const view = { centre: [4.5, 3.5] as [number, number], zoom: 20, turnDeg: -45, pitchDeg: 55 };
  const pixels = top.map((corner) => projectPoint(corner, view, SCREEN)!);
  // From the front corner the back right corner of the plan is the rightmost.
  expect(labelAnchor(top, view, SCREEN)).toEqual(pixels[2]);
});

test("stackView looks from 45 degrees left of the site axis, 35 degrees above the horizon", () => {
  const stack = floorStack([room(rectangle(0, 0, 4, 3), "ground")], undefined, ["ground"], FRAME, PIXEL_M);
  const view = stackView(stack, FRAME, 30, { width: 800, height: 600, fovDeg: 36.87 }, { top: 0, right: 0, bottom: 0, left: 0 })!;
  // Site axis 30 lies to the right at map bearing 300.
  expect(view).toMatchObject({ bearing: 255, pitch: 55 });
});
