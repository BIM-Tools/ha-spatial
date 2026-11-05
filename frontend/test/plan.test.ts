// Checks the plan geometry on lattice cases, in a metric and a US customary site frame.

import area from "@turf/area";
import booleanClockwise from "@turf/boolean-clockwise";
import type { Polygon } from "geojson";
import { expect, test } from "vitest";
import type { HassUnits } from "../src/units";
import {
  addToFootprint,
  areaLabel,
  boxChange,
  boxFromCorners,
  centreOf,
  edgeLengths,
  isAxisRectangle,
  movePolygon,
  resizeChange,
  resizeSide,
  sideLabels,
} from "../src/plan";
import { type LatticePoint, PlanFrame } from "../src/site-frame";
import { US_UNIT_M, siteFrameData } from "./site-frame-fixture";
import { METRIC_UNITS, US_UNITS } from "./units-fixture";

const METRIC = PlanFrame.fromSite(siteFrameData([5, 52], 20));
const INCHES = PlanFrame.fromSite(siteFrameData([5, 52], 20, US_UNIT_M));

const box = boxFromCorners(METRIC, [0, 0], [160, 120])!;
const latticeOf = (frame: PlanFrame, shape: Polygon) => shape.coordinates.map((ring) => ring.map((p) => frame.toLattice(p)));
const shapeOf = (frame: PlanFrame, ...rings: LatticePoint[][]): Polygon => ({
  type: "Polygon",
  coordinates: rings.map((ring) => [...ring, ring[0]].map((corner) => frame.fromLattice(corner))),
});
const rounded = (lengths: number[]) => lengths.map((m) => Math.round(m * 1e6) / 1e6);

test("boxFromCorners makes a counter-clockwise axis box", () => {
  const ring = box.coordinates[0];
  expect(ring).toHaveLength(5);
  expect(ring[4]).toEqual(ring[0]);
  expect(booleanClockwise(ring)).toBe(false);
  expect(rounded(edgeLengths(METRIC, box))).toEqual([4, 3, 4, 3]);
  expect(latticeOf(METRIC, boxFromCorners(METRIC, [160, 120], [0, 0])!)).toEqual(latticeOf(METRIC, box));
});

test("boxFromCorners is undefined under one grid step", () => {
  expect(boxFromCorners(METRIC, [0, 0], [0, 100])).toBeUndefined();
  expect(boxFromCorners(METRIC, [0, 0], [3, 100])).toBeUndefined();
  expect(boxFromCorners(METRIC, [0, 0], [100, 3])).toBeUndefined();
  expect(boxFromCorners(METRIC, [0, 0], [4, 100])).toBeDefined();
});

test("sideLabels and areaLabel show metres and square metres, at the middle of each side", () => {
  const labels = sideLabels(METRIC, box, METRIC_UNITS);
  expect(labels.map((label) => label.text)).toEqual(["4.00 m", "3.00 m", "4.00 m", "3.00 m"]);
  expect(labels.map((label) => label.edgeIndex)).toEqual([0, 1, 2, 3]);
  const middle = METRIC.toLatticeUnits(labels[0].at);
  expect(middle[0]).toBeCloseTo(80, 6);
  expect(middle[1]).toBeCloseTo(0, 6);
  expect(areaLabel(METRIC, box, METRIC_UNITS)).toBe("12.0 m²");
});

test("sideLabels and areaLabel show feet and inches and square feet in US customary units", () => {
  const inchBox = boxFromCorners(INCHES, [0, 0], [157, 118])!;
  expect(sideLabels(INCHES, inchBox, US_UNITS).map((label) => label.text)).toEqual(["13′ 1″", "9′ 10″", "13′ 1″", "9′ 10″"]);
  expect(areaLabel(INCHES, inchBox, US_UNITS)).toBe("129 ft²");
});

test("areaLabel takes holes out", () => {
  const holed = shapeOf(METRIC, [[0, 0], [160, 0], [160, 120], [0, 120]], [[40, 40], [40, 80], [80, 80], [80, 40]]);
  expect(areaLabel(METRIC, holed, METRIC_UNITS)).toBe("11.0 m²");
});

test("isAxisRectangle is false for an L-shape, a holed box and a box built from turned lattice points", () => {
  expect(isAxisRectangle(METRIC, box)).toBe(true);
  expect(isAxisRectangle(METRIC, shapeOf(METRIC, [[0, 0], [160, 0], [160, 40], [80, 40], [80, 120], [0, 120]]))).toBe(false);
  expect(
    isAxisRectangle(METRIC, shapeOf(METRIC, [[0, 0], [160, 0], [160, 120], [0, 120]], [[40, 40], [40, 80], [80, 80], [80, 40]])),
  ).toBe(false);
  expect(isAxisRectangle(METRIC, shapeOf(METRIC, [[0, 0], [120, 90], [30, 210], [-90, 120]]))).toBe(false);
});

