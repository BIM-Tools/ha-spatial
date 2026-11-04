// @vitest-environment happy-dom
// Checks drawing, adjusting and undoing rooms in the panel against a fake MapLibre and a scripted Home Assistant connection.
import area from "@turf/area";
import distance from "@turf/distance";
import type { Feature, Point, Polygon, Position } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  type Reply,
  answer,
  buttonNamed,
  dragPan,
  dragRotate,
  handlers,
  jumpTo,
  floorButtonNames,
  liveMarkers,
  layers,
  mapCanvas,
  mapCreated,
  guideText,
  partsText,
  toastMessages,
  toasts,
  mountPanel,
  onUpdateOf,
  panMap,
  queryRenderedFeatures,
  resetFakes,
  settle,
  SITE,
  siteReply,
  sources,
  touchZoomRotate,
  unprojectPixel,
} from "./panel-harness";
import { US_UNIT_M, siteFrameData } from "./site-frame-fixture";
import { METRIC_UNITS, US_UNITS } from "./units-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { edgeLengths, isAxisRectangle } from "../src/plan";
import { PlanFrame } from "../src/site-frame";
import "../src/spatial-panel";

afterEach(resetFakes);

// Site bearing 30 turns the map to bearing 300.
const SITE_BEARING = 30;
// Lattice x runs to the right on the screen and y up; a pixel is one grid step.
const FRAME_DATA = siteFrameData(SITE, SITE_BEARING);
const INCH_FRAME_DATA = siteFrameData(SITE, SITE_BEARING, US_UNIT_M);
const FRAME = PlanFrame.fromSite(FRAME_DATA);
const INCH_FRAME = PlanFrame.fromSite(INCH_FRAME_DATA);

const pixelBox = (x1: number, y1: number, x2: number, y2: number): Polygon => {
  const ring = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1],
  ].map((p) => unprojectPixel(p as [number, number], 300));
  return { type: "Polygon", coordinates: [ring] };
};

const KITCHEN = pixelBox(0, 0, 50, 50);
const OUTLINE = pixelBox(0, 100, 100, 200);

const mountEditor = (overrides: Reply = async () => undefined, outline: Polygon | null = OUTLINE, units = METRIC_UNITS) => {
  let registry = [
    { area_id: "kitchen", name: "Kitchen", floor_id: "ground" },
    { area_id: "bath", name: "Bath", floor_id: "ground" },
    { area_id: "hall", name: "Hall", floor_id: "ground" },
    { area_id: "attic", name: "Attic", floor_id: "loft" },
  ];
  let feed = [{ type: "Feature", id: "kitchen", geometry: KITCHEN, properties: { floor_id: "ground", level: 0 } }];
  const reply: Reply = async (message) => {
    const overridden = await overrides(message);
    if (overridden !== undefined) return overridden;
    switch (message.type) {
      case "spatial/site":
        return siteReply({ bearing_deg: SITE_BEARING, outline, frame: units === US_UNITS ? INCH_FRAME_DATA : FRAME_DATA });
      case "spatial/geojson":
        return { type: "FeatureCollection", features: feed };
      case "config/area_registry/list":
        return registry;
      case "config/floor_registry/list":
        return [
          { floor_id: "ground", name: "Ground floor", level: 0 },
          { floor_id: "loft", name: "Loft", level: 1 },
        ];
      case "config/area_registry/create": {
        const created = { area_id: "room_1", name: message.name as string, floor_id: message.floor_id as string };
        registry = [...registry, created];
        return created;
      }
      case "config/area_registry/update":
        return {};
      case "spatial/area/update_geometries":
        return { area_m2: {} };
    }
    return answer(message);
  };
  const mounted = mountPanel(reply, {}, false, undefined, units);
  const setRegistry = (next: typeof registry) => (registry = next);
  const setFeed = (next: typeof feed) => (feed = next);
  return { ...mounted, setRegistry, setFeed };
};

type Panel = HTMLElement & { updateComplete: Promise<boolean> };


const strip = (panel: HTMLElement) =>
  panel.shadowRoot?.querySelector("spatial-area-strip") as
    | (HTMLElement & { updateComplete: Promise<boolean> })
    | null;

const chips = (panel: HTMLElement) => [...(strip(panel)?.shadowRoot?.querySelectorAll<HTMLButtonElement>("button.pill") ?? [])];

// The markers the editor adds while drawing or adjusting, without the room labels.
const editorMarkers = () =>
  liveMarkers().filter((marker) => !marker.element.matches(".room-label, .building-label"));

const activeFilter = () => layers.find((layer) => layer.id === "spatial-active")?.filter;

const chipNames = (panel: HTMLElement) => chips(panel).map((chip) => chip.textContent?.trim());

const activeChip = (panel: HTMLElement) =>
  chips(panel)
    .find((chip) => chip.getAttribute("aria-pressed") === "true")
    ?.textContent?.trim();

const chip = (panel: HTMLElement, name: string) =>
  chips(panel).find((c) => c.textContent?.trim() === name)!;

const showFloor = async (panel: HTMLElement, floor = "Ground floor") => {
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await vi.waitFor(() => expect(buttonNamed(panel, floor)).toBeDefined());
  buttonNamed(panel, floor)!.click();
  await settle(panel);
};

const startDrawing = async (panel: HTMLElement, floor = "Ground floor") => {
  await showFloor(panel, floor);
  buttonNamed(panel, "Draw")!.click();
  await settle(panel);
};

const mouse = (x: number, y: number, altKey = false) => {
  const [lng, lat] = unprojectPixel([x, y]);
  return { point: { x, y }, lngLat: { lng, lat }, originalEvent: { button: 0, altKey }, preventDefault: vi.fn() };
};

const tap = (x: number, y: number) => {
  handlers.mousedown(mouse(x, y));
  handlers.mouseup(mouse(x, y));
  handlers.click(mouse(x, y));
};

const drag = (from: [number, number], to: [number, number]) => {
  handlers.mousedown(mouse(...from));
  handlers.mousemove(mouse(from[0] + 2, from[1] + 2));
  handlers.mousemove(mouse(...to));
  handlers.mouseup(mouse(...to));
};

const key = (type: "keydown" | "keyup", name: string) =>
  window.dispatchEvent(new KeyboardEvent(type, { key: name }));

type Sent = { mock: { calls: [{ type: string; [key: string]: unknown }][] } };

const sent = (connection: { sendMessagePromise: unknown }, type?: string) =>
  (connection.sendMessagePromise as Sent).mock.calls
    .map(([message]) => message)
    .filter((message) => !type || message.type === type);

const saves = (connection: { sendMessagePromise: unknown }) =>
  sent(connection, "spatial/area/update_geometries") as unknown as {
    areas: Record<string, Polygon>;
  }[];

test("the panel's floor buttons come from the floor registry, with No floor, and the toolbar has the tools", async () => {
  const { panel } = mountEditor();
  await vi.waitFor(() => expect(floorButtonNames(panel)).toEqual(["All", "Ground floor", "Loft", "No floor"]));
  for (const name of ["Align", "Draw", "Adjust", "Undo", "Redo"]) expect(buttonNamed(panel, name)).toBeDefined();
});

test("floors out of level order in the registry show in level order", async () => {
  const { panel } = mountEditor(async (message) =>
    message.type === "config/floor_registry/list"
      ? [
          { floor_id: "loft", name: "Loft", level: 1 },
          { floor_id: "ground", name: "Ground floor", level: 0 },
        ]
      : undefined,
  );
  await vi.waitFor(() => expect(floorButtonNames(panel)).toEqual(["All", "Ground floor", "Loft", "No floor"]));
});

