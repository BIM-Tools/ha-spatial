// Checks the building pick against turf geometry built in metres or in tile units, independent of the code under test.

import area from "@turf/area";
import destination from "@turf/destination";
import { polygon } from "@turf/helpers";
import type { Polygon } from "geojson";
import { expect, test } from "vitest";
import { type TileBuildings, alignFields, buildingAt, nearestBuilding, reachesUnreadTiles, wallAt, wallBearingAt } from "../src/outline";

type Pos = [number, number];

// A 10 m x 8 m rectangle at 52 N whose first wall runs at bearing 20, walked counter-clockwise.
const p0: Pos = [5, 52];
const p1 = destination(p0, 10, 20, { units: "meters" }).geometry.coordinates as Pos;
const p2 = destination(p1, 8, 290, { units: "meters" }).geometry.coordinates as Pos;
const p3 = destination(p2, 10, 200, { units: "meters" }).geometry.coordinates as Pos;
const building = polygon([[p0, p1, p2, p3, p0]]).geometry as Polygon;
const midpoint = (a: Pos, b: Pos): Pos => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// Vector tiles at zoom 14 around the Domtoren, in tile units: tile x spans [x, x + 1]. Each tile cuts its
// buildings at its edges plus a buffer of 8 of its 4096 units, as Home Assistant's map tiles do.
const Z = 14;
const UNIT = 1 / 4096;
const BUFFER = 8 * UNIT;
const SEAM_X = 8425;
const SEAM_Y = 5406;
// Slippy map tile names to WGS84: https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
const lngLat = ([x, y]: Pos): Pos => [(x / 2 ** Z) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** Z))) * 180) / Math.PI];
const ring = (...corners: Pos[]): Pos[] => [...corners, corners[0]].map(lngLat);
const box = (x0: number, y0: number, x1: number, y1: number): Pos[] => ring([x0, y0], [x1, y0], [x1, y1], [x0, y1]);
const shape = (outer: Pos[]): Polygon => ({ type: "Polygon", coordinates: [outer] });
const tile = (x: number, y: number, ...parts: Pos[][]): TileBuildings => ({
  z: Z,
  x,
  y,
  geometry: { type: "MultiPolygon", coordinates: parts.map((outer) => [outer]) },
});
const bbox = (shape: Polygon) => {
  const corners = shape.coordinates[0];
  return [0, 1].flatMap((axis) => [Math.min(...corners.map((c) => c[axis])), Math.max(...corners.map((c) => c[axis]))]);
};
const sameShape = (actual: Polygon | undefined, expected: Polygon) => {
  expect(actual?.type).toBe("Polygon");
  expect(actual!.coordinates).toHaveLength(expected.coordinates.length);
  expect(Math.abs(area(actual!) / area(expected) - 1)).toBeLessThan(1e-6);
  bbox(actual!).forEach((value, index) => expect(value).toBeCloseTo(bbox(expected)[index], 9));
};

