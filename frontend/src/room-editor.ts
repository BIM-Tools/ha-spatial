// Keeps the panel's room edits in step with Home Assistant: the area strip, side lengths, and each edit saved at once with undo and redo.

import { mdiDragHorizontalVariant } from "@mdi/js";
import { point } from "@turf/helpers";
import type { FeatureCollection, Polygon, Position } from "geojson";
import { html } from "lit";
import { type GeoJSONSource, Marker, type Map as MapLibreMap } from "maplibre-gl";
import { type AreaEntry, BUILDING, firstToDraw, newAreaName, stripOrder } from "./area-strip";
import { type ActiveRoom, BoxInteraction, type EditorSnapshot, coarsePointer } from "./box-interaction";
import { type Pixel, sideChipOffset } from "./edge-drag";
import { type Change, type FootprintBatch, History } from "./history";
import type { LayerColours } from "./map-paint";
import { byLevel } from "./map-view";
import { type ChangeOrRefusal, boxChange, edgeLengths, isAxisRectangle, resizeChange, sideLabels } from "./plan";
import type { PlanFrame } from "./site-frame";
import { type HassUnits, parseLength, refusalMessage, typedLength } from "./units";

interface Connection {
  sendMessagePromise<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
}

export interface FloorEntry {
  floor_id: string;
  name: string;
  level: number | null;
}

// Exactly one is active; Adjust is the default.
export type Tool = "align" | "draw" | "adjust";

/** The parameters of Home Assistant's toast, the `hass-notification` event. */
export interface Toast {
  message: string;
  action?: { text: string; action: () => void };
  // In milliseconds; -1 keeps the toast until it is dismissed, 0 closes the toast with this id.
  duration?: number;
  dismissable?: boolean;
  id?: string;
}

/** One line on the map that says what to do next. */
export interface Guide {
  text: string;
  step?: string;
}

/** What the editor needs from the panel that holds it. */
export interface EditorHost {
  requestUpdate(): void;
  reloadRooms(): Promise<void>;
  siteBearing(): number;
  siteFrame(): PlanFrame | undefined;
  units(): HassUnits;
  selectTool(tool: Tool): void;
  toast(toast: Toast): void;
  buildingName(): string;
  canRenameBuilding(): boolean;
  // The rooms whose labels hide while a resize draft over them shows its lengths and area.
  hideLabels(areaIds: string[]): void;
}

// A later save that succeeds closes the failure toast through this id.
const SAVE_FAILED_ID = "spatial-save-failed";

const SIDE_STYLE =
  "font: 12px sans-serif; background: var(--card-background-color); color: var(--primary-text-color); border: 1px solid var(--primary-color); border-radius: 3px";
// A side button or field sits on the map, inside a Marker that would block focus; its presses and keys stay its own.
const MAP_EVENTS = ["mousedown", "touchstart", "click", "dblclick", "keydown"];
// A grab handle is a 44 px target around a 44 x 20 px pill; its touches must not pan the map either.
const GRIP_TARGET_STYLE =
  "display: flex; align-items: center; box-sizing: border-box; width: 44px; height: 44px; margin: 0; padding: 0; border: none; background: none; touch-action: none";
const GRIP_STYLE =
  "display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 44px; height: 20px; border-radius: 10px; background: var(--card-background-color); border: 2px solid var(--primary-color); color: var(--primary-color); --mdc-icon-size: 16px";
const GRIP_EVENTS = [...MAP_EVENTS, "pointerdown", "touchmove", "touchend"];
// Half the grab handle's 20 px thickness and a 4 px gap.
const GRIP_CLEARANCE_PX = 14;

// Where a DOM event on a Marker falls on the map.
const pixelOn = (map: MapLibreMap, event: MouseEvent): Pixel => {
  const box = map.getContainer().getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
};

