// @vitest-environment happy-dom
// Checks drawing, adjusting and undoing rooms in the panel against a fake MapLibre and a scripted Home Assistant connection.
import area from "@turf/area";
import distance from "@turf/distance";
import type { Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  type Reply,
  answer,
  buttonNamed,
  dragPan,
  dragRotate,
  handlers,
  floorButtonNames,
  liveMarkers,
  layers,
  mapCreated,
  messageText,
  mountPanel,
  onUpdateOf,
  panMap,
  queryRenderedFeatures,
  resetFakes,
  settle,
  sources,
  touchZoomRotate,
  unprojectPixel,
} from "./panel-harness";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { edgeLengths, isAxisRectangle } from "../src/plan";
import "../src/spatial-panel";

afterEach(resetFakes);

// Site bearing 30 turns the map to bearing 300.
const SITE_BEARING = 30;

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

const mountEditor = (overrides: Reply = async () => undefined, outline: Polygon | null = OUTLINE) => {
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
        return { lon: 5, lat: 52, bearing_deg: SITE_BEARING, outline };
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
  const mounted = mountPanel(reply);
  const setRegistry = (next: typeof registry) => (registry = next);
  const setFeed = (next: typeof feed) => (feed = next);
  return { ...mounted, setRegistry, setFeed };
};

type Panel = HTMLElement & { updateComplete: Promise<boolean> };


const strip = (panel: HTMLElement) =>
  panel.shadowRoot?.querySelector("spatial-area-strip") as
    | (HTMLElement & { updateComplete: Promise<boolean> })
    | null;

const chips = (panel: HTMLElement) => [...(strip(panel)?.shadowRoot?.querySelectorAll("button") ?? [])];

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

const mouse = (x: number, y: number) => {
  const [lng, lat] = unprojectPixel([x, y]);
  return { point: { x, y }, lngLat: { lng, lat }, originalEvent: { button: 0 }, preventDefault: vi.fn() };
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
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Bath", "Hall", "Kitchen", "+ New area"]));
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
  expect(liveMarkers()).toEqual([]);
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

test("two taps save a box along the site axis and move on to the next area", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(isAxisRectangle(areas.bath, SITE_BEARING)).toBe(true);
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
  await vi.waitFor(() => expect(messageText(panel)).toContain("A room is one shape: draw against it"));
  expect(saves(connection)).toEqual([]);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("two taps 0.1 m apart save nothing", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(101, 1);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

const expectCornersNear = (actual: Polygon, expected: Polygon) =>
  actual.coordinates[0].forEach((corner, index) =>
    expect(distance(corner, expected.coordinates[0][index], { units: "meters" })).toBeLessThan(0.01),
  );

const activateKitchen = async (panel: HTMLElement) => {
  chip(panel, "Kitchen").click();
  await settle(panel);
};

test("in Draw a drag inside the active room moves it in one batch, and undo puts it back", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(45, 25));
  expectCornersNear(sources["spatial-draft"].data as Polygon, pixelBox(20, 0, 70, 50));
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
  await vi.waitFor(() => expect(messageText(panel)).toContain("Could not save"));
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

test("with New area active a box first creates Room 1 on the floor, then saves its footprint", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  chip(panel, "+ New area").click();
  await settle(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const writes = sent(connection).filter((m) =>
    ["config/area_registry/create", "spatial/area/update_geometries"].includes(m.type),
  );
  expect(writes.map((m) => m.type)).toEqual(["config/area_registry/create", "spatial/area/update_geometries"]);
  expect(writes[0]).toEqual({ type: "config/area_registry/create", name: "Room 1", floor_id: "ground" });
  expect(Object.keys(saves(connection)[0].areas)).toEqual(["room_1"]);
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Bath"));
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "bath"]);
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
  await vi.waitFor(() => expect(messageText(panel)).toContain("Could not save"));
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
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Bath", "Hall", "+ New area"]));
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

test("a created area whose first save fails stays active, so a retry creates no second area", async () => {
  let fail = true;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && fail) {
      fail = false;
      throw new Error("connection lost");
    }
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  chip(panel, "+ New area").click();
  await settle(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(messageText(panel)).toContain("Could not save"));
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Room 1"));
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(sent(connection, "config/area_registry/create")).toHaveLength(1);
  expect(Object.keys(saves(connection)[1].areas)).toEqual(["room_1"]);
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
  expect(messageText(panel)).not.toContain("Map could not load");
  errors.mockRestore();
});

test("Draw clears an Align message", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  buttonNamed(panel, "Align")!.click();
  handlers.click(mouse(0, 0));
  await vi.waitFor(() => expect(messageText(panel)).toContain("No building here"));
  buttonNamed(panel, "Draw")!.click();
  await settle(panel);
  expect(messageText(panel)).not.toContain("No building here");
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
  expect(edgeLengths(areas.kitchen)[0]).toBeCloseTo(5, 3);
  expect(edgeLengths(areas.kitchen)[1]).toBeCloseTo(3, 3);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
});

test.each(["0.1", ""])("a side typed as %j saves nothing and the bar says a side is at least 0.20 m", async (value) => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  typeSide(0, value);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(messageText(panel)).toContain("A side is at least 0.20 m");
  expect(sideField()).toBeDefined();
});

test("a refusal message is gone once the tool changes", async () => {
  const { panel } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  typeSide(0, "0.1");
  await settle(panel);
  buttonNamed(panel, "Draw")!.click();
  await settle(panel);
  expect(messageText(panel)).not.toContain("A side is at least");
});

test("Adjust shows the active room's area from the feed in its centre", async () => {
  const { panel, connection, setFeed } = mountEditor();
  await startAdjusting(panel);
  setFeed([feature("kitchen", KITCHEN, 21.46)]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  expect(liveMarkers().map((marker) => marker.element.textContent)).toContain("21.5 m²");
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
    expect(liveMarkers()).toEqual([]);
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
  await vi.waitFor(() => expect(messageText(panel)).toContain("Could not save"));
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
  chip(panel, "+ New area").click();
  await settle(panel);
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
  await vi.waitFor(() => expect(messageText(panel)).toContain("Could not save"));
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
  await vi.waitFor(() => expect(messageText(panel)).toContain("Could not save"));
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

test("pills tell linked areas from unlinked ones by data-linked, without a dot", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Bath", "Hall", "Kitchen", "+ New area"]));
  expect(chips(panel).map((c) => c.getAttribute("data-linked"))).toEqual(["true", "false", "false", "true", null]);
});

test("the map highlights the active area's polygon and nothing for an unlinked or new area", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toContain("Kitchen"));
  chip(panel, "Kitchen").click();
  await settle(panel);
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "kitchen"]);
  chip(panel, "Bath").click();
  await settle(panel);
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "bath"]);
  chip(panel, "+ New area").click();
  await settle(panel);
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], ""]);
});

const siteSaves = (connection: { sendMessagePromise: unknown }) =>
  sent(connection, "spatial/site/update") as unknown as { type: string; outline: Polygon | null }[];

const buildingHighlight = () =>
  layers.find((layer) => layer.id === "spatial-active-building")?.layout?.visibility;

test("without an outline the Building pill is active on every floor; a box saves the outline, then the first unlinked area is active", async () => {
  const { panel, connection } = mountEditor(undefined, null);
  await startDrawing(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Bath", "Hall", "Kitchen", "+ New area"]));
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
  expect(edgeLengths(siteSaves(connection)[0].outline!)[0]).toBeCloseTo(12, 3);
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
