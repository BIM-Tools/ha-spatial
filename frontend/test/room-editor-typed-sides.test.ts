// @vitest-environment happy-dom
// Checks Select: selecting rooms, corner handles and typing a side's length.
import { afterEach, expect, test, vi } from "vitest";
import { buttonNamed, toasts, onUpdateOf, settle, SITE, siteReply, resetFakes } from "./panel-harness";
import {
  FRAME,
  INCH_FRAME,
  KITCHEN,
  OUTLINE,
  mountEditor,
  editorMarkers,
  chip,
  tap,
  drag,
  sent,
  saves,
  pixelShape,
  feature,
  startSelecting,
  tapRoom,
  sideButtons,
  sideField,
  typeSide,
  handleCorners,
} from "./room-editor-fixture";
import { siteFrameData } from "./site-frame-fixture";
import { US_UNITS } from "./units-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { edgeLengths, isAxisRectangle } from "../src/plan";
import "../src/spatial-panel";

afterEach(resetFakes);

test("a side field typed while a new frame's refresh is pending resizes in the frame the field was built in", async () => {
  let turned = false;
  let releaseRegistry = () => {};
  const { panel, connection } = mountEditor(async (message) => {
    if (!turned) return undefined;
    if (message.type === "spatial/site") return siteReply({ bearing_deg: 75, outline: OUTLINE, frame: siteFrameData(SITE, 75) });
    if (message.type === "config/area_registry/list") await new Promise<void>((resolve) => (releaseRegistry = resolve));
    return undefined;
  });
  await startSelecting(panel);
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

test("a rectangular room shows a button per side, the width and depth once, an L-shaped room none", async () => {
  const { panel, connection, setFeed } = mountEditor();
  const lShape = pixelShape([100, 0], [200, 0], [200, 50], [150, 50], [150, 100], [100, 100]);
  await startSelecting(panel);
  setFeed([feature("kitchen", KITCHEN), feature("bath", lShape)]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  expect(sideButtons().map((button) => button.textContent)).toEqual(["", "", "5.00 m", "5.00 m"]);
  await tapRoom(panel, "bath");
  expect(sideButtons()).toEqual([]);
});

test("typing 5 on a side saves the room with that side 5 m long, in one batch", async () => {
  const { panel, connection, setFeed } = mountEditor();
  await startSelecting(panel);
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

test("a typed 3.47 m reads back as the saved lattice length, 3.475 m, on the side and in its field", async () => {
  const { panel, connection, setFeed } = mountEditor();
  await startSelecting(panel);
  setFeed([feature("kitchen", pixelShape([0, 0], [40, 0], [40, 30], [0, 30]))]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  typeSide(0, "3.47");
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  await vi.waitFor(() => expect(sideButtons()[2]?.textContent).toBe("3.475 m"));
  sideButtons()[0].click();
  expect(sideField()!.value).toBe("3.475 m");
});

test("a refused side length saves nothing, keeps its field and says why", async () => {
  const { panel, connection } = mountEditor();
  await startSelecting(panel);
  await tapRoom(panel, "kitchen");
  typeSide(0, "0.05");
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(toasts).toEqual([{ message: "Too small: every side needs at least 10 cm" }]);
  expect(sideField()).toBeDefined();
});

test("Enter on an unchanged side field leaves the edit without a save or an undo step", async () => {
  const { panel, connection } = mountEditor();
  await startSelecting(panel);
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
  await startSelecting(panel);
  setFeed([feature("kitchen", pixelShape([0, 0], [40, 0], [40, 30], [0, 30]))]);
  await onUpdateOf(connection)();
  await tapRoom(panel, "kitchen");
  expect(sideButtons().map((button) => button.textContent)).toEqual(["", "", "13′ 1″", "9′ 10″"]);
  sideButtons()[0].click();
  const field = sideField()!;
  field.value = `16' 5"`;
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(edgeLengths(INCH_FRAME, saves(connection)[0].areas.kitchen)[0]).toBeCloseTo(197 * 0.0254, 3);
});

test("corner handles sit on the active room's corners only, and not on All", async () => {
  const { panel } = mountEditor();
  await startSelecting(panel);
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

test("in Select taps and drags save nothing, and leaving leaves no side markers", async () => {
  const { panel, connection } = mountEditor();
  await startSelecting(panel);
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
    if (buttonNamed(panel, "Select")!.getAttribute("aria-pressed") !== "true") await startSelecting(panel);
  }
  expect(saves(connection)).toEqual([]);
});