// Rows of the building at the seam between tiles 8424 and 8425, 30 units deep, in tile row 5405.
const [ROW_TOP, ROW_BOTTOM] = [SEAM_Y - 40 * UNIT, SEAM_Y - 10 * UNIT];
const across = (x0: number, x1: number) => box(x0, ROW_TOP, x1, ROW_BOTTOM);
const WHOLE = shape(across(SEAM_X - 20 * UNIT, SEAM_X + 20 * UNIT));
const LEFT_HOUSE = shape(across(SEAM_X - 20 * UNIT, SEAM_X + 3 * UNIT));
const RIGHT_HOUSE = shape(across(SEAM_X + 3 * UNIT, SEAM_X + 20 * UNIT));
const IN_LEFT_TILE: Pos = [SEAM_X - 15 * UNIT, SEAM_Y - 25 * UNIT];
const IN_RIGHT_TILE: Pos = [SEAM_X + 15 * UNIT, SEAM_Y - 25 * UNIT];
const FAR = across(SEAM_X - 900 * UNIT, SEAM_X - 800 * UNIT);
const splitWithBuffer = [
  tile(8424, 5405, FAR, across(SEAM_X - 20 * UNIT, SEAM_X + BUFFER)),
  tile(8425, 5405, across(SEAM_X - BUFFER, SEAM_X + 20 * UNIT)),
];
// An L whose bar crosses the seam between columns and whose leg crosses the seam between rows.
const [LEG_LEFT, LEG_RIGHT] = [SEAM_X + 10 * UNIT, SEAM_X + 20 * UNIT];
const L_SHAPE = shape(
  ring(
    [SEAM_X - 20 * UNIT, ROW_TOP],
    [LEG_RIGHT, ROW_TOP],
    [LEG_RIGHT, SEAM_Y + 20 * UNIT],
    [LEG_LEFT, SEAM_Y + 20 * UNIT],
    [LEG_LEFT, ROW_BOTTOM],
    [SEAM_X - 20 * UNIT, ROW_BOTTOM],
  ),
);
const lSplit = [
  tile(8424, 5405, across(SEAM_X - 20 * UNIT, SEAM_X + BUFFER)),
  tile(
    8425,
    5405,
    ring(
      [SEAM_X - BUFFER, ROW_TOP],
      [LEG_RIGHT, ROW_TOP],
      [LEG_RIGHT, SEAM_Y + BUFFER],
      [LEG_LEFT, SEAM_Y + BUFFER],
      [LEG_LEFT, ROW_BOTTOM],
      [SEAM_X - BUFFER, ROW_BOTTOM],
    ),
  ),
  tile(8425, 5406, box(LEG_LEFT, SEAM_Y - BUFFER, LEG_RIGHT, SEAM_Y + 20 * UNIT)),
];

test.each([
  ["a square split across a seam, each part reaching into the buffer", splitWithBuffer, IN_LEFT_TILE, WHOLE],
  ["the same square read from the right-hand tile", splitWithBuffer, IN_RIGHT_TILE, WHOLE],
  ["a tile read twice, by two of the style's layers", [...splitWithBuffer, splitWithBuffer[1]], IN_LEFT_TILE, WHOLE],
  [
    "a square split exactly on a seam, from tiles without a buffer",
    [tile(8424, 5405, across(SEAM_X - 20 * UNIT, SEAM_X)), tile(8425, 5405, across(SEAM_X, SEAM_X + 20 * UNIT))],
    IN_LEFT_TILE,
    WHOLE,
  ],
  [
    "a square whose parts end just off the seam after quantisation",
    [tile(8424, 5405, across(SEAM_X - 20 * UNIT, SEAM_X - 0.5 * UNIT)), tile(8425, 5405, across(SEAM_X + 0.25 * UNIT, SEAM_X + 20 * UNIT))],
    IN_LEFT_TILE,
    WHOLE,
  ],
  ["an L split across two seams", lSplit, IN_LEFT_TILE, L_SHAPE],
  [
    "two neighbours sharing a wall off the seam: the left one",
    [
      tile(8424, 5405, across(SEAM_X - 20 * UNIT, SEAM_X + 3 * UNIT), across(SEAM_X + 3 * UNIT, SEAM_X + BUFFER)),
      tile(8425, 5405, across(SEAM_X - BUFFER, SEAM_X + 3 * UNIT), across(SEAM_X + 3 * UNIT, SEAM_X + 20 * UNIT)),
    ],
    IN_LEFT_TILE,
    LEFT_HOUSE,
  ],
  [
    "two neighbours sharing a wall off the seam: the right one",
    [
      tile(8424, 5405, across(SEAM_X - 20 * UNIT, SEAM_X + 3 * UNIT), across(SEAM_X + 3 * UNIT, SEAM_X + BUFFER)),
      tile(8425, 5405, across(SEAM_X - BUFFER, SEAM_X + 3 * UNIT), across(SEAM_X + 3 * UNIT, SEAM_X + 20 * UNIT)),
    ],
    IN_RIGHT_TILE,
    RIGHT_HOUSE,
  ],
])("buildingAt joins %s", (_case, tiles, at, expected) => {
  sameShape(buildingAt(tiles, lngLat(at), Z), expected);
});

test("buildingAt returns a building within one tile as the tile has it", () => {
  const tiles = [tile(8424, 5405, FAR, across(SEAM_X - 20 * UNIT, SEAM_X - 10 * UNIT))];
  expect(buildingAt(tiles, lngLat(IN_LEFT_TILE), Z)).toEqual(shape(across(SEAM_X - 20 * UNIT, SEAM_X - 10 * UNIT)));
});