export class RoomEditor {
  floors: FloorEntry[] = [];
  tool: Tool = "adjust";
  private readonly _history = new History();
  private _areas: AreaEntry[] = [];
  private _footprints = new Map<string, Polygon>();
  private _floor: string | null | "all" = "all";
  private _active = BUILDING;
  // The area whose pill is a name field, or "".
  private _renaming = "";
  private _map?: MapLibreMap;
  private _interaction?: BoxInteraction;
  private _saving = false;
  private _saveFailedShown = false;
  private _sides: Marker[] = [];
  // On a touch screen only: a grab handle per side, in the order of `_sides`.
  private _grips: Marker[] = [];
  private _resizeLive = false;

  private _editingSide?: number;
  // Counts acknowledged saves and started refreshes, so an older refresh cannot undo a newer save.
  private _changes = 0;

  constructor(
    private readonly _connection: Connection,
    private readonly _host: EditorHost,
  ) {}

  get canUndo() {
    return !this._saving && this._history.canUndo;
  }

  get canRedo() {
    return !this._saving && this._history.canRedo;
  }

  /** Any room footprint on any floor, or the outline. */
  get hasShapes() {
    return this._footprints.size > 0;
  }

  /** While aligning, what to click; with an area without a shape active, that it is next and how far the floor is. */
  get guide(): Guide | undefined {
    if (this.tool === "align") return { text: "Click the wall your rooms follow" };
    const order = this._order();
    const active = order.find((area) => area.area_id === this._active);
    if (!active || this._footprints.has(active.area_id)) return undefined;
    const shaped = order.filter((area) => this._footprints.has(area.area_id)).length;
    return { text: `Draw ${active.name}`, step: `${shaped + 1} of ${order.length}` };
  }

  attach(map: MapLibreMap) {
    this._map = map;
    this._interaction = new BoxInteraction(map, {
      snapshot: () => this._snapshot(),
      onBox: (box, frame) => this._finishBox(box, frame),
      onMove: (room, moved) => this._saveShape(room, moved),
      onResize: (room, resized) => this._saveShape(room, resized),
      onResizing: (resizing) => this._resizing(resizing),
      onPickRoom: (areaId) => this._select(areaId),
    });
    window.addEventListener("keydown", this._keys);
    map.on("move", this._placeGrips);
    this._showSides();
  }

  /** The active room or Building, strongly filled and edged, with round handles on its corners. */
  addLayers(map: MapLibreMap, colours: LayerColours) {
    const filter = this._activeFilter();
    const building = { visibility: this._buildingVisibility() };
    // Under the rooms, so they stay readable on an active Building.
    map.addLayer(
      {
        id: "spatial-active-building-fill",
        type: "fill",
        source: "outline",
        layout: building,
        paint: colours["spatial-active-building-fill"],
      },
      "areas-2d",
    );
    map.addLayer({ id: "spatial-active-fill", type: "fill", source: "areas", filter, paint: colours["spatial-active-fill"] });
    map.addLayer({
      id: "spatial-active",
      type: "line",
      source: "areas",
      filter,
      paint: { ...colours["spatial-active"], "line-width": 2 },
    });
    map.addLayer({
      id: "spatial-active-building",
      type: "line",
      source: "outline",
      layout: building,
      paint: { ...colours["spatial-active-building"], "line-width": 2.5 },
    });
    map.addSource("spatial-handles", { type: "geojson", data: this._handles() });
    map.addLayer({
      id: "spatial-handles",
      type: "circle",
      source: "spatial-handles",
      // 12 px across: a 4 px radius inside a 2 px ring.
      paint: { ...colours["spatial-handles"], "circle-radius": 4, "circle-stroke-width": 2 },
    });
    this._interaction?.addLayers(colours);
  }

  detach() {
    // Adjust leaves the map's own panning and rotating on.
    this.setTool("adjust");
    window.removeEventListener("keydown", this._keys);
    this._map?.off("move", this._placeGrips);
    this._interaction?.destroy();
    this._interaction = undefined;
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
    this._showHandles();
    const order = this._order();
    if (![BUILDING, ...order.map((area) => area.area_id)].includes(this._active)) {
      this._setActive(order[0]?.area_id ?? BUILDING);
    }
    this._showSides();
    this._host.requestUpdate();
  }

