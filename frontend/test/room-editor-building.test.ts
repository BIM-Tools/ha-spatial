// @vitest-environment happy-dom
// Checks drawing, moving, resizing and reshaping the building outline with the Building pill.
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
  pixelShape,
  sideButtons,
  sideField,
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

// An outline copied from a map with a slanted right wall, from [400, -400] to [420, -800] on the lattice.
const SLANTED = pixelShape([0, 100], [100, 100], [105, 200], [0, 200]);
const latticeCorners = (shape: Polygon) => shape.coordinates[0].slice(0, -1).map((corner) => FRAME.toLattice(corner));
const selectSlantedOutline = async () => {
  const mounted = mountEditor(undefined, SLANTED);
  await startSelecting(mounted.panel);
  chip(mounted.panel, "Building").click();
  await settle(mounted.panel);
  return mounted;
};
const pointer = (target: HTMLElement, type: string, [clientX, clientY]: [number, number]) =>
  target.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, button: 0, bubbles: true, cancelable: true }));

test.each<[string, () => void, [number, number][]]>([
  [
    "its slanted wall's corner dragged onto the line of the others",
    () => {
      handlers.mousedown(mouse(105, 200));
      handlers.mousemove(mouse(98, 195));
      handlers.mouseup(mouse(100.2, 200));
    },
    [[0, -400], [400, -400], [400, -800], [0, -800]],
  ],
  [
    "the chip of its slanted wall dragged out, along the wall's normal",
    () => {
      const slanted = sideButtons()[1];
      pointer(slanted, "pointerdown", [102.5, 150]);
      pointer(slanted, "pointermove", [112.5, 150]);
      pointer(slanted, "pointerup", [112.5, 150]);
      slanted.click();
    },
    [[0, -400], [440, -398], [460, -798], [0, -800]],
  ],
])("an outline of another shape in Select shows a length chip on every side, and %s saves it once with one undo step", async (_name, drag, corners) => {
  const { panel, connection } = await selectSlantedOutline();
  expect(sideButtons().map((button) => button.textContent)).toEqual(["10.00 m", "10.00 m", "10.50 m", "10.00 m"]);
  drag();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(latticeCorners(siteSaves(connection)[0].outline!)).toEqual(corners);
  expect(sideField()).toBeUndefined();
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(2));
  expect(siteSaves(connection)[1].outline).toEqual(SLANTED);
});

test("a corner of an outline of another shape dragged so that its walls cross is refused with a toast and saves nothing", async () => {
  const { panel, connection } = await selectSlantedOutline();
  handlers.mousedown(mouse(105, 200));
  handlers.mousemove(mouse(60, 180));
  handlers.mouseup(mouse(-30, 150));
  await settle(panel);
  expect(toasts).toEqual([{ message: "The outline cannot cross itself" }]);
  expect(siteSaves(connection)).toEqual([]);
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