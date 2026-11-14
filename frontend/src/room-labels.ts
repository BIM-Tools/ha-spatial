// Names the rooms on the plan with their Home Assistant icon and name, sized to the room as it appears on screen.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Polygon } from "geojson";
import { css } from "lit";
import { Marker, type Map as MapLibreMap } from "maplibre-gl";
import polylabel from "polylabel";
import { type ScreenBox, type Size, isSmall, placeLabels, screenShape, viewportOf } from "./draft-labels";
import { type HassUnits, formatArea } from "./units";

type Point = [number, number];

// A name chip's centre from its label's centre.
interface ChipPlace {
  x: number;
  y: number;
}

/** What a room's label shows: everything, icon and name, the icon, or nothing. */
export type LabelStep = "size" | "name" | "icon" | "none";

// How long a tap on a room keeps its name chip, in milliseconds.
const TAP_MS = 2000;
// Custom: the chip's size where its element cannot be measured (not yet built): 24 px high, about 7 px a letter,
// so the first placement of a chip can be off by a few pixels until the next camera move measures it.
const chipSize = (element: HTMLElement | null, name: string): Size => ({
  width: element?.offsetWidth || name.length * 7 + 16,
  height: element?.offsetHeight || 24,
});

const FALLBACK_ICON = "mdi:home-outline";
// Building label offset from the outline's top-left corner, in pixels.
const BUILDING_INSET: Point = [10, 8];
// The space each step needs around the label's centre, in pixels, largest first.
const STEP_SPACE: [LabelStep, number, number][] = [
  ["size", 90, 62],
  ["name", 72, 42],
  ["icon", 22, 22],
];

/**
 * The largest step whose space, centred on `at`, has all four corners inside the rings;
 * `withSize` false leaves out the m². A concave notch between two corners is not seen.
 */
export const labelStep = (rings: Point[][], at: Point, withSize: boolean): LabelStep => {
  const room: Polygon = { type: "Polygon", coordinates: rings };
  const inside = ([x, y]: Point) => booleanPointInPolygon([x, y], room);
  for (const [step, width, height] of STEP_SPACE) {
    const [halfWidth, halfHeight] = [width / 2, height / 2];
    const corners: Point[] = [
      [at[0] - halfWidth, at[1] - halfHeight],
      [at[0] + halfWidth, at[1] - halfHeight],
      [at[0] + halfWidth, at[1] + halfHeight],
      [at[0] - halfWidth, at[1] + halfHeight],
    ];
    if (corners.every(inside)) return step === "size" && !withSize ? "name" : step;
  }
  return "none";
};

// Custom: the distance from `at` to the nearest crossing with the rings along the x axis, on either side.
const halfWidthAt = (rings: Point[][], at: Point): number => {
  let nearest = Infinity;
  for (const ring of rings) {
    for (let index = 0; index < ring.length - 1; index++) {
      const [from, to] = [ring[index], ring[index + 1]];
      if (from[1] === to[1] || (at[1] - from[1]) * (at[1] - to[1]) > 0) continue;
      const crossing = from[0] + ((at[1] - from[1]) * (to[0] - from[0])) / (to[1] - from[1]);
      nearest = Math.min(nearest, Math.abs(crossing - at[0]));
    }
  }
  return nearest;
};

/**
 * Where a label goes in a polygon given in screen pixels, and the width across the room
 * there, which bounds the name. The point is the pole of inaccessibility, never the
 * centroid, so an L-shaped room gets its label in its widest part.
 */
