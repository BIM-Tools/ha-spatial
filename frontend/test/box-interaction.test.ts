// @vitest-environment happy-dom
// Checks map pointer, drag and keyboard events that draft boxes, move rooms and pick areas.

import type { Polygon, Position } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, expect, test, vi } from "vitest";
import {
  dragPan,
  dragRotate,
  fakeMapLibre,
  handlers,
  queryRenderedFeatures,
  resetFakes,
  SITE,
  sources,
  unprojectPixel,
} from "./panel-harness";
import { siteFrameData } from "./site-frame-fixture";
import { METRIC_UNITS } from "./units-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { type ActiveRoom, BoxInteraction } from "../src/box-interaction";
import { layerColours, readMapPaint } from "../src/map-paint";
import type { Tool } from "../src/room-editor";
import { PlanFrame } from "../src/site-frame";
import { candidatesOf } from "../src/snap";

const FRAME = PlanFrame.fromSite(siteFrameData(SITE, 30));

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

// The neighbours are snap candidates, each a room by its index.
const mountInteraction = (
  tool: Tool = "draw",
  activeRoom?: ActiveRoom,
  framed = true,
  { neighbours = [] as Polygon[], frame = () => FRAME as PlanFrame | undefined } = {},
) => {
  const map = new fakeMapLibre.Map({ bearing: 300 }) as unknown as MapLibreMap;
  const onBox = vi.fn();
  const onMove = vi.fn();
  const onPickRoom = vi.fn();
  const onResize = vi.fn();
  const onResizing = vi.fn();
  mounted = new BoxInteraction(map, {
    tool: () => tool,
    floorPicked: () => true,
    saving: () => false,
    activeRoom: () => activeRoom,
    siteBearing: () => 30,
    siteFrame: () => (framed ? frame() : undefined),
    snapCandidates: (snapFrame, exclude) =>
      candidatesOf(
        snapFrame,
        neighbours.filter((_, index) => String(index) !== exclude),
        undefined,
      ),
    units: () => METRIC_UNITS,
    onBox,
    onMove,
    onResize,
    onResizing,
    onPickRoom,
  });
  mounted.addLayers(layerColours(readMapPaint(document.body, false)));
  return { onBox, onMove, onPickRoom, onResize, onResizing };
};

const pointEvent = (x: number, y: number, button = 0, altKey = false) => {
  const [lng, lat] = unprojectPixel([x, y], 300);
  return {
    point: { x, y },
    lngLat: { lng, lat },
    originalEvent: { button, altKey },
    preventDefault: vi.fn(),
  };
};

const cornerAt = (x: number, y: number, frame = FRAME) => frame.toLattice(unprojectPixel([x, y], 300));
const highlighted = () =>
  (sources["spatial-snap"].data as { features: { geometry: { type: string; coordinates: Position } }[] }).features.map(
    ({ geometry }) => geometry,
  );
const highlightedCorner = (frame = FRAME) => {
  const [geometry] = highlighted();
  return geometry?.type === "Point" ? frame.toLattice(geometry.coordinates) : undefined;
};
const boxCorners = (box: Polygon, frame = FRAME) => box.coordinates[0].map((corner) => frame.toLattice(corner));
const pointer = (coarse: boolean) =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        matches: coarse && media === "(pointer: coarse)",
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );

// The neighbour's top right corner sits at pixel (50, 0).
const NEIGHBOUR = pixelBox(0, 0, 50, 50);

test("a box corner snaps to a neighbour corner and lights it", () => {
  const { onBox } = mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  handlers.mousedown(pointEvent(150, 100));
  handlers.mousemove(pointEvent(140, 90));
  handlers.mousemove(pointEvent(54, 3));
  expect(highlightedCorner()).toEqual(cornerAt(50, 0));
  handlers.mouseup(pointEvent(54, 3));
  expect(boxCorners(onBox.mock.calls[0][0])).toContainEqual(cornerAt(50, 0));
  expect(highlighted()).toEqual([]);
});

test("a box corner near an axis edge lands exactly on it, and the edge lights up", () => {
  const { onBox } = mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  handlers.mousedown(pointEvent(150, 100));
  handlers.mousemove(pointEvent(140, 90));
  handlers.mousemove(pointEvent(53, 30.2));
  expect(highlighted().map(({ type }) => type)).toEqual(["LineString"]);
  handlers.mouseup(pointEvent(53, 30.2));
  expect(boxCorners(onBox.mock.calls[0][0])).toContainEqual([cornerAt(50, 0)[0], cornerAt(0, 30)[1]]);
});

