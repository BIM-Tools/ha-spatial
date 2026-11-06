// @vitest-environment happy-dom
// Checks how the panel wires an edge or corner drag in Adjust: what it saves, records, hides and shows.
import type { Polygon, Position } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import { EMPTY, buttonNamed, handlers, liveMarkers, mapCanvas, onUpdateOf, resetFakes, settle, sources } from "./panel-harness";
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
  startAdjusting,
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

// The draft's own chips: plain labels, not the editor's side buttons or the room labels.
const draftLabels = () =>
  liveMarkers()
    .filter((marker) => !marker.element.firstElementChild && !marker.element.matches(".room-label, .building-label"))
    .map((marker) => marker.element.textContent);
const sidesVisible = () => sideButtons().map((button) => button.parentElement!.style.visibility !== "hidden");
const kitchenLabelShown = () => liveMarkers().some((marker) => marker.element.matches('.room-label[data-area="kitchen"]'));

const dragThrough = (points: [number, number][]) => {
  handlers.mousedown(mouse(...points[0]));
  for (const point of points.slice(1)) handlers.mousemove(mouse(...point));
  handlers.mouseup(mouse(...points[points.length - 1]));
};

const adjustKitchen = async () => {
  const mounted = mountEditor();
  await startAdjusting(mounted.panel);
  await tapRoom(mounted.panel, "kitchen");
  return mounted;
};

test("an edge drag shows the draft's lengths instead of the side buttons and the room label, and saves once with one undo step", async () => {
  const { panel, connection } = await adjustKitchen();
  expect(kitchenLabelShown()).toBe(true);
  const press = mouse(1, 25);
  handlers.mousedown(press);
  expect(press.preventDefault).toHaveBeenCalled();
  handlers.mousemove(mouse(-19.2, 25));
  expect(draftLabels()).toContain("7.00 m");
  expect(sidesVisible()).toEqual([false, false, false, false]);
  expect(kitchenLabelShown()).toBe(false);
  handlers.mouseup(mouse(-19.2, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -200, 200, 0));
  await vi.waitFor(() => expect(sidesVisible()).toEqual([true, true, true, true]));
  expect(kitchenLabelShown()).toBe(true);
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(cornerSet(saves(connection)[1].areas.kitchen)).toEqual(KITCHEN_BOX);
});

test("an edge drag released where it started saves nothing and records no undo step", async () => {
  const { panel, connection } = await adjustKitchen();
  dragThrough([
    [1, 25],
    [-10, 25],
    [0.6, 25],
  ]);
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
  expect(sidesVisible()).toEqual([true, true, true, true]);
});

test("the pointer turns into a resize arrow over an edge of the active rectangle", async () => {
  await adjustKitchen();
  handlers.mousemove(mouse(1, 25));
  expect(mapCanvas.style.cursor).toBe("ew-resize");
  handlers.mousemove(mouse(25, 25));
  expect(mapCanvas.style.cursor).toBe("");
});

test("with the map turned 40 degrees off the site axis the edge drag follows the room's edges", async () => {
  const { panel, connection } = await adjustKitchen();
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
  await startAdjusting(panel);
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
  const { panel, connection } = await adjustKitchen();
  handlers.mousedown(mouse(1, 25));
  handlers.mousemove(mouse(-19.2, 25));
  key("keydown", "Escape");
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  handlers.mouseup(mouse(-19.2, 25));
  await settle(panel);
  expect(saves(connection)).toEqual([]);
  expect(sidesVisible()).toEqual([true, true, true, true]);
  expect(kitchenLabelShown()).toBe(true);
});

test("a refresh during an edge drag keeps the side buttons hidden, and the release saves", async () => {
  const { panel, connection } = await adjustKitchen();
  handlers.mousedown(mouse(1, 25));
  handlers.mousemove(mouse(-12, 25));
  await onUpdateOf(connection)();
  await settle(panel);
  expect(sidesVisible()).toEqual([false, false, false, false]);
  handlers.mouseup(mouse(-19.2, 25));
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -200, 200, 0));
});

test.each<[string, () => void]>([
  ["Ctrl+Z", () => ctrlZ()],
  ["Ctrl+Shift+Z", () => ctrlZ(true)],
  ["Delete", () => key("keydown", "Delete")],
])("%s during an edge drag changes nothing, so the release saves against the room as grabbed", async (_, press) => {
  const { panel, connection } = await adjustKitchen();
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
  const { panel, connection } = await adjustKitchen();
  // The left edge's chip, pressed 15 px inside the room: beyond the edge's snap radius.
  const left = sideButtons()[3];
  const reached: string[] = [];
  left.parentElement!.addEventListener("mousedown", () => reached.push("mousedown"));
  left.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
  pressChip(left, [
    [15, 25],
    [5, 25],
    [-5, 25],
  ]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(cornerSet(saves(connection)[0].areas.kitchen)).toEqual(latticeBox(-80, -200, 200, 0));
  await settle(panel);
  expect(sideField()).toBeUndefined();
  expect(reached).toEqual([]);
});

test("a tap on a side chip opens its length field and saves nothing", async () => {
  const { panel, connection } = await adjustKitchen();
  pressChip(sideButtons()[0], [[25, 0]]);
  expect(sideField()).toBeDefined();
  await settle(panel);
  expect(saves(connection)).toEqual([]);
});

test("a press on a chip that the browser cancels ends, so the chips show what a refresh brought meanwhile", async () => {
  const { panel, connection, setFeed } = await adjustKitchen();
  const top = sideButtons()[0];
  pointer(top, "pointerdown", [25, 0]);
  setFeed([feature("kitchen", pixelBox(0, 0, 60, 50))]);
  await onUpdateOf(connection)();
  await settle(panel);
  pointer(top, "pointercancel", [25, 0]);
  expect(sideButtons().map((chip) => chip.textContent)).toEqual(["6.00 m", "5.00 m", "6.00 m", "5.00 m"]);
});

test("a refresh while a chip is pressed keeps the chip, so its drag still saves", async () => {
  const { panel, connection } = await adjustKitchen();
  const left = sideButtons()[3];
  pointer(left, "pointerdown", [0, 25]);
  await onUpdateOf(connection)();
  await settle(panel);
  expect(sideButtons()).toContain(left);
  pointer(left, "pointermove", [-19.2, 25]);
  pointer(left, "pointerup", [-19.2, 25]);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
});

test.each<[string, boolean, string, boolean]>([
  ["a touch screen", true, "44px", true],
  ["a mouse", false, "", false],
])("with %s a chip names its side, and only a finger gets a 44 px target and a grip mark", async (_, coarse, minimum, gripMark) => {
  if (coarse) touchScreen();
  await adjustKitchen();
  expect(sideButtons().map((chip) => chip.getAttribute("aria-label"))).toEqual(
    Array(4).fill("5.00 m side: drag to stretch, or press to type a length"),
  );
  expect(
    sideButtons().map((chip) => [chip.style.minWidth, chip.style.minHeight, Boolean(chip.querySelector("ha-svg-icon")), chip.textContent]),
  ).toEqual(Array(4).fill([minimum, minimum, gripMark, "5.00 m"]));
});
