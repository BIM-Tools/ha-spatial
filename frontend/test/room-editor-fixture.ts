// Shares the scripted Home Assistant, the fixed site frame and the pointer and key helpers of the room editor tests.
import distance from "@turf/distance";
import type { Feature, Point, Polygon } from "geojson";
import { expect, vi } from "vitest";
import {
  type Reply,
  areaEntry,
  buttonNamed,
  floorEntry,
  handlers,
  liveMarkers,
  layers,
  mountPanel,
  queryRenderedFeatures,
  rooms,
  settle,
  SITE,
  sources,
  unprojectPixel,
} from "./panel-harness";
import { US_UNIT_M, siteFrameData } from "./site-frame-fixture";
import { METRIC_UNITS, US_UNITS } from "./units-fixture";
import { PlanFrame } from "../src/site-frame";

// Site bearing 30 turns the map to bearing 300.
export const SITE_BEARING = 30;
// Lattice x runs to the right on the screen and y up; a pixel is one grid step.
export const FRAME_DATA = siteFrameData(SITE, SITE_BEARING);
export const INCH_FRAME_DATA = siteFrameData(SITE, SITE_BEARING, US_UNIT_M);
export const FRAME = PlanFrame.fromSite(FRAME_DATA);
export const INCH_FRAME = PlanFrame.fromSite(INCH_FRAME_DATA);

export const pixelBox = (x1: number, y1: number, x2: number, y2: number): Polygon => {
  const ring = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1],
  ].map((p) => unprojectPixel(p as [number, number], 300));
  return { type: "Polygon", coordinates: [ring] };
};

export const KITCHEN = pixelBox(0, 0, 50, 50);
export const OUTLINE = pixelBox(0, 100, 100, 200);

export const mountEditor = (overrides: Reply = async () => undefined, outline: Polygon | null = OUTLINE, units = METRIC_UNITS) => {
  let registry = [
    areaEntry("kitchen", "Kitchen", "ground"),
    areaEntry("bath", "Bath", "ground"),
    areaEntry("hall", "Hall", "ground"),
    areaEntry("attic", "Attic", "loft"),
  ];
  let feed = [{ type: "Feature", id: "kitchen", geometry: KITCHEN, properties: { floor_id: "ground", level: 0 } }];
  // The editor's writes; the reads come from the home below.
  const writes: Reply = async (message) => {
    const overridden = await overrides(message);
    if (overridden !== undefined) return overridden;
    switch (message.type) {
      case "config/area_registry/create": {
        const created = areaEntry("room_1", message.name as string, message.floor_id as string);
        registry = [...registry, created];
        return created;
      }
      case "config/area_registry/update":
        return {};
      case "spatial/area/update_geometries":
        return { area_m2: {} };
    }
    return undefined;
  };
  const mounted = mountPanel({
    reply: writes,
    site: { bearing_deg: SITE_BEARING, outline, frame: units === US_UNITS ? INCH_FRAME_DATA : FRAME_DATA },
    geojson: () => rooms(...feed),
    floors: [floorEntry("ground", "Ground floor", 0), floorEntry("loft", "Loft", 1)],
    areas: () => registry,
    units,
  });
  const setRegistry = (next: typeof registry) => (registry = next);
  const setFeed = (next: typeof feed) => (feed = next);
  return { ...mounted, setRegistry, setFeed };
};

export type Panel = HTMLElement & { updateComplete: Promise<boolean> };

export const strip = (panel: HTMLElement) =>
  panel.shadowRoot?.querySelector("spatial-area-strip") as
    | (HTMLElement & { updateComplete: Promise<boolean> })
    | null;

export const chips = (panel: HTMLElement) => [...(strip(panel)?.shadowRoot?.querySelectorAll<HTMLButtonElement>("button.pill") ?? [])];

// The markers the editor adds while drawing or adjusting, without the room labels.
export const editorMarkers = () =>
  liveMarkers().filter((marker) => !marker.element.matches(".room-label, .building-label"));

export const activeFilter = () => layers.find((layer) => layer.id === "spatial-active")?.filter;

export const chipNames = (panel: HTMLElement) => chips(panel).map((chip) => chip.textContent?.trim());

export const activeChip = (panel: HTMLElement) =>
  chips(panel)
    .find((chip) => chip.getAttribute("aria-pressed") === "true")
    ?.textContent?.trim();

export const chip = (panel: HTMLElement, name: string) =>
  chips(panel).find((c) => c.textContent?.trim() === name)!;

export const showFloor = async (panel: HTMLElement, floor = "Ground floor") => {
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await vi.waitFor(() => expect(buttonNamed(panel, floor)).toBeDefined());
  buttonNamed(panel, floor)!.click();
  await settle(panel);
};

export const startDrawing = async (panel: HTMLElement, floor = "Ground floor") => {
  await showFloor(panel, floor);
  buttonNamed(panel, "Draw")!.click();
  await settle(panel);
};

