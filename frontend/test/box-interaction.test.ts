// @vitest-environment happy-dom
// Checks map pointer, drag and keyboard events that draft boxes, move rooms and pick areas.

import type { Polygon } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, expect, test, vi } from "vitest";
import {
  dragPan,
  dragRotate,
  fakeMapLibre,
  handlers,
  queryRenderedFeatures,
  resetFakes,
  sources,
  unprojectPixel,
} from "./panel-harness";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { type ActiveRoom, BoxInteraction } from "../src/box-interaction";
import { layerColours, readMapPaint } from "../src/map-paint";
import type { Tool } from "../src/room-editor";

let mounted: BoxInteraction | undefined;

afterEach(() => {
  mounted?.destroy();
  mounted = undefined;
  resetFakes();
});

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

const mountInteraction = (tool: Tool = "draw", activeRoom?: ActiveRoom) => {
  const map = new fakeMapLibre.Map({ bearing: 300 }) as unknown as MapLibreMap;
  const onBox = vi.fn();
  const onMove = vi.fn();
  const onPickRoom = vi.fn();
  mounted = new BoxInteraction(map, {
    tool: () => tool,
    floorPicked: () => true,
    saving: () => false,
    activeRoom: () => activeRoom,
    siteBearing: () => 30,
    onBox,
    onMove,
    onPickRoom,
  });
  mounted.addLayers(layerColours(readMapPaint(document.body, false)));
  return { onBox, onMove, onPickRoom };
};

const pointEvent = (x: number, y: number, button = 0) => {
  const [lng, lat] = unprojectPixel([x, y], 300);
  return {
    point: { x, y },
    lngLat: { lng, lat },
    originalEvent: { button },
    preventDefault: vi.fn(),
  };
};

test("while drawing is enabled the map does not rotate or pan, except with Space", () => {
  mountInteraction();
  expect(dragPan.isEnabled()).toBe(false);
  expect(dragRotate.isEnabled()).toBe(false);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
  expect(dragPan.isEnabled()).toBe(true);

  window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
  expect(dragPan.isEnabled()).toBe(false);
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
  const { onMove, onBox } = mountInteraction("draw", { areaId: "room", footprint: ROOM });
  handlers.mousedown(pointEvent(25, 25));
  handlers.mousemove(pointEvent(45, 25));
  handlers.mouseup(pointEvent(45, 25));

  expect(onMove).toHaveBeenCalledTimes(1);
  expect(onBox).not.toHaveBeenCalled();
});

test("a click without movement inside the active footprint starts drafting a box", () => {
  const { onBox, onMove } = mountInteraction("draw", { areaId: "room", footprint: ROOM });
  handlers.mousedown(pointEvent(25, 25));
  handlers.mouseup(pointEvent(25, 25));
  handlers.click(pointEvent(25, 25));
  expect(onBox).not.toHaveBeenCalled();
  expect(onMove).not.toHaveBeenCalled();

  handlers.click(pointEvent(80, 80));
  expect(onBox).toHaveBeenCalledTimes(1);
});

test("in adjust mode a click on a room picks it", () => {
  const { onPickRoom } = mountInteraction("adjust");
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