test("the strip is shown in the panel and not in the card", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  expect(strip(panel)).not.toBeNull();
  const card = mountPanel(answer, {}, true).panel;
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(2));
  await (card as Panel).updateComplete;
  expect(strip(card)).toBeNull();
  for (const name of ["Draw", "Adjust", "Undo", "Redo"]) expect(buttonNamed(card, name)).toBeUndefined();
});

test("on a floor the first area without a footprint is active", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Kitchen", "Bath", "Hall", "New area"]));
  expect(activeChip(panel)).toBe("Bath");
});

test("a mouse drag draws a box with live side labels and saves it in one batch", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  handlers.mousedown(mouse(100, 0));
  handlers.mousemove(mouse(140, 30));
  const labels = liveMarkers().map((marker) => marker.element.textContent);
  expect(labels).toEqual(expect.arrayContaining(["4.00 m", "3.00 m", "12.0 m²"]));
  handlers.mouseup(mouse(140, 30));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(Object.keys(areas)).toEqual(["bath"]);
  expect(area(areas.bath)).toBeCloseTo(12, 1);
  expect(editorMarkers()).toEqual([]);
});

test("in Draw the map pans only while Space is held, and leaving Draw restores panning", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  expect(dragPan.isEnabled()).toBe(true);
  buttonNamed(panel, "Draw")!.click();
  expect(dragPan.isEnabled()).toBe(false);
  key("keydown", " ");
  expect(dragPan.isEnabled()).toBe(true);
  key("keyup", " ");
  expect(dragPan.isEnabled()).toBe(false);
  buttonNamed(panel, "Adjust")!.click();
  expect(dragPan.isEnabled()).toBe(true);
});

test("before any Align the map turns north up for Draw and boxes run north to south", async () => {
  const { panel, connection } = mountEditor(async (message) =>
    message.type === "spatial/site" ? siteReply({ bearing_deg: null, outline: OUTLINE }) : undefined,
  );
  await startDrawing(panel);
  expect(jumpTo).toHaveBeenLastCalledWith({ bearing: 0, pitch: 0 });
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(isAxisRectangle(PlanFrame.fromSite(siteFrameData(SITE, 0)), areas.bath)).toBe(true);
});

test("two taps save a box along the site axis and move on to the next area", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(isAxisRectangle(FRAME, areas.bath)).toBe(true);
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Hall"));
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "hall"]);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(false);
});

test("a box against an area's footprint saves their union", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  chip(panel, "Kitchen").click();
  await settle(panel);
  tap(50, 0);
  tap(100, 50);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(areas.kitchen.type).toBe("Polygon");
  expect(area(areas.kitchen)).toBeCloseTo(50, 1);
});

test("a box apart from the area's footprint saves nothing and says why", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  chip(panel, "Kitchen").click();
  await settle(panel);
  tap(200, 200);
  tap(240, 240);
  await vi.waitFor(() => expect(toasts).toEqual([{ message: "A room is one shape: draw against it" }]));
  expect(saves(connection)).toEqual([]);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("a box being drawn is marked apart while it cannot join the active footprint", async () => {
  const { panel } = mountEditor();
  await startDrawing(panel);
  chip(panel, "Kitchen").click();
  await settle(panel);
  const draftApart = () => (sources["spatial-draft"].data as Feature).properties?.apart;
  handlers.mousedown(mouse(200, 200));
  handlers.mousemove(mouse(240, 240));
  expect(draftApart()).toBe(true);
  // Clear of the snap radius of the corner at (50, 50), which would only touch.
  handlers.mousemove(mouse(40, 40));
  expect(draftApart()).toBe(false);
});

// Whole lattice units within 1e-6, and on the grid unless only the lattice is asked for.
const expectOnGrid = (frame: PlanFrame, shape: Polygon, step = frame.unitsPerStep) => {
  for (const corner of shape.coordinates[0]) {
    for (const units of frame.toLatticeUnits(corner)) expect(Math.abs(units / step - Math.round(units / step))).toBeLessThan(1e-6);
  }
};

test("a drawn box's corners land on the grid", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  drag([100.4, 0.3], [140.2, 29.6]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expectOnGrid(FRAME, areas.bath);
  expect(edgeLengths(FRAME, areas.bath).map((m) => Math.round(m * 1e6) / 1e6)).toEqual([4, 3, 4, 3]);
});

const draft = () => sources["spatial-draft"].data as Feature;

test.each([
  ["a drag on the grid narrower than half a step", false, 0.3],
  ["an Alt drag 3 lattice units wide", true, 0.75],
])("%s yields no box and no toast, and shows only the start dot while drawn", async (_name, altKey, widthPx) => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  const at = (x: number, y: number) => {
    const event = mouse(x, y);
    return { ...event, originalEvent: { ...event.originalEvent, altKey } };
  };
  handlers.mousedown(at(100, 0));
  handlers.mousemove(at(100 + widthPx, 30));
  expect(draft().geometry.type).toBe("Point");
  expect(FRAME.toLattice((draft().geometry as Point).coordinates)).toEqual([400, 0]);
  expect(layers.find((layer) => layer.id === "spatial-draft-point")).toMatchObject({ type: "circle", source: "spatial-draft" });
  expect(editorMarkers()).toEqual([]);
  handlers.mouseup(at(100 + widthPx, 30));
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(toasts).toEqual([]);
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
});

const expectCornersNear = (actual: Polygon, expected: Polygon) =>
  actual.coordinates[0].forEach((corner, index) =>
    expect(distance(corner, expected.coordinates[0][index], { units: "meters" })).toBeLessThan(0.01),
  );

const activateKitchen = async (panel: HTMLElement) => {
  chip(panel, "Kitchen").click();
  await settle(panel);
};

test("a drag that ends less than half a grid step from where it started saves nothing and records no undo step", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(40, 25));
  handlers.mousemove(mouse(25.2, 25.1));
  handlers.mouseup(mouse(25.2, 25.1));
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("a box joins in the frame its gesture started in, also when the frame changes before release", async () => {
  let inches = false;
  const { panel, connection } = mountEditor(async (message) =>
    inches && message.type === "spatial/site"
      ? siteReply({ bearing_deg: SITE_BEARING, outline: OUTLINE, frame: INCH_FRAME_DATA })
      : undefined,
  );
  await startDrawing(panel);
  await activateKitchen(panel);
  handlers.mousedown(mouse(100, 50));
  handlers.mousemove(mouse(90, 40));
  inches = true;
  await onUpdateOf(connection)();
  handlers.mousemove(mouse(50, 0));
  handlers.mouseup(mouse(50, 0));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expectOnGrid(FRAME, saves(connection)[0].areas.kitchen, 1);
  expect(toasts).toEqual([]);
});

test("a move shifts the room by whole grid steps", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  drag([25, 25], [45.3, 25.3]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const moved = saves(connection)[0].areas.kitchen;
  expectOnGrid(FRAME, moved, 1);
  moved.coordinates[0].forEach((corner, index) => {
    const [x, y] = FRAME.toLattice(corner);
    const [fromX, fromY] = FRAME.toLattice(KITCHEN.coordinates[0][index]);
    expect([x - fromX, y - fromY]).toEqual([80, 0]);
  });
});

const snapPoint = () => {
  const [feature] = (sources["spatial-snap"].data as { features: Feature<Point>[] }).features;
  return feature && FRAME.toLattice(feature.geometry.coordinates);
};

