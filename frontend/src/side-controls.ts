// Every side of the active rectangle is a handle that stretches it by drag or opens a field to type its length; each length shows once, on a chip. Every side of an outline of another shape is a chip with its length that drags it.

import { mdiDragVertical } from "@mdi/js";
import type { Polygon, Position } from "geojson";
import { type Map as MapLibreMap, Marker } from "maplibre-gl";
import { type BoxInteraction, coarsePointer } from "./box-interaction";
import { type ScreenBox, type Size, isSmall, placeLabels, screenShape } from "./draft-labels";
import { type Pixel, type ResizeTarget, resizeCursor } from "./edge-drag";
import { type ChangeOrRefusal, type SideHandle, axisSides, edgeLengths, isAxisRectangle, resizeChange, sideHandles, sideLabels } from "./plan";
import type { LatticePoint, PlanFrame } from "./site-frame";
import type { LatticeEdge } from "./snap";
import { planPill, planPillHeld } from "./styles";
import { type HassUnits, parseLength, typedLength } from "./units";

/** The active shape whose sides get controls, an axis rectangle or the outline, with the frame and units they are built in. */
export interface SideRoom {
  areaId: string;
  footprint: Polygon;
  frame: PlanFrame;
  units: HassUnits;
  // The axis edges of the floor's other rooms: a length stays off a side it shares with one.
  roomEdges: readonly LatticeEdge[];
}

/** What the side controls ask of the editor. */
export interface SideActions {
  // A chip or grip tapped or clicked without a drag.
  open(edgeIndex: number): void;
  // Escape, or Enter on an unchanged length, in the field; also a drag the browser cancelled.
  close(): void;
  resize(resized: ChangeOrRefusal): void;
}

/** The Markers of the side controls. */
export interface SideControls {
  /**
   * Moves each control to its side of a resize draft and counts the lengths; the held edge's handle gets a
   * primary ring. Returns where the visible pills now sit on the map.
   */
  follow(draft: Polygon, held: ResizeTarget): ScreenBox[];
  remove(): void;
}

// A finger needs a 44 px target; the chip inside it keeps its size and gets a grip mark.
const HIT_BOX_STYLE =
  "display: flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 44px; min-height: 44px; margin: 0; padding: 0; border: none; background: none";
const MARKED_CHIP_STYLE = `${planPill}; gap: 2px; padding: 0 8px 0 2px; --mdc-icon-size: 14px`;
// Lies along its side: 28 x 22 px on a side across the screen, 22 x 28 px on one down it.
const gripStyle = (across: boolean) => `${planPill}; width: ${across ? 28 : 22}px; height: ${across ? 22 : 28}px; padding: 0; --mdc-icon-size: 16px`;
// A control sits on the map, inside a Marker that would block focus; its presses, touches and keys stay
// its own. Mouse moves and releases still reach the map, so a move dragged across a control goes on.
const MAP_EVENTS = ["mousedown", "touchstart", "touchmove", "touchend", "click", "dblclick", "keydown"];

// Where a DOM event on a Marker falls on the map.
const pixelOn = (map: MapLibreMap, event: MouseEvent): Pixel => {
  const box = map.getContainer().getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
};

const latticeCorners = (frame: PlanFrame, rectangle: Polygon): LatticePoint[] =>
  rectangle.coordinates[0].slice(0, -1).map((corner) => frame.toLattice(corner));

const ariaLabel = (handle: SideHandle, length: string, typed: boolean) => {
  if (!typed) return `${length} side: drag to move it`;
  return handle === "length" ? `${length} side: drag to stretch, or press to type a length` : `Side of ${length}: drag to stretch, or press to type a length`;
};

// A built control: the element in the Marker; for a chip or grip the pill that shows it, a chip's length, and
// the side it drags, which a chip of a small room takes from the side it carries to the side it stands at.
interface Control {
  element: HTMLElement;
  face?: HTMLElement;
  length?: Text;
  edge: number;
}

/**
 * A Marker per side of the room: on a rectangle a length chip, a grip, or the length field for
 * `editingSide`; on an outline of another shape a length chip on every side, which only drags, as a
 * typed length has no rule for which corners move. `placeLabels` puts the chips outside their sides; on a room
 * whose shorter side is under 60 px they stand at the bottom and right (or the sides opposite), a chip
 * stepping to the opposite side of its pair when the rule puts it there, and the grips stay hidden until a
 * control is pressed or a length is typed. Custom: a grip is reachable only through that press, so a small
 * room is resized from its chips, and the grips come back only until the controls are rebuilt, not when the
 * room is pressed again later. An unmeasured map container gives no viewport, so nothing is flipped by its edge.
 */
