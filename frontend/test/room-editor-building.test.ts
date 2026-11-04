// @vitest-environment happy-dom
// Checks drawing, moving and resizing the building outline with the Building pill.
import area from "@turf/area";
import { afterEach, expect, test, vi } from "vitest";
import { buttonNamed, handlers, settle, resetFakes } from "./panel-harness";
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
  startAdjusting,
  typeSide,
  siteSaves,
  buildingHighlight,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { edgeLengths } from "../src/plan";
import "../src/spatial-panel";

afterEach(resetFakes);

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