test("rooms on other floors are not candidates, rooms on this floor and the outline are", async () => {
  const { panel, setFeed } = mountEditor();
  setFeed([
    { type: "Feature", id: "kitchen", geometry: KITCHEN, properties: { floor_id: "ground", level: 0 } },
    { type: "Feature", id: "attic", geometry: pixelBox(200, 0, 250, 50), properties: { floor_id: "loft", level: 1 } },
  ]);
  await startDrawing(panel);
  handlers.mousemove(mouse(203, 2));
  expect(snapPoint()).toBeUndefined();
  handlers.mousemove(mouse(53, 2));
  expect(snapPoint()).toEqual(FRAME.toLattice(unprojectPixel([50, 0], 300)));
  handlers.mousemove(mouse(103, 102));
  expect(snapPoint()).toEqual(FRAME.toLattice(unprojectPixel([100, 100], 300)));
});

test("a moved room shares its neighbour's edge", async () => {
  const { panel, connection, setFeed } = mountEditor();
  const bath = pixelBox(60, 0, 100, 50);
  setFeed([
    { type: "Feature", id: "kitchen", geometry: KITCHEN, properties: { floor_id: "ground", level: 0 } },
    { type: "Feature", id: "bath", geometry: bath, properties: { floor_id: "ground", level: 0 } },
  ]);
  await startDrawing(panel);
  await activateKitchen(panel);
  drag([25, 25], [31.3, 26]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const moved = saves(connection)[0].areas.kitchen.coordinates[0].map((corner) => FRAME.toLattice(corner));
  const neighbour = bath.coordinates[0].map((corner) => FRAME.toLattice(corner));
  expect(moved[1]).toEqual(neighbour[0]);
  expect(moved[2]).toEqual(neighbour[3]);
});

test("in Draw a drag inside the active room moves it in one batch, and undo puts it back", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(45, 25));
  expectCornersNear((sources["spatial-draft"].data as Feature<Polygon>).geometry, pixelBox(20, 0, 70, 50));
  handlers.mouseup(mouse(45, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(Object.keys(areas)).toEqual(["kitchen"]);
  expectCornersNear(areas.kitchen, pixelBox(20, 0, 70, 50));
  expect(area(areas.kitchen)).toBeCloseTo(25, 1);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ kitchen: KITCHEN });
});

test("in Draw a click inside the active room sets a corner and a second click finishes the box", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  tap(25, 25);
  tap(75, 50);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(area(saves(connection)[0].areas.kitchen)).toBeCloseTo(31.25, 1);
});

test("a rejected move reloads the rooms, says so and records nothing", async () => {
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries") throw new Error("not allowed");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  await activateKitchen(panel);
  const feedLoads = sent(connection, "spatial/geojson").length;
  drag([25, 25], [45, 25]);
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("a drag starting inside a room that is not active draws a box", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  drag([25, 25], [65, 55]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(Object.keys(areas)).toEqual(["bath"]);
  expect(area(areas.bath)).toBeCloseTo(12, 1);
});

test("in Adjust a drag inside the active room moves it without panning, and a tap still selects", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const press = mouse(25, 25);
  handlers.mousedown(press);
  expect(press.preventDefault).toHaveBeenCalled();
  handlers.mousemove(mouse(45, 25));
  handlers.mouseup(mouse(45, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expectCornersNear(saves(connection)[0].areas.kitchen, pixelBox(20, 0, 70, 50));
  await tapRoom(panel, "bath");
  expect(activeChip(panel)).toBe("Bath");
});

test("a rejected save reloads the rooms, says so and records nothing", async () => {
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries") throw new Error("not allowed");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  const feedLoads = sent(connection, "spatial/geojson").length;
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("Escape after the first tap cancels the box", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  handlers.mousemove(mouse(140, 30));
  key("keydown", "Escape");
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  tap(140, 30);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("on All the tools are disabled, and Draw chosen on a floor draws nothing there", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  expect(buttonNamed(panel, "Draw")!.disabled).toBe(true);
  expect(dragPan.isEnabled()).toBe(true);
  tap(100, 0);
  tap(140, 30);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("an update that removes the active area makes the first area in the order active", async () => {
  const { panel, connection, setRegistry, setFeed } = mountEditor();
  await startDrawing(panel);
  chip(panel, "Kitchen").click();
  await settle(panel);
  setRegistry([
    { area_id: "bath", name: "Bath", floor_id: "ground" },
    { area_id: "hall", name: "Hall", floor_id: "ground" },
  ]);
  setFeed([]);
  await onUpdateOf(connection)();
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Bath", "Hall", "New area"]));
  expect(activeChip(panel)).toBe("Bath");
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "bath"]);
});

test("renaming the active area updates the area registry", async () => {
  const { panel, connection } = mountEditor();
  await showFloor(panel);
  chip(panel, "Bath").click();
  await settle(panel);
  const input = strip(panel)!.shadowRoot!.querySelector("input")!;
  input.value = "Scullery";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() =>
    expect(sent(connection, "config/area_registry/update")).toEqual([
      { type: "config/area_registry/update", area_id: "bath", name: "Scullery" },
    ]),
  );
});

test("boxes while a save is in flight are ignored", async () => {
  let release = () => {};
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type !== "spatial/area/update_geometries") return undefined;
    await new Promise<void>((resolve) => (release = resolve));
    return { area_m2: {} };
  });
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  tap(140, 0);
  tap(180, 30);
  drag([140, 0], [180, 30]);
  await settle(panel);
  expect(saves(connection)).toHaveLength(1);
  release();
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Hall"));
  tap(100, 100);
  tap(140, 130);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
});

test("a press or taps while Space is held draw nothing", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  key("keydown", " ");
  drag([100, 0], [140, 30]);
  tap(100, 0);
  tap(140, 30);
  key("keyup", " ");
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("losing focus while Space is held ends panning", async () => {
  const { panel } = mountEditor();
  await startDrawing(panel);
  key("keydown", " ");
  expect(dragPan.isEnabled()).toBe(true);
  window.dispatchEvent(new Event("blur"));
  expect(dragPan.isEnabled()).toBe(false);
});

test("in Draw two fingers still pan and zoom, without turning the map", async () => {
  const { panel } = mountEditor();
  await startDrawing(panel);
  expect(touchZoomRotate.isEnabled()).toBe(true);
  expect(touchZoomRotate.isRotationEnabled()).toBe(false);
});

test("a floor change cancels a box in progress", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  buttonNamed(panel, "Loft")!.click();
  buttonNamed(panel, "Ground floor")!.click();
  await settle(panel);
  tap(140, 30);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("leaving the panel in Draw turns panning back on", async () => {
  const { panel } = mountEditor();
  await startDrawing(panel);
  expect(dragPan.isEnabled()).toBe(false);
  panel.remove();
  expect(dragPan.isEnabled()).toBe(true);
});

test("a failed registry read does not stop the map", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { panel } = mountEditor(async (message) => {
    if (message.type === "config/area_registry/list") throw new Error("connection lost");
    return undefined;
  });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(guideText(panel)).not.toContain("Map could not load");
  errors.mockRestore();
});

const pixelShape = (...pixels: [number, number][]): Polygon => ({
  type: "Polygon",
  coordinates: [[...pixels, pixels[0]].map((p) => unprojectPixel(p, 300))],
});

const feature = (id: string, geometry: Polygon, areaM2?: number) => ({
  type: "Feature",
  id,
  geometry,
  properties: { floor_id: "ground", level: 0, area_m2: areaM2 },
});

const startAdjusting = async (panel: HTMLElement) => {
  await showFloor(panel);
  buttonNamed(panel, "Adjust")!.click();
  await settle(panel);
};

const tapRoom = async (panel: HTMLElement, areaId: string) => {
  queryRenderedFeatures.mockReturnValue([{ properties: { area_id: areaId } }]);
  handlers.click(mouse(10, 10));
  await settle(panel);
};

const sideButtons = () =>
  liveMarkers()
    .map((marker) => marker.element.firstElementChild)
    .filter((element) => element instanceof HTMLButtonElement);

const sideField = () =>
  liveMarkers()
    .map((marker) => marker.element.firstElementChild)
    .find((element) => element instanceof HTMLInputElement) as HTMLInputElement | undefined;

const typeSide = (edgeIndex: number, value: string) => {
  sideButtons()[edgeIndex].click();
  const field = sideField()!;
  field.value = value;
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
};

test("a side field typed while a new frame's refresh is pending resizes in the frame the field was built in", async () => {
  let turned = false;
  let releaseRegistry = () => {};
  const { panel, connection } = mountEditor(async (message) => {
    if (!turned) return undefined;
    if (message.type === "spatial/site") return siteReply({ bearing_deg: 75, outline: OUTLINE, frame: siteFrameData(SITE, 75) });
    if (message.type === "config/area_registry/list") await new Promise<void>((resolve) => (releaseRegistry = resolve));
    return undefined;
  });
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  sideButtons()[0].click();
  turned = true;
  const refreshed = onUpdateOf(connection)();
  await vi.waitFor(() => expect(sent(connection, "spatial/site").length).toBeGreaterThan(1));
  await settle(panel);
  const field = sideField()!;
  field.value = "6";
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const resized = saves(connection)[0].areas.kitchen;
  expect(isAxisRectangle(FRAME, resized)).toBe(true);
  expect(edgeLengths(FRAME, resized)[0]).toBeCloseTo(6, 6);
  releaseRegistry();
  await refreshed;
});

const ctrlZ = (shiftKey = false) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: shiftKey ? "Z" : "z", ctrlKey: true, shiftKey }));

