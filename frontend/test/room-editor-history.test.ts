// @vitest-environment happy-dom
// Checks undo, redo and removing a shape.
import { afterEach, expect, test, vi } from "vitest";
import { EMPTY, buttonNamed, handlers, sources, resetFakes } from "./panel-harness";
import {
  KITCHEN,
  mountEditor,
  chipNames,
  activeChip,
  chip,
  startDrawing,
  mouse,
  tap,
  key,
  sent,
  saves,
  activateKitchen,
  startSelecting,
  tapRoom,
  ctrlZ,
  renameField,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

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

test.each<[string, (panel: HTMLElement) => void, (panel: HTMLElement) => void]>([
  ["the buttons", (panel) => buttonNamed(panel, "Undo")!.click(), (panel) => buttonNamed(panel, "Redo")!.click()],
  ["Ctrl+Z and Ctrl+Shift+Z", () => ctrlZ(), () => ctrlZ(true)],
])("undo by %s removes a new footprint and redo saves it again", async (_name, undo, redo) => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  undo(panel);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ bath: null });
  await vi.waitFor(() => expect(buttonNamed(panel, "Redo")!.disabled).toBe(false));
  redo(panel);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(3));
  expect(saves(connection)[2].areas).toEqual(saves(connection)[0].areas);
});

test("undo of an extended footprint saves the previous polygon", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
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

test("Remove shape is enabled only while the active area has a shape", async () => {
  const { panel } = mountEditor();
  await startSelecting(panel);
  await tapRoom(panel, "kitchen");
  await vi.waitFor(() => expect(buttonNamed(panel, "Remove shape")!.disabled).toBe(false));
  chip(panel, "Bath").click();
  await vi.waitFor(() => expect(buttonNamed(panel, "Remove shape")!.disabled).toBe(true));
});

test.each<[string, (panel: HTMLElement) => void]>([
  ["Delete", () => key("keydown", "Delete")],
  ["the Remove shape button", (panel) => buttonNamed(panel, "Remove shape")!.click()],
])("%s removes the active shape in one save, and undo brings it back", async (_name, remove) => {
  const { panel, connection } = mountEditor();
  await startSelecting(panel);
  await tapRoom(panel, "kitchen");
  remove(panel);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(saves(connection)[0].areas).toEqual({ kitchen: null });
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ kitchen: KITCHEN });
});
