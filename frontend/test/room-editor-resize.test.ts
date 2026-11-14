// @vitest-environment happy-dom
// Checks how the panel wires an edge or corner drag in Select: what it saves, records, hides and shows.
import type { Polygon, Position } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import { EMPTY, buttonNamed, handlers, liveMarkers, mapCanvas, onUpdateOf, queryRenderedFeatures, resetFakes, settle, sources } from "./panel-harness";
import {
  FRAME,
  KITCHEN,
  chip,
  ctrlZ,
  feature,
  key,
  mountEditor,
  mouse,
  pixelBox,
  saves,
  sent,
  sideButtons,
  sideField,
  siteSaves,
  startSelecting,
  tapRoom,
  typeSide,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(() => {
  resetFakes();
  vi.restoreAllMocks();
});

// The lattice corners of a shape, in a fixed order, whatever corner its ring starts at.
const cornerSet = (shape: Polygon) =>
  shape.coordinates[0]
    .slice(0, -1)
    .map((corner) => FRAME.toLattice(corner))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const latticeBox = (left: number, bottom: number, right: number, top: number) =>
  [
    [left, bottom],
    [left, top],
    [right, bottom],
    [right, top],
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
// KITCHEN in lattice units: a pixel is 4 units, and lattice y runs up the screen.
const KITCHEN_BOX = latticeBox(0, -200, 200, 0);

// The draft's own chips that show: plain labels, not the editor's side buttons or the room labels.
const draftLabels = () =>
  liveMarkers()
    .filter((marker) => !marker.element.firstElementChild && !marker.element.matches(".room-label, .building-label"))
    .filter((marker) => marker.element.style.visibility !== "hidden")
    .map((marker) => marker.element.textContent);
// Per side of the kitchen (top, right, bottom, left): grips show nothing, the bottom and left chips a length.
const sideTexts = () => sideButtons().map((button) => button.textContent);
const held = () => sideButtons().map((button) => button.style.borderColor === "var(--primary-color)");
// Where a side's Marker sits, in lattice units.
const sideAt = (edgeIndex: number) => {
  const marker = liveMarkers().find((each) => each.element.firstElementChild === sideButtons()[edgeIndex])!;
  return FRAME.toLatticeUnits(marker.lngLat!).map((units) => Math.round(units));
};
// Where a side's Marker sits against its midpoint, in pixels, and whether its control shows.
const sideOffset = (edgeIndex: number) => liveMarkers().find((each) => each.element.firstElementChild === sideButtons()[edgeIndex])!.offset;
const sideShown = (edgeIndex: number) =>
  liveMarkers().find((each) => each.element.firstElementChild === sideButtons()[edgeIndex])!.element.style.visibility !== "hidden";
const kitchenLabelShown = () => liveMarkers().some((marker) => marker.element.matches('.room-label[data-area="kitchen"]'));

const dragThrough = (points: [number, number][]) => {
  handlers.mousedown(mouse(...points[0]));
  for (const point of points.slice(1)) handlers.mousemove(mouse(...point));
  handlers.mouseup(mouse(...points[points.length - 1]));
};

const selectKitchen = async () => {
  const mounted = mountEditor();
  await startSelecting(mounted.panel);
  await tapRoom(mounted.panel, "kitchen");
  return mounted;
};

// The 70 x 50 px draft is too small for its area label, which shows only from 96 x 40 px.
test("an edge drag counts the width on its chip in place, rings the held side, hides the room label under a draft too small for its area, and saves once with one undo step", async () => {
  const { panel, connection } = await selectKitchen();
  expect(kitchenLabelShown()).toBe(true);
  const press = mouse(1, 25);
  handlers.mousedown(press);
  expect(press.preventDefault).toHaveBeenCalled();
  handlers.mousemove(mouse(-19.2, 25));
  expect(sideTexts()).toEqual(["", "", "7.00 m", "5.00 m"]);
  expect(sideAt(2)).toEqual([60, -200]);
  // The 5.00 m depth chip of this small room stands at the right side.
  expect(sideAt(3)).toEqual([200, -100]);
  expect(held()).toEqual([false, true, false, false]);
  expect(draftLabels()).toEqual([]);
  expect(kitchenLabelShown()).toBe(false);
  handlers.mouseup(mouse(-19.2, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -200, 200, 0));
  // Rebuilt on the saved box, whose ring starts at its bottom left.
  await vi.waitFor(() => expect(held()).toEqual([false, false, false, false]));
  expect(sideTexts()).toEqual(["7.00 m", "", "", "5.00 m"]);
  expect(kitchenLabelShown()).toBe(true);
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(cornerSet(saves(connection)[1].areas.kitchen)).toEqual(KITCHEN_BOX);
});

test("an edge drag released where it started saves nothing and records no undo step", async () => {
  const { panel, connection } = await selectKitchen();
  dragThrough([
    [1, 25],
    [-10, 25],
    [0.6, 25],
  ]);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
  expect(sideTexts()).toEqual(["", "", "5.00 m", "5.00 m"]);
  expect(held()).toEqual([false, false, false, false]);
});

test("the pointer turns into a resize arrow over an edge of the active rectangle, and a move arrow inside it", async () => {
  await selectKitchen();
  handlers.mousemove(mouse(1, 25));
  expect(mapCanvas.style.cursor).toBe("ew-resize");
  handlers.mousemove(mouse(25, 25));
  expect(mapCanvas.style.cursor).toBe("move");
});

test("with the map turned 40 degrees off the site axis the edge drag follows the room's edges", async () => {
  const { panel, connection } = await selectKitchen();
  const map = (panel as unknown as { _map: { setBearing(bearing: number): void; project(at: Position): { x: number; y: number } } })
    ._map;
  map.setBearing(340);
  const screenOf = (point: [number, number]): [number, number] => {
    const { x, y } = map.project(FRAME.fromLattice(point));
    return [x, y];
  };
  dragThrough([screenOf([4, -100]), screenOf([-30, -100]), screenOf([-76.8, -100])]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -200, 200, 0));
});

test("an edge drag of the Building rectangle hides the room labels under its draft and saves the outline", async () => {
  const { panel, connection } = mountEditor();
  await startSelecting(panel);
  chip(panel, "Building").click();
  await settle(panel);
  handlers.mousedown(mouse(99, 150));
  handlers.mousemove(mouse(110, 150));
  expect(kitchenLabelShown()).toBe(false);
  handlers.mouseup(mouse(120, 150));
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(cornerSet(siteSaves(connection)[0].outline!)).toEqual(latticeBox(0, -800, 484, -400));
  expect(saves(connection)).toEqual([]);
});

test("Escape cancels an edge drag without a save", async () => {
  const { panel, connection } = await selectKitchen();
  handlers.mousedown(mouse(1, 25));
  handlers.mousemove(mouse(-19.2, 25));
  key("keydown", "Escape");
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  handlers.mouseup(mouse(-19.2, 25));
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(sideTexts()).toEqual(["", "", "5.00 m", "5.00 m"]);
  expect(held()).toEqual([false, false, false, false]);
  expect(kitchenLabelShown()).toBe(true);
});

test("a refresh during an edge drag keeps the side controls on the draft, and the release saves", async () => {
  const { panel, connection } = await selectKitchen();
  handlers.mousedown(mouse(1, 25));
  handlers.mousemove(mouse(-12, 25));
  await onUpdateOf(connection)();
  await settle(panel);
  expect(sideTexts()).toEqual(["", "", "6.30 m", "5.00 m"]);
  expect(held()).toEqual([false, true, false, false]);
  handlers.mouseup(mouse(-19.2, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -200, 200, 0));
});

test.each<[string, () => void]>([
  ["Ctrl+Z", () => ctrlZ()],
  ["Ctrl+Shift+Z", () => ctrlZ(true)],
  ["Delete", () => key("keydown", "Delete")],
])("%s during an edge drag changes nothing, so the release saves against the room as grabbed", async (_, press) => {
  const { panel, connection } = await selectKitchen();
  // A typed side and an undone one leave both an undo and a redo step.
  typeSide(0, "6");
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  await settle(panel);
  typeSide(0, "7");
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  await settle(panel);
  ctrlZ();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(3));
  await settle(panel);
  const grabbed = saves(connection)[2].areas.kitchen;
  handlers.mousedown(mouse(1, 25));
  handlers.mousemove(mouse(-12, 25));
  const before = sent(connection).length;
  press();
  await settle(panel);
  expect(sent(connection)).toHaveLength(before);
  handlers.mouseup(mouse(-19.2, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(4));
  await settle(panel);
  ctrlZ();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(5));
  expect(saves(connection)[4].areas.kitchen).toEqual(grabbed);
});

