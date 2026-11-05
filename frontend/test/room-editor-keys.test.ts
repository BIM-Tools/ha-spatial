// @vitest-environment happy-dom
// Checks panning, Space and Escape around Draw, and the keys and taps that do nothing.
import { afterEach, expect, test, vi } from "vitest";
import {
  buttonNamed,
  dragPan,
  dragRotate,
  handlers,
  mapCreated,
  settle,
  touchZoomRotate,
  resetFakes,
} from "./panel-harness";
import {
  type Panel,
  mountEditor,
  activeFilter,
  chip,
  showFloor,
  startDrawing,
  mouse,
  tap,
  key,
  saves,
  tapRoom,
  sideButtons,
  sideField,
  ctrlZ,
  buildingHighlight,
  renameField,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

test("in Draw the map pans only while Space is held, and leaving Draw restores panning", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  expect(dragPan.isEnabled()).toBe(true);
  buttonNamed(panel, "Draw")!.click();
  expect(dragPan.isEnabled()).toBe(false);
  key("keydown", " ");
  expect(dragPan.isEnabled()).toBe(true);
  key("keyup", " ");
  expect(dragPan.isEnabled()).toBe(false);
  buttonNamed(panel, "Adjust")!.click();
  expect(dragPan.isEnabled()).toBe(true);
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

test("leaving the panel in Draw turns panning back on", async () => {
  const { panel } = mountEditor();
  await startDrawing(panel);
  expect(dragPan.isEnabled()).toBe(false);
  panel.remove();
  expect(dragPan.isEnabled()).toBe(true);
});

test("Draw chosen before the map attaches takes effect when it does", async () => {
  let release = () => {};
  // Holds the map style, the last step before the map is created.
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ json: async () => ({ sprite: [], glyphs: "/g", layers: [] }) } as Response);
      }),
  );
  const { panel } = mountEditor();
  await vi.waitFor(() => expect(buttonNamed(panel, "Ground floor")).toBeDefined());
  buttonNamed(panel, "Ground floor")!.click();
  await settle(panel);
  buttonNamed(panel, "Draw")!.click();
  release();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(dragPan.isEnabled()).toBe(false);
});

// Each row leaves Draw with Space held; Escape outside Draw does not cancel a move.
test.each<[string, (panel: Panel, connection: { sendMessagePromise: unknown }) => Promise<void>]>([
  [
    "Adjust",
    async (panel, connection) => {
      await tapRoom(panel, "kitchen");
      handlers.mousedown(mouse(25, 25));
      handlers.mousemove(mouse(45, 25));
      key("keydown", "Escape");
      handlers.mouseup(mouse(45, 25));
      await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
    },
  ],
  ["All", async () => {}],
])("after Draw, in %s, Space keeps its usual meaning, so it still presses a focused button", async (tool, after) => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  key("keydown", " ");
  buttonNamed(panel, tool)!.click();
  await settle(panel);
  const space = new KeyboardEvent("keydown", { key: " ", cancelable: true });
  window.dispatchEvent(space);
  expect(space.defaultPrevented).toBe(false);
  await after(panel as Panel, connection);
});

test("Space during a save in Draw leaves the map flat and turned to the site axis", async () => {
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
  key("keydown", " ");
  key("keyup", " ");
  expect(dragPan.isEnabled()).toBe(false);
  expect(dragRotate.isEnabled()).toBe(false);
  release();
});

const keyIn = (field: HTMLElement, name: string, ctrlKey = false) =>
  field.dispatchEvent(new KeyboardEvent("keydown", { key: name, ctrlKey, bubbles: true, composed: true }));

// Each row starts in Draw after one saved box, so there is a step to undo and a shape to delete.
test.each<[string, (panel: Panel) => Promise<void>]>([
  [
    "Ctrl+Z in the rename field or a side field",
    async (panel) => {
      chip(panel, "Hall").click();
      await settle(panel);
      keyIn(renameField(panel)!, "z", true);
      buttonNamed(panel, "Adjust")!.click();
      await tapRoom(panel, "kitchen");
      sideButtons()[0].click();
      keyIn(sideField()!, "z", true);
    },
  ],
  [
    "Delete without a shape, or in a field",
    async (panel) => {
      key("keydown", "Delete");
      chip(panel, "Kitchen").click();
      await settle(panel);
      chip(panel, "Kitchen").click();
      await settle(panel);
      keyIn(renameField(panel)!, "Delete");
    },
  ],
  [
    "on All, where the tools are off and nothing is highlighted, Ctrl+Z, Ctrl+Shift+Z and taps",
    async (panel) => {
      buttonNamed(panel, "All")!.click();
      await settle(panel);
      expect(dragPan.isEnabled()).toBe(true);
      expect(buildingHighlight()).toBe("none");
      expect(activeFilter()).toEqual(["==", ["get", "area_id"], ""]);
      ctrlZ();
      ctrlZ(true);
      tap(100, 100);
      tap(140, 130);
    },
  ],
])("%s change nothing", async (_name, act) => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  await act(panel as Panel);
  await settle(panel);
  expect(saves(connection)).toHaveLength(1);
});