test("in Adjust a tap on a room makes its area active", async () => {
  const { panel } = mountEditor();
  await startAdjusting(panel);
  expect(activeChip(panel)).toBe("Bath");
  await tapRoom(panel, "kitchen");
  expect(activeChip(panel)).toBe("Kitchen");
});

test("a rectangular room shows a button per side, an L-shaped room none", async () => {
  const { panel, connection, setFeed } = mountEditor();
  const lShape = pixelShape([100, 0], [200, 0], [200, 50], [150, 50], [150, 100], [100, 100]);
  await startAdjusting(panel);
  setFeed([feature("kitchen", KITCHEN), feature("bath", lShape)]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  expect(sideButtons().map((button) => button.textContent)).toEqual(["5.00 m", "5.00 m", "5.00 m", "5.00 m"]);
  await tapRoom(panel, "bath");
  expect(sideButtons()).toEqual([]);
});

test("typing 5 on a side saves the room with that side 5 m long, in one batch", async () => {
  const { panel, connection, setFeed } = mountEditor();
  await startAdjusting(panel);
  setFeed([feature("kitchen", pixelShape([0, 0], [40, 0], [40, 30], [0, 30]))]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  typeSide(0, "5");
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(Object.keys(areas)).toEqual(["kitchen"]);
  expect(edgeLengths(FRAME, areas.kitchen)[0]).toBeCloseTo(5, 3);
  expect(edgeLengths(FRAME, areas.kitchen)[1]).toBeCloseTo(3, 3);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
});

test("a typed 3.47 m lands on the lattice: 139 units, and the side and its field read 3.475 m", async () => {
  const { panel, connection, setFeed } = mountEditor();
  await startAdjusting(panel);
  setFeed([feature("kitchen", pixelShape([0, 0], [40, 0], [40, 30], [0, 30]))]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  typeSide(0, "3.47");
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const ring = saves(connection)[0].areas.kitchen.coordinates[0].map((corner) => FRAME.toLattice(corner));
  expect(ring[1][0] - ring[0][0]).toBe(139);
  expectOnGrid(FRAME, saves(connection)[0].areas.kitchen, 1);
  await vi.waitFor(() => expect(sideButtons()[0]?.textContent).toBe("3.475 m"));
  sideButtons()[0].click();
  expect(sideField()!.value).toBe("3.475 m");
});

test.each(["0.05", "0,05", "", "abc"])("a side typed as %j saves nothing and a toast says every side needs 10 cm", async (value) => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  typeSide(0, value);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(toasts).toEqual([{ message: "Too small: every side needs at least 10 cm" }]);
  expect(sideField()).toBeDefined();
});

test("Enter on an unchanged side field leaves the edit without a save or an undo step", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  sideButtons()[0].click();
  const field = sideField()!;
  expect(field.value).toBe("5.00 m");
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(sideField()).toBeUndefined();
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("in US customary units a side shows feet and inches and reads a typed length in feet and inches", async () => {
  const { panel, connection, setFeed } = mountEditor(undefined, OUTLINE, US_UNITS);
  await startAdjusting(panel);
  setFeed([feature("kitchen", pixelShape([0, 0], [40, 0], [40, 30], [0, 30]))]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  expect(sideButtons().map((button) => button.textContent)).toEqual(["13′ 1″", "9′ 10″", "13′ 1″", "9′ 10″"]);
  sideButtons()[0].click();
  const field = sideField()!;
  expect(field.value).toBe("13′ 1″");
  const enter = (value: string) => {
    field.value = value;
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  };
  enter(`3"`);
  await settle(panel);
  expect(toasts).toEqual([{ message: "Too small: every side needs at least 4 in" }]);
  enter(`16' 5"`);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(edgeLengths(INCH_FRAME, saves(connection)[0].areas.kitchen)[0]).toBeCloseTo(197 * 0.0254, 3);
});

test("on a floor each room is labelled with its area's icon, name and net m² from the feed", async () => {
  const { panel, connection, setFeed } = mountEditor();
  const living = pixelShape([0, 0], [200, 0], [200, 120], [0, 120]);
  await startAdjusting(panel);
  (panel as HTMLElement & { hass: object }).hass = {
    ...(panel as HTMLElement & { hass: object }).hass,
    areas: { kitchen: { name: "Kitchen", icon: "mdi:stove" } },
  };
  setFeed([feature("kitchen", living, 21.46)]);
  await onUpdateOf(connection)();
  const label = liveMarkers().find((marker) => marker.element.dataset.area === "kitchen")!.element;
  expect(label.querySelector("ha-icon")?.getAttribute("icon")).toBe("mdi:stove");
  expect(label.querySelector(".name")?.textContent).toBe("Kitchen");
  expect(label.querySelector(".size")?.textContent).toBe("21.5 m²");
});

const handleCorners = () =>
  (sources["spatial-handles"].data as { features: { geometry: { coordinates: number[] } }[] }).features.map(
    (handle) => handle.geometry.coordinates,
  );

test("corner handles sit on the active room's corners only, and not on All", async () => {
  const { panel } = mountEditor();
  await startAdjusting(panel);
  expect(handleCorners()).toEqual([]);
  await tapRoom(panel, "kitchen");
  expect(handleCorners()).toEqual(KITCHEN.coordinates[0].slice(0, -1));
  chip(panel, "Building").click();
  await settle(panel);
  expect(handleCorners()).toEqual(OUTLINE.coordinates[0].slice(0, -1));
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  expect(handleCorners()).toEqual([]);
});

test("in Adjust taps and drags save nothing, and leaving leaves no side markers", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  tap(100, 0);
  drag([100, 0], [160, 40]);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  const leavers = ["Draw", "Loft", "Align"];
  for (const name of leavers) {
    await tapRoom(panel, "kitchen");
    expect(sideButtons()).toHaveLength(4);
    buttonNamed(panel, name)!.click();
    await settle(panel);
    expect(editorMarkers()).toEqual([]);
    if (buttonNamed(panel, "Adjust")!.getAttribute("aria-pressed") !== "true") await startAdjusting(panel);
  }
  expect(saves(connection)).toEqual([]);
});

test("a rejected resize reloads the rooms, says so and records nothing", async () => {
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries") throw new Error("not allowed");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const feedLoads = sent(connection, "spatial/geojson").length;
  typeSide(0, "7");
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("Undo and Redo are disabled until they can act", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
  expect(buttonNamed(panel, "Redo")!.disabled).toBe(true);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  expect(buttonNamed(panel, "Redo")!.disabled).toBe(true);
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(buttonNamed(panel, "Redo")!.disabled).toBe(false));
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("undo of a new footprint removes it and redo saves it again", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ bath: null });
  await vi.waitFor(() => expect(buttonNamed(panel, "Redo")!.disabled).toBe(false));
  buttonNamed(panel, "Redo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(3));
  expect(saves(connection)[2].areas).toEqual(saves(connection)[0].areas);
});

test("undo of an extended footprint saves the previous polygon", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  chip(panel, "Kitchen").click();
  await settle(panel);
  tap(50, 0);
  tap(100, 50);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ kitchen: KITCHEN });
});

