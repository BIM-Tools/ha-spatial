// Names the rooms on the plan with their Home Assistant icon and name, sized to the room as it appears on screen.

import type { Feature, Polygon } from "geojson";
import { css } from "lit";
import { Marker, type Map as MapLibreMap } from "maplibre-gl";
import polylabel from "polylabel";

type Point = [number, number];

/** What a room's label shows: everything, icon and name, the icon, or nothing. */
export type LabelStep = "size" | "name" | "icon" | "none";

const FALLBACK_ICON = "mdi:home-outline";
// Building label offset from the outline's top-left corner, in pixels.
const BUILDING_INSET: Point = [10, 8];

/** The step that fits a label space of this many pixels; `withSize` false leaves out the m². */
export const labelStep = (widthPx: number, heightPx: number, withSize: boolean): LabelStep => {
  if (widthPx > 90 && heightPx > 62) return withSize ? "size" : "name";
  if (widthPx > 72 && heightPx > 42) return "name";
  if (widthPx >= 22 && heightPx >= 22) return "icon";
  return "none";
};

// Custom: the distance from `at` to the nearest crossing with the rings along one axis, on either side.
const halfChord = (rings: Point[][], at: Point, axis: 0 | 1): number => {
  const across = 1 - axis;
  let nearest = Infinity;
  for (const ring of rings) {
    for (let index = 0; index < ring.length - 1; index++) {
      const [from, to] = [ring[index], ring[index + 1]];
      if (from[across] === to[across] || (at[across] - from[across]) * (at[across] - to[across]) > 0) continue;
      const crossing = from[axis] + ((at[across] - from[across]) * (to[axis] - from[axis])) / (to[across] - from[across]);
      nearest = Math.min(nearest, Math.abs(crossing - at[axis]));
    }
  }
  return nearest;
};

/**
 * Where a label goes in a polygon given in screen pixels, and the width and height centred
 * there that stay inside it. The point is the pole of inaccessibility, never the centroid,
 * so an L-shaped room gets its label in its widest part.
 */
export const labelSpace = (rings: Point[][]): { at: Point; width: number; height: number } => {
  const at = polylabel(rings, 1) as Point;
  const point: Point = [at[0], at[1]];
  return { at: point, width: 2 * halfChord(rings, point, 0), height: 2 * halfChord(rings, point, 1) };
};

export interface AreaInfo {
  name: string;
  icon?: string | null;
}

/** The label elements; the panel and the card add them to their own styles. */
export const roomLabelStyles = css`
  /* MapLibre positions the marker absolutely, which also anchors the chip. */
  .room-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    pointer-events: none;
    color: var(--primary-text-color);
    text-shadow:
      0 0 3px var(--card-background-color),
      0 0 3px var(--card-background-color);
  }
  .room-label ha-icon {
    --mdc-icon-size: 18px;
    color: var(--secondary-text-color);
    filter: drop-shadow(0 0 2px var(--card-background-color));
  }
  .room-label[data-step="size"] ha-icon {
    --mdc-icon-size: 20px;
  }
  .room-label .name,
  .room-label .size {
    max-width: var(--label-width);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .room-label .name,
  .room-label .chip,
  .building-label {
    font-size: var(--ha-font-size-s);
    font-weight: var(--ha-font-weight-medium);
    line-height: 14px;
  }
  .room-label .size {
    font-size: 11px;
    line-height: 13px;
    color: var(--secondary-text-color);
  }
  .room-label .chip {
    position: absolute;
    bottom: 100%;
    margin-bottom: var(--ha-space-2);
    padding: 0 var(--ha-space-2);
    height: 24px;
    border-radius: var(--ha-border-radius-lg);
    background: var(--card-background-color);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    line-height: 24px;
    text-shadow: none;
    white-space: nowrap;
  }
  .building-label {
    pointer-events: none;
    color: var(--primary-text-color);
    text-shadow:
      0 0 3px var(--card-background-color),
      0 0 3px var(--card-background-color);
  }
`;

interface Label {
  marker: Marker;
  // What the element shows now, so a frame that changes nothing touches no DOM.
  shown: string;
}

/**
 * One label per room of the shown floor, placed and stepped again on every camera move.
 * In the 3D view of all floors there are none.
 */
export class RoomLabels {
  private _rooms: Feature<Polygon>[] = [];
  private _outline?: Polygon;
  private _areas: Record<string, AreaInfo> = {};
  private _pointed?: string;
  private _labels = new Map<string, Label>();
  private _building?: Marker;

