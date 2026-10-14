import area from "@turf/area";
import booleanClockwise from "@turf/boolean-clockwise";
import destination from "@turf/destination";
import distance from "@turf/distance";
import { lineString, point, polygon } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import transformRotate from "@turf/transform-rotate";
import type { Polygon } from "geojson";
import { expect, test } from "vitest";
import { OUTLINE_OFFSET_M, alignOutline, buildingAt, outlineBearing } from "../src/outline";

const ROTATION = 20;
type Pos = [number, number];

// 10 m x 8 m rectangle at 52 N, built with turf in metres and rotated 20 degrees clockwise
// around its south-west corner. Its south wall runs at bearing 110.
const sw: Pos = [5, 52];
const se = destination(sw, 10, 90, { units: "meters" }).geometry.coordinates as Pos;
const ne = destination(se, 8, 0, { units: "meters" }).geometry.coordinates as Pos;
const nw = destination(sw, 8, 0, { units: "meters" }).geometry.coordinates as Pos;
const unrotated = polygon([[sw, se, ne, nw, sw]]);
const building = transformRotate(unrotated, ROTATION, { pivot: sw }).geometry as Polygon;
const ring = building.coordinates[0] as Pos[];
const mid = (a: Pos, b: Pos): Pos => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

test("buildingAt returns the part containing the point", () => {
  const far = polygon([[[6, 52], [6.001, 52], [6.001, 52.001], [6, 52.001], [6, 52]]]).geometry;
  const multi = { type: "MultiPolygon" as const, coordinates: [far.coordinates, building.coordinates] };
  expect(buildingAt(multi, mid(ring[0], ring[2]))).toEqual(building);
  expect(buildingAt(multi, [5.5, 52.5])).toBeUndefined();
  expect(buildingAt(building, mid(ring[0], ring[2]))).toEqual(building);
});

test("alignOutline insets, rewinds and starts at the clicked wall", () => {
  const { outline, bearingDeg } = alignOutline(building, mid(ring[0], ring[1]));
  const out = outline.coordinates[0] as Pos[];
  expect(OUTLINE_OFFSET_M).toBe(0.25);
  expect(booleanClockwise(out)).toBe(false);
  expect(out[0]).toEqual(out[out.length - 1]);
  // The first edge lies on the south wall shifted 0.25 m inward (to its left).
  const shifted = lineString([
    destination(ring[0], 0.25, ROTATION, { units: "meters" }).geometry.coordinates,
    destination(ring[1], 0.25, ROTATION, { units: "meters" }).geometry.coordinates,
  ]);
  for (const vertex of out.slice(0, 2)) {
    const near = nearestPointOnLine(shifted, point(vertex), { units: "meters" });
    expect(distance(point(vertex), near, { units: "meters" })).toBeLessThan(0.05);
  }
  // The area loses the offset band: perimeter 36 m * 0.25 m - 4 * 0.25^2.
  const expected = area(unrotated) - (36 * 0.25 - 4 * 0.25 * 0.25);
  expect(Math.abs(area(polygon([out])) - expected) / expected).toBeLessThan(0.02);
  expect(Math.abs(bearingDeg - (90 + ROTATION))).toBeLessThan(0.5);
  expect(outlineBearing(outline)).toBeCloseTo(bearingDeg, 6);
});

test("alignOutline on the east wall turns the bearing 90 degrees left, as the ring runs counter-clockwise", () => {
  const south = alignOutline(building, mid(ring[0], ring[1]));
  const east = alignOutline(building, mid(ring[1], ring[2]));
  expect(Math.abs(east.bearingDeg - (south.bearingDeg - 90))).toBeLessThan(0.5);
  expect(outlineBearing(east.outline)).toBeCloseTo(east.bearingDeg, 6);
});