// A phone or a tablet: the main pointer is a finger.
const touchScreen = () =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) => ({ matches: media === "(pointer: coarse)", addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
// The map container sits at the page's origin, so client pixels are map pixels.
const pointer = (chip: HTMLElement, type: string, [clientX, clientY]: [number, number]) =>
  chip.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, button: 0, bubbles: true, cancelable: true }));
// A press, its moves and its release on a chip, then the click the browser sends after them.
const pressChip = (chip: HTMLElement, points: [number, number][]) => {
  pointer(chip, "pointerdown", points[0]);
  for (const point of points.slice(1)) pointer(chip, "pointermove", point);
  pointer(chip, "pointerup", points[points.length - 1]);
  chip.click();
};

test("dragging a side chip stretches its own edge and saves once, without opening the field or pressing the map", async () => {
  const { panel, connection, setFeed } = await selectKitchen();
  // A room of 200 x 150 px, whose left chip stands at its own side.
  setFeed([feature("kitchen", pixelBox(0, 0, 200, 150))]);
  await onUpdateOf(connection)();
  await settle(panel);
  // The left edge's chip, pressed 15 px inside the room: beyond the edge's snap radius.
  const left = sideButtons()[3];
  const reached: string[] = [];
  left.parentElement!.addEventListener("mousedown", () => reached.push("mousedown"));
  left.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
  pressChip(left, [
    [15, 75],
    [5, 75],
    [-5, 75],
  ]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -600, 800, 0));
  await settle(panel);
  expect(sideField()).toBeUndefined();
  expect(reached).toEqual([]);
});