  constructor(
    private readonly _map: MapLibreMap,
    private readonly _withSize: boolean,
  ) {
    _map.on("move", this.update);
    _map.on("resize", this.update);
  }

  destroy() {
    this._map.off("move", this.update);
    this._map.off("resize", this.update);
    this.show([], undefined, {});
  }

  /** The rooms of the floor on screen (none for all floors), the building outline and Home Assistant's areas. */
  show(rooms: Feature<Polygon>[], outline: Polygon | undefined, areas: Record<string, AreaInfo>) {
    this._rooms = rooms;
    this._outline = outline;
    this._areas = areas;
    this.update();
  }

  /** The room under the pointer, or the last tapped one; an icon-only room then names itself in a chip. */
  point(areaId: string | undefined) {
    if (areaId === this._pointed) return;
    this._pointed = areaId;
    this.update();
  }

  update = () => {
    const kept = new Set<string>();
    for (const room of this._rooms) {
      const areaId = String(room.properties?.area_id ?? room.id);
      const rings = room.geometry.coordinates.map((ring) => ring.map((position) => this._toScreen(position)));
      const space = labelSpace(rings);
      const step = labelStep(space.width, space.height, this._withSize);
      if (step === "none") continue;
      kept.add(areaId);
      const label = this._labels.get(areaId) ?? this._newLabel(areaId);
      const area = this._areas[areaId];
      const name = area?.name ?? String(room.properties?.name ?? areaId);
      const icon = area?.icon || FALLBACK_ICON;
      const size = step === "size" ? `${Number(room.properties?.area_m2).toFixed(1)} m²` : "";
      const chip = step === "icon" && areaId === this._pointed;
      const shown = JSON.stringify([step, name, icon, size, chip, Math.floor(space.width)]);
      if (shown !== label.shown) {
        label.shown = shown;
        this._fill(label.marker.getElement(), { step, name, icon, size, chip, width: space.width });
      }
      label.marker.setLngLat(this._map.unproject(space.at));
    }
    for (const [areaId, label] of this._labels) {
      if (kept.has(areaId)) continue;
      label.marker.remove();
      this._labels.delete(areaId);
    }
    this._placeBuildingLabel();
  };

  private _toScreen(position: number[]): Point {
    const { x, y } = this._map.project([position[0], position[1]]);
    return [x, y];
  }

  private _newLabel(areaId: string): Label {
    const element = document.createElement("div");
    element.className = "room-label";
    element.dataset.area = areaId;
    const label = { marker: new Marker({ element }).setLngLat([0, 0]).addTo(this._map), shown: "" };
    this._labels.set(areaId, label);
    return label;
  }

  private _fill(
    element: HTMLElement,
    { step, name, icon, size, chip, width }: { step: LabelStep; name: string; icon: string; size: string; chip: boolean; width: number },
  ) {
    element.dataset.step = step;
    element.style.setProperty("--label-width", `${Math.max(0, Math.floor(width) - 8)}px`);
    const iconElement = document.createElement("ha-icon");
    iconElement.setAttribute("icon", icon);
    const parts: HTMLElement[] = [iconElement];
    const text = (className: string, content: string) =>
      Object.assign(document.createElement("span"), { className, textContent: content });
    if (step !== "icon") parts.push(text("name", name));
    if (size) parts.push(text("size", size));
    if (chip) parts.unshift(text("chip", name));
    element.replaceChildren(...parts);
  }

  // The outline names itself only until the floor has rooms, at its top-left corner on screen.
  private _placeBuildingLabel() {
    const outline = this._rooms.length ? undefined : this._outline;
    if (!outline) {
      this._building?.remove();
      this._building = undefined;
      return;
    }
    const corners = outline.coordinates[0].map((position) => this._toScreen(position));
    const left = Math.min(...corners.map(([x]) => x)) + BUILDING_INSET[0];
    const top = Math.min(...corners.map(([, y]) => y)) + BUILDING_INSET[1];
    if (!this._building) {
      const element = Object.assign(document.createElement("div"), { className: "building-label", textContent: "Building" });
      this._building = new Marker({ element, anchor: "top-left" }).setLngLat([0, 0]).addTo(this._map);
    }
    this._building.setLngLat(this._map.unproject([left, top]));
  }
}