export const mouse = (x: number, y: number) => {
  const [lng, lat] = unprojectPixel([x, y]);
  return { point: { x, y }, lngLat: { lng, lat }, originalEvent: { button: 0 }, preventDefault: vi.fn() };
};

export const tap = (x: number, y: number) => {
  handlers.mousedown(mouse(x, y));
  handlers.mouseup(mouse(x, y));
  handlers.click(mouse(x, y));
};

export const drag = (from: [number, number], to: [number, number]) => {
  handlers.mousedown(mouse(...from));
  handlers.mousemove(mouse(from[0] + 2, from[1] + 2));
  handlers.mousemove(mouse(...to));
  handlers.mouseup(mouse(...to));
};

export const key = (type: "keydown" | "keyup", name: string) =>
  window.dispatchEvent(new KeyboardEvent(type, { key: name }));

export type Sent = { mock: { calls: [{ type: string; [key: string]: unknown }][] } };

export const sent = (connection: { sendMessagePromise: unknown }, type?: string) =>
  (connection.sendMessagePromise as Sent).mock.calls
    .map(([message]) => message)
    .filter((message) => !type || message.type === type);

export const saves = (connection: { sendMessagePromise: unknown }) =>
  sent(connection, "spatial/area/update_geometries") as unknown as {
    areas: Record<string, Polygon>;
  }[];

// Whole lattice units within 1e-6, and on the grid unless only the lattice is asked for.
export const expectOnGrid = (frame: PlanFrame, shape: Polygon, step = frame.unitsPerStep) => {
  for (const corner of shape.coordinates[0]) {
    for (const units of frame.toLatticeUnits(corner)) expect(Math.abs(units / step - Math.round(units / step))).toBeLessThan(1e-6);
  }
};

export const expectCornersNear = (actual: Polygon, expected: Polygon) =>
  actual.coordinates[0].forEach((corner, index) =>
    expect(distance(corner, expected.coordinates[0][index], { units: "meters" })).toBeLessThan(0.01),
  );

export const activateKitchen = async (panel: HTMLElement) => {
  chip(panel, "Kitchen").click();
  await settle(panel);
};

export const snapPoint = () => {
  const [feature] = (sources["spatial-snap"].data as { features: Feature<Point>[] }).features;
  return feature && FRAME.toLattice(feature.geometry.coordinates);
};

export const pixelShape = (...pixels: [number, number][]): Polygon => ({
  type: "Polygon",
  coordinates: [[...pixels, pixels[0]].map((p) => unprojectPixel(p, 300))],
});

export const feature = (id: string, geometry: Polygon, areaM2?: number) => ({
  type: "Feature",
  id,
  geometry,
  properties: { floor_id: "ground", level: 0, area_m2: areaM2 },
});

export const startAdjusting = async (panel: HTMLElement) => {
  await showFloor(panel);
  buttonNamed(panel, "Adjust")!.click();
  await settle(panel);
};

export const tapRoom = async (panel: HTMLElement, areaId: string) => {
  queryRenderedFeatures.mockReturnValue([{ properties: { area_id: areaId } }]);
  handlers.click(mouse(10, 10));
  await settle(panel);
};

export const sideButtons = () =>
  liveMarkers()
    .map((marker) => marker.element.firstElementChild)
    .filter((element) => element instanceof HTMLButtonElement);

export const sideField = () =>
  liveMarkers()
    .map((marker) => marker.element.firstElementChild)
    .find((element) => element instanceof HTMLInputElement) as HTMLInputElement | undefined;

export const typeSide = (edgeIndex: number, value: string) => {
  sideButtons()[edgeIndex].click();
  const field = sideField()!;
  field.value = value;
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
};

export const ctrlZ = (shiftKey = false) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: shiftKey ? "Z" : "z", ctrlKey: true, shiftKey }));

export const handleCorners = () =>
  (sources["spatial-handles"].data as { features: { geometry: { coordinates: number[] } }[] }).features.map(
    (handle) => handle.geometry.coordinates,
  );

export const siteSaves = (connection: { sendMessagePromise: unknown }) =>
  sent(connection, "spatial/site/update") as unknown as { type: string; outline: Polygon | null }[];

export const buildingHighlight = () =>
  layers.find((layer) => layer.id === "spatial-active-building")?.layout?.visibility;

export const renameField = (panel: HTMLElement) => strip(panel)?.shadowRoot?.querySelector("input") ?? null;

export const toolPressed = (panel: HTMLElement, name: string) => buttonNamed(panel, name)!.getAttribute("aria-pressed");

export const hoverFilter = () => layers.find((layer) => layer.id === "spatial-hover")?.filter;

export const failingFirstSave = () => {
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

export const draftGeometry = () => (sources["spatial-draft"].data as Feature<Polygon>).geometry;