test("undo of a created area's first box keeps the area in Home Assistant", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  chip(panel, "New area").click();
  await vi.waitFor(() => expect(activeChip(panel) ?? renameField(panel)?.value).toBe("Room 1"));
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ room_1: null });
  expect(sent(connection, "config/area_registry/delete")).toEqual([]);
  await vi.waitFor(() => expect(chipNames(panel)).toContain("Room 1"));
});

test("a rejected undo reloads the rooms, says so and can be tried again", async () => {
  let reject = false;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && reject) throw new Error("connection lost");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  reject = true;
  const feedLoads = sent(connection, "spatial/geojson").length;
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  await settle(panel);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(false);
  expect(buttonNamed(panel, "Redo")!.disabled).toBe(true);
});

test("Ctrl+Z undoes and Ctrl+Shift+Z redoes", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  ctrlZ();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ bath: null });
  await vi.waitFor(() => expect(buttonNamed(panel, "Redo")!.disabled).toBe(false));
  ctrlZ(true);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(3));
  expect(saves(connection)[2].areas).toEqual(saves(connection)[0].areas);
});

test("Ctrl+Z in the rename field or a side field undoes nothing", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  chip(panel, "Hall").click();
  await settle(panel);
  const rename = strip(panel)!.shadowRoot!.querySelector("input")!;
  rename.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, composed: true }));
  buttonNamed(panel, "Adjust")!.click();
  await tapRoom(panel, "kitchen");
  sideButtons()[0].click();
  sideField()!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, composed: true }));
  await settle(panel);
  expect(saves(connection)).toHaveLength(1);
});

test("a reload that hangs after a failed save does not block the next box", async () => {
  let failed = false;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && !failed) {
      failed = true;
      throw new Error("connection lost");
    }
    if (message.type === "spatial/geojson" && failed) return new Promise(() => {});
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
});

test("a refresh held back until after a save is acknowledged keeps the saved footprint", async () => {
  let release = () => {};
  let hold = false;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type !== "config/area_registry/list" || !hold) return undefined;
    hold = false;
    await new Promise<void>((resolve) => (release = resolve));
    return undefined;
  });
  await startDrawing(panel);
  hold = true;
  const refreshed = onUpdateOf(connection)();
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Hall"));
  release();
  await refreshed;
  await settle(panel);
  expect(chipNames(panel)).toContain("Bath");
});

test("Draw chosen before the map attaches takes effect when it does", async () => {
  let release = () => {};
  // Holds the map style, the last step before the map is created.
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ json: async () => ({ sprite: [], glyphs: "/g", layers: [] }) } as Response);
      }),
  );
  const { panel } = mountEditor();
  await vi.waitFor(() => expect(buttonNamed(panel, "Ground floor")).toBeDefined());
  buttonNamed(panel, "Ground floor")!.click();
  await settle(panel);
  buttonNamed(panel, "Draw")!.click();
  release();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(dragPan.isEnabled()).toBe(false);
});

test("a pan between the two taps keeps the box on the first tapped spot", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  panMap(30, 20);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(area(saves(connection)[0].areas.bath)).toBeCloseTo(35, 1);
});

test("pills tell linked areas from unlinked ones by data-linked", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Kitchen", "Bath", "Hall", "New area"]));
  expect(chips(panel).map((c) => c.getAttribute("data-linked"))).toEqual(["true", "true", "false", "false", null]);
});

test("the map highlights the active area's polygon, which an unlinked area does not have", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toContain("Kitchen"));
  chip(panel, "Kitchen").click();
  await settle(panel);
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "kitchen"]);
  chip(panel, "Bath").click();
  await settle(panel);
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "bath"]);
});

const siteSaves = (connection: { sendMessagePromise: unknown }) =>
  sent(connection, "spatial/site/update") as unknown as { type: string; outline: Polygon | null }[];

const buildingHighlight = () =>
  layers.find((layer) => layer.id === "spatial-active-building")?.layout?.visibility;

test("without an outline the Building pill is active on every floor; a box saves the outline, then the first unlinked area is active", async () => {
  const { panel, connection } = mountEditor(undefined, null);
  await startDrawing(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Kitchen", "Bath", "Hall", "New area"]));
  expect(activeChip(panel)).toBe("Building");
  expect(chip(panel, "Building").getAttribute("data-linked")).toBe("false");
  buttonNamed(panel, "Loft")!.click();
  await settle(panel);
  expect(activeChip(panel)).toBe("Building");
  buttonNamed(panel, "Ground floor")!.click();
  await settle(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  const [saved] = siteSaves(connection);
  expect(Object.keys(saved)).toEqual(["type", "outline"]);
  expect(area(saved.outline!)).toBeCloseTo(12, 1);
  expect(saves(connection)).toEqual([]);
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Bath"));
  expect(chip(panel, "Building").getAttribute("data-linked")).toBe("true");
});

test("undo of the first outline box removes the outline", async () => {
  const { panel, connection } = mountEditor(undefined, null);
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(2));
  expect(siteSaves(connection)[1]).toEqual({ type: "spatial/site/update", outline: null });
});

test("with the Building pill active the outline is highlighted and a box against it joins it", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  expect(buildingHighlight()).toBe("none");
  chip(panel, "Building").click();
  await settle(panel);
  expect(buildingHighlight()).toBe("visible");
  tap(90, 120);
  tap(150, 170);
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(area(siteSaves(connection)[0].outline!)).toBeCloseTo(125, 0);
  expect(saves(connection)).toEqual([]);
  chip(panel, "Kitchen").click();
  await settle(panel);
  expect(buildingHighlight()).toBe("none");
});

test("a drag inside the outline with the Building pill active moves the outline", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  chip(panel, "Building").click();
  await settle(panel);
  handlers.mousedown(mouse(50, 150));
  handlers.mousemove(mouse(70, 150));
  handlers.mouseup(mouse(70, 150));
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expectCornersNear(siteSaves(connection)[0].outline!, pixelBox(20, 100, 120, 200));
});

test("typing a side of the outline in Adjust saves the outline", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  chip(panel, "Building").click();
  await settle(panel);
  typeSide(0, "12");
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(edgeLengths(FRAME, siteSaves(connection)[0].outline!)[0]).toBeCloseTo(12, 3);
});

