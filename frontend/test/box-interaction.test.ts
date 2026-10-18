// @vitest-environment happy-dom
// Checks map pointer, drag and keyboard events that draft boxes, move rooms and pick areas.

import type { Polygon, Position } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, expect, test, vi } from "vitest";
import {
  dragPan,
  dragRotate,
  handlers,
  queryRenderedFeatures,
  resetFakes,
  sources,
  unprojectPixel,
} from "./panel-harness";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { BoxInteraction } from "../src/box-interaction";

afterEach(resetFakes);

const pixelBox = (x1: number, y1: number, x2: number, y2: number): Polygon => {
  const ring = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1],
  ].map((p) => unprojectPixel(p as [number, number], 300));
  return { type: "Polygon", coordinates: [ring] };
};

const ROOM = pixelBox(0, 0, 50, 50);

const mountInteraction = (overrides: Partial<{
  canDraw: boolean;
  canAdjust: boolean;
  activeFootprint: Polygon | undefined;
  siteBearing: number;
  onBox: (box: Polygon) => void;
  onMove: (from: Position, to: Position) => void;
  onPickRoom: (areaId: string) => void;
}> = {}) => {
  const map = new (fakeMapLibre.Map)({ bearing: 300 }) as unknown as MapLibreMap;
  const onBox = overrides.onBox ?? vi.fn();
  const onMove = overrides.onMove ?? vi.fn();
  const onPickRoom = overrides.onPickRoom ?? vi.fn();

  const interaction = new BoxInteraction(map, {
    canDraw: () => overrides.canDraw ?? true,
    canAdjust: () => overrides.canAdjust ?? false,
    activeFootprint: () => overrides.activeFootprint,
    siteBearing: () => overrides.siteBearing ?? 30,
    onBox,
    onMove,
    onPickRoom,
  });
  interaction.addLayers();
  return { map, interaction, onBox, onMove, onPickRoom };
};

const pointEvent = (x: number, y: number, button = 0) => {
  const [lng, lat] = unprojectPixel([x, y], 300);
  return {
    point: { x, y },
    lngLat: { lng, lat },
    originalEvent: { button, preventDefault: vi.fn() },
  };
};

test("while drawing is enabled the map does not rotate or pan, except with Space", () => {
  const { interaction } = mountInteraction();
  expect(dragPan.isEnabled()).toBe(false);
  expect(dragRotate.isRotationEnabled()).toBe(false);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
  expect(dragPan.isEnabled()).toBe(true);

  window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
  expect(dragPan.isEnabled()).toBe(false);

  interaction.destroy();
});

test("a mouse drag drafts a box and saves it on mouseup", () => {
  const { onBox } = mountInteraction();
  handlers.mousedown(pointEvent(0, 0));
  handlers.mousemove(pointEvent(100, 100));

  expect(sources["spatial-draft"].data).toBeDefined();

  handlers.mouseup(pointEvent(100, 100));
  expect(onBox).toHaveBeenCalledWith(expect.objectContaining({ type: "Polygon" }));
  expect(sources["spatial-draft"].data).toEqual({ type: "FeatureCollection", features: [] });
});

test("two clicks draft a box along the site axis", () => {
  const { onBox } = mountInteraction();
  handlers.click(pointEvent(0, 0));
  expect(onBox).not.toHaveBeenCalled();

  handlers.click(pointEvent(80, 60));
  expect(onBox).toHaveBeenCalledWith(expect.objectContaining({ type: "Polygon" }));
});

test("a drag inside the active footprint moves it", () => {
  const { onMove, onBox } = mountInteraction({ activeFootprint: ROOM });
  handlers.mousedown(pointEvent(25, 25));
  handlers.mousemove(pointEvent(45, 25));
  handlers.mouseup(pointEvent(45, 25));

  expect(onMove).toHaveBeenCalledTimes(1);
  expect(onBox).not.toHaveBeenCalled();
});

test("a click without movement inside the active footprint starts drafting a box", () => {
  const { onBox, onMove } = mountInteraction({ activeFootprint: ROOM });
  handlers.mousedown(pointEvent(25, 25));
  handlers.mouseup(pointEvent(25, 25));
  handlers.click(pointEvent(25, 25));
  expect(onBox).not.toHaveBeenCalled();
  expect(onMove).not.toHaveBeenCalled();

  handlers.click(pointEvent(80, 80));
  expect(onBox).toHaveBeenCalledTimes(1);
});

test("in adjust mode a click on a room picks it", () => {
  const { onPickRoom } = mountInteraction({ canDraw: false, canAdjust: true });
  queryRenderedFeatures.mockReturnValueOnce([{ properties: { area_id: "living_room" } }]);

  handlers.click(pointEvent(10, 10));
  expect(onPickRoom).toHaveBeenCalledWith("living_room");
});

test("Escape cancels an in-progress draft", () => {
  mountInteraction();
  handlers.click(pointEvent(0, 0));
  handlers.mousemove(pointEvent(50, 50));
  expect(sources["spatial-draft"].data).not.toEqual({ type: "FeatureCollection", features: [] });

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(sources["spatial-draft"].data).toEqual({ type: "FeatureCollection", features: [] });
});
