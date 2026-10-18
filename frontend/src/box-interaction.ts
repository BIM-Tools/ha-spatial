// Captures mouse, touch and keyboard input on the map to draft boxes, move rooms and pick areas.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { FeatureCollection, Polygon, Position } from "geojson";
import { type GeoJSONSource, type LngLat, Marker, type MapMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import { mapBearing } from "./map-view";
import { areaLabel, boxFromCorners, centreOf, movePolygon, sideLabels } from "./plan";

export interface Pixel {
  x: number;
  y: number;
}

export interface BoxInteractionCallbacks {
  readonly canDraw: () => boolean;
  readonly canAdjust: () => boolean;
  readonly activeFootprint: () => Polygon | undefined;
  readonly siteBearing: () => number;
  readonly onBox: (box: Polygon) => void;
  readonly onMove: (from: Position, to: Position) => void;
  readonly onPickRoom: (areaId: string) => void;
}

interface Grab {
  footprint: Polygon;
  from: Position;
}

const lngLatOf = (event: MapMouseEvent): Position => [event.lngLat.lng, event.lngLat.lat];
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const DRAG_MIN_PX = 5;
const LABEL_STYLE =
  "font: 12px sans-serif; background: rgba(255, 255, 255, 0.85); color: #212121; padding: 0 3px; border-radius: 3px; pointer-events: none";

export class BoxInteraction {
  private _corner?: LngLat;
  private _press?: Pixel;
  private _dragging = false;
  private _grab?: Grab;
  private _spaceHeld = false;
  private _labels: Marker[] = [];

  constructor(
    private readonly _map: MapLibreMap,
    private readonly _callbacks: BoxInteractionCallbacks,
  ) {
    _map.on("mousedown", this._down);
    _map.on("mousemove", this._move);
    _map.on("mouseup", this._up);
    _map.on("click", this._click);
    window.addEventListener("keydown", this._key);
    window.addEventListener("keyup", this._key);
    window.addEventListener("blur", this._releaseSpace);
    this.applyInput();
  }

  destroy() {
    this._cancel();
    window.removeEventListener("keydown", this._key);
    window.removeEventListener("keyup", this._key);
    window.removeEventListener("blur", this._releaseSpace);
    this._map.off?.("mousedown", this._down);
    this._map.off?.("mousemove", this._move);
    this._map.off?.("mouseup", this._up);
    this._map.off?.("click", this._click);
  }

  addLayers() {
    this._map.addSource("spatial-draft", { type: "geojson", data: EMPTY });
    this._map.addLayer({
      id: "spatial-draft",
      type: "line",
      source: "spatial-draft",
      paint: { "line-color": "#ff5722", "line-width": 2, "line-dasharray": [2, 1] },
    });
  }

  cancel() {
    this._cancel();
  }

  // Boxes are screen rectangles, so the map must be flat and turned to the site axis.
  applyInput(align = true) {
    const map = this._map;
    if (this._callbacks.canDraw()) {
      if (align) map.jumpTo({ bearing: mapBearing(this._callbacks.siteBearing()), pitch: 0 });
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.touchPitch.disable();
    } else {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.touchPitch.enable();
    }
    if (this._callbacks.canDraw() && !this._spaceHeld) map.dragPan.disable();
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
    this.applyInput(false);
  };

  // A keyup that happens in another window never arrives.
  private _releaseSpace = () => {
    this._spaceHeld = false;
    this.applyInput(false);
  };

  private _down = (event: MapMouseEvent) => {
    if (this._spaceHeld || event.originalEvent.button !== 0) return;
    const canDraw = this._callbacks.canDraw();
    const canAdjust = this._callbacks.canAdjust();
    if (!canDraw && !canAdjust) return;
    const at = lngLatOf(event);
    const footprint = this._callbacks.activeFootprint();
    this._grab = footprint && booleanPointInPolygon(at, footprint) ? { footprint, from: at } : undefined;
    if (!this._grab && !canDraw) return;
    // Keeps MapLibre from panning the map under the room in Adjust.
    if (this._grab) event.originalEvent.preventDefault?.();
    this._press = event.point;
    this._dragging = false;
  };

  private _move = (event: MapMouseEvent) => {
    const grab = this._grab;
    const canDraw = this._callbacks.canDraw();
    if (!canDraw && !grab) return;
    const press = this._press;
    if (press && !this._dragging && Math.hypot(event.point.x - press.x, event.point.y - press.y) >= DRAG_MIN_PX) {
      this._dragging = true;
      this._corner = undefined;
    }
    if (grab) {
      if (this._dragging) this._preview(movePolygon(grab.footprint, grab.from, lngLatOf(event)));
      return;
    }
    const from = this._dragging ? press : this._corner && this._map.project(this._corner);
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
    if (this._callbacks.canAdjust()) {
      const [room] = this._map.queryRenderedFeatures(event.point, { layers: ["areas-2d"] });
      if (room) this._callbacks.onPickRoom(String(room.properties.area_id));
      return;
    }
    if (!this._callbacks.canDraw() || this._spaceHeld) return;
    const corner = this._corner;
    if (!corner) {
      this._corner = event.lngLat;
      return;
    }
    this._corner = undefined;
    this._finish(this._map.project(corner), event.point);
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
    const corners = pixels.map((pixel): Position => this._map.unproject(pixel).toArray());
    return boxFromCorners(corners as [Position, Position, Position, Position]);
  }

  private _preview(box: Polygon | undefined) {
    const map = this._map;
    map.getSource<GeoJSONSource>("spatial-draft")?.setData(box ?? EMPTY);
    if (!box) {
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

  private _finish(from: Pixel, to: Pixel) {
    const box = this._box(from, to);
    this._preview(undefined);
    if (box) this._callbacks.onBox(box);
  }

  private _drop({ footprint, from }: Grab, to: Position) {
    this._preview(undefined);
    this._callbacks.onMove(from, to);
  }
}