test.each([
  ["no building at the point", [tile(8424, 5405, FAR)]],
  ["a building only in a tile of another zoom", [{ ...splitWithBuffer[0], z: Z - 1 }]],
])("buildingAt finds nothing with %s", (_case, tiles) => {
  expect(buildingAt(tiles, lngLat(IN_LEFT_TILE), Z)).toBeUndefined();
});

// Two terraced houses sharing a wall, inside one tile; a unit is about 0.37 m here.
const WALL_X = SEAM_X - 25 * UNIT;
const WEST_HOUSE = across(SEAM_X - 40 * UNIT, WALL_X);
const EAST_HOUSE = across(WALL_X, SEAM_X - 10 * UNIT);
const terrace = [tile(8424, 5405, FAR, WEST_HOUSE, EAST_HOUSE)];
// Two units, about 0.73 m, below the west house.
const BELOW_WEST: Pos = [SEAM_X - 35 * UNIT, ROW_BOTTOM + 2 * UNIT];

test.each<[string, Pos, number, Pos[] | undefined]>([
  ["inside wins over a nearer edge of another building", [WALL_X + 0.5 * UNIT, SEAM_Y - 25 * UNIT], 5, EAST_HOUSE],
  ["on a shared wall, the side the click is on", [WALL_X - 0.5 * UNIT, SEAM_Y - 25 * UNIT], 5, WEST_HOUSE],
  ["outside, within the tolerance", BELOW_WEST, 1, WEST_HOUSE],
  ["outside, beyond the tolerance", BELOW_WEST, 0.5, undefined],
  ["outside, without a tolerance", BELOW_WEST, 0, undefined],
])("nearestBuilding: %s", (_case, at, maxM, expected) => {
  expect(nearestBuilding(terrace, lngLat(at), maxM, Z)).toEqual(expected && shape(expected));
});

test.each([
  ["a building within its one tile", [tile(8424, 5405, across(SEAM_X - 20 * UNIT, SEAM_X - 10 * UNIT))], false],
  ["a part reaching into the next tile, unread", [splitWithBuffer[0]], true],
  ["a part reaching into the next tile, read", splitWithBuffer, false],
])("reachesUnreadTiles with %s: %s", (_case, tiles, expected) => {
  const building = buildingAt(tiles, lngLat(IN_LEFT_TILE), Z)!;
  expect(reachesUnreadTiles(building, tiles, Z)).toBe(expected);
});

test.each([
  [p0, p1, 20],
  [p1, p2, 290],
  [p2, p3, 200],
  [p3, p0, 110],
])("wallBearingAt near the wall from %j gives its bearing", (from, to, expected) => {
  expect(Math.abs(wallBearingAt(building, midpoint(from, to)) - expected)).toBeLessThan(0.5);
});

test("wallBearingAt reads a clockwise ring as its counter-clockwise twin", () => {
  const clockwise = polygon([[p0, p3, p2, p1, p0]]).geometry as Polygon;
  expect(Math.abs(wallBearingAt(clockwise, midpoint(p0, p1)) - 20)).toBeLessThan(0.5);
});

test("wallAt gives the two ends of the wall nearest to the point, counter-clockwise", () => {
  expect(wallAt(building, midpoint(p1, p2))).toEqual([p1, p2]);
  const clockwise = polygon([[p0, p3, p2, p1, p0]]).geometry as Polygon;
  expect(wallAt(clockwise, midpoint(p0, p1))).toEqual([p0, p1]);
});

test.each([
  ["an empty plan", p0, p1, false, 20, p0],
  ["an empty plan", p1, p2, false, 290, p1],
  ["a plan with shapes", p0, p1, true, 20, undefined],
  ["a plan with shapes", p2, p3, true, 200, undefined],
])("alignFields on %s near the wall from %j writes its bearing and its left end as origin only when empty", (_plan, from, to, hasShapes, bearing, origin) => {
  const fields = alignFields(building, midpoint(from, to), hasShapes);
  expect(Math.abs(fields.bearing_deg - bearing)).toBeLessThan(0.5);
  expect(fields.origin).toEqual(origin);
  expect("origin" in fields).toBe(origin !== undefined);
});
