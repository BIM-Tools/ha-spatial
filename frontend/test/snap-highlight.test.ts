// @vitest-environment happy-dom
// Checks what the snap highlight puts on the map for each kind of snap source.

import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, expect, test } from "vitest";
import { layerColours, readMapPaint } from "../src/map-paint";
import { PlanFrame } from "../src/site-frame";
import { SnapHighlight } from "../src/snap-highlight";
import { EMPTY, SITE, fakeMapLibre, layers, resetFakes, sources } from "./panel-harness";
import { siteFrameData } from "./site-frame-fixture";

const FRAME = PlanFrame.fromSite(siteFrameData(SITE, 30));

afterEach(resetFakes);

const mount = () => {
  const highlight = new SnapHighlight(new fakeMapLibre.Map({}) as unknown as MapLibreMap);
  highlight.addLayers(layerColours(readMapPaint(document.body, false)));
  return highlight;
};
const geometries = () =>
  (sources["spatial-snap"].data as { features: { geometry: { type: string; coordinates: unknown } }[] }).features.map(
    (feature) => feature.geometry,
  );

test("a corner shows one point and an edge one line, 4 px with round caps, dot radius 6", () => {
  const highlight = mount();
  highlight.show(FRAME, { kind: "corner", at: [40, 8] });
  expect(geometries()).toEqual([{ type: "Point", coordinates: FRAME.fromLattice([40, 8]) }]);
  highlight.show(FRAME, {
    kind: "edge",
    edge: [
      [0, 0],
      [0, 40],
    ],
  });
  expect(geometries()).toEqual([{ type: "LineString", coordinates: [FRAME.fromLattice([0, 0]), FRAME.fromLattice([0, 40])] }]);
  expect(layers.find((layer) => layer.id === "spatial-snap-line")).toMatchObject({
    type: "line",
    layout: { "line-cap": "round" },
    paint: { "line-width": 4 },
  });
  expect(layers.find((layer) => layer.id === "spatial-snap-point")).toMatchObject({ type: "circle", paint: { "circle-radius": 6 } });
});

test("the grid and the lattice light up nothing, and clear empties the highlight", () => {
  const highlight = mount();
  highlight.show(FRAME, { kind: "corner", at: [40, 8] });
  highlight.show(FRAME, { kind: "grid" });
  expect(sources["spatial-snap"].data).toEqual(EMPTY);
  highlight.show(FRAME, { kind: "corner", at: [40, 8] });
  highlight.show(FRAME, { kind: "lattice" });
  expect(sources["spatial-snap"].data).toEqual(EMPTY);
  highlight.show(FRAME, { kind: "corner", at: [40, 8] });
  highlight.clear();
  expect(sources["spatial-snap"].data).toEqual(EMPTY);
});
