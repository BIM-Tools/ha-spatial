// Draws and adjusts rooms on the panel's map along the site axis, saving each action at once to Home Assistant.

import type { FeatureCollection, Polygon, Position } from "geojson";
import { html, nothing } from "lit";
import { type GeoJSONSource, Marker, type MapMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import { type AreaEntry, NEW_AREA, newAreaName, nextActive, stripOrder } from "./area-strip";
import { type Change, type FootprintBatch, History } from "./history";
import { byLevel, mapBearing } from "./map-view";
import {
  MIN_SIDE_M,
  addToFootprint,
  areaLabel,
  boxFromCorners,
  centreOf,
  edgeLengths,
  isAxisRectangle,
  resizeSide,
  sideLabels,
} from "./plan";

interface Connection {
  sendMessagePromise<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
}

export interface FloorEntry {
  floor_id: string;
  name: string;
  level: number | null;
}

export type Tool = "draw" | "adjust";

interface Pixel {
  x: number;
  y: number;
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const DRAG_MIN_PX = 5;
const LABEL_STYLE =
  "font: 12px sans-serif; background: rgba(255, 255, 255, 0.85); color: #212121; padding: 0 3px; border-radius: 3px; pointer-events: none";
const SIDE_STYLE = "font: 12px sans-serif; background: #fff; color: #212121; border: 1px solid #ff5722; border-radius: 3px";
// A side button or field sits on the map, inside a Marker that would block focus; its presses and keys stay its own.
const MAP_EVENTS = ["mousedown", "touchstart", "click", "dblclick", "keydown"];

export class RoomEditor {
  floors: FloorEntry[] = [];
  tool?: Tool;
  private readonly _history = new History();
  private _message = "";
  private _areas: AreaEntry[] = [];
  private _footprints = new Map<string, Polygon>();
  private _sizesM2 = new Map<string, number>();
  private _floor: string | null | "all" = "all";
  private _active = NEW_AREA;
  private _map?: MapLibreMap;
  private _corner?: Pixel;
  private _press?: Pixel;
  private _dragging = false;
  private _spaceHeld = false;
  private _saving = false;
  private _labels: Marker[] = [];
  private _sides: Marker[] = [];
  private _editingSide?: number;

  constructor(
    private readonly _connection: Connection,
    private readonly _requestUpdate: () => void,
    private readonly _reloadRooms: () => Promise<void>,
    private readonly _siteBearing: () => number,
  ) {}

  get status(): string {
    return this.tool && this._floor === "all" ? `Pick a floor to ${this.tool}` : this._message;
  }

  get canUndo() {
    return !this._saving && this._history.canUndo;
  }

  get canRedo() {
    return !this._saving && this._history.canRedo;
  }

  attach(map: MapLibreMap) {
    this._map = map;
    map.on("mousedown", this._down);
    map.on("mousemove", this._move);
    map.on("mouseup", this._up);
    map.on("click", this._click);
    window.addEventListener("keydown", this._undoKey);
  }

  addLayers(map: MapLibreMap) {
    map.addSource("spatial-draft", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "spatial-draft",
      type: "line",
      source: "spatial-draft",
      paint: { "line-color": "#ff5722", "line-width": 2, "line-dasharray": [2, 1] },
    });
  }

  detach() {
    this.setTool(undefined);
    window.removeEventListener("keydown", this._undoKey);
    this._map = undefined;
  }

  /** Takes the footprints from the feed and re-reads the area and floor registries. */
  async refresh(feed: FeatureCollection) {
    // On failure the previous lists stay; the next update reads them again.
    try {
      const [areas, floors] = await Promise.all([
        this._connection.sendMessagePromise<AreaEntry[]>({ type: "config/area_registry/list" }),
        this._connection.sendMessagePromise<FloorEntry[]>({ type: "config/floor_registry/list" }),
      ]);
      this._areas = areas;
      this.floors = [...floors].sort(byLevel);
    } catch (err) {
      console.error(err);
    }
    this._footprints = new Map(feed.features.map((feature) => [String(feature.id), feature.geometry as Polygon]));
    this._sizesM2 = new Map(feed.features.map((feature) => [String(feature.id), feature.properties?.area_m2]));
    const order = this._order();
    if (this._active !== NEW_AREA && !order.some((area) => area.area_id === this._active)) {
      this._active = order[0]?.area_id ?? NEW_AREA;
    }
    this._showSides();
    this._requestUpdate();
  }

  setFloor(floor: string | null | "all") {
    this._floor = floor;
    this._message = "";
    this._cancel();
    this._applyInput();
    this._select(nextActive(this._order(), this._linked()));
  }

  setTool(tool: Tool | undefined) {
    this.tool = tool;
    this._message = "";
    this._cancel();
    this._spaceHeld = false;
    if (tool === "draw") {
      window.addEventListener("keydown", this._key);
      window.addEventListener("keyup", this._key);
      window.addEventListener("blur", this._releaseSpace);
    } else {
      window.removeEventListener("keydown", this._key);
      window.removeEventListener("keyup", this._key);
      window.removeEventListener("blur", this._releaseSpace);
    }
    this._applyInput();
    this._select(this._active);
  }

  undo = () =>
    this._whileSaving(async () => {
      const change = this._history.undo();
      if (!change) return;
      await this._send(change.before).catch((err) => {
        this._history.redo();
        throw err;
      });
    });

  redo = () =>
    this._whileSaving(async () => {
      const change = this._history.redo();
      if (!change) return;
      await this._send(change.after).catch((err) => {
        this._history.undo();
        throw err;
      });
    });

  render() {
    if (this._floor === "all") return nothing;
    return html`<spatial-area-strip
      .order=${this._order()}
      .linked=${this._linked()}
      .active=${this._active}
      @area-select=${(event: CustomEvent<{ areaId: string }>) => {
        this._cancel();
        this._select(event.detail.areaId);
      }}
      @area-rename=${(event: CustomEvent<{ areaId: string; name: string }>) => this._rename(event.detail)}
    ></spatial-area-strip>`;
  }

  private get _canDraw() {
    return this.tool === "draw" && this._floor !== "all";
  }

  private _linked() {
    return new Set(this._footprints.keys());
  }

  private _order() {
    return this._floor === "all" ? [] : stripOrder(this._areas, this._linked(), this._floor);
  }

  private _select(areaId: string) {
    this._active = areaId;
    this._editingSide = undefined;
    this._showSides();
    this._requestUpdate();
  }

  // Boxes are screen rectangles, so the map must be flat and turned to the site axis.
  private _applyInput(align = true) {
    const map = this._map;
    if (!map) return;
    if (this._canDraw) {
      if (align) map.jumpTo({ bearing: mapBearing(this._siteBearing()), pitch: 0 });
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.touchPitch.disable();
    } else {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.touchPitch.enable();
    }
    if (this._canDraw && !this._spaceHeld) map.dragPan.disable();
    else map.dragPan.enable();
  }

  private _key = (event: KeyboardEvent) => {
    if (event.composedPath()[0] instanceof HTMLInputElement) return;
    if (event.key === "Escape") this._cancel();
    if (event.key !== " ") return;
    // Keeps Space from pressing the focused toolbar button.
    event.preventDefault();
    const held = event.type === "keydown";
    if (held === this._spaceHeld) return;
    this._spaceHeld = held;
    this._applyInput(false);
  };

  private _undoKey = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
    if (event.composedPath()[0] instanceof HTMLInputElement) return;
    event.preventDefault();
    if (event.shiftKey) this.redo();
    else this.undo();
  };

  // A keyup that happens in another window never arrives.
  private _releaseSpace = () => {
    this._spaceHeld = false;
    this._applyInput(false);
  };

  private _down = (event: MapMouseEvent) => {
    if (!this._canDraw || this._spaceHeld || this._saving || event.originalEvent.button !== 0) return;
    this._press = event.point;
    this._dragging = false;
  };

  private _move = (event: MapMouseEvent) => {
    if (!this._canDraw) return;
    const press = this._press;
    if (press && !this._dragging && Math.hypot(event.point.x - press.x, event.point.y - press.y) >= DRAG_MIN_PX) {
      this._dragging = true;
      this._corner = undefined;
    }
    const from = this._dragging ? press : this._corner;
    if (from) this._preview(this._box(from, event.point));
  };

  private _up = (event: MapMouseEvent) => {
    const press = this._press;
    const dragged = this._dragging;
    this._press = undefined;
    this._dragging = false;
    if (press && dragged) this._finish(press, event.point);
  };

  // MapLibre fires `click` for a tap too, so two taps draw a box on a phone.
  private _click = (event: MapMouseEvent) => {
    if (this.tool === "adjust" && this._floor !== "all") {
      const [room] = this._map!.queryRenderedFeatures(event.point, { layers: ["areas-2d"] });
      if (room) this._select(String(room.properties.area_id));
      return;
    }
    if (!this._canDraw || this._spaceHeld || this._saving) return;
    const corner = this._corner;
    if (!corner) {
      this._corner = event.point;
      return;
    }
    this._corner = undefined;
    this._finish(corner, event.point);
  };

  private _cancel() {
    this._corner = undefined;
    this._press = undefined;
    this._dragging = false;
    this._preview(undefined);
  }

  private _box(from: Pixel, to: Pixel): Polygon | undefined {
    const pixels = [
      [from.x, from.y],
      [to.x, from.y],
      [to.x, to.y],
      [from.x, to.y],
    ] as [number, number][];
    const corners = pixels.map((pixel): Position => this._map!.unproject(pixel).toArray());
    return boxFromCorners(corners as [Position, Position, Position, Position]);
  }

  private _preview(box: Polygon | undefined) {
    const map = this._map;
    map?.getSource<GeoJSONSource>("spatial-draft")?.setData(box ?? EMPTY);
    if (!map || !box) {
      for (const label of this._labels) label.remove();
      this._labels = [];
      return;
    }
    const labels = [...sideLabels(box), { at: centreOf(box), text: areaLabel(box) }];
    if (!this._labels.length) {
      this._labels = labels.map(() => {
        const element = document.createElement("span");
        element.style.cssText = LABEL_STYLE;
        return new Marker({ element }).setLngLat([0, 0]).addTo(map);
      });
    }
    labels.forEach(({ at, text }, index) => {
      this._labels[index].setLngLat(at as [number, number]);
      this._labels[index].getElement().textContent = text;
    });
  }

  // In Adjust each side of the active room, when it is a rectangle on the site axis, is a button that opens a length field.
  private _showSides() {
    for (const side of this._sides) side.remove();
    this._sides = [];
    const map = this._map;
    const areaId = this._active;
    const footprint = this._footprints.get(areaId);
    if (!map || this.tool !== "adjust" || this._floor === "all" || !footprint) return;
    const sizeM2 = this._sizesM2.get(areaId);
    if (sizeM2 !== undefined) {
      const element = Object.assign(document.createElement("span"), { textContent: `${sizeM2.toFixed(1)} m²` });
      element.style.cssText = LABEL_STYLE;
      this._sides.push(new Marker({ element }).setLngLat(centreOf(footprint) as [number, number]).addTo(map));
    }
    if (!isAxisRectangle(footprint, this._siteBearing())) return;
    const lengths = edgeLengths(footprint);
    let field: HTMLInputElement | undefined;
    this._sides.push(...sideLabels(footprint).map(({ at, edgeIndex, text }) => {
      let control: HTMLElement;
      if (edgeIndex === this._editingSide) {
        field = Object.assign(document.createElement("input"), {
          type: "number",
          step: "0.01",
          min: String(MIN_SIDE_M),
          value: lengths[edgeIndex].toFixed(2),
        });
        const typed = field;
        typed.addEventListener("keydown", (event) => {
          if (event.key === "Enter") this._resize(areaId, footprint, edgeIndex, Number(typed.value));
          if (event.key === "Escape") this._select(areaId);
        });
        control = typed;
      } else {
        control = Object.assign(document.createElement("button"), { textContent: text });
        control.addEventListener("click", () => {
          this._editingSide = edgeIndex;
          this._showSides();
        });
      }
      control.style.cssText = SIDE_STYLE;
      if (control === field) control.style.width = "6em";
      for (const type of MAP_EVENTS) control.addEventListener(type, (event) => event.stopPropagation());
      const element = document.createElement("span");
      element.append(control);
      return new Marker({ element }).setLngLat(at as [number, number]).addTo(map);
    }));
    field?.focus();
    field?.select();
  }

  private _resize(areaId: string, footprint: Polygon, edgeIndex: number, lengthM: number) {
    // An empty field reads as 0.
    if (!(lengthM >= MIN_SIDE_M)) {
      this._message = `A side is at least ${MIN_SIDE_M.toFixed(2)} m`;
      this._requestUpdate();
      return;
    }
    const after = resizeSide(footprint, edgeIndex, lengthM);
    this._editingSide = undefined;
    this._whileSaving(() => this._apply({ before: { [areaId]: footprint }, after: { [areaId]: after } }));
  }

  private async _finish(from: Pixel, to: Pixel) {
    const box = this._box(from, to);
    this._preview(undefined);
    if (!box) return;
    const areaId = this._active;
    const floor = this._floor;
    const current = areaId === NEW_AREA ? undefined : this._footprints.get(areaId);
    const footprint = addToFootprint(current, box);
    if (!footprint) {
      this._message = "A room is one shape: draw against it";
      this._requestUpdate();
      return;
    }
    await this._whileSaving(async () => {
      const id = areaId === NEW_AREA ? await this._createArea(floor) : areaId;
      // A retry after a failed save goes to the created area, not to another new one.
      if (this._floor === floor) this._active = id;
      await this._apply({ before: { [id]: current ?? null }, after: { [id]: footprint } });
      if (this._floor === floor) this._active = nextActive(this._order(), this._linked());
    });
  }

  private async _apply(change: Change) {
    await this._send(change.after);
    this._history.record(change);
  }

  // One action at a time: a second one before the first settles would build on a stale footprint.
  private async _whileSaving(action: () => Promise<void>) {
    if (this._saving) return;
    this._saving = true;
    this._requestUpdate();
    let failed = false;
    try {
      await action();
      this._message = "";
    } catch (err) {
      console.error(err);
      this._message = "Could not save";
      failed = true;
    }
    // Released before the reload, so a reload that hangs does not block input.
    this._saving = false;
    this._showSides();
    this._requestUpdate();
    if (failed) await this._reloadRooms().catch(console.error);
  }

  private async _send(areas: FootprintBatch) {
    await this._connection.sendMessagePromise({ type: "spatial/area/update_geometries", areas });
    for (const [areaId, footprint] of Object.entries(areas)) {
      if (footprint) this._footprints.set(areaId, footprint);
      else this._footprints.delete(areaId);
    }
  }

  private async _createArea(floor: string | null | "all"): Promise<string> {
    const entry = await this._connection.sendMessagePromise<AreaEntry>({
      type: "config/area_registry/create",
      name: newAreaName(this._areas.map((area) => area.name)),
      ...(floor === null ? {} : { floor_id: floor }),
    });
    this._areas = [...this._areas, entry];
    return entry.area_id;
  }

  private async _rename({ areaId, name }: { areaId: string; name: string }) {
    try {
      await this._connection.sendMessagePromise({ type: "config/area_registry/update", area_id: areaId, name });
      await this._reloadRooms();
    } catch (err) {
      console.error(err);
      this._message = "Could not rename";
      this._requestUpdate();
    }
  }
}