test("Space during a move cancels it", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(45, 25));
  key("keydown", " ");
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  handlers.mouseup(mouse(45, 25));
  key("keyup", " ");
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("outside Draw Space and Escape keep their usual meaning, also when Space was held on leaving Draw", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  key("keydown", " ");
  buttonNamed(panel, "Adjust")!.click();
  await tapRoom(panel, "kitchen");
  const space = new KeyboardEvent("keydown", { key: " ", cancelable: true });
  window.dispatchEvent(space);
  expect(space.defaultPrevented).toBe(false);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(45, 25));
  key("keydown", "Escape");
  handlers.mouseup(mouse(45, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
});

test("Space during a save in Draw leaves the map flat and turned to the site axis", async () => {
  let release = () => {};
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type !== "spatial/area/update_geometries") return undefined;
    await new Promise<void>((resolve) => (release = resolve));
    return { area_m2: {} };
  });
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  key("keydown", " ");
  key("keyup", " ");
  expect(dragPan.isEnabled()).toBe(false);
  expect(dragRotate.isEnabled()).toBe(false);
  release();
});

test("the box from a first tap follows the mouse while an undo is saving", async () => {
  let hold = false;
  let release = () => {};
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type !== "spatial/area/update_geometries" || !hold) return undefined;
    await new Promise<void>((resolve) => (release = resolve));
    return { area_m2: {} };
  });
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  tap(100, 100);
  hold = true;
  ctrlZ();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  handlers.mousemove(mouse(140, 130));
  expect(sources["spatial-draft"].data).not.toEqual(EMPTY);
  release();
});

test("an update during a move saves the room as it was grabbed", async () => {
  const { panel, connection, setFeed } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  handlers.mousedown(mouse(25, 25));
  setFeed([{ type: "Feature", id: "kitchen", geometry: pixelBox(0, 0, 60, 60), properties: { floor_id: "ground", level: 0 } }]);
  await onUpdateOf(connection)();
  handlers.mousemove(mouse(45, 25));
  handlers.mouseup(mouse(45, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expectCornersNear(saves(connection)[0].areas.kitchen, pixelBox(20, 0, 70, 50));
});

test("on All Ctrl+Z and Ctrl+Shift+Z change nothing, as the tools are off there", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  ctrlZ();
  ctrlZ(true);
  await settle(panel);
  expect(saves(connection)).toHaveLength(1);
});

test("Space keeps its usual meaning on All after Draw, so it still presses a focused button", async () => {
  const { panel } = mountEditor();
  await startDrawing(panel);
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  const space = new KeyboardEvent("keydown", { key: " ", cancelable: true });
  window.dispatchEvent(space);
  expect(space.defaultPrevented).toBe(false);
});

const renameField = (panel: HTMLElement) => strip(panel)?.shadowRoot?.querySelector("input") ?? null;

const toolPressed = (panel: HTMLElement, name: string) => buttonNamed(panel, name)!.getAttribute("aria-pressed");

test("choosing a pill without a shape picks Draw; a pill with one keeps the tool", async () => {
  const { panel } = mountEditor();
  await startAdjusting(panel);
  chip(panel, "Kitchen").click();
  await settle(panel);
  expect(toolPressed(panel, "Adjust")).toBe("true");
  chip(panel, "Hall").click();
  await settle(panel);
  expect(toolPressed(panel, "Draw")).toBe("true");
  expect(activeChip(panel)).toBe("Hall");
});

test("New area creates the area on the floor at once, makes it active in Draw and opens its name", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  chip(panel, "New area").click();
  await vi.waitFor(() => expect(renameField(panel)?.value).toBe("Room 1"));
  expect(sent(connection, "config/area_registry/create")).toEqual([
    { type: "config/area_registry/create", name: "Room 1", floor_id: "ground" },
  ]);
  expect(toolPressed(panel, "Draw")).toBe("true");
  expect(guideText(panel)).toBe("Draw Room 1 2 of 4");
  const field = renameField(panel)!;
  field.value = "Study";
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() =>
    expect(sent(connection, "config/area_registry/update")).toEqual([
      { type: "config/area_registry/update", area_id: "room_1", name: "Study" },
    ]),
  );
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(Object.keys(saves(connection)[0].areas)).toEqual(["room_1"]);
});

test("a tap on the active pill opens its name, and Escape closes it without a rename", async () => {
  const { panel, connection } = mountEditor();
  await showFloor(panel);
  chip(panel, "Bath").click();
  await settle(panel);
  const field = renameField(panel)!;
  expect(field.value).toBe("Bath");
  field.value = "Scullery";
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await settle(panel);
  expect(renameField(panel)).toBeNull();
  expect(sent(connection, "config/area_registry/update")).toEqual([]);
});

test("the guide says which area to draw and how far the floor is, and nothing for a drawn one", async () => {
  const { panel, connection } = mountEditor();
  await showFloor(panel);
  expect(guideText(panel)).toBe("Draw Bath 2 of 3");
  buttonNamed(panel, "Draw")!.click();
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  await settle(panel);
  expect(guideText(panel)).toBe("Draw Hall 3 of 3");
  chip(panel, "Kitchen").click();
  await settle(panel);
  expect(guideText(panel)).toBe("");
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  expect(guideText(panel)).toBe("");
});

test("on All the strip shows only the Building and a hint, and nothing is highlighted", async () => {
  const { panel } = mountEditor();
  await vi.waitFor(() => expect(strip(panel)).not.toBeNull());
  await settle(panel);
  expect(partsText(strip(panel)!)).toBe("Building Choose a floor to edit its rooms");
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  expect(buildingHighlight()).toBe("none");
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], ""]);
});

const hoverFilter = () => layers.find((layer) => layer.id === "spatial-hover")?.filter;

test("pointing at a pill outlines its room, and pointing at a room marks its pill", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  chip(panel, "Kitchen").dispatchEvent(new MouseEvent("mouseenter"));
  await settle(panel);
  expect(hoverFilter()).toEqual(["==", ["get", "area_id"], "kitchen"]);
  chip(panel, "Kitchen").dispatchEvent(new MouseEvent("mouseleave"));
  chip(panel, "Building").dispatchEvent(new MouseEvent("mouseenter"));
  await settle(panel);
  expect(hoverFilter()).not.toEqual(["==", ["get", "area_id"], "kitchen"]);
  expect(layers.find((layer) => layer.id === "spatial-hover-building")?.layout?.visibility).toBe("visible");
  queryRenderedFeatures.mockReturnValue([{ properties: { area_id: "kitchen" } }]);
  handlers.mousemove(mouse(10, 10));
  await settle(panel);
  expect(chips(panel).filter((c) => c.hasAttribute("data-hovered")).map((c) => c.textContent?.trim())).toEqual([
    "Kitchen",
  ]);
  handlers.mouseout();
  await settle(panel);
  expect(chips(panel).some((c) => c.hasAttribute("data-hovered"))).toBe(false);
});

test("Retry after a failed box saves it again, the box stays on the map until then, and success closes the toast", async () => {
  let fail = true;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && fail) throw new Error("connection lost");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  const [failure] = toasts;
  expect(failure).toMatchObject({ action: { text: "Retry" }, duration: -1, dismissable: true });
  const kept = (sources["spatial-draft"].data as Feature<Polygon>).geometry;
  expect(kept).toEqual(saves(connection)[0].areas.bath);
  fail = false;
  failure.action!.action();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1]).toEqual(saves(connection)[0]);
  await vi.waitFor(() => expect(sources["spatial-draft"].data).toEqual(EMPTY));
  expect(toasts.at(-1)).toEqual({ id: failure.id, message: "", duration: 0 });
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(false);
});