export const labelSpace = (rings: Point[][]): { at: Point; width: number } => {
  const pole = polylabel(rings, 1);
  const at: Point = [pole[0], pole[1]];
  return { at, width: 2 * halfWidthAt(rings, at) };
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
  /* A live value is read against the room's fill, so it takes the primary text colour. */
  .room-label .size.live {
    color: var(--primary-text-color);
  }
  /* Placed by the one rule: --chip-x and --chip-y are the chip's centre from the label's centre. */
  .room-label .chip {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(calc(-50% + var(--chip-x)), calc(-50% + var(--chip-y)));
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
  private _texts: Record<string, string> = {};
  private _pointed?: string;
  private _active?: string;
  private _tapTimer?: ReturnType<typeof setTimeout>;
  private _boxes: ScreenBox[] = [];
  private _hidden = new Set<string>();
  private _labels = new Map<string, Label>();
  private _building?: Marker;

  constructor(
    private readonly _map: MapLibreMap,
    private readonly _withSize: boolean,
    private readonly _units: () => HassUnits,
    private readonly _buildingName: () => string,
  ) {
    _map.on("move", this.update);
    _map.on("resize", this.update);
  }

  destroy() {
    this._map.off("move", this.update);
    this._map.off("resize", this.update);
    clearTimeout(this._tapTimer);
    this.show([], undefined, {});
  }

  /**
   * The rooms of the floor on screen (none for all floors), the building outline and Home Assistant's areas.
   * `texts` is an optional second line per area id, such as a room's live value; the panel's m² shows where there is none.
   */
  show(rooms: Feature<Polygon>[], outline: Polygon | undefined, areas: Record<string, AreaInfo>, texts: Record<string, string> = {}) {
    this._rooms = rooms;
    this._texts = texts;
    this._outline = outline;
    this._areas = areas;
    this.update();
  }

  /** The room under the pointer; a room too small to name itself then does so in a chip. */
  point(areaId: string | undefined) {
    clearTimeout(this._tapTimer);
    this._set(areaId);
  }

  /** A tap on a room: its chip shows for 2 s. */
  tap(areaId: string) {
    clearTimeout(this._tapTimer);
    this._set(areaId);
    this._tapTimer = setTimeout(() => this._set(undefined), TAP_MS);
  }

  /** The room being edited; while small, it keeps its name chip. */
  activate(areaId: string | undefined) {
    if (areaId === this._active) return;
    this._active = areaId;
    this.update();
  }

  /** The screen boxes (map container pixels) of the labels and name chips shown now, for others to keep clear of. */
  boxes(): ScreenBox[] {
    return this._boxes;
  }

  private _set(areaId: string | undefined) {
    if (areaId === this._pointed) return;
    this._pointed = areaId;
    this.update();
  }

  /** The rooms whose labels step aside while a draft over them shows its own numbers; none shows them all. */
  hide(areaIds: readonly string[]) {
    this._hidden = new Set(areaIds);
    this.update();
  }

  update = () => {
    const kept = new Set<string>();
    const rooms = [];
    const labelBoxes = new Map<string, ScreenBox>();
    for (const room of this._rooms) {
      const areaId = String(room.properties?.area_id ?? room.id);
      if (this._hidden.has(areaId)) continue;
      const rings = room.geometry.coordinates.map((ring) => ring.map((position) => this._toScreen(position)));
      const space = labelSpace(rings);
      const text = this._texts[areaId];
      const step = labelStep(rings, space.at, this._withSize || text !== undefined);
      // Only "none" is not in STEP_SPACE, and takes no space.
      const [, width, height] = STEP_SPACE.find(([name]) => name === step) ?? [step, 0, 0];
      if (step !== "none") labelBoxes.set(areaId, { centre: { x: space.at[0], y: space.at[1] }, size: { width, height } });
      rooms.push({ room, areaId, rings, space, text, step, labelSize: { width, height } });
    }
    const chipBoxes: ScreenBox[] = [];
    for (const { room, areaId, rings, space, text, step, labelSize } of rooms) {
      const area = this._areas[areaId];
      const name = area?.name ?? String(room.properties?.name ?? areaId);
      const { sides, box, centre } = screenShape(rings[0].slice(0, -1).map(([x, y]) => ({ x, y })));
      const small = isSmall(box);
      const named = step === "size" || step === "name";
      // Pointed at or tapped, a room that cannot name itself does so in a chip; the active small room always does.
      const wantChip = (areaId === this._pointed && !named) || (areaId === this._active && small);
      let chip: ChipPlace | undefined;
      if (wantChip) {
        const label = this._labels.get(areaId)?.marker.getElement().querySelector<HTMLElement>(".chip") ?? null;
        const size = chipSize(label, name);
        const own = [...labelBoxes].filter(([id]) => id !== areaId).map(([, labelBox]) => labelBox);
        const { name: offset } = placeLabels({
          sides,
          sideSizes: sides.map(() => ({ width: 0, height: 0 })),
          box,
          area: { centre, size: labelSize },
          controls: [...own, ...chipBoxes],
          name: size,
          viewport: viewportOf(this._map.getContainer()),
        });
        if (offset) {
          chip = { x: centre.x - space.at[0] + offset.x, y: centre.y - space.at[1] + offset.y };
          chipBoxes.push({ centre: { x: centre.x + offset.x, y: centre.y + offset.y }, size });
        }
      }
      if (step === "none" && !chip) continue;
      kept.add(areaId);
      const label = this._labels.get(areaId) ?? this._newLabel(areaId);
      const icon = area?.icon || FALLBACK_ICON;
      const size = step !== "size" ? "" : (text ?? formatArea(Number(room.properties?.area_m2), this._units()));
      const shown = JSON.stringify([step, name, icon, size, text !== undefined, chip, Math.floor(space.width)]);
      if (shown !== label.shown) {
        label.shown = shown;
        this._fill(label.marker.getElement(), { step, name, icon, size, live: text !== undefined, chip, width: space.width });
      }
      label.marker.setLngLat(this._map.unproject(space.at));
    }
    for (const [areaId, label] of this._labels) {
      if (kept.has(areaId)) continue;
      label.marker.remove();
      this._labels.delete(areaId);
    }
    // The active room is edited under its own label, which its side chips need not keep clear of.
    this._boxes = [...[...labelBoxes].filter(([id]) => id !== this._active).map(([, labelBox]) => labelBox), ...chipBoxes];
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
    { step, name, icon, size, live, chip, width }: { step: LabelStep; name: string; icon: string; size: string; live: boolean; chip?: ChipPlace; width: number },
  ) {
    element.dataset.step = step;
    // Named at every step, also when only the icon shows.
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", size ? `${name}, ${size}` : name);
    element.style.setProperty("--label-width", `${Math.max(0, Math.floor(width) - 8)}px`);
    const iconElement = document.createElement("ha-icon");
    iconElement.setAttribute("icon", icon);
    const parts: HTMLElement[] = step === "none" ? [] : [iconElement];
    const text = (className: string, content: string) =>
      Object.assign(document.createElement("span"), { className, textContent: content });
    if (step !== "icon") parts.push(text("name", name));
    if (size) parts.push(text(live ? "size live" : "size", size));
    if (chip) {
      const chipElement = text("chip", name);
      chipElement.style.setProperty("--chip-x", `${chip.x}px`);
      chipElement.style.setProperty("--chip-y", `${chip.y}px`);
      parts.unshift(chipElement);
    }
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
      const element = Object.assign(document.createElement("div"), { className: "building-label" });
      this._building = new Marker({ element, anchor: "top-left" }).setLngLat([0, 0]).addTo(this._map);
    }
    const element = this._building.getElement();
    const name = this._buildingName();
    if (element.textContent !== name) element.textContent = name;
    this._building.setLngLat(this._map.unproject([left, top]));
  }
}
