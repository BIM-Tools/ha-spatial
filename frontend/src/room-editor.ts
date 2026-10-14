// Draws rooms on the panel's map as boxes along the site axis, saving each box at once to the active area.

import type { FeatureCollection, Polygon, Position } from "geojson";
import { html, nothing } from "lit";
import { type GeoJSONSource, Marker, type MapMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import { type AreaEntry, NEW_AREA, newAreaName, nextActive, stripOrder } from "./area-strip";
import { History } from "./history";
import { mapBearing } from "./map-view";
import { addToFootprint, areaLabel, boxFromCorners, centreOf, sideLabels } from "./plan";

interface Connection {
  sendMessagePromise<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
}

export interface FloorEntry {
  floor_id: string;
  name: string;
}

interface Pixel {
  x: number;
  y: number;
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const DRAG_MIN_PX = 5;
const LABEL_STYLE =
  "font: 12px sans-serif; background: rgba(255, 255, 255, 0.85); color: #212121; padding: 0 3px; border-radius: 3px; pointer-events: none";

export class RoomEditor {
  readonly history = new History();
  floors: FloorEntry[] = [];
  drawing = false;
  private _message = "";
  private _areas: AreaEntry[] = [];
  private _footprints = new Map<string, Polygon>();
  private _floor: string | null | "all" = "all";
  private _active = NEW_AREA;
  private _map?: MapLibreMap;
  private _corner?: Pixel;
  private _press?: Pixel;
  private _dragging = false;
  private _spaceHeld = false;
  private _saving = false;
  private _labels: Marker[] = [];

  constructor(
    private readonly _connection: Connection,
    private readonly _requestUpdate: () => void,
    private readonly _reloadRooms: () => Promise<void>,
    private readonly _siteBearing: () => number,
  ) {}

  get status(): string {
    return this.drawing && this._floor === "all" ? "Pick a floor to draw" : this._message;
  }

  attach(map: MapLibreMap) {
    this._map = map;
    map.on("mousedown", this._down);
    map.on("mousemove", this._move);
    map.on("mouseup", this._up);
    map.on("click", this._click);
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
    this.setDrawing(false);
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
      this.floors = floors;
    } catch (err) {
      console.error(err);
    }
    this._footprints = new Map(feed.features.map((feature) => [String(feature.id), feature.geometry as Polygon]));
    const order = this._order();
    if (this._active !== NEW_AREA && !order.some((area) => area.area_id === this._active)) {
      this._active = order[0]?.area_id ?? NEW_AREA;
    }
    this._requestUpdate();
  }

  setFloor(floor: string | null | "all") {
    this._floor = floor;
    this._message = "";
    this._cancel();
    this._active = nextActive(this._order(), this._linked());
    this._applyInput();
    this._requestUpdate();
  }

  setDrawing(drawing: boolean) {
    this.drawing = drawing;
    this._cancel();
    this._spaceHeld = false;
    if (drawing) {
      window.addEventListener("keydown", this._key);
      window.addEventListener("keyup", this._key);
      window.addEventListener("blur", this._releaseSpace);
    } else {
      window.removeEventListener("keydown", this._key);
      window.removeEventListener("keyup", this._key);
      window.removeEventListener("blur", this._releaseSpace);
    }
    this._applyInput();
    this._requestUpdate();
  }

  render() {
    if (this._floor === "all") return nothing;
    return html`<spatial-area-strip
      .order=${this._order()}
      .linked=${this._linked()}
      .active=${this._active}
      @area-select=${(event: CustomEvent<{ areaId: string }>) => {
        this._active = event.detail.areaId;
        this._cancel();
        this._requestUpdate();
      }}
      @area-rename=${(event: CustomEvent<{ areaId: string; name: string }>) => this._rename(event.detail)}
    ></spatial-area-strip>`;
  }

  private get _canDraw() {
    return this.drawing && this._floor !== "all";
  }

  private _linked() {
    return new Set(this._footprints.keys());
  }

  private _order() {
    return this._floor === "all" ? [] : stripOrder(this._areas, this._linked(), this._floor);
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
    // A second box before this one settles would replace it, or create a second area.
    this._saving = true;
    try {
      const id = areaId === NEW_AREA ? await this._createArea(floor) : areaId;
      // A retry after a failed save goes to the created area, not to another new one.
      if (this._floor === floor) this._active = id;
      await this._connection.sendMessagePromise({
        type: "spatial/area/update_geometries",
        areas: { [id]: footprint },
      });
      this.history.record({ before: { [id]: current ?? null }, after: { [id]: footprint } });
      this._footprints.set(id, footprint);
      this._message = "";
      if (this._floor === floor) this._active = nextActive(this._order(), this._linked());
    } catch (err) {
      console.error(err);
      this._message = "Could not save";
      await this._reloadRooms().catch(console.error);
    } finally {
      this._saving = false;
    }
    this._requestUpdate();
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
