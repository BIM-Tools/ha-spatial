// @vitest-environment happy-dom
// Checks moving a room by a drag inside it.
import area from "@turf/area";
import type { Feature, Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import { EMPTY, buttonNamed, handlers, onUpdateOf, settle, sources, resetFakes } from "./panel-harness";
import {
  FRAME,
  pixelBox,
  KITCHEN,
  mountEditor,
  activeChip,
  startDrawing,
  mouse,
  drag,
  key,
  saves,
  expectOnGrid,
  expectCornersNear,
  activateKitchen,
  startAdjusting,
  tapRoom,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

test("a drag that ends less than half a grid step from where it started saves nothing and records no undo step", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(40, 25));
  handlers.mousemove(mouse(25.2, 25.1));
  handlers.mouseup(mouse(25.2, 25.1));
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("a move shifts the room by whole grid steps", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  drag([25, 25], [45.3, 25.3]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const moved = saves(connection)[0].areas.kitchen;
  expectOnGrid(FRAME, moved, 1);
  moved.coordinates[0].forEach((corner, index) => {
    const [x, y] = FRAME.toLattice(corner);
    const [fromX, fromY] = FRAME.toLattice(KITCHEN.coordinates[0][index]);
    expect([x - fromX, y - fromY]).toEqual([80, 0]);
  });
});

test("a moved room shares its neighbour's edge", async () => {
  const { panel, connection, setFeed } = mountEditor();
  const bath = pixelBox(60, 0, 100, 50);
  setFeed([
    { type: "Feature", id: "kitchen", geometry: KITCHEN, properties: { floor_id: "ground", level: 0 } },
    { type: "Feature", id: "bath", geometry: bath, properties: { floor_id: "ground", level: 0 } },
  ]);
  await startDrawing(panel);
  await activateKitchen(panel);
  drag([25, 25], [31.3, 26]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const moved = saves(connection)[0].areas.kitchen.coordinates[0].map((corner) => FRAME.toLattice(corner));
  const neighbour = bath.coordinates[0].map((corner) => FRAME.toLattice(corner));
  expect(moved[1]).toEqual(neighbour[0]);
  expect(moved[2]).toEqual(neighbour[3]);
});

test("in Draw a drag inside the active room moves it in one batch, and undo puts it back", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(45, 25));
  expectCornersNear((sources["spatial-draft"].data as Feature<Polygon>).geometry, pixelBox(20, 0, 70, 50));
  handlers.mouseup(mouse(45, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  const [{ areas }] = saves(connection);
  expect(Object.keys(areas)).toEqual(["kitchen"]);
  expectCornersNear(areas.kitchen, pixelBox(20, 0, 70, 50));
  expect(area(areas.kitchen)).toBeCloseTo(25, 1);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1].areas).toEqual({ kitchen: KITCHEN });
});

test("in Adjust a drag inside the active room moves it without panning, and a tap still selects", async () => {
  const { panel, connection } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const press = mouse(25, 25);
  handlers.mousedown(press);
  expect(press.preventDefault).toHaveBeenCalled();
  handlers.mousemove(mouse(45, 25));
  handlers.mouseup(mouse(45, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expectCornersNear(saves(connection)[0].areas.kitchen, pixelBox(20, 0, 70, 50));
  await tapRoom(panel, "bath");
  expect(activeChip(panel)).toBe("Bath");
});

test("Space during a move cancels it", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  await activateKitchen(panel);
  handlers.mousedown(mouse(25, 25));
  handlers.mousemove(mouse(45, 25));
  key("keydown", " ");
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  handlers.mouseup(mouse(45, 25));
  key("keyup", " ");
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("an update during a move saves the room as it was grabbed", async () => {
  const { panel, connection, setFeed } = mountEditor();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  handlers.mousedown(mouse(25, 25));
  setFeed([{ type: "Feature", id: "kitchen", geometry: pixelBox(0, 0, 60, 60), properties: { floor_id: "ground", level: 0 } }]);
  await onUpdateOf(connection)();
  handlers.mousemove(mouse(45, 25));
  handlers.mouseup(mouse(45, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expectCornersNear(saves(connection)[0].areas.kitchen, pixelBox(20, 0, 70, 50));
});
