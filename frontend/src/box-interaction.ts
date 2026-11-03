// Turns mouse input and keys on the map into box drafts, room moves and room picks, so the room editor only edits and saves.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { feature } from "@turf/helpers";
import type { FeatureCollection, Point, Polygon, Position } from "geojson";
import { type GeoJSONSource, Marker, type MapMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import type { LayerColours } from "./map-paint";
import { mapBearing } from "./map-view";
import { addToFootprint, areaLabel, boxFromCorners, centreOf, gridPoint, movePolygon, sideLabels } from "./plan";
import type { Tool } from "./room-editor";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { SnapHighlight } from "./snap-highlight";
import type { HassUnits } from "./units";

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
  readonly siteFrame: () => PlanFrame | undefined;
  readonly units: () => HassUnits;
  readonly onBox: (box: Polygon, frame: PlanFrame) => void;
  readonly onMove: (room: ActiveRoom, moved: Polygon) => void;
  readonly onPickRoom: (areaId: string) => void;
}

// A gesture keeps the frame it started with.
interface Grab {
  room: ActiveRoom;
  from: Position;
  frame: PlanFrame;
}

interface Start {
  corner: LatticePoint;
  frame: PlanFrame;
}

const lngLatOf = (event: MapMouseEvent): Position => [event.lngLat.lng, event.lngLat.lat];
// Alt places a corner on the lattice instead of the grid.
const cornerAt = (event: MapMouseEvent, frame: PlanFrame): LatticePoint =>
  event.originalEvent.altKey ? frame.toLattice(lngLatOf(event)) : gridPoint(frame, lngLatOf(event));
// The pointer's travel in whole grid steps, so a moved room keeps its offset to the grid.
const stepsBetween = (frame: PlanFrame, from: Position, to: Position): LatticePoint => {
  const [fromX, fromY] = frame.toLatticeUnits(from);
  const [toX, toY] = frame.toLatticeUnits(to);
  const step = frame.unitsPerStep;
  return [Math.round((toX - fromX) / step) * step, Math.round((toY - fromY) / step) * step];
};
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const DRAG_MIN_PX = 5;
const LABEL_STYLE =
  "font: 12px sans-serif; background: color-mix(in srgb, var(--card-background-color) 85%, transparent); color: var(--primary-text-color); padding: 0 3px; border-radius: 3px; pointer-events: none";

export class BoxInteraction {
  // A lattice point, so a pan or zoom between the two taps does not move it.
  private _corner?: Start;
  private _press?: Pixel;
  private _pressCorner?: Start;
  private _dragging = false;
  // Set when a press starts inside the active room's footprint: a drag then moves it.
  private _grab?: Grab;
  private _spaceHeld = false;
  private _labels: Marker[] = [];
  // The shape of a failed save, shown until it saves or the next draft replaces it.
  private _kept?: Polygon;
  private readonly _highlight: SnapHighlight;

  constructor(
    private readonly _map: MapLibreMap,
    private readonly _callbacks: BoxInteractionCallbacks,
  ) {
    this._highlight = new SnapHighlight(_map);
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
    // A new style, after a theme or map toggle, keeps the shape of a failed save.
    const kept = this._kept;
    this._map.addSource("spatial-draft", { type: "geojson", data: kept ? feature(kept, { apart: false }) : EMPTY });
    this._map.addLayer({ id: "spatial-draft-fill", type: "fill", source: "spatial-draft", paint: colours["spatial-draft-fill"] });
    this._map.addLayer({
      id: "spatial-draft",
      type: "line",
      source: "spatial-draft",
      paint: { ...colours["spatial-draft"], "line-width": 2, "line-dasharray": [2, 1] },
    });
    // The start of a box that is still under one grid step: 14 px across with a 2 px ring.
    this._map.addLayer({
      id: "spatial-draft-point",
      type: "circle",
      source: "spatial-draft",
      filter: ["==", ["geometry-type"], "Point"],
      paint: { ...colours["spatial-draft-point"], "circle-radius": 7, "circle-stroke-width": 2 },
    });
    this._highlight.addLayers(colours);
  }

