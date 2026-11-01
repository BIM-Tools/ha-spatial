// Keeps the panel's room edits in step with Home Assistant: the area strip, side lengths, and each edit saved at once with undo and redo.

import { point } from "@turf/helpers";
import type { FeatureCollection, Polygon } from "geojson";
import { html } from "lit";
import { type GeoJSONSource, Marker, type Map as MapLibreMap } from "maplibre-gl";
import { type AreaEntry, BUILDING, newAreaName, nextActive, stripOrder } from "./area-strip";
import { type ActiveRoom, BoxInteraction } from "./box-interaction";
import { type Change, type FootprintBatch, History } from "./history";
import type { LayerColours } from "./map-paint";
import { byLevel } from "./map-view";
import {
  MIN_SIDE_M,
  addToFootprint,
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
  selectTool(tool: Tool): void;
  toast(toast: Toast): void;
}

// A later save that succeeds closes the failure toast through this id.
const SAVE_FAILED_ID = "spatial-save-failed";

const SIDE_STYLE =
  "font: 12px sans-serif; background: var(--card-background-color); color: var(--primary-text-color); border: 1px solid var(--primary-color); border-radius: 3px";
// A side button or field sits on the map, inside a Marker that would block focus; its presses and keys stay its own.
const MAP_EVENTS = ["mousedown", "touchstart", "click", "dblclick", "keydown"];

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
      tool: () => this.tool,
      floorPicked: () => this._floor !== "all",
      saving: () => this._saving,
      activeRoom: () => {
        const footprint = this._footprints.get(this._active);
        return footprint && { areaId: this._active, footprint };
      },
      siteBearing: () => this._host.siteBearing(),
      onBox: (box) => this._finishBox(box),
      onMove: (room, moved) => this._saveMove(room, moved),
      onPickRoom: (areaId) => this._select(areaId),
    });
    window.addEventListener("keydown", this._keys);
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
    this._select(this._firstToDraw());
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this._interaction?.toolChanged();
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

  /** The area strip; on All only the Building pill and a hint. */
  render(hovered?: string) {
    return html`<spatial-area-strip
      ?allFloors=${this._floor === "all"}
      .order=${this._order()}
      .linked=${this._linked()}
      .active=${this._active}
      .renaming=${this._renaming}
      .hovered=${hovered}
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

  // The outline comes first, as it frames the rooms; with every area drawn the outline is active.
  private _firstToDraw() {
    return (this._footprints.has(BUILDING) && nextActive(this._order(), this._linked())) || BUILDING;
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
    for (const side of this._sides) side.remove();
    this._sides = [];
    const map = this._map;
    const areaId = this._active;
    const footprint = this._footprints.get(areaId);
    if (!map || this.tool !== "adjust" || this._floor === "all" || !footprint) return;
    if (!isAxisRectangle(footprint, this._host.siteBearing())) return;
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
      this._host.toast({ message: `A side is at least ${MIN_SIDE_M.toFixed(2)} m` });
      return;
    }
    const after = resizeSide(footprint, edgeIndex, lengthM);
    this._editingSide = undefined;
    this._whileSaving(() => this._apply({ before: { [areaId]: footprint }, after: { [areaId]: after } }), after);
  }

  private async _finishBox(box: Polygon) {
    const areaId = this._active;
    const floor = this._floor;
    const current = this._footprints.get(areaId);
    const footprint = addToFootprint(current, box);
    if (!footprint) {
      this._host.toast({ message: "A room is one shape: draw against it" });
      return;
    }
    await this._whileSaving(async () => {
      await this._apply({ before: { [areaId]: current ?? null }, after: { [areaId]: footprint } });
      // Only a first shape moves on: the next box for a drawn area usually extends it.
      if (!current && this._floor === floor) this._setActive(this._firstToDraw());
    }, footprint);
  }

  private _saveMove({ areaId, footprint }: ActiveRoom, moved: Polygon) {
    this._whileSaving(() => this._apply({ before: { [areaId]: footprint }, after: { [areaId]: moved } }), moved);
  }

  private async _apply(change: Change) {
    await this._send(change.after);
    this._history.record(change);
  }

  // One action at a time: a second one before the first settles would build on a stale footprint.
  // A failed action keeps its shape on the map and offers to run again, until it saves or the user draws on.
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
      if (shape) this._interaction?.dropShape(shape);
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

  // The area exists in Home Assistant at once, so its name can be typed before it has a shape.
  private async _newArea() {
    const floor = this._floor;
    if (floor === "all") return;
    let entry: AreaEntry;
    try {
      entry = await this._connection.sendMessagePromise<AreaEntry>({
        type: "config/area_registry/create",
        name: newAreaName(this._areas.map((area) => area.name)),
        ...(floor === null ? {} : { floor_id: floor }),
      });
    } catch (err) {
      console.error(err);
      this._saveFailed(() => this._newArea());
      return;
    }
    this._saveSucceeded();
    this._areas = [...this._areas, entry];
    if (this._floor !== floor) return;
    this._startRename(entry.area_id);
  }

  private async _rename(change: { areaId: string; name: string }) {
    this._endRename();
    try {
      await this._connection.sendMessagePromise({
        type: "config/area_registry/update",
        area_id: change.areaId,
        name: change.name,
      });
    } catch (err) {
      console.error(err);
      this._saveFailed(() => this._rename(change));
      return;
    }
    this._saveSucceeded();
    await this._host.reloadRooms().catch(console.error);
  }
}