  setFloor(floor: string | null | "all") {
    this._floor = floor;
    this._interaction?.toolChanged();
    this._select(firstToDraw(this._order(), this._linked()));
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this._interaction?.toolChanged();
    this._select(this._active);
  }

  // An empty history saves nothing, so it must not count as a save that supersedes a failed one.
  undo = () =>
    this._history.canUndo &&
    this._whileSaving(async () => {
      const change = this._history.undo();
      if (!change) return;
      await this._send(change.before).catch((err) => {
        this._history.redo();
        throw err;
      });
    });

  redo = () =>
    this._history.canRedo &&
    this._whileSaving(async () => {
      const change = this._history.redo();
      if (!change) return;
      await this._send(change.after).catch((err) => {
        this._history.undo();
        throw err;
      });
    });

  /** The area strip; on All only the Building pill and a hint. */
  render(hovered?: string) {
    return html`<spatial-area-strip
      ?allFloors=${this._floor === "all"}
      .order=${this._order()}
      .linked=${this._linked()}
      .active=${this._active}
      .renaming=${this._renaming}
      .hovered=${hovered}
      .buildingName=${this._host.buildingName()}
      ?buildingRenamable=${this._host.canRenameBuilding()}
      @area-select=${(event: CustomEvent<{ areaId: string }>) => this._choose(event.detail.areaId)}
      @area-rename-start=${(event: CustomEvent<{ areaId: string }>) => this._startRename(event.detail.areaId)}
      @area-rename=${(event: CustomEvent<{ areaId: string; name: string }>) => this._rename(event.detail)}
      @area-rename-cancel=${() => this._endRename()}
      @area-create=${() => this._newArea()}
    ></spatial-area-strip>`;
  }

  private _linked() {
    return new Set(this._footprints.keys());
  }

  private _snapshot(): EditorSnapshot {
    const footprint = this._footprints.get(this._active);
    return {
      tool: this.tool,
      floorPicked: this._floor !== "all",
      saving: this._saving,
      activeRoom: footprint && { areaId: this._active, footprint },
      siteBearing: this._host.siteBearing(),
      siteFrame: this._host.siteFrame(),
      units: this._host.units(),
      floorAreaIds: this._order().map((area) => area.area_id),
      footprints: this._footprints,
    };
  }

  private _order() {
    return this._floor === "all" ? [] : stripOrder(this._areas, this._floor);
  }

  // An area without a footprint has no feature, so nothing is highlighted; neither is anything on All, a view only.
  private _activeFilter(): ["==", ["get", string], string] {
    return ["==", ["get", "area_id"], this._floor === "all" ? "" : this._active];
  }

  private _buildingVisibility(): "visible" | "none" {
    return this._floor !== "all" && this._active === BUILDING ? "visible" : "none";
  }

  private _setActive(areaId: string) {
    this._active = areaId;
    if (areaId !== this._renaming) this._renaming = "";
    this._showHandles();
    if (!this._map?.getLayer("spatial-active")) return;
    for (const layerId of ["spatial-active", "spatial-active-fill"]) this._map.setFilter(layerId, this._activeFilter());
    for (const layerId of ["spatial-active-building", "spatial-active-building-fill"]) {
      this._map.setLayoutProperty(layerId, "visibility", this._buildingVisibility());
    }
  }

  // The corners of the active footprint's outer ring, on a floor only.
  private _handles(): FeatureCollection {
    const footprint = this._floor === "all" ? undefined : this._footprints.get(this._active);
    const corners = footprint?.coordinates[0].slice(0, -1) ?? [];
    return { type: "FeatureCollection", features: corners.map((corner) => point(corner)) };
  }

  private _showHandles() {
    this._map?.getSource<GeoJSONSource>("spatial-handles")?.setData(this._handles());
  }

  private _select(areaId: string) {
    this._setActive(areaId);
    this._editingSide = undefined;
    this._showSides();
    this._host.requestUpdate();
  }