test("a failed rename offers Retry, which renames the area", async () => {
  let fail = true;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "config/area_registry/update" && fail) throw new Error("connection lost");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await showFloor(panel);
  chip(panel, "Bath").click();
  await settle(panel);
  renameField(panel)!.value = "Scullery";
  renameField(panel)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  fail = false;
  toasts[0].action!.action();
  await vi.waitFor(() => expect(sent(connection, "config/area_registry/update")).toHaveLength(2));
  expect(sent(connection, "config/area_registry/update")[1]).toEqual({
    type: "config/area_registry/update",
    area_id: "bath",
    name: "Scullery",
  });
});

test("Delete removes the active shape in one save, and undo brings it back", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  key("keydown", "Delete");
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(saves(connection)[0].areas).toEqual({ kitchen: null });
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ kitchen: KITCHEN });
});

test("Delete without a shape, or in a field, removes nothing", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  key("keydown", "Delete");
  chip(panel, "Bath").click();
  await settle(panel);
  renameField(panel)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, composed: true }));
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

const failingFirstSave = () => {
  let fail = true;
  const mounted = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && fail) {
      fail = false;
      throw new Error("connection lost");
    }
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  return mounted;
};

const draftGeometry = () => (sources["spatial-draft"].data as Feature<Polygon>).geometry;

test("a new map style keeps the shape of a failed save on the map", async () => {
  const { panel } = failingFirstSave();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  const kept = draftGeometry();
  handlers["style.load"]();
  expect(draftGeometry()).toEqual(kept);
});

test("the snap highlight sits above the corner handles and comes back with a new map style", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  const ids = () => layers.map((layer) => layer.id);
  expect(ids().indexOf("spatial-snap-line")).toBeGreaterThan(ids().indexOf("spatial-handles"));
  expect(ids().indexOf("spatial-snap-point")).toBeGreaterThan(ids().indexOf("spatial-handles"));
  handlers["style.load"]();
  expect(ids().filter((id) => id === "spatial-snap-point")).toHaveLength(2);
  expect(sources["spatial-snap"].data).toEqual(EMPTY);
});

test("Ctrl+Z with nothing to undo keeps the failure toast and the failed shape", async () => {
  const { panel } = failingFirstSave();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  ctrlZ();
  ctrlZ(true);
  await settle(panel);
  expect(toasts).toHaveLength(1);
  expect(draftGeometry()).toBeDefined();
});

test("an undo that saves after a failed first box clears the failed shape and its toast", async () => {
  let saveCount = 0;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && ++saveCount === 2) throw new Error("connection lost");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  tap(100, 60);
  tap(140, 90);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  await vi.waitFor(() => expect(draftGeometry()).toBeDefined());
  ctrlZ();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(3));
  await vi.waitFor(() => expect(sources["spatial-draft"].data).toEqual(EMPTY));
  expect(toasts.at(-1)).toMatchObject({ message: "", duration: 0 });
});

const failingSaves = () => {
  let fail = true;
  const mounted = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && fail) throw new Error("outside_outline");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  return { ...mounted, stopFailing: () => (fail = false) };
};

// A refused change of a stored room shows that room as stored, still active; Retry sends the same change.
const expectOnlyStoredKitchen = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  await settle(panel);
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "kitchen"]);
  expect(handleCorners()).toEqual(KITCHEN.coordinates[0].slice(0, -1));
};

const expectRetrySendsTheSame = async (connection: { sendMessagePromise: unknown }, stopFailing: () => void) => {
  stopFailing();
  toasts[0].action!.action();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1]).toEqual(saves(connection)[0]);
};

test("a refused move shows only the stored room, still active, and Retry sends the same move", async () => {
  const { panel, connection, stopFailing } = failingSaves();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  drag([25, 25], [45, 25]);
  await expectOnlyStoredKitchen(panel);
  await expectRetrySendsTheSame(connection, stopFailing);
});

test("a refused resize shows only the stored room, still active, and Retry sends the same resize", async () => {
  const { panel, connection, stopFailing } = failingSaves();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  typeSide(0, "7");
  await expectOnlyStoredKitchen(panel);
  await expectRetrySendsTheSame(connection, stopFailing);
});

test("a refused extension shows only the stored room, still active, and Retry sends the same extension", async () => {
  const { panel, connection, stopFailing } = failingSaves();
  await startDrawing(panel);
  await activateKitchen(panel);
  tap(50, 0);
  tap(100, 50);
  await expectOnlyStoredKitchen(panel);
  await expectRetrySendsTheSame(connection, stopFailing);
});

test("Retry of a failed New area creates it on the floor it was asked on, with the same name", async () => {
  let fail = true;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "config/area_registry/create" && fail) {
      fail = false;
      throw new Error("connection lost");
    }
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await showFloor(panel);
  chip(panel, "New area").click();
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  buttonNamed(panel, "Loft")!.click();
  await settle(panel);
  toasts[0].action!.action();
  await vi.waitFor(() => expect(sent(connection, "config/area_registry/create")).toHaveLength(2));
  expect(sent(connection, "config/area_registry/create")[1]).toEqual({
    type: "config/area_registry/create",
    name: "Room 1",
    floor_id: "ground",
  });
});

test("two quick taps on New area create one area", async () => {
  const { panel, connection } = mountEditor();
  await showFloor(panel);
  chip(panel, "New area").click();
  chip(panel, "New area").click();
  await vi.waitFor(() => expect(renameField(panel)?.value).toBe("Room 1"));
  expect(sent(connection, "config/area_registry/create")).toHaveLength(1);
});

// The lattice corners of a shape, in a fixed order, whatever corner its ring starts at.
const cornerSet = (shape: Polygon, frame = FRAME) =>
  shape.coordinates[0]
    .slice(0, -1)
    .map((corner) => frame.toLattice(corner))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const latticeBox = (left: number, bottom: number, right: number, top: number) =>
  [
    [left, bottom],
    [left, top],
    [right, bottom],
    [right, top],
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
// KITCHEN in lattice units: a pixel is 4 units, and lattice y runs up the screen.
const KITCHEN_BOX = latticeBox(0, -200, 200, 0);

// The draft's own chips: plain labels, not the editor's side buttons or the room labels.
const draftLabels = () =>
  liveMarkers()
    .filter((marker) => !marker.element.firstElementChild && !marker.element.matches(".room-label, .building-label"))
    .map((marker) => marker.element.textContent);
const sidesVisible = () => sideButtons().map((button) => button.parentElement!.style.visibility !== "hidden");

const dragThrough = (points: [number, number][], altKey = false) => {
  handlers.mousedown(mouse(...points[0], altKey));
  for (const point of points.slice(1)) handlers.mousemove(mouse(...point, altKey));
  handlers.mouseup(mouse(...points[points.length - 1], altKey));
};

test("in Adjust a press on an edge of the active rectangle drags that edge, with counting chips, in one save and one undo step", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const press = mouse(1, 25);
  handlers.mousedown(press);
  expect(press.preventDefault).toHaveBeenCalled();
  handlers.mousemove(mouse(-12, 25));
  expect(draftLabels()).toContain("6.30 m");
  handlers.mousemove(mouse(-19.2, 25));
  expect(draftLabels()).toContain("7.00 m");
  expect(sidesVisible()).toEqual([false, false, false, false]);
  handlers.mouseup(mouse(-19.2, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -200, 200, 0));
  await vi.waitFor(() => expect(sidesVisible()).toEqual([true, true, true, true]));
  expect(sideButtons().map((button) => button.textContent)).toContain("7.00 m");
  sideButtons()[0].click();
  expect(sideField()).toBeDefined();
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(cornerSet(saves(connection)[1].areas.kitchen)).toEqual(KITCHEN_BOX);
});

