// @vitest-environment happy-dom
// Checks what a room's label shows at each size on screen, against the fake MapLibre.
import type { Feature, Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import { fakeMapLibre, liveMarkers, resetFakes, unprojectPixel } from "./panel-harness";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { RoomLabels, labelSpace, labelStep } from "../src/room-labels";

afterEach(resetFakes);

// A room as a box in screen pixels, from the top-left to the bottom-right corner.
const pixelRoom = (areaId: string, [x1, y1]: [number, number], [x2, y2]: [number, number], areaM2 = 12.34): Feature<Polygon> => ({
  type: "Feature",
  id: areaId,
  geometry: {
    type: "Polygon",
    coordinates: [[unprojectPixel([x1, y1]), unprojectPixel([x2, y1]), unprojectPixel([x2, y2]), unprojectPixel([x1, y2]), unprojectPixel([x1, y1])]],
  },
  properties: { area_id: areaId, area_m2: areaM2 },
});

const mountLabels = (rooms: Feature<Polygon>[], withSize = true, areas = {}, outline?: Polygon) => {
  const labels = new RoomLabels(new fakeMapLibre.Map({}) as never, withSize);
  labels.show(rooms, outline, areas);
  return labels;
};

const labelOf = (areaId: string) =>
  liveMarkers()
    .map((marker) => marker.element)
    .find((element) => element.classList.contains("room-label") && element.dataset.area === areaId);

const shown = (areaId: string) => {
  const element = labelOf(areaId);
  return element && {
    icon: element.querySelector("ha-icon")?.getAttribute("icon"),
    name: element.querySelector(".name")?.textContent,
    size: element.querySelector(".size")?.textContent,
    chip: element.querySelector(".chip")?.textContent,
  };
};

const AREAS = {
  living: { name: "Living room", icon: "mdi:sofa" },
  hall: { name: "Hall", icon: "mdi:door" },
  wc: { name: "WC", icon: "mdi:toilet" },
  shaft: { name: "Shaft", icon: "mdi:pipe" },
};

test("a room shows icon, name and m², then icon and name, then the icon, then nothing as it gets smaller", () => {
  mountLabels(
    [
      pixelRoom("living", [0, 0], [200, 120]),
      pixelRoom("hall", [300, 0], [380, 50]),
      pixelRoom("wc", [400, 0], [430, 30]),
      pixelRoom("shaft", [500, 0], [515, 15]),
    ],
    true,
    AREAS,
  );
  expect(shown("living")).toEqual({ icon: "mdi:sofa", name: "Living room", size: "12.3 m²", chip: undefined });
  expect(shown("hall")).toEqual({ icon: "mdi:door", name: "Hall", size: undefined, chip: undefined });
  expect(shown("wc")).toEqual({ icon: "mdi:toilet", name: undefined, size: undefined, chip: undefined });
  expect(shown("shaft")).toBeUndefined();
});

test("an area without an icon shows Home Assistant's home icon", () => {
  mountLabels([pixelRoom("living", [0, 0], [200, 120])], true, { living: { name: "Living room", icon: null } });
  expect(shown("living")?.icon).toBe("mdi:home-outline");
});

test("the card's labels have no m²", () => {
  mountLabels([pixelRoom("living", [0, 0], [200, 120])], false, AREAS);
  expect(shown("living")).toEqual({ icon: "mdi:sofa", name: "Living room", size: undefined, chip: undefined });
});

test("an icon-only room names itself in a chip while pointed at", () => {
  const labels = mountLabels([pixelRoom("wc", [400, 0], [430, 30])], true, AREAS);
  expect(labelOf("wc")?.getAttribute("aria-label")).toBe("WC");
  labels.point("wc");
  expect(shown("wc")?.chip).toBe("WC");
  labels.point(undefined);
  expect(shown("wc")?.chip).toBeUndefined();
});

test("the outline is labelled Building only while the floor has no rooms", () => {
  const outline = pixelRoom("building", [0, 0], [400, 300]).geometry;
  const labels = mountLabels([], true, AREAS, outline);
  const buildingLabels = () => liveMarkers().filter((marker) => marker.element.classList.contains("building-label"));
  expect(buildingLabels().map((marker) => marker.element.textContent)).toEqual(["Building"]);
  labels.show([pixelRoom("living", [0, 0], [200, 120])], outline, AREAS);
  expect(buildingLabels()).toEqual([]);
});

test("an L-shaped room's label sits in its widest part, not on its centroid", () => {
  // A wide bar along the top and a narrow leg down the left; the centroid falls outside both.
  const rings: [number, number][][] = [
    [
      [0, 0],
      [300, 0],
      [300, 80],
      [40, 80],
      [40, 300],
      [0, 300],
      [0, 0],
    ],
  ];
  const { at, width } = labelSpace(rings);
  expect(at[1]).toBeCloseTo(40, -1);
  expect(width).toBeGreaterThanOrEqual(78);
  expect(labelStep(rings, at, true)).toBe("size");
});

test("a room turned on screen gets only the step whose space fits inside it", () => {
  // A 100 px square turned 45 degrees: its full width and height at the centre, but not its corners.
  const diamond: [number, number][][] = [
    [
      [0, 50],
      [50, 0],
      [100, 50],
      [50, 100],
      [0, 50],
    ],
  ];
  expect(labelStep(diamond, [50, 50], true)).toBe("icon");
});

test("a label is named with its m² for screen readers", () => {
  mountLabels([pixelRoom("living", [0, 0], [200, 120])], true, AREAS);
  expect(labelOf("living")?.getAttribute("aria-label")).toBe("Living room, 12.3 m²");
});
