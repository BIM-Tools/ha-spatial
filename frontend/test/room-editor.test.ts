// @vitest-environment happy-dom
// Checks drawing rooms in the panel against a fake MapLibre and a scripted Home Assistant connection.
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
  resetFakes,
  sources,
  unprojectPixel,
} from "./panel-harness";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { isAxisRectangle } from "../src/plan";
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
      case "config/area_registry/create":
        return { area_id: "room_1", name: message.name, floor_id: message.floor_id };
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

type Panel = HTMLElement & { updateComplete: Promise<boolean>; editor?: { history: { canUndo: boolean } } };

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
    ).toEqual(["All", "Ground floor", "Loft", "No floor", "Draw", "Building"]),
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
  expect(barButton(card, "Draw")).toBeUndefined();
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
  expect((panel as Panel).editor?.history.canUndo).toBe(true);
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
  expect((panel as Panel).editor?.history.canUndo).toBe(false);
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
  expect((panel as Panel).editor?.history.canUndo).toBe(false);
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