  // A space without a shape can only be drawn, so choosing one picks Draw.
  private _choose(areaId: string) {
    this._interaction?.cancel();
    if (this.tool !== "draw" && !this._footprints.has(areaId)) this._host.selectTool("draw");
    this._select(areaId);
  }

  private _startRename(areaId: string) {
    if (areaId !== this._active) this._choose(areaId);
    this._renaming = areaId;
    this._host.requestUpdate();
  }

  private _endRename() {
    this._renaming = "";
    this._host.requestUpdate();
  }

  private _keys = (event: KeyboardEvent) => {
    // All floors is a view only, as its disabled Undo and Redo buttons show.
    if (this._floor === "all") return;
    if (event.composedPath()[0] instanceof HTMLInputElement) return;
    // A held edge or corner saves against the room as grabbed, which these would change under it.
    if (this._interaction?.resizing) return;
    if (event.key === "Delete") {
      this._removeActiveShape();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) this.redo();
    else this.undo();
  };

  private _removeActiveShape() {
    const areaId = this._active;
    const footprint = this._footprints.get(areaId);
    if (!footprint || this.tool === "align") return;
    this._whileSaving(() => this._apply({ before: { [areaId]: footprint }, after: { [areaId]: null } }));
  }

  // In Adjust each side of the active room, when it is a rectangle on the site axis, is a button that opens a length field.
  private _showSides() {
    // The draft shows the lengths until the resize ends; `_resizing` rebuilds them then. A held
    // grab handle would lose its pointer capture, so nothing is rebuilt from its press on.
    if (this._resizeLive || this._interaction?.resizing) return;
    for (const marker of [...this._sides, ...this._grips]) marker.remove();
    this._sides = [];
    this._grips = [];
    const map = this._map;
    const areaId = this._active;
    const footprint = this._footprints.get(areaId);
    if (!map || this.tool !== "adjust" || this._floor === "all" || !footprint) return;
    const frame = this._host.siteFrame();
    if (!frame || !isAxisRectangle(frame, footprint)) return;
    const units = this._host.units();
    const lengths = edgeLengths(frame, footprint);
    let field: HTMLInputElement | undefined;
    this._sides.push(...sideLabels(frame, footprint, units).map(({ at, edgeIndex, text }) => {
      let control: HTMLElement;
      if (edgeIndex === this._editingSide) {
        const prefilled = typedLength(lengths[edgeIndex], units);
        field = Object.assign(document.createElement("input"), { type: "text", value: prefilled });
        const typed = field;
        typed.addEventListener("keydown", (event) => {
          // An unchanged field leaves the edit: saving its rounded length would shift the side and add an undo step.
          if (event.key === "Escape" || (event.key === "Enter" && typed.value === prefilled)) this._select(areaId);
          // The frame the field was built in, so a refresh still in flight cannot pair it with another one.
          else if (event.key === "Enter") this._resize(resizeChange(frame, areaId, footprint, edgeIndex, parseLength(typed.value, units)));
        });
        control = typed;
      } else {
        control = Object.assign(document.createElement("button"), { textContent: text });
        control.addEventListener("click", () => {
          // The click that ends a drag from this button comes while that drag saves.
          if (this._saving) return;
          this._editingSide = edgeIndex;
          this._showSides();
        });
        // A button sits on its edge and covers part of it, so a press on it drags that edge; a click without a drag still opens the field.
        control.addEventListener("mousedown", (event) => {
          if (event.button === 0) this._interaction?.startResize({ kind: "edge", index: edgeIndex }, pixelOn(map, event), event.altKey);
        });
      }
      control.style.cssText = SIDE_STYLE;
      if (control === field) control.style.width = "6em";
      for (const type of MAP_EVENTS) control.addEventListener(type, (event) => event.stopPropagation());
      const element = document.createElement("span");
      element.append(control);
      return new Marker({ element }).setLngLat(at as [number, number]).addTo(map);
    }));
    if (coarsePointer()) {
      this._grips = sideLabels(frame, footprint, units).map(({ at, edgeIndex, text }) => this._grip(map, at, edgeIndex, text));
      this._placeGrips();
    }
    field?.focus();
    field?.select();
  }

