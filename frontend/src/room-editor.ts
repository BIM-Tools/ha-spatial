// Keeps the panel's room edits in step with Home Assistant: the area strip, side lengths, and each edit saved at once with undo and redo.

import { point } from "@turf/helpers";
import type { FeatureCollection, Polygon } from "geojson";
import { html, nothing } from "lit";
import { type GeoJSONSource, Marker, type Map as MapLibreMap } from "maplibre-gl";
import { type AreaEntry, BUILDING, NEW_AREA, newAreaName, nextActive, stripOrder } from "./area-strip";
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

const SIDE_STYLE =
  "font: 12px sans-serif; background: var(--card-background-color); color: var(--primary-text-color); border: 1px solid var(--primary-color); border-radius: 3px";
// A side button or field sits on the map, inside a Marker that would block focus; its presses and keys stay its own.
const MAP_EVENTS = ["mousedown", "touchstart", "click", "dblclick", "keydown"];

export class RoomEditor {
  floors: FloorEntry[] = [];
  tool: Tool = "adjust";
  private readonly _history = new History();
  // The last refusal or failure, shown by the panel.
  message = "";
  private _areas: AreaEntry[] = [];
  private _footprints = new Map<string, Polygon>();
  private _floor: string | null | "all" = "all";
  private _active = NEW_AREA;
  private _map?: MapLibreMap;
  private _interaction?: BoxInteraction;
  private _saving = false;
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

  get canUndo() {
    return !this._saving && this._history.canUndo;
  }

  get canRedo() {
    return !this._saving && this._history.canRedo;
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
      siteBearing: () => this._siteBearing(),
      onBox: (box) => this._finishBox(box),
      onMove: (room, moved) => this._saveMove(room, moved),
      onPickRoom: (areaId) => this._select(areaId),
    });
    window.addEventListener("keydown", this._undoKey);
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
    window.removeEventListener("keydown", this._undoKey);
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
    if (![NEW_AREA, BUILDING, ...order.map((area) => area.area_id)].includes(this._active)) {
      this._setActive(order[0]?.area_id ?? NEW_AREA);
    }
    this._showSides();
    this._requestUpdate();
  }

  setFloor(floor: string | null | "all") {
    this._floor = floor;
    this.message = "";
    this._interaction?.toolChanged();
    this._select(this._nextActive());
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.message = "";
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

  render() {
    if (this._floor === "all") return nothing;
    return html`<spatial-area-strip
      .order=${this._order()}
      .linked=${this._linked()}
      .active=${this._active}
      @area-select=${(event: CustomEvent<{ areaId: string }>) => {
        this._interaction?.cancel();
        this._select(event.detail.areaId);
      }}
      @area-rename=${(event: CustomEvent<{ areaId: string; name: string }>) => this._rename(event.detail)}
    ></spatial-area-strip>`;
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

  private _buildingVisibility(): "visible" | "none" {
    return this._active === BUILDING ? "visible" : "none";
  }

  private _setActive(areaId: string) {
    this._active = areaId;
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

  private _undoKey = (event: KeyboardEvent) => {
    // All floors is a view only, as its disabled Undo and Redo buttons show.
    if (this._floor === "all") return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
    if (event.composedPath()[0] instanceof HTMLInputElement) return;
    event.preventDefault();
    if (event.shiftKey) this.redo();
    else this.undo();
  };

  // In Adjust each side of the active room, when it is a rectangle on the site axis, is a button that opens a length field.
  private _showSides() {
    for (const side of this._sides) side.remove();
    this._sides = [];
    const map = this._map;
    const areaId = this._active;
    const footprint = this._footprints.get(areaId);
    if (!map || this.tool !== "adjust" || this._floor === "all" || !footprint) return;
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
      this.message = `A side is at least ${MIN_SIDE_M.toFixed(2)} m`;
      this._requestUpdate();
      return;
    }
    const after = resizeSide(footprint, edgeIndex, lengthM);
    this._editingSide = undefined;
    this._whileSaving(() => this._apply({ before: { [areaId]: footprint }, after: { [areaId]: after } }));
  }

  private async _finishBox(box: Polygon) {
    const areaId = this._active;
    const floor = this._floor;
    const current = areaId === NEW_AREA ? undefined : this._footprints.get(areaId);
    const footprint = addToFootprint(current, box);
    if (!footprint) {
      this.message = "A room is one shape: draw against it";
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

  private _saveMove({ areaId, footprint }: ActiveRoom, moved: Polygon) {
    this._whileSaving(() => this._apply({ before: { [areaId]: footprint }, after: { [areaId]: moved } }));
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
      this.message = "";
    } catch (err) {
      console.error(err);
      this.message = "Could not save";
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
    this._showHandles();
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
      this.message = "Could not rename";
      this._requestUpdate();
    }
  }
}