test("resizeSide rounds the length to whole lattice units and keeps the start corner", () => {
  const resized = resizeSide(METRIC, box, 0, 3.47)!;
  expect(latticeOf(METRIC, resized)[0]).toEqual([[0, 0], [139, 0], [139, 120], [0, 120], [0, 0]]);
  const second = resizeSide(METRIC, box, 1, 2)!;
  expect(latticeOf(METRIC, second)[0]).toEqual([[0, 0], [160, 0], [160, 80], [0, 80], [0, 0]]);
  const fromTheFar = resizeSide(METRIC, box, 2, 2)!;
  expect(latticeOf(METRIC, fromTheFar)[0]).toEqual([[80, 0], [160, 0], [160, 120], [80, 120], [80, 0]]);
});

test("resizeSide is undefined under one grid step", () => {
  expect(resizeSide(METRIC, box, 0, 0.05)).toBeUndefined();
});

test("movePolygon moves every corner by a lattice delta", () => {
  expect(latticeOf(METRIC, movePolygon(METRIC, box, [8, -4]))[0]).toEqual([
    [8, -4],
    [168, -4],
    [168, 116],
    [8, 116],
    [8, -4],
  ]);
});

test("centreOf is the middle of the box on the plan", () => {
  const [x, y] = METRIC.toLatticeUnits(centreOf(METRIC, box));
  expect(x).toBeCloseTo(80, 6);
  expect(y).toBeCloseTo(60, 6);
});

test("addToFootprint unions touching boxes into one Polygon", () => {
  const neighbour = boxFromCorners(METRIC, [0, 120], [160, 240])!;
  const joined = addToFootprint(METRIC, box, neighbour)!;
  expect(joined.type).toBe("Polygon");
  expect(Math.abs(area(joined) - 24) / 24).toBeLessThan(0.005);
});

test("addToFootprint refuses a box that does not touch the footprint", () => {
  expect(addToFootprint(METRIC, box, boxFromCorners(METRIC, [0, 160], [160, 280])!)).toBeUndefined();
});

test("addToFootprint returns the box when there is no footprint", () => {
  expect(addToFootprint(METRIC, undefined, box)).toEqual(box);
});

test("addToFootprint joins boxes that share part of an edge, in any frame, on whole lattice units", () => {
  for (const bearing of [0, 10, 30, 45, 61, 77, 89]) {
    const frame = PlanFrame.fromSite(siteFrameData([5, 52], bearing));
    const room = boxFromCorners(frame, [0, 0], [160, 120])!;
    for (let y = 4; y < 100; y += 4) {
      const joined = addToFootprint(frame, room, boxFromCorners(frame, [160, y], [280, y + 12])!);
      expect(joined, `bearing ${bearing}, y ${y}`).toBeDefined();
      for (const corner of joined!.coordinates[0]) {
        for (const units of frame.toLatticeUnits(corner)) expect(Math.abs(units - Math.round(units))).toBeLessThan(1e-6);
      }
    }
  }
});

test.each<[string, Polygon | undefined, Polygon, Polygon | null | undefined]>([
  ["a first box starts the footprint", undefined, box, null],
  ["a touching box joins it", box, boxFromCorners(METRIC, [0, 120], [160, 240])!, box],
])("boxChange: %s, as one area's change", (_name, current, drawn, before) => {
  const result = boxChange(METRIC, "kitchen", current, drawn);
  expect(result).toEqual({ change: { before: { kitchen: before }, after: { kitchen: addToFootprint(METRIC, current, drawn) } } });
});

test("boxChange refuses a box apart from the footprint and says why", () => {
  expect(boxChange(METRIC, "kitchen", box, boxFromCorners(METRIC, [0, 160], [160, 280])!)).toEqual({
    refusal: "A room is one shape: draw against it",
  });
});

test("resizeChange saves the resized rectangle as one area's change", () => {
  expect(resizeChange(METRIC, "kitchen", box, 0, 5, METRIC_UNITS)).toEqual({
    change: { before: { kitchen: box }, after: { kitchen: resizeSide(METRIC, box, 0, 5) } },
  });
});

test.each<[string, PlanFrame, number | undefined, HassUnits, string]>([
  ["a side under a grid step", METRIC, 0.05, METRIC_UNITS, "10 cm"],
  ["an unreadable length", METRIC, undefined, METRIC_UNITS, "10 cm"],
  ["a side under a grid step in US customary units", INCHES, 3 * 0.0254, US_UNITS, "4 in"],
])("resizeChange refuses %s and names the grid step", (_name, frame, lengthM, units, step) => {
  const rectangle = boxFromCorners(frame, [0, 0], [160, 120])!;
  expect(resizeChange(frame, "kitchen", rectangle, 0, lengthM, units)).toEqual({
    refusal: `Too small: every side needs at least ${step}`,
  });
});