test("the hover in Draw shows the highlight before the first corner", () => {
  mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  handlers.mousemove(pointEvent(52, 1));
  expect(highlightedCorner()).toEqual(cornerAt(50, 0));
  handlers.mousemove(pointEvent(120, 120));
  expect(highlighted()).toEqual([]);
});

test("Alt places on the lattice without a highlight", () => {
  const { onBox } = mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  handlers.mousemove(pointEvent(54, 3, 0, true));
  expect(highlighted()).toEqual([]);
  handlers.mousedown(pointEvent(54, 3, 0, true));
  handlers.mousemove(pointEvent(140, 90, 0, true));
  handlers.mousemove(pointEvent(150.3, 100.3, 0, true));
  expect(highlighted()).toEqual([]);
  handlers.mouseup(pointEvent(150.3, 100.3, 0, true));
  const corners = boxCorners(onBox.mock.calls[0][0]);
  expect(corners).toContainEqual(cornerAt(54, 3));
  expect(corners).toContainEqual(cornerAt(150.3, 100.3));
});

test("Alt keydown and keyup are prevented while drawing", () => {
  mountInteraction();
  for (const type of ["keydown", "keyup"]) {
    const alt = new KeyboardEvent(type, { key: "Alt", cancelable: true });
    window.dispatchEvent(alt);
    expect(alt.defaultPrevented).toBe(true);
  }
});

test("in Adjust Alt is prevented through the release of a move made with it, and left alone otherwise", () => {
  const room = pixelBox(60, 0, 100, 50);
  mountInteraction("adjust", { areaId: "1", footprint: room }, true, { neighbours: [NEIGHBOUR, room] });
  const alt = (type: string) => {
    const event = new KeyboardEvent(type, { key: "Alt", cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(alt("keydown")).toBe(false);
  handlers.mousedown(pointEvent(80, 25, 0, true));
  handlers.mousemove(pointEvent(70, 25, 0, true));
  handlers.mouseup(pointEvent(70, 25, 0, true));
  expect(alt("keyup")).toBe(true);
  expect(alt("keydown")).toBe(false);
  expect(alt("keyup")).toBe(false);
});

test("a moved room snaps its corner to a neighbour's corner", () => {
  const room = pixelBox(60, 0, 100, 50);
  const { onMove } = mountInteraction("adjust", { areaId: "1", footprint: room }, true, { neighbours: [NEIGHBOUR, room] });
  handlers.mousedown(pointEvent(80, 25));
  handlers.mousemove(pointEvent(75, 25));
  expect(highlightedCorner()).toEqual(cornerAt(50, 0));
  handlers.mouseup(pointEvent(75, 25));
  expect(boxCorners(onMove.mock.calls[0][1])[0]).toEqual(cornerAt(50, 0));
  expect(highlighted()).toEqual([]);
});

test("the radius is 12 px on a coarse pointer and 8 px on a fine one", () => {
  const query = pointer(false);
  mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  handlers.mousemove(pointEvent(60, 0));
  expect(highlighted()).toEqual([]);
  query.mockRestore();
  pointer(true);
  handlers.mousemove(pointEvent(60, 0));
  expect(highlightedCorner()).toEqual(cornerAt(50, 0));
  vi.restoreAllMocks();
});

test("on a coarse pointer two taps each snap, and the highlight shows after the first tap", () => {
  pointer(true);
  const other = pixelBox(150, 100, 200, 150);
  const { onBox } = mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR, other] });
  handlers.click(pointEvent(60, 0));
  expect(highlightedCorner()).toEqual(cornerAt(50, 0));
  handlers.click(pointEvent(140, 100));
  const corners = boxCorners(onBox.mock.calls[0][0]);
  expect(corners).toContainEqual(cornerAt(50, 0));
  expect(corners).toContainEqual(cornerAt(150, 100));
  expect(highlighted()).toEqual([]);
  vi.restoreAllMocks();
});

