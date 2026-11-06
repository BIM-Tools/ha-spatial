// Turns mouse input and keys on the map into box drafts, room moves, resizes and room picks, so the room editor only edits and saves.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { feature } from "@turf/helpers";
import type { FeatureCollection, Point, Polygon, Position } from "geojson";
import { type GeoJSONSource, Marker, type MapMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import { BUILDING } from "./area-strip";
import { type Pixel, type ResizeTarget, resizeCursor, resizeRectangle, resizeTargetAt } from "./edge-drag";
import type { LayerColours } from "./map-paint";
import { mapBearing } from "./map-view";
import { areaLabel, boxChange, boxFromCorners, centreOf, isAxisRectangle, movePolygon, sideLabels } from "./plan";
import type { Tool } from "./room-editor";
import type { LatticePoint, PlanFrame } from "./site-frame";
import { type SnapCandidates, type SnapOptions, type SnapSource, snapCandidatesFor, snapMove, snapPoint } from "./snap";
import { SnapHighlight, snapMarks } from "./snap-highlight";
import type { HassUnits } from "./units";


export interface ActiveRoom {
  areaId: string;
  footprint: Polygon;
}

/** The editor's state as the interaction reads it at each event. */
export interface EditorSnapshot {
  readonly tool: Tool;
  readonly floorPicked: boolean;
  readonly saving: boolean;
  readonly activeRoom: ActiveRoom | undefined;
  readonly siteBearing: number;
  readonly siteFrame: PlanFrame | undefined;
  readonly units: HassUnits;
  // The current floor's areas, and every footprint with the outline under BUILDING: what a gesture snaps to.
  readonly floorAreaIds: readonly string[];
  readonly footprints: ReadonlyMap<string, Polygon>;
}

export interface BoxInteractionCallbacks {
  readonly snapshot: () => EditorSnapshot;
  readonly onBox: (box: Polygon, frame: PlanFrame) => void;
  readonly onMove: (room: ActiveRoom, moved: Polygon) => void;
  readonly onResize: (room: ActiveRoom, resized: Polygon) => void;
  // Each move of an edge or corner drag, from the first that leaves the press, with what is held and the
  // draft; undefined when it ends. The draft shows only its area, so the side controls count the lengths.
  readonly onResizing: (resizing: { target: ResizeTarget; draft: Polygon } | undefined) => void;
  readonly onPickRoom: (areaId: string) => void;
}

// A gesture keeps the frame, the snap candidates and the pointer's radius it started with.
interface Snapping {
  frame: PlanFrame;
  candidates: SnapCandidates;
  radiusPx: number;
}

interface Grab extends Snapping {
  room: ActiveRoom;
  from: Position;
}

interface Start extends Snapping {
  corner: LatticePoint;
}

interface Resize extends Snapping {
  room: ActiveRoom;
  target: ResizeTarget;
  // From the pointer to the grabbed edge or corner, so it does not jump to the pointer.
  offset: [number, number];
  press: Pixel;
  moved: boolean;
}

const lngLatOf = (event: MapMouseEvent): Position => [event.lngLat.lng, event.lngLat.lat];
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const DRAG_MIN_PX = 5;
/** Whether the main pointer is a finger, as on a phone or a tablet. */
export const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;
// A finger covers more of the map than a mouse pointer.
const snapRadiusPx = () => (coarsePointer() ? 12 : 8);
// A snapped wall lights this far either side of the snapped point on screen, so a whole wall never reads as a selection.
const SNAP_MARK_HALF_PX = 24;
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
  // Alt was held during a move or a resize, so its release must not reach the browser either.
  private _altInMove = false;
  private _resize?: Resize;
  // The resize cursor this set on the map's canvas, or "".
  private _cursor = "";

  constructor(
    private readonly _map: MapLibreMap,
    private readonly _callbacks: BoxInteractionCallbacks,
  ) {
    this._highlight = new SnapHighlight(_map);
    _map.on("mousedown", this._down);
    _map.on("mousemove", this._move);
    _map.on("mouseup", this._up);
    _map.on("click", this._click);
    _map.on("mouseout", this._out);
    this.toolChanged();
  }

  destroy() {
    this.cancel();
    this._listenToKeys(false);
    this._map.off("mousedown", this._down);
    this._map.off("mousemove", this._move);
    this._map.off("mouseup", this._up);
    this._map.off("click", this._click);
    this._map.off("mouseout", this._out);
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
    this._highlight.clear();
    this._setCursor("");
    const resize = this._resize;
    this._resize = undefined;
    if (resize?.moved) this._callbacks.onResizing(undefined);
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

  // Space pans and Escape cancels only in Draw on a floor; elsewhere the keys keep their usual meaning,
  // apart from Alt during a move. Also called on a floor change, since All does not draw.
  toolChanged() {
    this.cancel();
    this._spaceHeld = false;
    this._listenToKeys(this._toolOnFloor() !== undefined);
    this.applyInput();
  }

  // Boxes run along the site axes, so the map must be flat and turned to them.
  applyInput(align = true) {
    const map = this._map;
    if (this._canDraw()) {
      if (align) map.jumpTo({ bearing: mapBearing(this._callbacks.snapshot().siteBearing), pitch: 0 });
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
    const { tool, floorPicked } = this._callbacks.snapshot();
    return floorPicked && tool !== "align" ? tool : undefined;
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
    if (event.composedPath()[0] instanceof HTMLInputElement) return;
    // Firefox on Windows opens its menu bar when Alt is released alone; a move made with Alt keeps
    // it from doing so until Alt is released, also after the mouse.
    const dragging = this._grab || this._resize;
    if (event.key === "Alt") {
      if (dragging && event.type === "keydown") this._altInMove = true;
      if (this._canDraw() || dragging || this._altInMove) event.preventDefault();
      if (event.type === "keyup") this._altInMove = false;
    }
    if (event.key === "Escape" && this._resize) this.cancel();
    if (!this._canDraw()) return;
    if (event.key === "Escape") this.cancel();
    if (event.key !== " ") return;
    // Keeps Space from pressing the focused toolbar button.
    event.preventDefault();
    const held = event.type === "keydown";
    if (held === this._spaceHeld) return;
    this._spaceHeld = held;
    if (held && this._grab) this.cancel();
    if (held) this._highlight.clear();
    this.applyInput(false);
  };

  // A keyup that happens in another window never arrives.
  private _releaseSpace = () => {
    this._spaceHeld = false;
    this.applyInput(false);
  };

  private _down = (event: MapMouseEvent) => {
    const { saving, siteFrame: frame, activeRoom: room } = this._callbacks.snapshot();
    if (!this._toolOnFloor() || this._spaceHeld || saving || event.originalEvent.button !== 0) return;
    // Until the first site reply there is no lattice to draw on.
    if (!frame) return;
    const target = this._resizeTarget(event.point);
    if (target && this.startResize(target, event.point, event.originalEvent.altKey)) {
      // Keeps MapLibre from panning the map under the edge.
      event.preventDefault();
      return;
    }
    const at = lngLatOf(event);
    const grabbed = room && booleanPointInPolygon(at, room.footprint) ? room : undefined;
    if (!grabbed && !this._canDraw()) return;
    // A moved shape does not snap to itself.
    const snapping = this._snapping(frame, grabbed?.areaId);
    this._grab = grabbed && { ...snapping, room: grabbed, from: at };
    this._press = event.point;
    this._pressCorner = { ...snapping, corner: this._cornerAt(event, snapping) };
    this._dragging = false;
    if (this._grab) {
      if (event.originalEvent.altKey) this._altInMove = true;
      // Keeps MapLibre from panning the map under the room in Adjust.
      event.preventDefault();
      this._highlight.clear();
    }
  };

  private _move = (event: MapMouseEvent) => {
    if (this._resize) {
      this.resizeTo(event.point, event.originalEvent.altKey);
      return;
    }
    const grab = this._grab;
    if (!this._canDraw() && !grab) {
      const target = this._press ? undefined : this._resizeTarget(event.point);
      this._setCursor(target ? this._cursorOf(target) : "");
      return;
    }
    const press = this._press;
    if (press && !this._dragging && Math.hypot(event.point.x - press.x, event.point.y - press.y) >= DRAG_MIN_PX) {
      this._dragging = true;
      this._corner = undefined;
    }
    if (grab) {
      if (this._dragging) this._preview(movePolygon(grab.frame, grab.room.footprint, this._moved(grab, event)), grab.frame);
      return;
    }
    const start = this._dragging ? this._pressCorner : this._corner;
    if (start) this._draft(start, this._cornerAt(event, start));
    else if (!press && !this._spaceHeld) this._hover(event);
  };

  private _up = (event: MapMouseEvent) => {
    if (this._resize) {
      this.endResize(event.point, event.originalEvent.altKey);
      return;
    }
    const start = this._pressCorner;
    const dragged = this._dragging;
    const grab = this._grab;
    this._press = undefined;
    this._pressCorner = undefined;
    this._dragging = false;
    this._grab = undefined;
    if (start && dragged) {
      if (grab) this._drop(grab, event);
      else this._finish(start, this._cornerAt(event, start));
    }
    this._highlight.clear();
  };

  // Leaving the map ends a hover, not a box, a move or a resize in progress.
  private _out = () => {
    if (this._press || this._corner || this._resize) return;
    this._highlight.clear();
    this._setCursor("");
  };

  /** Whether an edge or a corner is held, from its press to its release. */
  get resizing() {
    return Boolean(this._resize);
  }

  /** Grabs an edge or a corner of the active axis rectangle at a pixel; false when there is none to grab. */
  startResize(target: ResizeTarget, pixel: Pixel, free: boolean): boolean {
    const room = this._resizable();
    const frame = this._callbacks.snapshot().siteFrame;
    if (!room || !frame) return false;
    const [anchorX, anchorY] = frame.toLattice(room.footprint.coordinates[0][target.index]);
    const [x, y] = this._latticeAt(pixel, frame);
    this._resize = {
      ...this._snapping(frame, room.areaId),
      room,
      target,
      offset: [anchorX - x, anchorY - y],
      press: pixel,
      moved: false,
    };
    this._setCursor(this._cursorOf(target));
    if (free) this._altInMove = true;
    return true;
  }

  // The corner, else the edge, of the active axis rectangle within the snap radius of a pixel; in Adjust only.
  private _resizeTarget(pixel: Pixel): ResizeTarget | undefined {
    const room = this._resizable();
    const project = (position: Position) => this._map.project(position as [number, number]);
    return room && resizeTargetAt(pixel, room.footprint, project, snapRadiusPx());
  }

  /** Follows the pointer once it is a few pixels from the press, with the draft and its area; nothing when none is held. */
  resizeTo(pixel: Pixel, free: boolean) {
    const resize = this._resize;
    if (!resize) return;
    if (!resize.moved && Math.hypot(pixel.x - resize.press.x, pixel.y - resize.press.y) < DRAG_MIN_PX) return;
    resize.moved = true;
    const { shape, sources, pointer, options } = this._resized(resize, pixel, free);
    this._preview(shape, resize.frame, false, false);
    const corners = shape.coordinates[0].slice(0, -1).map((corner) => resize.frame.toLattice(corner));
    this._showSnap(resize, sources, corners, pointer, options);
    this._callbacks.onResizing({ target: resize.target, draft: shape });
  }

  /**
   * Releases a held edge or corner, and says whether the press became a drag; a press that did not
   * move, or a drag back to the start, saves nothing.
   */
  endResize(pixel: Pixel, free: boolean): boolean {
    const resize = this._resize;
    if (!resize) return false;
    this._resize = undefined;
    if (!resize.moved) return false;
    const { shape, changed } = this._resized(resize, pixel, free);
    this._preview(undefined);
    this._highlight.clear();
    if (changed) this._callbacks.onResize(resize.room, shape);
    this._callbacks.onResizing(undefined);
    return true;
  }

  // The active shape, when it is an axis rectangle in Adjust on a floor and nothing else is going on.
  private _resizable(): ActiveRoom | undefined {
    const { saving, siteFrame: frame, activeRoom: room } = this._callbacks.snapshot();
    if (this._toolOnFloor() !== "adjust" || saving) return undefined;
    return frame && room && isAxisRectangle(frame, room.footprint) ? room : undefined;
  }

  private _resized(resize: Resize, pixel: Pixel, free: boolean) {
    const [x, y] = this._latticeAt(pixel, resize.frame);
    const pointer: [number, number] = [x + resize.offset[0], y + resize.offset[1]];
    const options = this._options(pixel, free, resize);
    return { ...resizeRectangle(resize.frame, resize.room.footprint, resize.target, pointer, resize.candidates, options), pointer, options };
  }

  private _latticeAt(pixel: Pixel, frame: PlanFrame): [number, number] {
    return frame.toLatticeUnits(this._map.unproject([pixel.x, pixel.y]).toArray());
  }

  private _cursorOf(target: ResizeTarget): string {
    const corners = this._callbacks.snapshot().activeRoom!.footprint.coordinates[0].map((corner) => this._map.project(corner as [number, number]));
    return resizeCursor(target, corners);
  }

  private _setCursor(cursor: string) {
    if (cursor === this._cursor) return;
    this._cursor = cursor;
    this._map.getCanvas().style.cursor = cursor;
  }

  // Before the first corner the highlight shows where a press would land.
  private _hover(event: MapMouseEvent) {
    const frame = this._callbacks.snapshot().siteFrame;
    if (frame) this._cornerAt(event, this._snapping(frame));
  }

  private _snapping(frame: PlanFrame, exclude?: string): Snapping {
    const { floorAreaIds, footprints } = this._callbacks.snapshot();
    return { frame, candidates: snapCandidatesFor(frame, floorAreaIds, footprints, BUILDING, exclude), radiusPx: snapRadiusPx() };
  }

  // The pixel radius in lattice units at the pointer, which differ with zoom; Alt places freely.
  // Measured across and down the screen, the larger of the two, so a pitched view in Adjust still
  // snaps everything within the radius on screen, and a little more across.
  private _options({ x, y }: Pixel, free: boolean, { frame, radiusPx }: Snapping): SnapOptions {
    const at = (px: number, py: number) => this._latticeAt({ x: px, y: py }, frame);
    const [fromX, fromY] = at(x, y);
    const units = ([toX, toY]: [number, number]) => Math.hypot(toX - fromX, toY - fromY);
    const radius = Math.max(units(at(x + radiusPx, y)), units(at(x, y + radiusPx)));
    return { radius, gridUnits: frame.unitsPerStep, free };
  }

  private _cornerAt(event: MapMouseEvent, snapping: Snapping): LatticePoint {
    const pointer = snapping.frame.toLatticeUnits(lngLatOf(event));
    const options = this._options(event.point, event.originalEvent.altKey, snapping);
    const { point, sources } = snapPoint(pointer, snapping.candidates, options);
    this._showSnap(snapping, sources, [point], pointer, options);
    return point;
  }

  // Lights what a gesture snapped to near `points`, never the active shape's own walls; the stretch's
  // half length in lattice units scales from the snap radius `_options` converted at the pointer.
  private _showSnap(
    { frame, radiusPx }: Snapping,
    sources: readonly SnapSource[],
    points: readonly LatticePoint[],
    pointer: readonly [number, number],
    { radius }: SnapOptions,
  ) {
    const own = this._callbacks.snapshot().activeRoom?.footprint.coordinates.map((ring) => ring.slice(0, -1).map((corner) => frame.toLattice(corner)));
    this._highlight.show(frame, snapMarks(sources, points, pointer, (radius * SNAP_MARK_HALF_PX) / radiusPx, own));
  }

  // MapLibre fires `click` for a tap too, so two taps draw a box on a phone.
  private _click = (event: MapMouseEvent) => {
    if (this._toolOnFloor() === "adjust") {
      const [room] = this._map.queryRenderedFeatures(event.point, { layers: ["areas-2d"] });
      if (room) this._callbacks.onPickRoom(String(room.properties.area_id));
      return;
    }
    if (!this._canDraw() || this._spaceHeld || this._callbacks.snapshot().saving) return;
    const start = this._corner;
    if (!start) {
      const frame = this._callbacks.snapshot().siteFrame;
      if (!frame) return;
      const snapping = this._snapping(frame);
      this._corner = { ...snapping, corner: this._cornerAt(event, snapping) };
      this._draft(this._corner, this._corner.corner);
      return;
    }
    this._corner = undefined;
    this._finish(start, this._cornerAt(event, start));
    this._highlight.clear();
  };

  // A box under one grid step shows only its start, as a dot.
  private _draft({ corner, frame }: Start, end: LatticePoint) {
    const box = boxFromCorners(frame, corner, end);
    if (box) this._preview(box, frame, this._apartFromActive(box, frame));
    else this._preview({ type: "Point", coordinates: frame.fromLattice(corner) }, frame);
  }

  // The lattice delta of a move, snapped by the moved shape's corners and stopped at the outline.
  private _moved(grab: Grab, event: MapMouseEvent): LatticePoint {
    const { frame, room, from } = grab;
    const [fromX, fromY] = frame.toLatticeUnits(from);
    const [toX, toY] = frame.toLatticeUnits(lngLatOf(event));
    const rings = room.footprint.coordinates.map((ring) => ring.slice(0, -1).map((corner) => frame.toLattice(corner)));
    const options = this._options(event.point, event.originalEvent.altKey, grab);
    const { delta, sources } = snapMove(rings, [toX - fromX, toY - fromY], grab.candidates, options);
    const corners = rings.flat().map(([x, y]): LatticePoint => [x + delta[0], y + delta[1]]);
    this._showSnap(grab, sources, corners, [toX, toY], options);
    return delta;
  }

  // A box the active footprint cannot join is refused on release, so it shows in the warning colour while drawn.
  private _apartFromActive(box: Polygon, frame: PlanFrame): boolean {
    const room = this._callbacks.snapshot().activeRoom;
    return room !== undefined && "refusal" in boxChange(frame, room.areaId, room.footprint, box);
  }

  // A resize leaves the side lengths to the side controls.
  private _preview(draft: Polygon | Point | undefined, frame?: PlanFrame, apart = false, sides = true) {
    const map = this._map;
    this._kept = undefined;
    map.getSource<GeoJSONSource>("spatial-draft")?.setData(draft ? feature(draft, { apart }) : EMPTY);
    if (draft?.type !== "Polygon" || !frame) {
      for (const label of this._labels) label.remove();
      this._labels = [];
      return;
    }
    const units = this._callbacks.snapshot().units;
    const labels = [...(sides ? sideLabels(frame, draft, units) : []), { at: centreOf(frame, draft), text: areaLabel(frame, draft, units) }];
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

  // A drag that lands where it started saves nothing, so it adds no undo step.
  private _drop(grab: Grab, event: MapMouseEvent) {
    this._preview(undefined);
    const [x, y] = this._moved(grab, event);
    if (x || y) this._callbacks.onMove(grab.room, movePolygon(grab.frame, grab.room.footprint, [x, y]));
  }
}