export function showSideControls(
  map: MapLibreMap,
  interaction: BoxInteraction,
  room: SideRoom,
  editingSide: number | undefined,
  actions: SideActions,
  // Other rooms' label boxes on screen, in map container pixels, which the chips keep clear of.
  avoid?: () => readonly ScreenBox[],
): SideControls {
  const corners = latticeCorners(room.frame, room.footprint);
  const rectangle = isAxisRectangle(room.frame, room.footprint);
  const handles: SideHandle[] = rectangle ? sideHandles(corners, room.roomEdges) : corners.map(() => "length");
  // A rectangle's draft may start its ring at another corner, so its sides match by place; any other shape keeps its corner order.
  const places = rectangle ? axisSides(corners) : undefined;
  let field: HTMLInputElement | undefined;
  const controls: Control[] = [];
  let revealed = editingSide !== undefined;
  let drawn = room.footprint;
  const markers = sideLabels(room.frame, room.footprint, room.units).map(({ at, edgeIndex, text }) => {
    if (edgeIndex === editingSide && rectangle) {
      field = lengthField(room, edgeIndex, actions);
      controls.push({ element: field, edge: edgeIndex });
    } else {
      const across = places?.[edgeIndex] === "bottom" || places?.[edgeIndex] === "top";
      const reveal = () => {
        if (revealed) return;
        revealed = true;
        place(drawn);
      };
      controls.push(sideHandle(map, interaction, room, edgeIndex, handles[edgeIndex], text, across, rectangle, actions, reveal));
    }
    const control = controls[edgeIndex].element;
    for (const type of MAP_EVENTS) control.addEventListener(type, (event) => event.stopPropagation());
    const element = document.createElement("span");
    element.append(control);
    return new Marker({ element }).setLngLat(at as [number, number]).addTo(map);
  });
  // Where each control stands for a draft: its text set, each pill measured, `placeLabels` asked for the chips'
  // spots. A side keeps its control through the drag; `drawn` is the draft the map's own moves re-place.
  function place(draft: Polygon) {
    drawn = draft;
    const draftPlaces = places && axisSides(latticeCorners(room.frame, draft));
    const labels = sideLabels(room.frame, draft, room.units);
    const labelOf = (edgeIndex: number) => labels[draftPlaces && places ? draftPlaces.indexOf(places[edgeIndex]) : edgeIndex];
    controls.forEach((control, edgeIndex) => {
      const { text } = labelOf(edgeIndex);
      if (control.length) control.length.data = text;
      control.element.setAttribute("aria-label", ariaLabel(handles[edgeIndex], text, rectangle));
    });
    const shape = screenShape(draft.coordinates[0].slice(0, -1).map((corner) => map.project(corner as [number, number])));
    // In the room's own side order, which the draft's ring may not start with.
    const drawnIndex = (edgeIndex: number) => labels.indexOf(labelOf(edgeIndex));
    // A rectangle's opposite sides are a pair that shows one length, on the chip of the pair.
    const chipOf = (edgeIndex: number) => (!rectangle || handles[edgeIndex] === "length" ? edgeIndex : (edgeIndex + 2) % controls.length);
    const sizeOf = (edgeIndex: number): Size => {
      const { element, face } = controls[chipOf(edgeIndex)];
      return { width: (face ?? element).offsetWidth, height: (face ?? element).offsetHeight };
    };
    const container = map.getContainer();
    const given = placeLabels({
      sides: controls.map((_, edgeIndex) => shape.sides[drawnIndex(edgeIndex)]),
      sideSizes: controls.map((_, edgeIndex) => sizeOf(edgeIndex)),
      box: shape.box,
      area: { centre: shape.centre, size: { width: 0, height: 0 } },
      controls: avoid?.(),
      viewport: container.clientWidth && container.clientHeight ? { width: container.clientWidth, height: container.clientHeight } : undefined,
    }).sides;
    // A small room's chips stand apart and its grips wait to be pressed; a side without a chip has none.
    const small = isSmall(shape.box);
    markers.forEach((marker, edgeIndex) => {
      const control = controls[edgeIndex];
      const chip = control.length !== undefined;
      // The chip of a pair the rule put on the opposite side stands there, and drags that side.
      const stands = chip && small && given[edgeIndex] === undefined && rectangle && given[(edgeIndex + 2) % controls.length] ? (edgeIndex + 2) % controls.length : edgeIndex;
      control.edge = stands;
      const offset = chip ? given[stands] : small && !revealed ? undefined : { x: 0, y: 0 };
      marker.setLngLat(labelOf(stands).at as [number, number]);
      marker.setOffset(offset ? [offset.x, offset.y] : [0, 0]);
      marker.getElement().style.visibility = offset ? "" : "hidden";
    });
  }
  place(room.footprint);
  const onMove = () => place(drawn);
  map.on("move", onMove);
  field?.focus();
  field?.select();
  return {
    follow(draft, held) {
      place(draft);
      controls.forEach(({ face, edge }, edgeIndex) => {
        if (face && held.kind === "edge" && (held.index === edge || held.index === edgeIndex)) Object.assign(face.style, planPillHeld);
      });
      const mapBox = map.getContainer().getBoundingClientRect();
      return controls.flatMap(({ element, face }, edgeIndex) => {
        if (markers[edgeIndex].getElement().style.visibility === "hidden") return [];
        const { left, top, width, height } = (face ?? element).getBoundingClientRect();
        return [{ centre: { x: left + width / 2 - mapBox.left, y: top + height / 2 - mapBox.top }, size: { width, height } }];
      });
    },
    remove() {
      map.off("move", onMove);
      for (const marker of markers) marker.remove();
    },
  };
}

