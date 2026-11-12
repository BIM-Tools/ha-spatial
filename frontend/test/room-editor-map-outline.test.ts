// @vitest-environment happy-dom
// Checks the offer to copy the outline from the map's building after Align: the question, Use outline and Draw it myself.
import type { MultiPolygon, Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import { buttonNamed, chooseFromMenu, handlers, nextFrame, queryRenderedFeatures, resetFakes, settle, sources, toasts } from "./panel-harness";
import { FRAME, activeChip, chip, mountEditor, mouse, pixelBox, siteSaves, snapHighlights, startDrawing, toolPressed } from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

// 10 m along the site axis and 8 m deep, from the site origin; screen y runs down, lattice y up.
const MAP_HOUSE = pixelBox(0, 0, 100, -80);

const guidePart = (panel: HTMLElement, part: string) => panel.shadowRoot!.querySelector(`.guide ${part}`)?.textContent?.trim();
const question = (panel: HTMLElement) => panel.shadowRoot!.querySelector(".guide.question");
const preview = () => sources["spatial-map-outline"].data as Polygon | { features: unknown[] };
const guideLine = () => sources["spatial-map-guide"].data as Polygon | { features: unknown[] };
const latticeCorners = (outline: Polygon) => outline.coordinates[0].map((corner) => FRAME.toLattice(corner));

// A narrower neighbour 10 m further along the axis, in the same tile: 6 m wide and 8 m deep.
const NEIGHBOUR = pixelBox(200, 0, 260, -80);
const TERRACE: MultiPolygon = { type: "MultiPolygon", coordinates: [MAP_HOUSE.coordinates, NEIGHBOUR.coordinates] };

// Draw on the ground floor with the Building pill active and no outline; the map tiles hold `buildings`.
const offer = async (buildings: Polygon | MultiPolygon | undefined) => {
  const mounted = mountEditor(undefined, null);
  queryRenderedFeatures.mockImplementation(((_where: unknown, options: { layers: string[] }) =>
    buildings && options.layers.includes("building-3d") ? [{ geometry: buildings }] : []) as never);
  await startDrawing(mounted.panel);
  handlers.idle();
  await settle(mounted.panel);
  return mounted;
};

test("after Align the map's building under the site offers its outline, dashed, with its size and two answers", async () => {
  const { panel } = await offer(MAP_HOUSE);
  expect(guidePart(panel, ".text")).toBe("Use the map's outline?");
  expect(guidePart(panel, ".detail")).toBe("9.70 × 7.70 m. Or click another building.");
  expect(buttonNamed(panel, "Draw it myself")).toBeDefined();
  expect(buttonNamed(panel, "Use outline")!.classList.contains("lit")).toBe(true);
  expect(latticeCorners(preview() as Polygon)).toEqual([[6, 6], [394, 6], [394, 314], [6, 314], [6, 6]]);
});

test("without a building on the map there is no question and no preview", async () => {
  const { panel } = await offer(undefined);
  expect(question(panel)).toBeNull();
  expect(preview()).toEqual({ type: "FeatureCollection", features: [] });
});

test("Use outline saves it as the outline in one undoable write, then asks to check one length until Looks right", async () => {
  const { panel, connection } = await offer(MAP_HOUSE);
  buttonNamed(panel, "Use outline")!.click();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  expect(latticeCorners(siteSaves(connection)[0].outline!)).toEqual([[6, 6], [394, 6], [394, 314], [6, 314], [6, 6]]);
  await vi.waitFor(() => expect(guidePart(panel, ".text")).toBe("Check one length you know"));
  expect(guidePart(panel, ".detail")).toBe("For example the front of the house. Tap it to type the real size.");
  expect(toolPressed(panel, "Select")).toBe("true");
  expect(preview()).toEqual({ type: "FeatureCollection", features: [] });
  buttonNamed(panel, "Looks right")!.click();
  await settle(panel);
  expect(question(panel)).toBeNull();
  // The stored outline is the guide from now on, so the map's building no longer shows.
  expect(guideLine()).toEqual({ type: "FeatureCollection", features: [] });
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(2));
  expect(siteSaves(connection)[1].outline).toBeNull();
});

// In Select, a click on the neighbour picks it in place of the building at the site origin.
const repick = async (panel: HTMLElement) => {
  buttonNamed(panel, "Select")!.click();
  await settle(panel);
  handlers.click(mouse(230, -40));
  await settle(panel);
};

test("in Select a click on another building picks it, and the offered outline follows", async () => {
  const { panel } = await offer(TERRACE);
  await repick(panel);
  expect(guidePart(panel, ".detail")).toBe("5.70 × 7.70 m. Or click another building.");
  expect(latticeCorners(preview() as Polygon)).toEqual([[806, 6], [1034, 6], [1034, 314], [806, 314], [806, 6]]);
});

test("after Align a click on empty map in Select says nothing and deselects, and the question stays", async () => {
  const { panel } = await offer(MAP_HOUSE);
  buttonNamed(panel, "Select")!.click();
  await settle(panel);
  handlers.click(mouse(600, -40));
  await settle(panel);
  expect(toasts).toEqual([]);
  expect(activeChip(panel)).toBeUndefined();
  expect(guidePart(panel, ".text")).toBe("Use the map's outline?");
  expect(latticeCorners(preview() as Polygon)).toEqual([[6, 6], [394, 6], [394, 314], [6, 314], [6, 6]]);
});

test("in Draw a click on another building picks it instead of starting a box", async () => {
  const { panel } = await offer(TERRACE);
  handlers.click(mouse(230, -40));
  await settle(panel);
  expect(guidePart(panel, ".detail")).toBe("5.70 × 7.70 m. Or click another building.");
  expect(sources["spatial-draft"].data).toEqual({ type: "FeatureCollection", features: [] });
  expect(toolPressed(panel, "Draw")).toBe("true");
});

test("Undo of Use outline brings the question back with the pick kept", async () => {
  const { panel, connection } = await offer(TERRACE);
  await repick(panel);
  buttonNamed(panel, "Use outline")!.click();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(1));
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(2));
  handlers.idle();
  await vi.waitFor(() => expect(guidePart(panel, ".detail")).toBe("5.70 × 7.70 m. Or click another building."));
});

test("Draw it myself keeps Draw on and the outline as a dotted snap guide in Draw and Select, not in Align", async () => {
  const { panel } = await offer(MAP_HOUSE);
  buttonNamed(panel, "Draw it myself")!.click();
  await settle(panel);
  expect(question(panel)).toBeNull();
  expect(toolPressed(panel, "Draw")).toBe("true");
  expect(preview()).toEqual({ type: "FeatureCollection", features: [] });
  expect(latticeCorners(guideLine() as Polygon)).toEqual([[6, 6], [394, 6], [394, 314], [6, 314], [6, 6]]);
  // 1.5 px left of the guide's right side, which lies 6 lattice units, 1.5 px, in; away from the lines through the kitchen's corners.
  handlers.mousemove(mouse(97, -40));
  await nextFrame();
  expect(snapHighlights()).toEqual(["LineString"]);
  chip(panel, "Bath").click();
  await settle(panel);
  handlers.mousemove(mouse(97, -40));
  await nextFrame();
  expect(snapHighlights()).toEqual(["LineString"]);
  buttonNamed(panel, "Select")!.click();
  await settle(panel);
  expect(latticeCorners(guideLine() as Polygon)).toEqual([[6, 6], [394, 6], [394, 314], [6, 314], [6, 6]]);
  await chooseFromMenu(panel, "Change alignment");
  await settle(panel);
  expect(guideLine()).toEqual({ type: "FeatureCollection", features: [] });
});
