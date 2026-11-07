// @vitest-environment happy-dom
// Checks undo, redo and removing a shape.
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  areaEntry,
  buttonNamed,
  chooseFromMenu,
  handlers,
  headerButton,
  settle,
  sources,
  resetFakes,
  toastMessages,
  toasts,
} from "./panel-harness";
import {
  KITCHEN,
  pixelBox,
  showFloor,
  siteSaves,
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

const HALL = pixelBox(50, 0, 100, 50);
const ATTIC = pixelBox(0, 0, 80, 80);

const mountTwoFloors = () => {
  const mounted = mountEditor();
  mounted.setFeed([
    { type: "Feature", id: "kitchen", geometry: KITCHEN, properties: { floor_id: "ground", level: 0 } },
    { type: "Feature", id: "hall", geometry: HALL, properties: { floor_id: "ground", level: 0 } },
    { type: "Feature", id: "attic", geometry: ATTIC, properties: { floor_id: "loft", level: 1 } },
  ]);
  return mounted;
};

// The More options button opens the menu, and pressed again closes it.
const toggleMenu = async (panel: HTMLElement) => {
  headerButton(panel, "More options")!.click();
  await settle(panel);
};

test("Clear <floor> removes the floor's room shapes in one save, leaves the outline, and its toast's Undo restores them", async () => {
  const { panel, connection } = mountTwoFloors();
  await startSelecting(panel);
  await chooseFromMenu(panel, "Clear Ground floor");
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(saves(connection)[0].areas).toEqual({ kitchen: null, hall: null });
  expect(siteSaves(connection)).toEqual([]);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Ground floor cleared"]));
  expect(toasts[0].action?.text).toBe("Undo");
  toasts[0].action!.action();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ kitchen: KITCHEN, hall: HALL });
});

test("the clear toast's Undo does nothing once another change came after the clear", async () => {
  const { panel, connection } = mountTwoFloors();
  await startSelecting(panel);
  await chooseFromMenu(panel, "Clear Ground floor");
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Ground floor cleared"]));
  const [cleared] = toasts;
  buttonNamed(panel, "Draw")!.click();
  await activateKitchen(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  cleared.action!.action();
  await settle(panel);
  expect(saves(connection)).toHaveLength(2);
});

test("No floor offers no clear, even with shaped outdoor areas", async () => {
  const { panel, setRegistry, setFeed } = mountTwoFloors();
  setRegistry([areaEntry("kitchen", "Kitchen", "ground"), areaEntry("garden", "Garden", null)]);
  // The editor reads an area's floor from the registry; the feature's properties do not count here.
  setFeed([{ type: "Feature", id: "garden", geometry: HALL, properties: { floor_id: "", level: 0 } }]);
  await showFloor(panel, "No floor");
  await toggleMenu(panel);
  expect(buttonNamed(panel, "Clear floor")!.disabled).toBe(true);
  expect(buttonNamed(panel, "Clear No floor")).toBeUndefined();
});

test("Clear is one undo step, and off on All and on a floor without room shapes", async () => {
  const { panel, connection } = mountTwoFloors();
  await vi.waitFor(() => expect(headerButton(panel, "More options")).toBeDefined());
  await settle(panel);
  await toggleMenu(panel);
  expect(buttonNamed(panel, "Clear floor")!.disabled).toBe(true);
  await toggleMenu(panel);
  await startSelecting(panel);
  await chooseFromMenu(panel, "Clear Ground floor");
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  await toggleMenu(panel);
  expect(buttonNamed(panel, "Clear Ground floor")!.disabled).toBe(true);
  await toggleMenu(panel);
  ctrlZ();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ kitchen: KITCHEN, hall: HALL });
});
