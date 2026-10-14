// @vitest-environment happy-dom
// Checks drawing, adjusting and undoing rooms in the panel against a fake MapLibre and a scripted Home Assistant connection.
import area from "@turf/area";
import type { Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  type Reply,
  answer,
  dragPan,
  handlers,
  handles,
  mapCreated,
  mountPanel,
  onUpdateOf,
  queryRenderedFeatures,
  resetFakes,
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

const mountEditor = (overrides: Reply = async () => undefined) => {
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
        return { lon: 5, lat: 52, bearing_deg: SITE_BEARING, outline: null };
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

const barButton = (panel: HTMLElement, name: string) =>
  [...(panel.shadowRoot?.querySelectorAll(".bar > button") ?? [])].find(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;

const barText = (panel: HTMLElement) => panel.shadowRoot?.querySelector(".bar")?.textContent ?? "";

const strip = (panel: HTMLElement) =>
  panel.shadowRoot?.querySelector("spatial-area-strip") as
    | (HTMLElement & { updateComplete: Promise<boolean> })
    | null;

const chips = (panel: HTMLElement) => [...(strip(panel)?.shadowRoot?.querySelectorAll("button") ?? [])];

const chipNames = (panel: HTMLElement) => chips(panel).map((chip) => chip.textContent?.trim());

const activeChip = (panel: HTMLElement) =>
  chips(panel)
    .find((chip) => chip.getAttribute("aria-pressed") === "true")
    ?.textContent?.trim();

const chip = (panel: HTMLElement, name: string) =>
  chips(panel).find((c) => c.textContent?.trim() === name)!;

const settle = async (panel: HTMLElement) => {
  await (panel as Panel).updateComplete;
  await strip(panel)?.updateComplete;
};

const showFloor = async (panel: HTMLElement, floor = "Ground floor") => {
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await vi.waitFor(() => expect(barButton(panel, floor)).toBeDefined());
  barButton(panel, floor)!.click();
  await settle(panel);
};

const startDrawing = async (panel: HTMLElement, floor = "Ground floor") => {
  await showFloor(panel, floor);
  barButton(panel, "Draw")!.click();
  await settle(panel);
};

const mouse = (x: number, y: number) => {
  const [lng, lat] = unprojectPixel([x, y]);
  return { point: { x, y }, lngLat: { lng, lat }, originalEvent: { button: 0, target: null } };
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

test("the panel's floor buttons come from the floor registry, with No floor and a Draw button", async () => {
  const { panel } = mountEditor();
  await vi.waitFor(() =>
    expect(
      [...(panel.shadowRoot?.querySelectorAll(".bar > button") ?? [])].map((b) => b.textContent?.trim()),
    ).toEqual(["All", "Ground floor", "Loft", "No floor", "Draw", "Adjust", "Undo", "Redo", "Building"]),
  );
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
  await vi.waitFor(() =>
    expect(
      [...(panel.shadowRoot?.querySelectorAll(".bar > button") ?? [])].map((b) => b.textContent?.trim()).slice(0, 4),
    ).toEqual(["All", "Ground floor", "Loft", "No floor"]),
  );
});

test("the strip is shown in the panel and not in the card", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  expect(strip(panel)).not.toBeNull();
  const card = mountPanel(answer, {}, true).panel;
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(2));
  await (card as Panel).updateComplete;
  expect(strip(card)).toBeNull();
  for (const name of ["Draw", "Adjust", "Undo", "Redo"]) expect(barButton(card, name)).toBeUndefined();
});

test("on a floor the first area without a footprint is active", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Bath", "Hall", "● Kitchen", "+ New area"]));
  expect(activeChip(panel)).toBe("Bath");
});

test("a mouse drag draws a box with live side labels and saves it in one batch", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  handlers.mousedown(mouse(100, 0));
  handlers.mousemove(mouse(140, 30));
  const labels = handles().map((marker) => marker.element.textContent);
  expect(labels).toEqual(expect.arrayContaining(["4.00 m", "3.00 m", "12.0 m²"]));
  handlers.mouseup(mouse(140, 30));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(Object.keys(areas)).toEqual(["bath"]);
  expect(area(areas.bath)).toBeCloseTo(12, 1);
  expect(handles()).toEqual([]);
});

