// Draws, moves and adjusts rooms and the building outline on the panel's map along the site axis, saving each action at once to Home Assistant.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { FeatureCollection, Polygon, Position } from "geojson";
import { html, nothing } from "lit";
import { type GeoJSONSource, type LngLat, Marker, type MapMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import { type AreaEntry, BUILDING, NEW_AREA, newAreaName, nextActive, stripOrder } from "./area-strip";
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
  movePolygon,
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

interface Grab {
  areaId: string;
  footprint: Polygon;
  from: Position;
}

const lngLatOf = (event: MapMouseEvent): Position => [event.lngLat.lng, event.lngLat.lat];
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
  // A spot on the map, so a pan or zoom between the two taps does not move it.
  private _corner?: LngLat;
  private _press?: Pixel;
  private _dragging = false;
  // Set when a press starts inside the active space's footprint: a drag then moves it.
  private _grab?: Grab;
  private _spaceHeld = false;
  private _saving = false;
  private _labels: Marker[] = [];
  private _sides: Marker[] = [];
  private _editingSide?: number;
  // Counts acknowledged saves and started refreshes, so an older refresh cannot undo a newer save.
  private _changes = 0;

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
    // The toolbar works before the map exists.
    this._applyInput();
    this._showSides();
  }

  addLayers(map: MapLibreMap) {
    const paint = {
      "line-color": getComputedStyle(map.getContainer()).getPropertyValue("--primary-color").trim() || "#03a9f4",
      "line-width": 4,
    };
    map.addLayer({ id: "spatial-active", type: "line", source: "areas", filter: this._activeFilter(), paint });
    map.addLayer({
      id: "spatial-active-building",
      type: "line",
      source: "outline",
      layout: { visibility: this._buildingVisibility() },
      paint,
    });
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

  /** Takes the footprints from the requested feed and site, and re-reads the area and floor registries. */
  async refresh(feedRequest: Promise<FeatureCollection>, siteRequest: Promise<{ outline: Polygon | null }>) {
    const started = ++this._changes;
    const registries = Promise.all([
      this._connection.sendMessagePromise<AreaEntry[]>({ type: "config/area_registry/list" }),
      this._connection.sendMessagePromise<FloorEntry[]>({ type: "config/floor_registry/list" }),
    ]).catch((err) => {
      // The previous lists stay; the next update reads them again.
      console.error(err);
      return undefined;
    });
    const [feed, { outline }, lists] = await Promise.all([feedRequest, siteRequest, registries]);
    // A save acknowledged or a refresh started since then knows newer footprints.
    if (started !== this._changes) return;
    if (lists) {
      this._areas = lists[0];
      this.floors = [...lists[1]].sort(byLevel);
    }
    this._footprints = new Map(feed.features.map((feature) => [String(feature.id), feature.geometry as Polygon]));
    if (outline) this._footprints.set(BUILDING, outline);
    this._sizesM2 = new Map(feed.features.map((feature) => [String(feature.id), feature.properties?.area_m2]));
    const order = this._order();
    if (![NEW_AREA, BUILDING, ...order.map((area) => area.area_id)].includes(this._active)) {
      this._setActive(order[0]?.area_id ?? NEW_AREA);
    }
    this._showSides();
    this._requestUpdate();
  }

  setFloor(floor: string | null | "all") {
    this._floor = floor;
    this._message = "";
    this._cancel();
    this._applyInput();
    this._select(this._nextActive());
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

  // An area without a footprint has no feature, so nothing is highlighted.
  private _activeFilter(): ["==", ["get", string], string] {
    return ["==", ["get", "area_id"], this._active];
  }

  private _buildingVisibility() {
    return this._active === BUILDING ? "visible" : "none";
  }

  private _setActive(areaId: string) {
    this._active = areaId;
    if (!this._map?.getLayer("spatial-active")) return;
    this._map.setFilter("spatial-active", this._activeFilter());
    this._map.setLayoutProperty("spatial-active-building", "visibility", this._buildingVisibility());
  }

  // The outline comes first, as it frames the rooms.
  private _nextActive() {
    return this._footprints.has(BUILDING) ? nextActive(this._order(), this._linked()) : BUILDING;
  }

  private _select(areaId: string) {
    this._setActive(areaId);
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
    if (held && this._grab) this._cancel();
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
    if (!this.tool || this._floor === "all" || this._spaceHeld || this._saving || event.originalEvent.button !== 0) {
      return;
    }
    const at = lngLatOf(event);
    const footprint = this._footprints.get(this._active);
    this._grab =
      footprint && booleanPointInPolygon(at, footprint) ? { areaId: this._active, footprint, from: at } : undefined;
    if (!this._grab && !this._canDraw) return;
    // Keeps MapLibre from panning the map under the room in Adjust.
    if (this._grab) event.preventDefault();
    this._press = event.point;
    this._dragging = false;
  };

  private _move = (event: MapMouseEvent) => {
    const grab = this._grab;
    if (!this._canDraw && !grab) return;
    const press = this._press;
    if (press && !this._dragging && Math.hypot(event.point.x - press.x, event.point.y - press.y) >= DRAG_MIN_PX) {
      this._dragging = true;
      this._corner = undefined;
    }
    if (grab) {
      if (this._dragging) this._preview(movePolygon(grab.footprint, grab.from, lngLatOf(event)));
      return;
    }
    const from = this._dragging ? press : this._corner && this._map!.project(this._corner);
    if (from) this._preview(this._box(from, event.point));
  };

  private _up = (event: MapMouseEvent) => {
    const press = this._press;
    const dragged = this._dragging;
    const grab = this._grab;
    this._press = undefined;
    this._dragging = false;
    this._grab = undefined;
    if (!press || !dragged) return;
    if (grab) this._drop(grab, lngLatOf(event));
    else this._finish(press, event.point);
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
      this._corner = event.lngLat;
      return;
    }
    this._corner = undefined;
    this._finish(this._map!.project(corner), event.point);
  };

  private _cancel() {
    this._corner = undefined;
    this._press = undefined;
    this._dragging = false;
    this._grab = undefined;
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
      if (this._floor === floor) this._setActive(id);
      await this._apply({ before: { [id]: current ?? null }, after: { [id]: footprint } });
      if (this._floor === floor) this._setActive(this._nextActive());
    });
  }

  private _drop({ areaId, footprint, from }: Grab, to: Position) {
    this._preview(undefined);
    this._whileSaving(() =>
      this._apply({ before: { [areaId]: footprint }, after: { [areaId]: movePolygon(footprint, from, to) } }),
    );
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

  // Every batch holds one key, so it is either the site outline or areas, never both.
  private async _send(batch: FootprintBatch) {
    await this._connection.sendMessagePromise(
      BUILDING in batch
        ? { type: "spatial/site/update", outline: batch[BUILDING] }
        : { type: "spatial/area/update_geometries", areas: batch },
    );
    this._changes++;
    for (const [areaId, footprint] of Object.entries(batch)) {
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