test("a tap on a grip opens the length field filled with its side's length and saves nothing", async () => {
  const { panel, connection } = await selectKitchen();
  pressChip(sideButtons()[1], [[50, 25]]);
  expect(sideField()?.value).toBe("5.00 m");
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("dragging the depth chip that stands at the right side rings it alone and counts the width on the bottom chip", async () => {
  const { panel, connection } = await selectKitchen();
  const right = sideButtons()[3];
  pointer(right, "pointerdown", [50, 25]);
  pointer(right, "pointermove", [60, 25]);
  // The chip stands at the right side and the right grip moved to the left: only the chip is ringed.
  expect(held()).toEqual([false, false, false, true]);
  expect(sideTexts()).toEqual(["", "", "6.00 m", "5.00 m"]);
  expect(sideAt(3)).toEqual([240, -100]);
  pointer(right, "pointerup", [60, 25]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(0, -200, 240, 0));
  await settle(panel);
});

test("a side shared with another room on the floor carries a grip, and its length moves to the opposite side", async () => {
  const { panel, connection, setFeed } = await selectKitchen();
  setFeed([feature("kitchen", KITCHEN), feature("bath", pixelBox(0, 50, 50, 80))]);
  await onUpdateOf(connection)();
  await settle(panel);
  expect(sideButtons().map((button) => button.className)).toEqual(["side-chip", "side-grip", "side-grip", "side-chip"]);
  expect(sideTexts()).toEqual(["5.00 m", "", "", "5.00 m"]);
});

test("a press on a chip that the browser cancels ends, so the chips show what a refresh brought meanwhile", async () => {
  const { panel, connection, setFeed } = await selectKitchen();
  const top = sideButtons()[0];
  pointer(top, "pointerdown", [25, 0]);
  setFeed([feature("kitchen", pixelBox(0, 0, 60, 50))]);
  await onUpdateOf(connection)();
  await settle(panel);
  pointer(top, "pointercancel", [25, 0]);
  expect(sideTexts()).toEqual(["", "", "6.00 m", "5.00 m"]);
});

test("a refresh while a chip is pressed keeps the chip, so its drag still saves", async () => {
  const { panel, connection } = await selectKitchen();
  const left = sideButtons()[3];
  pointer(left, "pointerdown", [0, 25]);
  await onUpdateOf(connection)();
  await settle(panel);
  expect(sideButtons()).toContain(left);
  pointer(left, "pointermove", [-19.2, 25]);
  pointer(left, "pointerup", [-19.2, 25]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
});

const CHIP_LABEL = "5.00 m side: drag to stretch, or press to type a length";
const GRIP_LABEL = "Side of 5.00 m: drag to stretch, or press to type a length";

test.each<[string, boolean, string, boolean]>([
  ["a touch screen", true, "44px", true],
  ["a mouse", false, "", false],
])("with %s the chips name their length and the grips their side; only a finger gets 44 px targets and a mark on the chips", async (_, coarse, minimum, chipMark) => {
  if (coarse) touchScreen();
  await selectKitchen();
  const icon = (button: HTMLButtonElement) => button.querySelector<HTMLElement>("ha-svg-icon");
  expect(
    sideButtons().map((button) => [button.getAttribute("aria-label"), button.style.minWidth, button.style.minHeight, icon(button)?.style.transform ?? null, button.textContent]),
  ).toEqual([
    [GRIP_LABEL, minimum, minimum, "rotate(90deg)", ""],
    [GRIP_LABEL, minimum, minimum, "", ""],
    [CHIP_LABEL, minimum, minimum, chipMark ? "" : null, "5.00 m"],
    [CHIP_LABEL, minimum, minimum, chipMark ? "" : null, "5.00 m"],
  ]);
});

// The placement rule at work on the side controls: an unmeasured pill is 0 x 0 px, so a chip sits 8 px off its edge.
test("a room of 200 x 150 px keeps its two chips 8 px outside the bottom and left sides and its grips on their edges", async () => {
  const { panel, connection, setFeed } = await selectKitchen();
  setFeed([feature("kitchen", pixelBox(0, 0, 200, 150))]);
  await onUpdateOf(connection)();
  await settle(panel);
  expect([0, 1, 2, 3].map(sideOffset).map((offset) => offset!.map((n) => Math.round(n) + 0))).toEqual([[0, 0], [0, 0], [0, 8], [-8, 0]]);
  expect([0, 1, 2, 3].map(sideShown)).toEqual([true, true, true, true]);
});

test("a room under 60 px shows its width chip below and its depth chip right of it, and hides the grips", async () => {
  await selectKitchen();
  // The depth chip is the left side's, moved to the right side, where the rule puts it.
  expect(sideOffset(2)).toEqual([0, 8]);
  expect(sideOffset(3)).toEqual([8, 0]);
  expect(FRAME.toLatticeUnits(liveMarkers().find((each) => each.element.firstElementChild === sideButtons()[3])!.lngLat!).map(Math.round)).toEqual([200, -100]);
  expect([0, 1, 2, 3].map(sideShown)).toEqual([false, false, true, true]);
});

test("a press on a chip of a small room brings the grips back", async () => {
  await selectKitchen();
  pointer(sideButtons()[2], "pointerdown", [25, 50]);
  expect([0, 1, 2, 3].map(sideShown)).toEqual([true, true, true, true]);
});

test("once the grips are revealed a small room has exactly one control on each of its four sides", async () => {
  await selectKitchen();
  pointer(sideButtons()[2], "pointerdown", [25, 50]);
  // Top, left (the right grip moved over, as its chip left), bottom, right (the depth chip).
  expect([0, 1, 2, 3].map(sideAt).map((at) => at.map((n) => n + 0))).toEqual([
    [100, 0],
    [0, -100],
    [100, -200],
    [200, -100],
  ]);
});

test("after the room is deselected a map move leaves its removed side markers alone", async () => {
  const { panel } = await selectKitchen();
  const removed = liveMarkers().filter((marker) => marker.element.firstElementChild instanceof HTMLButtonElement);
  expect(removed).toHaveLength(4);
  queryRenderedFeatures.mockReturnValue([]);
  handlers.click(mouse(300, 300));
  await settle(panel);
  expect(sideButtons()).toEqual([]);
  for (const marker of removed) marker.offset = [99, 99];
  handlers.move();
  expect(removed.map((marker) => marker.offset)).toEqual([[99, 99], [99, 99], [99, 99], [99, 99]]);
});
