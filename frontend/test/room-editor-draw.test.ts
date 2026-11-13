// @vitest-environment happy-dom
// Checks drawing boxes in Draw: taps, drags, the grid, joins and snapping.
import area from "@turf/area";
import type { Feature } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import {
  buttonNamed,
  handlers,
  jumpTo,
  liveMarkers,
  nextFrame,
  toasts,
  onUpdateOf,
  panMap,
  settle,
  SITE,
  siteReply,
  sources,
  resetFakes,
} from "./panel-harness";
import {
  SITE_BEARING,
  INCH_FRAME_DATA,
  FRAME,
  pixelBox,
  KITCHEN,
  OUTLINE,
  mountEditor,
  editorMarkers,
  activeFilter,
  activeChip,
  chip,
  startDrawing,
  mouse,
  tap,
  drag,
  saves,
  expectOnGrid,
  activateKitchen,
  snapHighlights,
} from "./room-editor-fixture";
import { siteFrameData } from "./site-frame-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { edgeLengths, isAxisRectangle } from "../src/plan";
import { PlanFrame } from "../src/site-frame";
import "../src/spatial-panel";

afterEach(resetFakes);

test("a mouse drag draws a box with live side labels, its area only once the box has room for it, and saves it in one batch", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  const shownLabels = () => liveMarkers().filter((marker) => marker.element.style.visibility !== "hidden").map((marker) => marker.element.textContent);
  handlers.mousedown(mouse(100, 0));
  handlers.mousemove(mouse(200, 50));
  expect(shownLabels()).toContain("50.0 m²");
  handlers.mousemove(mouse(140, 30));
  expect(shownLabels()).toEqual(expect.arrayContaining(["4.00 m", "3.00 m"]));
  expect(shownLabels()).not.toContain("12.0 m²");
  handlers.mouseup(mouse(140, 30));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(Object.keys(areas)).toEqual(["bath"]);
  expect(area(areas.bath)).toBeCloseTo(12, 1);
  expect(editorMarkers()).toEqual([]);
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

test("a drawn box's corners land on the grid", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  drag([100.4, 0.3], [140.2, 29.6]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expectOnGrid(FRAME, areas.bath);
  expect(edgeLengths(FRAME, areas.bath).map((m) => Math.round(m * 1e6) / 1e6)).toEqual([4, 3, 4, 3]);
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

test("rooms on other floors are not candidates, rooms on this floor and the outline are", async () => {
  const { panel, setFeed } = mountEditor();
  setFeed([
    { type: "Feature", id: "kitchen", geometry: KITCHEN, properties: { floor_id: "ground", level: 0 } },
    { type: "Feature", id: "attic", geometry: pixelBox(200, 0, 250, 50), properties: { floor_id: "loft", level: 1 } },
  ]);
  await startDrawing(panel);
  // Near a corner the two walls that meet there light up, and the corner; the attic's wall, away
  // from the lines through the kitchen's corners, lights up nothing.
  handlers.mousemove(mouse(203, 22));
  await nextFrame();
  expect(snapHighlights()).toEqual([]);
  handlers.mousemove(mouse(53, 2));
  await nextFrame();
  expect(snapHighlights()).toEqual(["LineString", "LineString", "Point"]);
  handlers.mousemove(mouse(103, 102));
  await nextFrame();
  expect(snapHighlights()).toEqual(["LineString", "LineString", "Point"]);
});

test("a drag starting inside a room that is not active draws a box", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  // The end lies more than the snap radius from the lines through the kitchen's and the outline's corners.
  drag([25, 25], [65, 61]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(Object.keys(areas)).toEqual(["bath"]);
  expect(area(areas.bath)).toBeCloseTo(14.4, 1);
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

test("a pan between the two taps keeps the box on the first tapped spot", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  panMap(30, 20);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(area(saves(connection)[0].areas.bath)).toBeCloseTo(35, 1);
});