test("in Draw the map pans only while Space is held, and leaving Draw restores panning", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  expect(dragPan.isEnabled()).toBe(true);
  barButton(panel, "Draw")!.click();
  expect(dragPan.isEnabled()).toBe(false);
  key("keydown", " ");
  expect(dragPan.isEnabled()).toBe(true);
  key("keyup", " ");
  expect(dragPan.isEnabled()).toBe(false);
  barButton(panel, "Draw")!.click();
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
  expect(barButton(panel, "Undo")!.disabled).toBe(false);
});

test("a box against an area's footprint saves their union", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  chip(panel, "● Kitchen").click();
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
  chip(panel, "● Kitchen").click();
  await settle(panel);
  tap(200, 200);
  tap(240, 240);
  await vi.waitFor(() => expect(barText(panel)).toContain("A room is one shape: draw against it"));
  expect(saves(connection)).toEqual([]);
  expect(barButton(panel, "Undo")!.disabled).toBe(true);
});

test("two taps 0.1 m apart save nothing", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(101, 1);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
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
  await vi.waitFor(() => expect(barText(panel)).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  expect(barButton(panel, "Undo")!.disabled).toBe(true);
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

test("on All taps draw nothing and the bar asks for a floor", async () => {
  const { panel, connection } = mountEditor();
  await vi.waitFor(() => expect(barButton(panel, "Draw")).toBeDefined());
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  barButton(panel, "Draw")!.click();
  await settle(panel);
  expect(barText(panel)).toContain("Pick a floor to draw");
  expect(dragPan.isEnabled()).toBe(true);
  tap(100, 0);
  tap(140, 30);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("an update that removes the active area makes the first area in the order active", async () => {
  const { panel, connection, setRegistry, setFeed } = mountEditor();
  await startDrawing(panel);
  chip(panel, "● Kitchen").click();
  await settle(panel);
  setRegistry([
    { area_id: "bath", name: "Bath", floor_id: "ground" },
    { area_id: "hall", name: "Hall", floor_id: "ground" },
  ]);
  setFeed([]);
  await onUpdateOf(connection)();
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Bath", "Hall", "+ New area"]));
  expect(activeChip(panel)).toBe("Bath");
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
  await vi.waitFor(() => expect(barText(panel)).toContain("Could not save"));
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
  barButton(panel, "Loft")!.click();
  barButton(panel, "Ground floor")!.click();
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
  expect(barText(panel)).not.toContain("Map could not load");
  errors.mockRestore();
});

test("Draw clears a building message", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  barButton(panel, "Building")!.click();
  handlers.click(mouse(0, 0));
  await vi.waitFor(() => expect(barText(panel)).toContain("No building here"));
  barButton(panel, "Draw")!.click();
  await settle(panel);
  expect(barText(panel)).not.toContain("No building here");
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
  barButton(panel, "Adjust")!.click();
  await settle(panel);
};

const tapRoom = async (panel: HTMLElement, areaId: string) => {
  queryRenderedFeatures.mockReturnValue([{ properties: { area_id: areaId } }]);
  handlers.click(mouse(10, 10));
  await settle(panel);
};

const sideButtons = () =>
  handles()
    .map((marker) => marker.element.firstElementChild)
    .filter((element) => element instanceof HTMLButtonElement);

const sideField = () =>
  handles()
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
  expect(activeChip(panel)).toBe("● Kitchen");
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
  await vi.waitFor(() => expect(barButton(panel, "Undo")!.disabled).toBe(false));
});

test.each(["0.1", ""])("a side typed as %j saves nothing and the bar says a side is at least 0.20 m", async (value) => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  typeSide(0, value);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(barText(panel)).toContain("A side is at least 0.20 m");
  expect(sideField()).toBeDefined();
});

test("a refusal message is gone once the tool changes", async () => {
  const { panel } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  typeSide(0, "0.1");
  await settle(panel);
  barButton(panel, "Adjust")!.click();
  await settle(panel);
  expect(barText(panel)).not.toContain("A side is at least");
});

test("Adjust shows the active room's area from the feed in its centre", async () => {
  const { panel, connection, setFeed } = mountEditor();
  await startAdjusting(panel);
  setFeed([feature("kitchen", KITCHEN, 21.46)]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  expect(handles().map((marker) => marker.element.textContent)).toContain("21.5 m²");
});

test("in Adjust taps and drags save nothing, and leaving leaves no side markers", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  tap(100, 0);
  drag([100, 0], [160, 40]);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  const leavers = ["Draw", "Loft", "Adjust"];
  for (const name of leavers) {
    await tapRoom(panel, "kitchen");
    expect(sideButtons()).toHaveLength(4);
    barButton(panel, name)!.click();
    await settle(panel);
    expect(handles()).toEqual([]);
    if (barButton(panel, "Adjust")!.getAttribute("aria-pressed") !== "true") await startAdjusting(panel);
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
  await vi.waitFor(() => expect(barText(panel)).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  expect(barButton(panel, "Undo")!.disabled).toBe(true);
});

test("Undo and Redo are disabled until they can act", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  expect(barButton(panel, "Undo")!.disabled).toBe(true);
  expect(barButton(panel, "Redo")!.disabled).toBe(true);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  await vi.waitFor(() => expect(barButton(panel, "Undo")!.disabled).toBe(false));
  expect(barButton(panel, "Redo")!.disabled).toBe(true);
  barButton(panel, "Undo")!.click();
  await vi.waitFor(() => expect(barButton(panel, "Redo")!.disabled).toBe(false));
  expect(barButton(panel, "Undo")!.disabled).toBe(true);
});

test("undo of a new footprint removes it and redo saves it again", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(barButton(panel, "Undo")!.disabled).toBe(false));
  barButton(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ bath: null });
  await vi.waitFor(() => expect(barButton(panel, "Redo")!.disabled).toBe(false));
  barButton(panel, "Redo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(3));
  expect(saves(connection)[2].areas).toEqual(saves(connection)[0].areas);
});

