// Checks which mouse pointer the map shows for each tool and what lies under the pointer.
import { expect, test } from "vitest";
import { type PointerState, mapCursor } from "../src/map-cursor";

const NOTHING: PointerState = { tool: "select", pickable: false, resize: undefined, onShape: false };

test.each<[string, Partial<PointerState>, string]>([
  ["Select over nothing: default", {}, "default"],
  ["Select on the active shape: move", { onShape: true }, "move"],
  ["Select on an edge of the active shape: ew-resize", { onShape: true, resize: "ew-resize" }, "ew-resize"],
  ["Select over a building to pick: pointer", { pickable: true }, "pointer"],
  ["Draw: crosshair", { tool: "draw" }, "crosshair"],
  ["Draw over a building to pick: pointer", { tool: "draw", pickable: true }, "pointer"],
  ["Align: crosshair", { tool: "align" }, "crosshair"],
])("%s", (_name, state, cursor) => {
  expect(mapCursor({ ...NOTHING, ...state })).toBe(cursor);
});
