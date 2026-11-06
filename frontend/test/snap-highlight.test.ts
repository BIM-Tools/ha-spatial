// @vitest-environment happy-dom
// Checks which stretches of wall and which corners a snap lights up, and how the highlight puts them on the map.

import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, expect, test } from "vitest";
import { layerColours, readMapPaint } from "../src/map-paint";
import { PlanFrame } from "../src/site-frame";
import { SnapHighlight, type SnapMarks, snapMarks } from "../src/snap-highlight";
import type { SnapSource } from "../src/snap";
import { EMPTY, SITE, fakeMapLibre, layers, resetFakes, sources } from "./panel-harness";
import { siteFrameData } from "./site-frame-fixture";

const FRAME = PlanFrame.fromSite(siteFrameData(SITE, 30));

afterEach(resetFakes);

const LEFT: SnapSource = { kind: "edge", edge: [[0, 0], [0, 400]] };
const TOP: SnapSource = { kind: "edge", edge: [[0, 400], [400, 400]] };
const SQUARE = [[[0, 0], [0, 400], [400, 400], [400, 0]] as const];

test.each([
  ["a wall lights around the point on it", [LEFT], [[0, 200]], [0, 200], [], { walls: [[[0, 150], [0, 250]]], dots: [] }],
  ["the stretch stops at the wall's end", [LEFT], [[0, 20]], [0, 20], [], { walls: [[[0, 0], [0, 70]]], dots: [] }],
  [
    "two walls meeting at the point light both stretches and a dot",
    [LEFT, TOP],
    [[0, 400]],
    [0, 400],
    [],
    { walls: [[[0, 350], [0, 400]], [[0, 400], [50, 400]]], dots: [[0, 400]] },
  ],
  ["a point beside the wall lights where it projects", [LEFT], [[10, 100]], [10, 100], [], { walls: [[[0, 50], [0, 150]]], dots: [] }],
  ["of points on the wall the one nearest the pointer", [LEFT], [[0, 100], [0, 300]], [0, 280], [], { walls: [[[0, 250], [0, 350]]], dots: [] }],
  ["the point nearest the wall wins over the pointer", [LEFT], [[20, 100], [0, 300]], [20, 100], [], { walls: [[[0, 250], [0, 350]]], dots: [] }],
  [
    "a diagonal outline wall lights along itself",
    [{ kind: "edge", edge: [[0, 0], [300, 400]] }],
    [[150, 200]],
    [150, 200],
    [],
    { walls: [[[120, 160], [180, 240]]], dots: [] },
  ],
  ["a corner lights as a dot", [{ kind: "corner", at: [40, 8] }], [[40, 8]], [40, 8], [], { walls: [], dots: [[40, 8]] }],
  [
    "the active shape's own walls and corners stay dark, either way round",
    [{ kind: "edge", edge: [[0, 400], [0, 0]] }, { kind: "corner", at: [400, 0] }],
    [[0, 200]],
    [0, 200],
    SQUARE,
    { walls: [], dots: [] },
  ],
] as [string, SnapSource[], [number, number][], [number, number], [number, number][][], SnapMarks][])(
  "%s",
  (_name, snapped, points, pointer, own, marks) => {
    expect(snapMarks(snapped, points, pointer, 50, own)).toEqual(marks);
  },
);

const mount = () => {
  const highlight = new SnapHighlight(new fakeMapLibre.Map({}) as unknown as MapLibreMap);
  highlight.addLayers(layerColours(readMapPaint(document.body, false)));
  return highlight;
};
const geometries = () =>
  (sources["spatial-snap"].data as { features: { geometry: { type: string; coordinates: unknown } }[] }).features.map(
    (feature) => feature.geometry,
  );

test("walls show as lines under the dots, 4 px with round caps, a dot of radius 6 with a 2 px ring", () => {
  const highlight = mount();
  highlight.show(FRAME, { walls: [[[0, 350], [0, 400]]], dots: [[0, 400]] });
  expect(geometries()).toEqual([
    { type: "LineString", coordinates: [FRAME.fromLattice([0, 350]), FRAME.fromLattice([0, 400])] },
    { type: "Point", coordinates: FRAME.fromLattice([0, 400]) },
  ]);
  expect(layers.find((layer) => layer.id === "spatial-snap-line")).toMatchObject({
    type: "line",
    layout: { "line-cap": "round" },
    paint: { "line-width": 4 },
  });
  expect(layers.find((layer) => layer.id === "spatial-snap-point")).toMatchObject({
    type: "circle",
    paint: { "circle-radius": 6, "circle-stroke-width": 2 },
  });
});

test("no marks and clear empty the highlight", () => {
  const highlight = mount();
  highlight.show(FRAME, { walls: [], dots: [[40, 8]] });
  highlight.show(FRAME, { walls: [], dots: [] });
  expect(sources["spatial-snap"].data).toEqual(EMPTY);
  highlight.show(FRAME, { walls: [], dots: [[40, 8]] });
  highlight.clear();
  expect(sources["spatial-snap"].data).toEqual(EMPTY);
});