  // A finger cannot find the thin edge on the map, which takes no touch events, so on a touch screen
  // each side gets a handle that drags it; a tap opens the length field, like the side button.
  private _grip(map: MapLibreMap, at: Position, edgeIndex: number, length: string): Marker {
    const element = Object.assign(document.createElement("button"), { type: "button", className: "side-grip" });
    element.setAttribute("aria-label", `Drag to stretch the ${length} side`);
    element.style.cssText = GRIP_TARGET_STYLE;
    const pill = document.createElement("span");
    pill.style.cssText = GRIP_STYLE;
    pill.append(Object.assign(document.createElement("ha-svg-icon"), { path: mdiDragHorizontalVariant }));
    element.append(pill);
    element.addEventListener("pointerdown", (event) => {
      if (this._interaction?.startResize({ kind: "edge", index: edgeIndex }, pixelOn(map, event), false)) {
        element.setPointerCapture?.(event.pointerId);
      }
    });
    element.addEventListener("pointermove", (event) => this._interaction?.resizeTo(pixelOn(map, event), false));
    element.addEventListener("pointerup", (event) => this._interaction?.endResize(pixelOn(map, event), false));
    element.addEventListener("pointercancel", () => {
      if (this._interaction?.resizing) this._interaction.cancel();
    });
    element.addEventListener("click", () => {
      // The click that ends a drag from this handle comes while that drag saves.
      if (this._saving) return;
      this._editingSide = edgeIndex;
      this._showSides();
    });
    for (const type of GRIP_EVENTS) element.addEventListener(type, (event) => event.stopPropagation());
    return new Marker({ element }).setLngLat(at as [number, number]).addTo(map);
  }