test("a site update during a drag keeps the gesture's frame and candidates", () => {
  let frame = FRAME;
  const turned = PlanFrame.fromSite(siteFrameData(SITE, 75));
  const { onBox } = mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR], frame: () => frame });
  handlers.mousedown(pointEvent(150, 100));
  handlers.mousemove(pointEvent(140, 90));
  frame = turned;
  handlers.mousemove(pointEvent(54, 3));
  expect(highlightedCorner()).toEqual(cornerAt(50, 0));
  handlers.mouseup(pointEvent(54, 3));
  expect(onBox).toHaveBeenCalledWith(expect.anything(), FRAME);
  expect(boxCorners(onBox.mock.calls[0][0])).toContainEqual(cornerAt(50, 0));
});

test("Escape, Space and a tool change clear the highlight", () => {
  mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  const hover = () => {
    handlers.mousemove(pointEvent(52, 1));
    expect(highlighted()).toHaveLength(1);
  };
  hover();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(highlighted()).toEqual([]);
  hover();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
  expect(highlighted()).toEqual([]);
  handlers.mousemove(pointEvent(52, 1));
  expect(highlighted()).toEqual([]);
  window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
  hover();
  mounted!.toolChanged();
  expect(highlighted()).toEqual([]);
});

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
  expect(onBox).toHaveBeenCalledWith(expect.objectContaining({ type: "Polygon" }), FRAME);
  expect(sources["spatial-draft"].data).toEqual({ type: "FeatureCollection", features: [] });
});

test("two clicks draft a box along the site axis", () => {
  const { onBox } = mountInteraction();
  handlers.click(pointEvent(0, 0));
  expect(onBox).not.toHaveBeenCalled();

  handlers.click(pointEvent(80, 60));
  expect(onBox).toHaveBeenCalledWith(expect.objectContaining({ type: "Polygon" }), FRAME);
});

test("the first of two taps shows the start dot, and the box once each side is a grid step", () => {
  mountInteraction();
  const draftType = () => (sources["spatial-draft"].data as { geometry: { type: string } }).geometry.type;
  handlers.click(pointEvent(0, 0));
  expect(draftType()).toBe("Point");
  handlers.mousemove(pointEvent(80, 60));
  expect(draftType()).toBe("Polygon");
});

test("before the site frame arrives presses and taps draw and move nothing", () => {
  const { onBox, onMove } = mountInteraction("draw", { areaId: "room", footprint: ROOM }, false);
  handlers.mousedown(pointEvent(25, 25));
  handlers.mousemove(pointEvent(45, 25));
  handlers.mouseup(pointEvent(45, 25));
  handlers.click(pointEvent(100, 100));
  handlers.click(pointEvent(180, 160));
  expect(onBox).not.toHaveBeenCalled();
  expect(onMove).not.toHaveBeenCalled();
  expect(sources["spatial-draft"].data).toEqual({ type: "FeatureCollection", features: [] });
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

test("in Adjust a press on an edge of the active rectangle resizes it instead of moving it, and says when it starts and ends", () => {
  const { onMove, onResize, onResizing } = mountInteraction("adjust", { areaId: "room", footprint: ROOM });
  const press = pointEvent(48, 25);
  handlers.mousedown(press);
  expect(press.preventDefault).toHaveBeenCalled();
  handlers.mousemove(pointEvent(50, 25));
  expect(onResizing).not.toHaveBeenCalled();
  handlers.mousemove(pointEvent(60, 25));
  expect(onResizing).toHaveBeenLastCalledWith(true);
  handlers.mouseup(pointEvent(70, 25));
  expect(onMove).not.toHaveBeenCalled();
  expect(onResizing).toHaveBeenLastCalledWith(false);
  const corners = boxCorners(onResize.mock.calls[0][1]);
  expect(corners).toContainEqual(cornerAt(72, 0));
  expect(corners).toContainEqual(cornerAt(0, 50));
});

test("in Draw an edge press of the active room moves it, as edges resize only in Adjust", () => {
  const { onMove, onResize } = mountInteraction("draw", { areaId: "room", footprint: ROOM });
  handlers.mousedown(pointEvent(48, 25));
  handlers.mousemove(pointEvent(60, 25));
  handlers.mouseup(pointEvent(60, 25));
  expect(onResize).not.toHaveBeenCalled();
  expect(onMove).toHaveBeenCalledTimes(1);
});

test("Escape cancels an in-progress draft", () => {
  mountInteraction();
  handlers.click(pointEvent(0, 0));
  handlers.mousemove(pointEvent(50, 50));
  expect(sources["spatial-draft"].data).not.toEqual({ type: "FeatureCollection", features: [] });

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(sources["spatial-draft"].data).toEqual({ type: "FeatureCollection", features: [] });
});
