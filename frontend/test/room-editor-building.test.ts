// @vitest-environment happy-dom
// Checks drawing, moving and resizing the building outline with the Building pill.
import area from "@turf/area";
import type { Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import { buttonNamed, handlers, settle, resetFakes, toasts } from "./panel-harness";
import {
  FRAME,
  pixelBox,
  mountEditor,
  chipNames,
  activeChip,
  chip,
  startDrawing,
  mouse,
  tap,
  saves,
  expectCornersNear,
  startSelecting,
  typeSide,
  siteSaves,
  buildingHighlight,
  ctrlZ,
  key,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { edgeLengths } from "../src/plan";
import "../src/spatial-panel";

afterEach(resetFakes);

// An L of 4 m by 3 m less a 2 m by 1 m corner: 10 square metres.
const L_CORNERS: [number, number][] = [
  [100, 0],
  [140, 0],
  [140, 30],
  [120, 30],
  [120, 20],
  [100, 20],
];
const placeCorners = (corners: [number, number][]) => corners.forEach(([x, y]) => tap(x, y));

test("without an outline the Building pill is active; clicking the first corner again saves the outline, then the first unlinked area is active", async () => {
  const { panel, connection } = mountEditor(undefined, null);
  await startDrawing(panel);
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Kitchen", "Bath", "Hall", "New area"]));
  expect(activeChip(panel)).toBe("Building");
  expect(chip(panel, "Building").getAttribute("data-linked")).toBe("false");
  placeCorners(L_CORNERS);
  expect(siteSaves(connection)).toEqual([]);
  tap(101, 1);
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  const [saved] = siteSaves(connection);
  expect(Object.keys(saved)).toEqual(["type", "outline"]);
  expect(saved.outline!.coordinates[0]).toHaveLength(7);
  expect(area(saved.outline!)).toBeCloseTo(10, 1);
  expect(saves(connection)).toEqual([]);
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Bath"));
  expect(chip(panel, "Building").getAttribute("data-linked")).toBe("true");
});

test("undo of the first outline removes it", async () => {
  const { panel, connection } = mountEditor(undefined, null);
  await startDrawing(panel);
  placeCorners([...L_CORNERS, L_CORNERS[0]]);
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(2));
  expect(siteSaves(connection)[1]).toEqual({ type: "spatial/site/update", outline: null });
});

// Each row takes back a stray last corner of an open ring, which then closes without it, in one save.
test.each<[string, (panel: HTMLElement) => void]>([
  ["Escape", () => key("keydown", "Escape")],
  ["Ctrl Z", () => ctrlZ()],
  ["the Undo button", (panel) => buttonNamed(panel, "Undo")!.click()],
])("%s drops the last corner while the outline is drawn", async (_name, takeBack) => {
  const { panel, connection } = mountEditor(undefined, null);
  await startDrawing(panel);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
  placeCorners([...L_CORNERS, [60, 60]]);
  await settle(panel);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(false);
  takeBack(panel);
  tap(...L_CORNERS[0]);
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(area(siteSaves(connection)[0].outline!)).toBeCloseTo(10, 1);
});

test("Escape on the only corner ends the ring, so the next click starts a new one", async () => {
  const { panel, connection } = mountEditor(undefined, null);
  await startDrawing(panel);
  tap(60, 60);
  key("keydown", "Escape");
  placeCorners([...L_CORNERS, L_CORNERS[0]]);
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(area(siteSaves(connection)[0].outline!)).toBeCloseTo(10, 1);
});

test("a ring that crosses itself is refused with a toast and stays open", async () => {
  const { panel, connection } = mountEditor(undefined, null);
  await startDrawing(panel);
  placeCorners([
    [100, 0],
    [140, 30],
    [140, 0],
    [100, 30],
    [100, 0],
  ]);
  await vi.waitFor(() => expect(toasts).toEqual([{ message: "The outline cannot cross itself" }]));
  expect(siteSaves(connection)).toEqual([]);
  // The last corner taken back leaves three corners that do not cross.
  key("keydown", "Escape");
  tap(100, 0);
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(area(siteSaves(connection)[0].outline!)).toBeCloseTo(6, 1);
});

// Each row acts on the outline with the Building pill active: one outline save, no area save.
test.each<[string, (panel: HTMLElement) => Promise<void>, () => void, (outline: Polygon) => void]>([
  [
    "a box against it joins it",
    startDrawing,
    () => {
      tap(90, 120);
      tap(150, 170);
    },
    (outline) => expect(area(outline)).toBeCloseTo(125, 0),
  ],
  [
    "a drag inside it moves it",
    startDrawing,
    () => {
      handlers.mousedown(mouse(50, 150));
      handlers.mousemove(mouse(70, 150));
      handlers.mouseup(mouse(70, 150));
    },
    (outline) => expectCornersNear(outline, pixelBox(20, 100, 120, 200)),
  ],
  ["typing a side in Select resizes it", startSelecting, () => typeSide(0, "12"), (outline) => expect(edgeLengths(FRAME, outline)[0]).toBeCloseTo(12, 3)],
])("with the Building pill active the outline is highlighted, and %s", async (_name, start, act, expectOutline) => {
  const { panel, connection } = mountEditor();
  await start(panel);
  expect(buildingHighlight()).toBe("none");
  chip(panel, "Building").click();
  await settle(panel);
  expect(buildingHighlight()).toBe("visible");
  act();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expectOutline(siteSaves(connection)[0].outline!);
  expect(saves(connection)).toEqual([]);
  chip(panel, "Kitchen").click();
  await settle(panel);
  expect(buildingHighlight()).toBe("none");
});