test("an edge drag released where it started saves nothing and records no undo step", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  dragThrough([
    [1, 25],
    [-10, 25],
    [0.6, 25],
  ]);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
  expect(sidesVisible()).toEqual([true, true, true, true]);
});

test("hovering an edge or a corner of the active rectangle shows the resize cursor along it", async () => {
  const { panel } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const cursorAt = (x: number, y: number) => {
    handlers.mousemove(mouse(x, y));
    return mapCanvas.style.cursor;
  };
  expect(cursorAt(1, 25)).toBe("ew-resize");
  expect(cursorAt(25, 49)).toBe("ns-resize");
  expect(cursorAt(1, 1)).toBe("nwse-resize");
  expect(cursorAt(49, 1)).toBe("nesw-resize");
  expect(cursorAt(25, 25)).toBe("");
});

test("with the map turned 40 degrees off the site axis the edge drag follows the room's edges", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const map = (panel as unknown as { _map: { setBearing(bearing: number): void; project(at: Position): { x: number; y: number } } })
    ._map;
  map.setBearing(340);
  const screenOf = (point: [number, number]): [number, number] => {
    const { x, y } = map.project(FRAME.fromLattice(point));
    return [x, y];
  };
  handlers.mousemove(mouse(...screenOf([2, -100])));
  expect(mapCanvas.style.cursor).toBe("ew-resize");
  dragThrough([screenOf([4, -100]), screenOf([-30, -100]), screenOf([-76.8, -100])]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -200, 200, 0));
});

test("an edge drag of the Building rectangle saves the outline", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  chip(panel, "Building").click();
  await settle(panel);
  dragThrough([
    [99, 150],
    [110, 150],
    [120, 150],
  ]);
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(cornerSet(siteSaves(connection)[0].outline!)).toEqual(latticeBox(0, -800, 484, -400));
  expect(saves(connection)).toEqual([]);
});

// Bath's bottom right corner sits at pixel (-10, -10), lattice (-40, 40).
const withBathUpLeft = async () => {
  const mounted = mountEditor();
  await startAdjusting(mounted.panel);
  mounted.setFeed([feature("kitchen", KITCHEN), feature("bath", pixelBox(-30, -30, -10, -10))]);
  await onUpdateOf(mounted.connection)();
  await tapRoom(mounted.panel, "kitchen");
  return mounted;
};

test("a press near a corner drags the corner, not an edge: the opposite corner stays", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  dragThrough([
    [1, 1],
    [-5, -5],
    [-10.3, -10.3],
  ]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-44, -200, 200, 44));
});

test("a dragged corner snaps to a neighbour's corner and lights it, in one save and one undo step", async () => {
  const { panel, connection } = await withBathUpLeft();
  handlers.mousedown(mouse(1, 1));
  handlers.mousemove(mouse(-5, -5));
  handlers.mousemove(mouse(-11.5, -11));
  expect(snapPoint()).toEqual([-40, 40]);
  handlers.mouseup(mouse(-11.5, -11));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-40, -200, 200, 40));
  expect(snapPoint()).toBeUndefined();
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(cornerSet(saves(connection)[1].areas.kitchen)).toEqual(KITCHEN_BOX);
});

test("Alt keeps a dragged corner off the snap, on the lattice", async () => {
  const { connection } = await withBathUpLeft();
  dragThrough(
    [
      [1, 1],
      [-5, -5],
      [-11.5, -11],
    ],
    true,
  );
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-50, -200, 200, 48));
});

test("Escape cancels an edge drag in Adjust without a save", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  handlers.mousedown(mouse(1, 25));
  handlers.mousemove(mouse(-19.2, 25));
  key("keydown", "Escape");
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  handlers.mouseup(mouse(-19.2, 25));
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(sidesVisible()).toEqual([true, true, true, true]);
});

const coarsePointer = (coarse: boolean) =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        matches: coarse && media === "(pointer: coarse)",
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
const edgeGrips = () => liveMarkers().filter((marker) => marker.element.matches(".edge-grip"));
const cornerGrips = () => liveMarkers().filter((marker) => marker.element.matches(".corner-grip"));
const sideChips = () => liveMarkers().filter((marker) => marker.element.firstElementChild instanceof HTMLButtonElement);

// The map container sits at the page's origin, so client pixels are map pixels.
const pointerDrag = (element: HTMLElement, points: [number, number][]) => {
  const at = (type: string, [clientX, clientY]: [number, number]) =>
    element.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, bubbles: true, cancelable: true }));
  at("pointerdown", points[0]);
  for (const point of points.slice(1)) at("pointermove", point);
  at("pointerup", points[points.length - 1]);
};

test("on a coarse pointer the active rectangle in Adjust has a 44 x 20 px grab handle on each edge and a 44 px target on each corner", async () => {
  coarsePointer(true);
  const { panel } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  expect(edgeGrips()).toHaveLength(4);
  for (const { element, options } of edgeGrips()) {
    expect([element.style.width, element.style.height]).toEqual(["44px", "20px"]);
    expect(element.getAttribute("aria-hidden")).toBe("true");
    expect(element.style.touchAction).toBe("none");
    expect(options.rotationAlignment).toBe("map");
  }
  // Edge 0 runs left to right on the screen and edge 1 down it, at map bearing 300.
  expect(edgeGrips().map(({ options }) => Math.round(options.rotation!) % 180)).toEqual([120, 30, 120, 30]);
  expect(cornerGrips()).toHaveLength(4);
  for (const { element } of cornerGrips()) {
    expect([element.style.width, element.style.height]).toEqual(["44px", "44px"]);
    expect(element.getAttribute("aria-hidden")).toBe("true");
  }
  vi.restoreAllMocks();
});

test("on a fine pointer there are no grab handles", async () => {
  coarsePointer(false);
  const { panel } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  expect(sideChips()).toHaveLength(4);
  expect([...edgeGrips(), ...cornerGrips()]).toEqual([]);
  vi.restoreAllMocks();
});

test("each side chip sits outward of its grab handle, clear of it", async () => {
  coarsePointer(true);
  const { panel } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const [top, right, bottom, left] = sideChips().map(({ options }) => options.offset!);
  expect(top[1]).toBeLessThan(-13.9);
  expect(right[0]).toBeGreaterThan(13.9);
  expect(bottom[1]).toBeGreaterThan(13.9);
  expect(left[0]).toBeLessThan(-13.9);
  vi.restoreAllMocks();
});

test("dragging an edge handle saves one resize, and the chips hide while it moves", async () => {
  coarsePointer(true);
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const grip = edgeGrips()[3].element;
  const at = (type: string, [clientX, clientY]: [number, number]) =>
    grip.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, bubbles: true, cancelable: true }));
  at("pointerdown", [0, 25]);
  at("pointermove", [-12, 25]);
  expect(sideChips().map(({ element }) => element.style.visibility)).toEqual(["hidden", "hidden", "hidden", "hidden"]);
  at("pointermove", [-19.2, 25]);
  at("pointerup", [-19.2, 25]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-76, -200, 200, 0));
  vi.restoreAllMocks();
});

test("dragging a corner target moves that corner and keeps the opposite one", async () => {
  coarsePointer(true);
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  pointerDrag(cornerGrips()[2].element, [
    [50, 50],
    [56, 56],
    [60.3, 60.3],
  ]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(0, -240, 240, 0));
  vi.restoreAllMocks();
});