  // Turns each grab handle along its edge on screen and moves each side chip off it, clear of the
  // neighbouring rooms; again whenever the map moves.
  private _placeGrips = () => {
    const map = this._map;
    const footprint = this._footprints.get(this._active);
    if (!map || !footprint || !this._grips.length) return;
    const toScreen = (ring: Position[]) => ring.map((corner) => map.project(corner as [number, number]));
    const corners = toScreen(footprint.coordinates[0].slice(0, 4));
    const centre = { x: corners.reduce((sum, { x }) => sum + x, 0) / 4, y: corners.reduce((sum, { y }) => sum + y, 0) / 4 };
    const neighbours: Polygon[] = this._order().flatMap(({ area_id }) => {
      const room = area_id === this._active ? undefined : this._footprints.get(area_id);
      return room ? [{ type: "Polygon", coordinates: room.coordinates.map((ring) => toScreen(ring).map(({ x, y }) => [x, y])) }] : [];
    });
    corners.forEach((from, index) => {
      const to = corners[(index + 1) % 4];
      this._grips[index].setRotation((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
      const chip = this._sides[index];
      const { width, height } = chip.getElement().getBoundingClientRect();
      chip.setOffset(sideChipOffset([from, to], centre, { width, height }, GRIP_CLEARANCE_PX, neighbours));
    });
  };

  private _resize(resized: ChangeOrRefusal) {
    if ("refusal" in resized) {
      this._host.toast({ message: refusalMessage(resized.refusal, this._host.units()) });
      return;
    }
    this._editingSide = undefined;
    this._whileSaving(() => this._apply(resized.change));
  }

  private async _finishBox(box: Polygon, frame: PlanFrame) {
    const areaId = this._active;
    const floor = this._floor;
    const current = this._footprints.get(areaId);
    const drawn = boxChange(frame, areaId, current, box);
    if ("refusal" in drawn) {
      this._host.toast({ message: refusalMessage(drawn.refusal, this._host.units()) });
      return;
    }
    await this._whileSaving(async () => {
      await this._apply(drawn.change);
      // Only a first shape moves on: the next box for a drawn area usually extends it.
      if (!current && this._floor === floor) this._setActive(firstToDraw(this._order(), this._linked()));
    }, current ? undefined : box);
  }

  private _saveShape({ areaId, footprint }: ActiveRoom, changed: Polygon) {
    this._whileSaving(() => this._apply({ before: { [areaId]: footprint }, after: { [areaId]: changed } }));
  }

  // While an edge or corner is dragged the draft shows its lengths and area, so the side buttons and
  // the labels under it hide; a save shows the buttons again when it settles.
  private _resizing(resizing: boolean) {
    this._resizeLive = resizing;
    // The building's draft covers every room on the floor.
    const covered = this._active === BUILDING ? this._order().map((area) => area.area_id) : [this._active];
    this._host.hideLabels(resizing ? covered : []);
    if (!resizing) {
      if (!this._saving) this._showSides();
      return;
    }
    for (const side of this._sides) side.getElement().style.visibility = "hidden";
    // Only the pill hides, so the held handle keeps its pointer capture; MapLibre sets a marker's own opacity.
    for (const grip of this._grips) (grip.getElement().firstElementChild as HTMLElement).style.visibility = "hidden";
  }

  private async _apply(change: Change) {
    await this._send(change.after);
    this._history.record(change);
  }

  // One action at a time: a second one before the first settles would build on a stale footprint.
  // A failed action offers to run again. A failed first shape stays on the map until it saves or the user draws
  // on; a room with a stored shape shows only that one, as a second outline reads as a second room.
  private async _whileSaving(action: () => Promise<void>, shape?: Polygon) {
    if (this._saving) return;
    this._saving = true;
    this._host.requestUpdate();
    let failed = false;
    try {
      await action();
    } catch (err) {
      console.error(err);
      failed = true;
    }
    // Released before the reload, so a reload that hangs does not block input.
    this._saving = false;
    if (failed) {
      if (shape) this._interaction?.keepShape(shape);
      this._saveFailed(() => this._whileSaving(action, shape));
    } else {
      // Any save that succeeds supersedes a failed one, also a removal or an undo.
      this._interaction?.dropShape();
      this._saveSucceeded();
    }
    this._showSides();
    this._host.requestUpdate();
    if (failed) await this._host.reloadRooms().catch(console.error);
  }

  private _saveFailed(retry: () => void) {
    this._saveFailedShown = true;
    this._host.toast({
      id: SAVE_FAILED_ID,
      message: "Could not save",
      action: { text: "Retry", action: retry },
      duration: -1,
      dismissable: true,
    });
  }

  private _saveSucceeded() {
    if (!this._saveFailedShown) return;
    this._saveFailedShown = false;
    this._host.toast({ id: SAVE_FAILED_ID, message: "", duration: 0 });
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
    this._showHandles();
  }

  // The area exists in Home Assistant at once, so its name can be typed before it has a shape. It
  // waits for a pending save, as it changes the active area; Retry creates it on the same floor.
  private _newArea() {
    const floor = this._floor;
    if (floor === "all" || this._saving) return;
    const name = newAreaName(this._areas.map((area) => area.name));
    this._whileSaving(async () => {
      const entry = await this._connection.sendMessagePromise<AreaEntry>({
        type: "config/area_registry/create",
        name,
        ...(floor === null ? {} : { floor_id: floor }),
      });
      this._areas = [...this._areas, entry];
      if (this._floor === floor) this._startRename(entry.area_id);
    });
  }

  private async _rename(change: { areaId: string; name: string }) {
    this._endRename();
    try {
      // The building's name is Home Assistant's location name.
      await this._connection.sendMessagePromise(
        change.areaId === BUILDING
          ? { type: "config/core/update", location_name: change.name }
          : { type: "config/area_registry/update", area_id: change.areaId, name: change.name },
      );
    } catch (err) {
      console.error(err);
      this._saveFailed(() => this._rename(change));
      return;
    }
    this._saveSucceeded();
    await this._host.reloadRooms().catch(console.error);
  }
}
