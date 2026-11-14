// @vitest-environment happy-dom
// Checks that the room editor tells the room labels which room is active, and that a touch tap shows a name.
import { afterEach, expect, test, vi } from "vitest";
import { handlers, queryRenderedFeatures, resetFakes, settle } from "./panel-harness";
import { mountEditor, mouse, startSelecting, tapRoom } from "./room-editor-fixture";
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

test("the side controls keep clear of the label boxes", async () => {
  const boxes = vi.spyOn(RoomLabels.prototype, "boxes");
  const { panel } = mountEditor();
  await startSelecting(panel);
  await tapRoom(panel, "kitchen");
  expect(boxes).toHaveBeenCalled();
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
