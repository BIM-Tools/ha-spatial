// Turns mouse input and keys on the map into box drafts, room moves and room picks, so the room editor only edits and saves.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { feature } from "@turf/helpers";
import type { FeatureCollection, Polygon, Position } from "geojson";
import { type GeoJSONSource, type LngLat, Marker, type MapMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import type { LayerColours } from "./map-paint";
import { mapBearing } from "./map-view";
import { addToFootprint, areaLabel, boxFromCorners, centreOf, movePolygon, sideLabels } from "./plan";
import type { Tool } from "./room-editor";

interface Pixel {
  x: number;
  y: number;
}

export interface ActiveRoom {
  areaId: string;
  footprint: Polygon;
}

export interface BoxInteractionCallbacks {
  readonly tool: () => Tool;
  readonly floorPicked: () => boolean;
  readonly saving: () => boolean;
  readonly activeRoom: () => ActiveRoom | undefined;
  readonly siteBearing: () => number;
  readonly onBox: (box: Polygon) => void;
  readonly onMove: (room: ActiveRoom, moved: Polygon) => void;
  readonly onPickRoom: (areaId: string) => void;
}

interface Grab {
  room: ActiveRoom;
  from: Position;
}

const lngLatOf = (event: MapMouseEvent): Position => [event.lngLat.lng, event.lngLat.lat];
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const DRAG_MIN_PX = 5;
const LABEL_STYLE =
  "font: 12px sans-serif; background: color-mix(in srgb, var(--card-background-color) 85%, transparent); color: var(--primary-text-color); padding: 0 3px; border-radius: 3px; pointer-events: none";

export class BoxInteraction {
  // A spot on the map, so a pan or zoom between the two taps does not move it.
  private _corner?: LngLat;
  private _press?: Pixel;
  private _dragging = false;
  // Set when a press starts inside the active room's footprint: a drag then moves it.
  private _grab?: Grab;
  private _spaceHeld = false;
  private _labels: Marker[] = [];
  // The shape of a failed save, shown until it saves or the next draft replaces it.
  private _kept?: Polygon;

  constructor(
    private readonly _map: MapLibreMap,
    private readonly _callbacks: BoxInteractionCallbacks,
  ) {
    _map.on("mousedown", this._down);
    _map.on("mousemove", this._move);
    _map.on("mouseup", this._up);
    _map.on("click", this._click);
    this.toolChanged();
  }

  destroy() {
    this.cancel();
    this._listenToKeys(false);
    this._map.off("mousedown", this._down);
    this._map.off("mousemove", this._move);
    this._map.off("mouseup", this._up);
    this._map.off("click", this._click);
  }

  addLayers(colours: LayerColours) {
    this._map.addSource("spatial-draft", { type: "geojson", data: EMPTY });
    this._map.addLayer({ id: "spatial-draft-fill", type: "fill", source: "spatial-draft", paint: colours["spatial-draft-fill"] });
    this._map.addLayer({
      id: "spatial-draft",
      type: "line",
      source: "spatial-draft",
      paint: { ...colours["spatial-draft"], "line-width": 2, "line-dasharray": [2, 1] },
    });
  }

  cancel() {
    this._corner = undefined;
    this._press = undefined;
    this._dragging = false;
    this._grab = undefined;
    this._preview(undefined);
  }

  keepShape(shape: Polygon) {
    if (this._press || this._corner) return;
    this._preview(undefined);
    this._kept = shape;
    this._map.getSource<GeoJSONSource>("spatial-draft")?.setData(feature(shape, { apart: false }));
  }

  dropShape(shape: Polygon) {
    if (this._kept === shape) this._preview(undefined);
  }

  // Space pans and Escape cancels only in Draw on a floor; elsewhere the keys keep their usual meaning.
  // Also called on a floor change, since All does not draw.
  toolChanged() {
    this.cancel();
    this._spaceHeld = false;
    this._listenToKeys(this._canDraw());
    this.applyInput();
  }

  // Boxes are screen rectangles, so the map must be flat and turned to the site axis.
  applyInput(align = true) {
    const map = this._map;
    if (this._canDraw()) {
      if (align) map.jumpTo({ bearing: mapBearing(this._callbacks.siteBearing()), pitch: 0 });
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.touchPitch.disable();
    } else {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.touchPitch.enable();
    }
    if (this._canDraw() && !this._spaceHeld) map.dragPan.disable();
    else map.dragPan.enable();
  }

  // Align picks a wall on the map, so only Draw and Adjust edit rooms.
  private _toolOnFloor(): "draw" | "adjust" | undefined {
    const tool = this._callbacks.tool();
    return this._callbacks.floorPicked() && tool !== "align" ? tool : undefined;
  }

  private _canDraw() {
    return this._toolOnFloor() === "draw";
  }

  private _listenToKeys(listen: boolean) {
    if (listen) {
      window.addEventListener("keydown", this._key);
      window.addEventListener("keyup", this._key);
      window.addEventListener("blur", this._releaseSpace);
    } else {
      window.removeEventListener("keydown", this._key);
      window.removeEventListener("keyup", this._key);
      window.removeEventListener("blur", this._releaseSpace);
    }
  }

  private _key = (event: KeyboardEvent) => {
    if (!this._canDraw()) return;
    if (event.composedPath()[0] instanceof HTMLInputElement) return;
    if (event.key === "Escape") this.cancel();
    if (event.key !== " ") return;
    // Keeps Space from pressing the focused toolbar button.
    event.preventDefault();
    const held = event.type === "keydown";
    if (held === this._spaceHeld) return;
    this._spaceHeld = held;
    if (held && this._grab) this.cancel();
    this.applyInput(false);
  };

  // A keyup that happens in another window never arrives.
  private _releaseSpace = () => {
    this._spaceHeld = false;
    this.applyInput(false);
  };

  private _down = (event: MapMouseEvent) => {
    if (!this._toolOnFloor() || this._spaceHeld || this._callbacks.saving() || event.originalEvent.button !== 0) {
      return;
    }
    const at = lngLatOf(event);
    const room = this._callbacks.activeRoom();
    this._grab = room && booleanPointInPolygon(at, room.footprint) ? { room, from: at } : undefined;
    if (!this._grab && !this._canDraw()) return;
    // Keeps MapLibre from panning the map under the room in Adjust.
    if (this._grab) event.preventDefault();
    this._press = event.point;
    this._dragging = false;
  };

  private _move = (event: MapMouseEvent) => {
    const grab = this._grab;
    if (!this._canDraw() && !grab) return;
    const press = this._press;
    if (press && !this._dragging && Math.hypot(event.point.x - press.x, event.point.y - press.y) >= DRAG_MIN_PX) {
      this._dragging = true;
      this._corner = undefined;
    }
    if (grab) {
      if (this._dragging) this._preview(movePolygon(grab.room.footprint, grab.from, lngLatOf(event)));
      return;
    }
    const from = this._dragging ? press : this._corner && this._map.project(this._corner);
    if (from) {
      const box = this._box(from, event.point);
      this._preview(box, box && this._apartFromActive(box));
    }
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
    if (this._toolOnFloor() === "adjust") {
      const [room] = this._map.queryRenderedFeatures(event.point, { layers: ["areas-2d"] });
      if (room) this._callbacks.onPickRoom(String(room.properties.area_id));
      return;
    }
    if (!this._canDraw() || this._spaceHeld || this._callbacks.saving()) return;
    const corner = this._corner;
    if (!corner) {
      this._corner = event.lngLat;
      return;
    }
    this._corner = undefined;
    this._finish(this._map.project(corner), event.point);
  };

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

  // A box the active footprint cannot join is refused on release, so it shows in the warning colour while drawn.
  private _apartFromActive(box: Polygon): boolean {
    const room = this._callbacks.activeRoom();
    return Boolean(room && !addToFootprint(room.footprint, box));
  }

  private _preview(box: Polygon | undefined, apart = false) {
    const map = this._map;
    this._kept = undefined;
    map.getSource<GeoJSONSource>("spatial-draft")?.setData(box ? feature(box, { apart }) : EMPTY);
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

  private _drop({ room, from }: Grab, to: Position) {
    this._preview(undefined);
    this._callbacks.onMove(room, movePolygon(room.footprint, from, to));
  }
}