  cancel() {
    this._corner = undefined;
    this._press = undefined;
    this._pressCorner = undefined;
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

  dropShape() {
    if (this._kept) this._preview(undefined);
  }

  // Space pans and Escape cancels only in Draw on a floor; elsewhere the keys keep their usual meaning.
  // Also called on a floor change, since All does not draw.
  toolChanged() {
    this.cancel();
    this._spaceHeld = false;
    this._listenToKeys(this._canDraw());
    this.applyInput();
  }

  // Boxes run along the site axes, so the map must be flat and turned to them.
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
    const frame = this._callbacks.siteFrame();
    // Until the first site reply there is no lattice to draw on.
    if (!frame) return;
    const at = lngLatOf(event);
    const room = this._callbacks.activeRoom();
    this._grab = room && booleanPointInPolygon(at, room.footprint) ? { room, from: at, frame } : undefined;
    if (!this._grab && !this._canDraw()) return;
    // Keeps MapLibre from panning the map under the room in Adjust.
    if (this._grab) event.preventDefault();
    this._press = event.point;
    this._pressCorner = { corner: cornerAt(event, frame), frame };
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
      if (this._dragging) this._preview(this._moved(grab, lngLatOf(event)), grab.frame);
      return;
    }
    const start = this._dragging ? this._pressCorner : this._corner;
    if (start) this._draft(start, cornerAt(event, start.frame));
  };

  private _up = (event: MapMouseEvent) => {
    const start = this._pressCorner;
    const dragged = this._dragging;
    const grab = this._grab;
    this._press = undefined;
    this._pressCorner = undefined;
    this._dragging = false;
    this._grab = undefined;
    if (!start || !dragged) return;
    if (grab) this._drop(grab, lngLatOf(event));
    else this._finish(start, cornerAt(event, start.frame));
  };

  // MapLibre fires `click` for a tap too, so two taps draw a box on a phone.
  private _click = (event: MapMouseEvent) => {
    if (this._toolOnFloor() === "adjust") {
      const [room] = this._map.queryRenderedFeatures(event.point, { layers: ["areas-2d"] });
      if (room) this._callbacks.onPickRoom(String(room.properties.area_id));
      return;
    }
    if (!this._canDraw() || this._spaceHeld || this._callbacks.saving()) return;
    const start = this._corner;
    if (!start) {
      const frame = this._callbacks.siteFrame();
      if (!frame) return;
      this._corner = { corner: cornerAt(event, frame), frame };
      this._draft(this._corner, this._corner.corner);
      return;
    }
    this._corner = undefined;
    this._finish(start, cornerAt(event, start.frame));
  };

  // A box under one grid step shows only its start, as a dot.
  private _draft({ corner, frame }: Start, end: LatticePoint) {
    const box = boxFromCorners(frame, corner, end);
    if (box) this._preview(box, frame, this._apartFromActive(box, frame));
    else this._preview({ type: "Point", coordinates: frame.fromLattice(corner) }, frame);
  }

  private _moved({ room, from, frame }: Grab, to: Position): Polygon {
    return movePolygon(frame, room.footprint, stepsBetween(frame, from, to));
  }

  // A box the active footprint cannot join is refused on release, so it shows in the warning colour while drawn.
  private _apartFromActive(box: Polygon, frame: PlanFrame): boolean {
    const room = this._callbacks.activeRoom();
    return Boolean(room && !addToFootprint(frame, room.footprint, box));
  }

  private _preview(draft: Polygon | Point | undefined, frame?: PlanFrame, apart = false) {
    const map = this._map;
    this._kept = undefined;
    map.getSource<GeoJSONSource>("spatial-draft")?.setData(draft ? feature(draft, { apart }) : EMPTY);
    if (draft?.type !== "Polygon" || !frame) {
      for (const label of this._labels) label.remove();
      this._labels = [];
      return;
    }
    const units = this._callbacks.units();
    const labels = [...sideLabels(frame, draft, units), { at: centreOf(frame, draft), text: areaLabel(frame, draft, units) }];
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

  // A box under one grid step is not created, without a toast: while drawn it showed only its start.
  private _finish({ corner, frame }: Start, end: LatticePoint) {
    const box = boxFromCorners(frame, corner, end);
    this._preview(undefined);
    if (box) this._callbacks.onBox(box, frame);
  }

  // A drag that rounds to no grid step saves nothing, so it adds no undo step.
  private _drop(grab: Grab, to: Position) {
    this._preview(undefined);
    const [x, y] = stepsBetween(grab.frame, grab.from, to);
    if (x || y) this._callbacks.onMove(grab.room, movePolygon(grab.frame, grab.room.footprint, [x, y]));
  }
}
