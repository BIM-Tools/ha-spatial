// Checks the plan-space geometry against rectangles built with turf in metres, independent of the code under test.

import bearing from "@turf/bearing";
import area from "@turf/area";
import booleanClockwise from "@turf/boolean-clockwise";
import destination from "@turf/destination";
import distance from "@turf/distance";
import { point, polygon } from "@turf/helpers";
import type { Polygon, Position } from "geojson";
import { expect, test } from "vitest";
import {
  MIN_SIDE_M,
  addToFootprint,
  areaLabel,
  boxFromCorners,
  centreOf,
  edgeLengths,
  isAxisRectangle,
  movePolygon,
  resizeSide,
  sideLabels,
} from "../src/plan";

type Corners = [Position, Position, Position, Position];

const ORIGIN: Position = [5, 52];
const move = (from: Position, metres: number, bearingDeg: number): Position =>
  destination(from, metres, bearingDeg, { units: "meters" }).geometry.coordinates;

// Four corners of a counter-clockwise rectangle: `along` metres on bearing `axis`, then `across` metres on axis - 90.
const rectangle = (from: Position, along: number, across: number, axis: number): Corners => {
  const a = move(from, along, axis);
  return [from, a, move(a, across, axis - 90), move(from, across, axis - 90)];
};

const corners = rectangle(ORIGIN, 4, 3, 20);
const box = boxFromCorners(corners)!;
const bearingOf = (from: Position, to: Position) => (bearing(point(from), point(to)) + 360) % 360;
const ringOf = (shape: Polygon) => shape.coordinates[0];

test("boxFromCorners closes the corners into a counter-clockwise ring", () => {
  expect(MIN_SIDE_M).toBe(0.2);
  const ring = ringOf(box);
  expect(ring).toHaveLength(5);
  expect(ring[4]).toEqual(ring[0]);
  expect(booleanClockwise(ring)).toBe(false);
  expect(edgeLengths(box).map((m) => Math.round(m * 1000) / 1000)).toEqual([4, 3, 4, 3]);
});

test("boxFromCorners keeps the first corner and the edge bearings", () => {
  const ring = ringOf(box);
  expect(ring[0]).toEqual(corners[0]);
  [20, 290, 200, 110].forEach((expected, index) => {
    const delta = Math.abs(((bearingOf(ring[index], ring[index + 1]) - expected + 540) % 360) - 180);
    expect(delta).toBeLessThan(0.1);
  });
});

test("boxFromCorners rewinds a clockwise input", () => {
  const clockwise = [corners[0], corners[3], corners[2], corners[1]] as Corners;
  expect(booleanClockwise([...clockwise, clockwise[0]])).toBe(true);
  expect(booleanClockwise(ringOf(boxFromCorners(clockwise)!))).toBe(false);
});

test("boxFromCorners refuses a side shorter than the minimum", () => {
  expect(boxFromCorners(rectangle(ORIGIN, 4, 0.1, 20))).toBeUndefined();
  expect(boxFromCorners(rectangle(ORIGIN, 0.1, 4, 20))).toBeUndefined();
});

test("sideLabels and areaLabel show metres and square metres", () => {
  const labels = sideLabels(box);
  expect(labels.map((label) => label.text)).toEqual(["4.00 m", "3.00 m", "4.00 m", "3.00 m"]);
  expect(labels.map((label) => label.edgeIndex)).toEqual([0, 1, 2, 3]);
  const ring = ringOf(box);
  const middle = move(ring[0], 2, 20);
  expect(distance(point(labels[0].at), point(middle), { units: "meters" })).toBeLessThan(0.01);
  expect(areaLabel(box)).toBe("12.0 m²");
});

test("isAxisRectangle accepts the axis and its perpendicular only", () => {
  expect(isAxisRectangle(box, 20)).toBe(true);
  expect(isAxisRectangle(box, 30)).toBe(false);
  expect(isAxisRectangle(boxFromCorners(rectangle(ORIGIN, 4, 3, 30))!, 20)).toBe(false);
  const lShape = polygon([[
    ORIGIN, move(ORIGIN, 4, 20), move(move(ORIGIN, 4, 20), 1, 110),
    move(move(move(ORIGIN, 4, 20), 1, 110), 2, 20), move(move(ORIGIN, 2, 20), 3, 110), move(ORIGIN, 3, 110), ORIGIN,
  ]]).geometry;
  expect(isAxisRectangle(lShape, 20)).toBe(false);
});

test("resizeSide stretches an edge and its opposite and keeps the start vertex", () => {
  const resized = resizeSide(box, 0, 5);
  expect(edgeLengths(resized).map((m) => Math.round(m * 1000) / 1000)).toEqual([5, 3, 5, 3]);
  expect(distance(point(ringOf(resized)[0]), point(ringOf(box)[0]), { units: "meters" })).toBeLessThan(0.001);
  const second = resizeSide(box, 1, 2);
  expect(edgeLengths(second).map((m) => Math.round(m * 1000) / 1000)).toEqual([4, 2, 4, 2]);
});

test("addToFootprint unions touching boxes into one Polygon", () => {
  const neighbour = boxFromCorners(rectangle(corners[3], 4, 3, 20))!;
  const union = addToFootprint(box, neighbour)!;
  expect(union.type).toBe("Polygon");
  expect(Math.abs(area(union) - 24) / 24).toBeLessThan(0.005);
});

test("addToFootprint refuses a box that does not touch the footprint", () => {
  const apart = boxFromCorners(rectangle(move(corners[3], 1, 290), 4, 3, 20))!;
  expect(addToFootprint(box, apart)).toBeUndefined();
});

test("addToFootprint returns the box when there is no footprint", () => {
  expect(addToFootprint(undefined, box)).toEqual(box);
});

test("centreOf is the middle of a box", () => {
  const box: Polygon = { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
  expect(centreOf(box)).toEqual([1, 1]);
});

test("isAxisRectangle refuses a rectangle with a hole", () => {
  const hole = rectangle(move(move(ORIGIN, 1, 20), 1, -70), 1, 1, 20);
  const holed: Polygon = { type: "Polygon", coordinates: [ringOf(box), [...hole, hole[0]].reverse()] };
  expect(isAxisRectangle(holed, 20)).toBe(false);
});

test("movePolygon moves every corner 2 m east and keeps the side lengths", () => {
  const box4By3 = boxFromCorners(rectangle(ORIGIN, 4, 3, 0))!;
  const moved = movePolygon(box4By3, ORIGIN, move(ORIGIN, 2, 90));
  ringOf(moved).forEach((corner, index) => {
    expect(distance(point(corner), point(move(ringOf(box4By3)[index], 2, 90)), { units: "meters" })).toBeLessThan(0.01);
  });
  edgeLengths(moved).forEach((length, index) => expect(length).toBeCloseTo(edgeLengths(box4By3)[index], 2));
});