test("undo of an extended footprint saves the previous polygon", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  chip(panel, "● Kitchen").click();
  await settle(panel);
  tap(50, 0);
  tap(100, 50);
  await vi.waitFor(() => expect(barButton(panel, "Undo")!.disabled).toBe(false));
  barButton(panel, "Undo")!.click();
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
  await vi.waitFor(() => expect(barButton(panel, "Undo")!.disabled).toBe(false));
  barButton(panel, "Undo")!.click();
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
  await vi.waitFor(() => expect(barButton(panel, "Undo")!.disabled).toBe(false));
  reject = true;
  const feedLoads = sent(connection, "spatial/geojson").length;
  barButton(panel, "Undo")!.click();
  await vi.waitFor(() => expect(barText(panel)).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  await settle(panel);
  expect(barButton(panel, "Undo")!.disabled).toBe(false);
  expect(barButton(panel, "Redo")!.disabled).toBe(true);
});

test("Ctrl+Z undoes and Ctrl+Shift+Z redoes", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(barButton(panel, "Undo")!.disabled).toBe(false));
  ctrlZ();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ bath: null });
  await vi.waitFor(() => expect(barButton(panel, "Redo")!.disabled).toBe(false));
  ctrlZ(true);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(3));
  expect(saves(connection)[2].areas).toEqual(saves(connection)[0].areas);
});

test("Ctrl+Z in the rename field or a side field undoes nothing", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(barButton(panel, "Undo")!.disabled).toBe(false));
  chip(panel, "Hall").click();
  await settle(panel);
  const rename = strip(panel)!.shadowRoot!.querySelector("input")!;
  rename.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, composed: true }));
  barButton(panel, "Adjust")!.click();
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
  await vi.waitFor(() => expect(barText(panel)).toContain("Could not save"));
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
  expect(chipNames(panel)).toContain("● Bath");
});