// The field holds the frame it was built in, so a refresh still in flight cannot pair it with another one.
function lengthField({ areaId, footprint, frame, units }: SideRoom, edgeIndex: number, actions: SideActions) {
  const prefilled = typedLength(edgeLengths(frame, footprint)[edgeIndex], units);
  const field = Object.assign(document.createElement("input"), { type: "text", value: prefilled });
  field.style.cssText = `${planPill}; width: 6em`;
  Object.assign(field.style, planPillHeld);
  field.addEventListener("keydown", (event) => {
    // An unchanged field leaves the edit: saving its rounded length would shift the side and add an undo step.
    if (event.key === "Escape" || (event.key === "Enter" && field.value === prefilled)) actions.close();
    else if (event.key === "Enter") actions.resize(resizeChange(frame, areaId, footprint, edgeIndex, parseLength(field.value, units)));
  });
  return field;
}

// The chip or grip sits on its edge and covers part of it, so a press on it drags that edge through the
// map's edge drag; mouse and finger alike, captured so the drag follows the pointer off the control.
// Only a `typed` side opens its length field on a click.
function sideHandle(
  map: MapLibreMap,
  interaction: BoxInteraction,
  room: SideRoom,
  edgeIndex: number,
  handle: SideHandle,
  text: string,
  across: boolean,
  typed: boolean,
  actions: SideActions,
  reveal: () => void,
): Control {
  const target = (): ResizeTarget => ({ kind: "edge", index: control.edge });
  const button = Object.assign(document.createElement("button"), { type: "button", className: handle === "length" ? "side-chip" : "side-grip" });
  button.setAttribute("aria-label", ariaLabel(handle, text, typed));
  const length = handle === "length" ? document.createTextNode(text) : undefined;
  // A grip lies along its side; a chip's mark stands as it always did.
  const grip = () => {
    const icon = Object.assign(document.createElement("ha-svg-icon"), { path: mdiDragVertical });
    if (across && !length) icon.style.transform = "rotate(90deg)";
    return icon;
  };
  const control: Control = { element: button, face: button, length, edge: edgeIndex };
  if (coarsePointer()) {
    button.style.cssText = `${HIT_BOX_STYLE}; touch-action: none`;
    const face = document.createElement("span");
    face.style.cssText = length ? MARKED_CHIP_STYLE : gripStyle(across);
    face.append(...(length ? [grip(), length] : [grip()]));
    button.append(face);
    control.face = face;
  } else if (length) {
    button.style.cssText = `${planPill}; touch-action: none`;
    button.append(length);
  } else {
    button.style.cssText = `${gripStyle(across)}; touch-action: none`;
    button.append(grip());
  }
  // Across the edge as it lies on screen now; the map may have turned since the control was built.
  button.addEventListener("pointerenter", () => {
    const corners = room.footprint.coordinates[0].map((corner: Position) => map.project(corner as [number, number]));
    button.style.cursor = resizeCursor(target(), corners);
  });
  let dragged = false;
  button.addEventListener("pointerdown", (event) => {
    dragged = false;
    reveal();
    if (event.button === 0 && interaction.startResize(target(), pixelOn(map, event), event.altKey)) button.setPointerCapture?.(event.pointerId);
  });
  button.addEventListener("pointermove", (event) => interaction.resizeTo(pixelOn(map, event), event.altKey));
  button.addEventListener("pointerup", (event) => {
    dragged = interaction.endResize(pixelOn(map, event), event.altKey);
  });
  // The controls were not rebuilt while it was pressed, so a cancelled press rebuilds them.
  button.addEventListener("pointercancel", () => {
    if (interaction.resizing) interaction.cancel();
    actions.close();
  });
  // A click follows the release, also of a drag; Enter or Space on the focused control opens the field too.
  button.addEventListener("click", () => {
    if (!dragged && typed) actions.open(control.edge);
  });
  return control;
}
