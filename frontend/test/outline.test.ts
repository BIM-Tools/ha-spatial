// Checks the building pick against turf geometry built in metres, independent of the code under test.

import destination from "@turf/destination";
import { polygon } from "@turf/helpers";
import type { Polygon } from "geojson";
import { expect, test } from "vitest";
import { buildingAt, wallBearingAt } from "../src/outline";

type Pos = [number, number];

// A 10 m x 8 m rectangle at 52 N whose first wall runs at bearing 20, walked counter-clockwise.
const p0: Pos = [5, 52];
const p1 = destination(p0, 10, 20, { units: "meters" }).geometry.coordinates as Pos;
const p2 = destination(p1, 8, 290, { units: "meters" }).geometry.coordinates as Pos;
const p3 = destination(p2, 10, 200, { units: "meters" }).geometry.coordinates as Pos;
const building = polygon([[p0, p1, p2, p3, p0]]).geometry as Polygon;
const midpoint = (a: Pos, b: Pos): Pos => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

test("buildingAt returns the part containing the point", () => {
  const far = polygon([[[6, 52], [6.001, 52], [6.001, 52.001], [6, 52.001], [6, 52]]]).geometry;
  const multi = { type: "MultiPolygon" as const, coordinates: [far.coordinates, building.coordinates] };
  expect(buildingAt(multi, midpoint(p0, p2))).toEqual(building);
  expect(buildingAt(multi, [5.5, 52.5])).toBeUndefined();
  expect(buildingAt(building, midpoint(p0, p2))).toEqual(building);
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
