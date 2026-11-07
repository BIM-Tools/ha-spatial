// @vitest-environment happy-dom
// Checks the offer to copy the outline from the map's building after Align: the question, Use outline and Draw it myself.
import type { Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import { buttonNamed, handlers, queryRenderedFeatures, resetFakes, settle, sources } from "./panel-harness";
import { FRAME, chip, mountEditor, mouse, pixelBox, siteSaves, snapHighlights, startDrawing, toolPressed } from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

// 10 m along the site axis and 8 m deep, from the site origin; screen y runs down, lattice y up.
const MAP_HOUSE = pixelBox(0, 0, 100, -80);

const guidePart = (panel: HTMLElement, part: string) => panel.shadowRoot!.querySelector(`.guide ${part}`)?.textContent?.trim();
const question = (panel: HTMLElement) => panel.shadowRoot!.querySelector(".guide.question");
const preview = () => sources["spatial-map-outline"].data as Polygon | { features: unknown[] };
const latticeCorners = (outline: Polygon) => outline.coordinates[0].map((corner) => FRAME.toLattice(corner));

// Draw on the ground floor with the Building pill active and no outline; the map tiles hold `building`.
const offer = async (building: Polygon | undefined) => {
  const mounted = mountEditor(undefined, null);
  queryRenderedFeatures.mockReturnValue(building ? [{ geometry: building }] : []);
  await startDrawing(mounted.panel);
  handlers.idle();
  await settle(mounted.panel);
  return mounted;
};

test("after Align the map's building under the site offers its outline, dashed, with its size and two answers", async () => {
  const { panel } = await offer(MAP_HOUSE);
  expect(guidePart(panel, ".text")).toBe("Use the map's outline?");
  expect(guidePart(panel, ".detail")).toBe("9.70 × 7.70 m");
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
  buttonNamed(panel, "Undo")!.click();
  await vi.waitFor(() => expect(siteSaves(connection)).toHaveLength(2));
  expect(siteSaves(connection)[1].outline).toBeNull();
});

test("Draw it myself keeps Draw on and the outline as a snap target for the Building only", async () => {
  const { panel } = await offer(MAP_HOUSE);
  buttonNamed(panel, "Draw it myself")!.click();
  await settle(panel);
  expect(question(panel)).toBeNull();
  expect(toolPressed(panel, "Draw")).toBe("true");
  // 1.5 px right of the offered outline's left side, which lies 6 lattice units, 1.5 px, in.
  handlers.mousemove(mouse(3, -40));
  expect(snapHighlights()).toEqual(["LineString"]);
  chip(panel, "Bath").click();
  await settle(panel);
  handlers.mousemove(mouse(3, -40));
  expect(snapHighlights()).toEqual([]);
});
