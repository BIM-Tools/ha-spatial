// A side's length chip is also its handle, so one control on each side of the active rectangle stretches it by drag or opens a field to type its length.

import { mdiDragVertical } from "@mdi/js";
import type { Polygon, Position } from "geojson";
import { type Map as MapLibreMap, Marker } from "maplibre-gl";
import { type BoxInteraction, coarsePointer } from "./box-interaction";
import { type Pixel, type ResizeTarget, resizeCursor } from "./edge-drag";
import { type ChangeOrRefusal, edgeLengths, resizeChange, sideLabels } from "./plan";
import type { PlanFrame } from "./site-frame";
import { type HassUnits, parseLength, typedLength } from "./units";

/** The active axis rectangle whose sides get controls, with the frame and units they are built in. */
export interface SideRoom {
  areaId: string;
  footprint: Polygon;
  frame: PlanFrame;
  units: HassUnits;
}

/** What the side controls ask of the editor. */
export interface SideActions {
  // A chip tapped or clicked without a drag.
  open(edgeIndex: number): void;
  // Escape, or Enter on an unchanged length, in the field; also a drag the browser cancelled.
  close(): void;
  resize(resized: ChangeOrRefusal): void;
}

const CHIP_STYLE =
  "font: 12px sans-serif; background: var(--card-background-color); color: var(--primary-text-color); border: 1px solid var(--primary-color); border-radius: 3px";
// A finger needs a 44 px target; the chip inside it keeps its size and gets a grip mark.
const HIT_BOX_STYLE =
  "display: flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 44px; min-height: 44px; margin: 0; padding: 0; border: none; background: none";
const PILL_STYLE = `${CHIP_STYLE}; display: inline-flex; align-items: center; gap: 2px; padding: 2px 6px 2px 2px; --mdc-icon-size: 14px`;
// A control sits on the map, inside a Marker that would block focus; its presses, touches and keys stay
// its own. Mouse moves and releases still reach the map, so a move dragged across a chip goes on.
const MAP_EVENTS = ["mousedown", "touchstart", "touchmove", "touchend", "click", "dblclick", "keydown"];

// Where a DOM event on a Marker falls on the map.
const pixelOn = (map: MapLibreMap, event: MouseEvent): Pixel => {
  const box = map.getContainer().getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
};

/** A Marker per side of the room: a length chip, or the length field for `editingSide`. */
export function showSideControls(
  map: MapLibreMap,
  interaction: BoxInteraction,
  room: SideRoom,
  editingSide: number | undefined,
  actions: SideActions,
): Marker[] {
  let field: HTMLInputElement | undefined;
  const markers = sideLabels(room.frame, room.footprint, room.units).map(({ at, edgeIndex, text }) => {
    const control = edgeIndex === editingSide ? (field = lengthField(room, edgeIndex, actions)) : sideChip(map, interaction, room, edgeIndex, text, actions);
    for (const type of MAP_EVENTS) control.addEventListener(type, (event) => event.stopPropagation());
    const element = document.createElement("span");
    element.append(control);
    return new Marker({ element }).setLngLat(at as [number, number]).addTo(map);
  });
  field?.focus();
  field?.select();
  return markers;
}

// The field holds the frame it was built in, so a refresh still in flight cannot pair it with another one.
function lengthField({ areaId, footprint, frame, units }: SideRoom, edgeIndex: number, actions: SideActions) {
  const prefilled = typedLength(edgeLengths(frame, footprint)[edgeIndex], units);
  const field = Object.assign(document.createElement("input"), { type: "text", value: prefilled });
  field.style.cssText = `${CHIP_STYLE}; width: 6em`;
  field.addEventListener("keydown", (event) => {
    // An unchanged field leaves the edit: saving its rounded length would shift the side and add an undo step.
    if (event.key === "Escape" || (event.key === "Enter" && field.value === prefilled)) actions.close();
    else if (event.key === "Enter") actions.resize(resizeChange(frame, areaId, footprint, edgeIndex, parseLength(field.value, units)));
  });
  return field;
}

// The chip sits on its edge and covers part of it, so a press on it drags that edge through the map's edge
// drag; mouse and finger alike, captured so the drag follows the pointer off the chip.
function sideChip(map: MapLibreMap, interaction: BoxInteraction, room: SideRoom, edgeIndex: number, text: string, actions: SideActions) {
  const target: ResizeTarget = { kind: "edge", index: edgeIndex };
  const chip = Object.assign(document.createElement("button"), { type: "button", className: "side-chip" });
  chip.setAttribute("aria-label", `${text} side: drag to stretch, or press to type a length`);
  if (coarsePointer()) {
    chip.style.cssText = `${HIT_BOX_STYLE}; touch-action: none`;
    const pill = document.createElement("span");
    pill.style.cssText = PILL_STYLE;
    pill.append(Object.assign(document.createElement("ha-svg-icon"), { path: mdiDragVertical }), text);
    chip.append(pill);
  } else {
    chip.style.cssText = `${CHIP_STYLE}; touch-action: none`;
    chip.textContent = text;
  }
  // Across the edge as it lies on screen now; the map may have turned since the chip was built.
  chip.addEventListener("pointerenter", () => {
    const corners = room.footprint.coordinates[0].map((corner: Position) => map.project(corner as [number, number]));
    chip.style.cursor = resizeCursor(target, corners);
  });
  let dragged = false;
  chip.addEventListener("pointerdown", (event) => {
    dragged = false;
    if (event.button === 0 && interaction.startResize(target, pixelOn(map, event), event.altKey)) chip.setPointerCapture?.(event.pointerId);
  });
  chip.addEventListener("pointermove", (event) => interaction.resizeTo(pixelOn(map, event), event.altKey));
  chip.addEventListener("pointerup", (event) => {
    dragged = interaction.endResize(pixelOn(map, event), event.altKey);
  });
  // The chips were not rebuilt while it was pressed, so a cancelled press rebuilds them.
  chip.addEventListener("pointercancel", () => {
    if (interaction.resizing) interaction.cancel();
    actions.close();
  });
  // A click follows the release, also of a drag; Enter or Space on the focused chip opens the field too.
  chip.addEventListener("click", () => {
    if (!dragged) actions.open(edgeIndex);
  });
  return chip;
}
