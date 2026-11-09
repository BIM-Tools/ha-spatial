// @vitest-environment happy-dom
// Checks map pointer, drag and keyboard events that draft boxes, move rooms and pick areas.

import type { Feature, FeatureCollection, Point, Polygon, Position } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, expect, test, vi } from "vitest";
import { EMPTY, fakeMapLibre, handlers, layers, liveMarkers, nextFrame, resetFakes, SITE, sources, unprojectPixel } from "./panel-harness";
import { FRAME, pixelBox } from "./room-editor-fixture";
import { siteFrameData } from "./site-frame-fixture";
import { METRIC_UNITS } from "./units-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { type ActiveRoom, BoxInteraction, type BoxInteractionCallbacks } from "../src/box-interaction";
import { layerColours, readMapPaint } from "../src/map-paint";
import type { Tool } from "../src/room-editor";
import { PlanFrame } from "../src/site-frame";

let mounted: BoxInteraction | undefined;

afterEach(() => {
  mounted?.destroy();
  mounted = undefined;
  resetFakes();
});


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
  const onResizing = vi.fn<BoxInteractionCallbacks["onResizing"]>(() => []);
  mounted = new BoxInteraction(map, {
    snapshot: () => ({
      tool,
      floorPicked: true,
      saving: false,
      activeRoom,
      siteBearing: 30,
      siteFrame: framed ? frame() : undefined,
      units: METRIC_UNITS,
      floorAreaIds: neighbours.map((_, index) => String(index)),
      footprints: new Map(neighbours.map((neighbour, index) => [String(index), neighbour])),
      mapGuide: undefined,
    }),
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
const highlightedTypes = () => highlighted().map(({ type }) => type);
const marker = () => (sources["spatial-snap-marker"].data as FeatureCollection<Point>).features.map(({ geometry }) => FRAME.toLattice(geometry.coordinates));
// A hover in Draw snaps on the next animation frame.
const hoverAt = async (x: number, y: number, altKey = false) => {
  handlers.mousemove(pointEvent(x, y, 0, altKey));
  await nextFrame();
};
// A point snapped onto a neighbour's corner lights the two walls that meet there, and the corner.
const CORNER_SNAP = ["LineString", "LineString", "Point"];
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

test("a box corner snaps to a neighbour corner and lights both its walls", () => {
  const { onBox } = mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  handlers.mousedown(pointEvent(150, 100));
  handlers.mousemove(pointEvent(140, 90));
  handlers.mousemove(pointEvent(54, 3));
  expect(highlightedTypes()).toEqual(CORNER_SNAP);
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

test("a wall lights only 24 px either side of the snapped point, up to its end", async () => {
  mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  await hoverAt(53, 30.2);
  const ends = (highlighted()[0].coordinates as unknown as Position[]).map((end) => FRAME.toLatticeUnits(end));
  const expected = [FRAME.toLatticeUnits(unprojectPixel([50, 6], 300)), FRAME.toLatticeUnits(unprojectPixel([50, 50], 300))];
  const sorted = (points: number[][]) => [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  sorted(ends).forEach((end, index) => {
    expect(end[0]).toBeCloseTo(sorted(expected)[index][0], 0);
    expect(end[1]).toBeCloseTo(sorted(expected)[index][1], 0);
  });
});

test("the active room's own walls never light up while drawing next to it", async () => {
  mountInteraction("draw", { areaId: "0", footprint: NEIGHBOUR }, true, { neighbours: [NEIGHBOUR] });
  await hoverAt(52, 1);
  expect(highlighted()).toEqual([]);
});

test("the hover in Draw marks where the first corner lands and lights what the first click then snaps to", async () => {
  mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  await hoverAt(120, 120);
  expect(highlighted()).toEqual([]);
  expect(marker()).toHaveLength(1);
  handlers.mouseout();
  expect(marker()).toEqual([]);
  await hoverAt(54, 3);
  expect(highlightedTypes()).toEqual(CORNER_SNAP);
  expect(marker()).toEqual([cornerAt(50, 0)]);
  const lit = highlighted();
  handlers.click(pointEvent(54, 3));
  expect(FRAME.toLattice((sources["spatial-draft"].data as Feature<Point>).geometry.coordinates)).toEqual(cornerAt(50, 0));
  expect(highlighted()).toEqual(lit);
  expect(marker()).toEqual([]);
});

test("Alt places on the lattice without a highlight", async () => {
  const { onBox } = mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  await hoverAt(54, 3, true);
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

test("in Select Alt is prevented through the release of a move made with it, and left alone otherwise", () => {
  const room = pixelBox(60, 0, 100, 50);
  mountInteraction("select", { areaId: "1", footprint: room }, true, { neighbours: [NEIGHBOUR, room] });
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
  const { onMove } = mountInteraction("select", { areaId: "1", footprint: room }, true, { neighbours: [NEIGHBOUR, room] });
  handlers.mousedown(pointEvent(80, 25));
  handlers.mousemove(pointEvent(75, 25));
  expect(highlightedTypes()).toEqual(CORNER_SNAP);
  handlers.mouseup(pointEvent(75, 25));
  expect(boxCorners(onMove.mock.calls[0][1])[0]).toEqual(cornerAt(50, 0));
  expect(highlighted()).toEqual([]);
});

test("the radius is 12 px on a coarse pointer and 8 px on a fine one", async () => {
  const query = pointer(false);
  mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  await hoverAt(60, 0);
  expect(highlighted()).toEqual([]);
  query.mockRestore();
  pointer(true);
  await hoverAt(60, 0);
  expect(highlightedTypes()).toEqual(CORNER_SNAP);
  vi.restoreAllMocks();
});

test("on a coarse pointer two taps each snap, and the highlight shows after the first tap", () => {
  pointer(true);
  const other = pixelBox(150, 100, 200, 150);
  const { onBox } = mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR, other] });
  handlers.click(pointEvent(60, 0));
  expect(highlightedTypes()).toEqual(CORNER_SNAP);
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
  expect(highlightedTypes()).toEqual(CORNER_SNAP);
  handlers.mouseup(pointEvent(54, 3));
  expect(onBox).toHaveBeenCalledWith(expect.anything(), FRAME);
  expect(boxCorners(onBox.mock.calls[0][0])).toContainEqual(cornerAt(50, 0));
});

test("Escape, Space and a tool change clear the highlight", async () => {
  mountInteraction("draw", undefined, true, { neighbours: [NEIGHBOUR] });
  const hover = async () => {
    await hoverAt(52, 1);
    expect(highlightedTypes()).toEqual(CORNER_SNAP);
  };
  await hover();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(highlighted()).toEqual([]);
  await hover();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
  expect(highlighted()).toEqual([]);
  await hoverAt(52, 1);
  expect(highlighted()).toEqual([]);
  window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
  await hover();
  mounted!.toolChanged();
  expect(highlighted()).toEqual([]);
});


test("the first of two taps shows the start dot, and the box once each side is a grid step", () => {
  mountInteraction();
  const draftType = () => (sources["spatial-draft"].data as { geometry: { type: string } }).geometry.type;
  handlers.click(pointEvent(0, 0));
  expect(draftType()).toBe("Point");
  handlers.mousemove(pointEvent(80, 60));
  expect(draftType()).toBe("Polygon");
});

test.each([
  ["a drag on the grid narrower than half a step", false, 0.3],
  ["an Alt drag 3 lattice units wide", true, 0.75],
])("%s yields no box, and shows only the start dot while drawn", (_name, altKey, widthPx) => {
  const { onBox } = mountInteraction();
  handlers.mousedown(pointEvent(100, 0, 0, altKey));
  handlers.mousemove(pointEvent(100 + widthPx, 30, 0, altKey));
  const draft = sources["spatial-draft"].data as Feature;
  expect(draft.geometry.type).toBe("Point");
  expect(FRAME.toLattice((draft.geometry as Point).coordinates)).toEqual([400, 0]);
  expect(layers.find((layer) => layer.id === "spatial-draft-point")).toMatchObject({ type: "circle", source: "spatial-draft" });
  expect(liveMarkers()).toEqual([]);
  handlers.mouseup(pointEvent(100 + widthPx, 30, 0, altKey));
  expect(onBox).not.toHaveBeenCalled();
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
});

test("a press or taps while Space is held draw nothing", () => {
  const { onBox } = mountInteraction();
  const tapAt = (x: number, y: number) => {
    handlers.mousedown(pointEvent(x, y));
    handlers.mouseup(pointEvent(x, y));
    handlers.click(pointEvent(x, y));
  };
  window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
  handlers.mousedown(pointEvent(100, 0));
  handlers.mousemove(pointEvent(102, 2));
  handlers.mousemove(pointEvent(140, 30));
  handlers.mouseup(pointEvent(140, 30));
  tapAt(100, 0);
  tapAt(140, 30);
  window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
  expect(onBox).not.toHaveBeenCalled();
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


test("in Select a press on an edge of the active rectangle resizes it instead of moving it, and says when it starts and ends", () => {
  const { onMove, onResize, onResizing } = mountInteraction("select", { areaId: "room", footprint: ROOM });
  const press = pointEvent(48, 25);
  handlers.mousedown(press);
  expect(press.preventDefault).toHaveBeenCalled();
  handlers.mousemove(pointEvent(50, 25));
  expect(onResizing).not.toHaveBeenCalled();
  handlers.mousemove(pointEvent(60, 25));
  expect(onResizing).toHaveBeenLastCalledWith({ target: { kind: "edge", index: 1 }, draft: expect.objectContaining({ type: "Polygon" }) });
  expect(boxCorners(onResizing.mock.lastCall![0]!.draft)).toContainEqual(cornerAt(62, 0));
  handlers.mouseup(pointEvent(70, 25));
  expect(onMove).not.toHaveBeenCalled();
  expect(onResizing).toHaveBeenLastCalledWith(undefined);
  const corners = boxCorners(onResize.mock.calls[0][1]);
  expect(corners).toContainEqual(cornerAt(72, 0));
  expect(corners).toContainEqual(cornerAt(0, 50));
});

test("in Draw an edge press of the active room moves it, as edges resize only in Select", () => {
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
