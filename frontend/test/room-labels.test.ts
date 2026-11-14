// @vitest-environment happy-dom
// Checks what a room's label shows at each size on screen, against the fake MapLibre.
import type { Feature, Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import { fakeMapLibre, liveMarkers, resetFakes, unprojectPixel } from "./panel-harness";
import { METRIC_UNITS, US_UNITS } from "./units-fixture";

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

const mountLabels = (rooms: Feature<Polygon>[], withSize = true, areas = {}, outline?: Polygon, units = METRIC_UNITS) => {
  const labels = new RoomLabels(new fakeMapLibre.Map({}) as never, withSize, () => units, () => "Building");
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

test("in US customary units a room's size is in whole square feet", () => {
  mountLabels([pixelRoom("living", [0, 0], [200, 120])], true, AREAS, undefined, US_UNITS);
  expect(shown("living")?.size).toBe("133 ft²");
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

test("a hidden room has no label until it is shown again, and the others keep theirs", () => {
  const labels = mountLabels([pixelRoom("living", [0, 0], [200, 120]), pixelRoom("hall", [300, 0], [380, 50])], true, AREAS);
  labels.hide(["living"]);
  expect(shown("living")).toBeUndefined();
  expect(shown("hall")?.name).toBe("Hall");
  labels.hide([]);
  expect(shown("living")?.name).toBe("Living room");
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

test("a second-line text replaces the m², is marked live, and goes before the name when the room is small", () => {
  const labels = new RoomLabels(new fakeMapLibre.Map({}) as never, false, () => METRIC_UNITS, () => "Building");
  labels.show(
    [pixelRoom("living", [0, 0], [200, 120]), pixelRoom("hall", [300, 0], [380, 50])],
    undefined,
    AREAS,
    { living: "80 %", hall: "21.5°" },
  );
  expect(shown("living")).toMatchObject({ name: "Living room", size: "80 %" });
  expect(shown("hall")).toMatchObject({ name: "Hall", size: undefined });
  expect(labelOf("living")?.querySelector(".size")?.classList.contains("live")).toBe(true);
});

// A tiny room pointed at, tapped or active names itself in a chip that the one placement rule puts above it.
const chipOf = (areaId: string) => labelOf(areaId)?.querySelector<HTMLElement>(".chip");

test.each([
  ["pointed at", (labels: RoomLabels) => labels.point("shaft"), true],
  ["tapped", (labels: RoomLabels) => labels.tap("shaft"), true],
  ["not pointed", () => undefined, false],
])("a room too small for any label: %s", (_case, act, chip) => {
  const labels = mountLabels([pixelRoom("shaft", [500, 100], [515, 115])], true, AREAS);
  act(labels);
  expect(chipOf("shaft")?.textContent).toBe(chip ? "Shaft" : undefined);
  if (chip) {
    expect(labelOf("shaft")?.querySelector("ha-icon")).toBeNull();
    // Above the room's box: the chip's centre is higher than the box's centre.
    expect(Number(chipOf("shaft")?.style.getPropertyValue("--chip-y").replace("px", ""))).toBeLessThan(0);
  }
});

test("a pointed room that is not small and shows only its icon gets its chip from the same rule, above its box", () => {
  const labels = mountLabels([pixelRoom("wc", [400, 100], [465, 165])], true, AREAS);
  expect(chipOf("wc")).toBeFalsy();
  labels.point("wc");
  expect(chipOf("wc")?.textContent).toBe("WC");
  expect(Number(chipOf("wc")?.style.getPropertyValue("--chip-y").replace("px", ""))).toBeLessThan(-32);
});

test("a tap shows the chip for 2 s", () => {
  vi.useFakeTimers();
  try {
    const labels = mountLabels([pixelRoom("shaft", [500, 100], [515, 115])], true, AREAS);
    labels.tap("shaft");
    vi.advanceTimersByTime(1999);
    expect(chipOf("shaft")).toBeTruthy();
    vi.advanceTimersByTime(2);
    expect(labelOf("shaft")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("an active small room shows its chip, a large one does not", () => {
  const labels = mountLabels([pixelRoom("hall", [300, 100], [380, 150]), pixelRoom("living", [0, 0], [200, 120])], true, AREAS);
  labels.activate("hall");
  expect(chipOf("hall")?.textContent).toBe("Hall");
  labels.activate("living");
  expect(chipOf("hall")).toBeFalsy();
  expect(chipOf("living")).toBeFalsy();
});

test("boxes leaves out the active room's own label", () => {
  const labels = mountLabels([pixelRoom("living", [0, 0], [200, 120]), pixelRoom("hall", [300, 0], [500, 120])], true, AREAS);
  expect(labels.boxes()).toHaveLength(2);
  labels.activate("hall");
  expect(labels.boxes()).toHaveLength(1);
  expect(labels.boxes()[0].centre.x).toBeLessThan(250);
});

test("boxes lists every shown label and chip in map pixels", () => {
  const labels = mountLabels([pixelRoom("living", [0, 0], [200, 120]), pixelRoom("shaft", [500, 100], [515, 115])], true, AREAS);
  expect(labels.boxes()).toHaveLength(1);
  expect(labels.boxes()[0].centre.y).toBeCloseTo(60);
  labels.point("shaft");
  const boxes = labels.boxes();
  expect(boxes).toHaveLength(2);
  expect(boxes[1].centre.x).toBeCloseTo(507.5);
  expect(boxes[1].centre.y).toBeLessThan(100);
});
