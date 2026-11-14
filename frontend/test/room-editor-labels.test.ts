// @vitest-environment happy-dom
// Checks that the room editor tells the room labels which room is active, and that a touch tap shows a name.
import { afterEach, expect, test, vi } from "vitest";
import { handlers, liveMarkers, panMap, queryRenderedFeatures, resetFakes, settle } from "./panel-harness";
import { mountEditor, mouse, sideButtons, startSelecting, tapRoom } from "./room-editor-fixture";
import { RoomLabels } from "../src/room-labels";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(() => {
  resetFakes();
  vi.restoreAllMocks();
});

test("selecting a room activates it for the labels, and clearing the selection clears it", async () => {
  const activate = vi.spyOn(RoomLabels.prototype, "activate");
  const { panel } = mountEditor();
  await startSelecting(panel);
  await tapRoom(panel, "kitchen");
  expect(activate).toHaveBeenLastCalledWith("kitchen");
  queryRenderedFeatures.mockReturnValue([]);
  handlers.click(mouse(300, 300));
  await settle(panel);
  expect(activate).toHaveBeenLastCalledWith(undefined);
});

// The kitchen's 50 x 50 px box is small: its width chip stands 8 px below its bottom side, which lies at y 150 once the view is panned clear of the screen's top edge.
test.each([
  ["nothing is there", [], [0, 8]],
  ["another label covers the area below", [{ centre: { x: 0, y: 1000 }, size: { width: 4000, height: 1700 } }], [0, -8]],
])("the width chip of a small room goes off the spot below it when %s: %j", async (_, boxes, offset) => {
  panMap(-100, -100);
  vi.spyOn(RoomLabels.prototype, "boxes").mockReturnValue(boxes);
  const { panel } = mountEditor();
  await startSelecting(panel);
  await tapRoom(panel, "kitchen");
  const bottom = liveMarkers().find((marker) => marker.element.firstElementChild === sideButtons()[2])!;
  // Adding 0 turns the -0 of a sign flip into 0.
  expect(bottom.offset!.map((value) => value + 0)).toEqual(offset);
});

test.each([
  ["touch", "kitchen", true],
  ["mouse", "kitchen", false],
  ["touch", undefined, false],
])("a %s click on %s taps its label: %s", async (pointerType, areaId, tapped) => {
  const tap = vi.spyOn(RoomLabels.prototype, "tap");
  const { panel } = mountEditor();
  await startSelecting(panel);
  queryRenderedFeatures.mockReturnValue(areaId ? [{ properties: { area_id: areaId } }] : []);
  handlers.click({ ...mouse(10, 10), originalEvent: { button: 0, pointerType } });
  await settle(panel);
  expect(tap.mock.calls).toEqual(tapped ? [[areaId]] : []);
});
