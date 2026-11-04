// @vitest-environment happy-dom
// Checks panning, Space and Escape around Draw, and when the tools are off.
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
  mountEditor,
  showFloor,
  startDrawing,
  mouse,
  tap,
  drag,
  key,
  saves,
  tapRoom,
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

test("on All the tools are disabled, and Draw chosen on a floor draws nothing there", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  expect(buttonNamed(panel, "Draw")!.disabled).toBe(true);
  expect(dragPan.isEnabled()).toBe(true);
  tap(100, 0);
  tap(140, 30);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("a press or taps while Space is held draw nothing", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  key("keydown", " ");
  drag([100, 0], [140, 30]);
  tap(100, 0);
  tap(140, 30);
  key("keyup", " ");
  await settle(panel);
  expect(saves(connection)).toEqual([]);
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

test("outside Draw Space and Escape keep their usual meaning, also when Space was held on leaving Draw", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  key("keydown", " ");
  buttonNamed(panel, "Adjust")!.click();
  await tapRoom(panel, "kitchen");
  const space = new KeyboardEvent("keydown", { key: " ", cancelable: true });
  window.dispatchEvent(space);
  expect(space.defaultPrevented).toBe(false);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(45, 25));
  key("keydown", "Escape");
  handlers.mouseup(mouse(45, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
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

test("Space keeps its usual meaning on All after Draw, so it still presses a focused button", async () => {
  const { panel } = mountEditor();
  await startDrawing(panel);
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  const space = new KeyboardEvent("keydown", { key: " ", cancelable: true });
  window.dispatchEvent(space);
  expect(space.defaultPrevented).toBe(false);
});
