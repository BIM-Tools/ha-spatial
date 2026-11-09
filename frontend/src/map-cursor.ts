// The mouse pointer says what a click on the map would do, so it is derived from one place for every tool.

import type { Tool } from "./room-editor";

/** What lies under the pointer on the map, as the panel and the editor know it. */
export interface PointerState {
  tool: Tool;
  // A click here would pick a map building as the home's.
  pickable: boolean;
  // The resize cursor of the edge or corner under the pointer or held, if any.
  resize: string | undefined;
  // On the active shape in Select, where a drag moves it.
  onShape: boolean;
}

/**
 * The CSS cursor for the map: resize on an edge, pointer on a building to pick, crosshair to draw or
 * align, move on a shape; elsewhere "", which leaves MapLibre's own grab and grabbing cursors for a pan.
 */
export function mapCursor({ tool, pickable, resize, onShape }: PointerState): string {
  if (resize) return resize;
  if (pickable) return "pointer";
  if (tool !== "select") return "crosshair";
  return onShape ? "move" : "";
}
