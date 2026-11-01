// The space editor panel; the dashboard card embeds it to show the rooms on the map.

import { lineString } from "@turf/helpers";
import type { FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import {
  type GeoJSONSource,
  type MapMouseEvent,
  Map as MapLibreMap,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
import "./editor-toolbar";
import type { Floor, FloorChoice } from "./floor-selector";
import "./floor-selector";
import "./map-stack";
import { bounds, floorsByLevel, mapBearing, styleUrl, withMapTilesToken } from "./map-view";
import { buildingAt, wallAt, wallBearingAt } from "./outline";
import "./panel-header";
import { RoomEditor, type Tool } from "./room-editor";
import { floatingSurface, phoneBar } from "./styles";

// The parts of Home Assistant's `hass` object this panel uses.
interface Hass {
  connection: {
    sendMessagePromise<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
    subscribeMessage(callback: () => void, message: { type: string }): Promise<() => Promise<void>>;
    subscribeEvents(callback: () => void, eventType: string): Promise<() => Promise<void>>;
    addEventListener(eventType: "ready", listener: () => void): void;
    removeEventListener(eventType: "ready", listener: () => void): void;
  };
  floors?: Record<string, { name: string }>;
  themes: { darkMode: boolean };
}

interface Site {
  lon: number;
  lat: number;
  // Null until the first Align.
  bearing_deg: number | null;
  outline: Polygon | null;
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const EAST_DEG = 90;
// Share of the map height the aligned wall sits below the centre.
const WALL_OFFSET_SHARE = 0.3;
const REGISTRY_EVENTS = ["area_registry_updated", "floor_registry_updated"];
const PHONE_QUERY = "(max-width: 600px)";
const MAP_SHOWN_KEY = "spatial-show-map";

// Core rotates the map tiles token every 30 minutes and keeps two live; this
// is the interval Home Assistant's own frontend refreshes at.
const TOKEN_REFRESH_MS = 20 * 60 * 1000;

// Storage can be blocked; the map toggle then lasts only this visit.
const readMapShown = (): boolean => {
  try {
    return localStorage.getItem(MAP_SHOWN_KEY) !== "false";
  } catch {
    return true;
  }
};

const storeMapShown = (shown: boolean) => {
  try {
    localStorage.setItem(MAP_SHOWN_KEY, String(shown));
  } catch {
    // As above.
  }
};

const loadStyle = async (darkMode: boolean): Promise<StyleSpecification> => {
  const style = await (await fetch(styleUrl(darkMode))).json();
  // The shipped style is root-relative; MapLibre needs absolute sprite and
  // glyph URLs. Glyphs are concatenated so `{fontstack}` is not encoded.
  style.sprite = style.sprite.map((sprite: { url: string }) => ({
    ...sprite,
    url: new URL(sprite.url, location.origin).href,
  }));
  style.glyphs = location.origin + style.glyphs;
  return style;
};

// Without the map the plan lies on the page colour, and no vector tiles load.
const plainStyle = (ground: string): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: "ground", type: "background", paint: { "background-color": ground } }],
});

class SpatialPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    // Set by the dashboard card.
    card: { type: Boolean },
    // Set by the card's `floor` option: a fixed, static view of "all" or one floor_id.
    floor: { attribute: false },
    panel: { attribute: false },
    _floors: { state: true },
    _floor: { state: true },
    _failed: { state: true },
    _message: { state: true },
    _mapShown: { state: true },
    _phone: { state: true },
    // The stored site direction, which names the compass.
    _bearing: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      /* The panel resolver around a custom panel has no height to fill. */
      height: 100dvh;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
    }
    :host([card]) {
      height: 100%;
      background: none;
    }
    .stage {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    #map {
      position: absolute;
      inset: 0;
    }
    /* Floors left, tools right; when both do not fit, the tools move to a row below. */
    .top {
      position: absolute;
      top: 16px;
      right: 16px;
      left: 16px;
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px;
      pointer-events: none;
    }
    .top > * {
      pointer-events: auto;
    }
    .toolbar {
      margin-left: auto;
    }
    /* Clear of the round map toggle on the right. */
    .top.phone {
      top: 12px;
      right: 68px;
      left: 12px;
    }
    .map-stack {
      position: absolute;
      right: 16px;
      bottom: 96px;
    }
    .map-stack[round] {
      top: 64px;
      right: 12px;
      bottom: auto;
    }
    .messages {
      display: flex;
      flex-basis: 100%;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
    }
    .top.phone .messages {
      margin-top: 0;
    }
    .messages span {
      display: flex;
      align-items: center;
      min-height: 40px;
      box-sizing: border-box;
      padding: 0 16px;
      ${floatingSurface}
      border-radius: 20px;
      font-size: 14px;
    }
    /* Centred by its margins, so it can grow to the full stage width before it scrolls. */
    .strip {
      ${floatingSurface}
      position: absolute;
      right: 16px;
      bottom: 16px;
      left: 16px;
      display: flex;
      box-sizing: border-box;
      width: fit-content;
      max-width: min(1352px, calc(100% - 32px));
      margin-inline: auto;
      border-radius: 26px;
    }
    .strip > * {
      min-width: 0;
    }
    .strip-bar {
      ${phoneBar}
      display: flex;
      border-top: 1px solid var(--divider-color);
    }
  `;

  // `declare` keeps class fields from shadowing Lit's accessors.
  declare hass: Hass | undefined;
  declare card: boolean;
  declare floor: string | undefined;
  declare panel: object | undefined;
  declare _floors: (string | null)[] | undefined;
  declare _floor: Floor;
  declare _failed: boolean;
  declare _message: string;
  declare _mapShown: boolean;
  declare _phone: boolean;
  declare _bearing: number | null;

  private _map?: MapLibreMap;
  private _started = false;
  // Bumped on disconnect, so a startup still awaiting creates nothing.
  private _run = 0;
  // Dark mode and map visibility of the style on the map, and of the one being fetched.
  private _styleKey = "";
  private _pendingStyleKey = "";
  // Not reactive: the compass follows every rotate frame without rendering the panel.
  private _mapBearingDeg = 0;
  private _token = "";
  private _tokenTimer?: ReturnType<typeof setInterval>;
  private _unsubscribe?: () => void;
  private _areas: FeatureCollection = EMPTY;
  private _outline: Polygon | FeatureCollection = EMPTY;
  // Only the admin panel edits; the card stays read-only.
  private _editor?: RoomEditor;
  private readonly _phoneQuery = window.matchMedia(PHONE_QUERY);

  constructor() {
    super();
    this.card = false;
    this._floor = "all";
    this._message = "";
    this._mapShown = readMapShown();
    this._phone = false;
    this._bearing = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._phone = this._phoneQuery.matches;
    this._phoneQuery.addEventListener("change", this._phoneChanged);
  }

  private _phoneChanged = () => {
    this._phone = this._phoneQuery.matches;
  };

  // The site's x-axis, clockwise from north. Before any Align it points east, so the view is north up.
  private get _axisDeg(): number {
    return this._bearing ?? EAST_DEG;
  }

  private get _aligning() {
    return this._editor?.tool === "align";
  }

  // The card keeps the map until it has its own option.
  private get _mapVisible() {
    return this.card || this._mapShown || this._aligning;
  }

  render() {
    const editor = this._editor;
    const phone = this._phone && !this.card;
    const onFloor = this._floor !== "all";
    return html`
      <link rel="stylesheet" href="/static/map/maplibre-gl.css" />
      ${this.card ? nothing : html`<spatial-panel-header ?narrow=${phone}></spatial-panel-header>`}
      ${phone ? this._floorSelector(true) : nothing}
      <div class="stage">
        <div id="map"></div>
        <div class="top ${phone ? "phone" : ""}">
          ${phone ? nothing : this._floorSelector(false)}
          ${editor && !phone ? this._toolbar(editor, false) : nothing} ${this._messages()}
        </div>
        ${editor
          ? html`<spatial-map-stack
              class="map-stack"
              ?round=${phone}
              .mapShown=${this._mapShown}
              .mapForced=${this._aligning}
              .bearing=${this._mapBearingDeg}
              .aligned=${this._bearing !== null}
              @map-toggle=${this._toggleMap}
              @zoom-in=${() => this._map?.zoomIn()}
              @zoom-out=${() => this._map?.zoomOut()}
              @compass=${this._faceSite}
            ></spatial-map-stack>`
          : nothing}
        ${editor && onFloor && !phone ? html`<div class="strip">${editor.render()}</div>` : nothing}
      </div>
      ${editor && onFloor && phone ? html`<div class="strip-bar">${editor.render()}</div>` : nothing}
      ${editor && phone ? this._toolbar(editor, true) : nothing}
    `;
  }

  private _floorSelector(chips: boolean) {
    const choices = this._floorChoices();
    if (!choices.length) return nothing;
    return html`<spatial-floor-selector
      ?chips=${chips}
      .choices=${choices}
      .selected=${this._floor}
      @floor-select=${(event: CustomEvent<{ floor: Floor }>) => this._show(event.detail.floor)}
    ></spatial-floor-selector>`;
  }

  private _toolbar(editor: RoomEditor, bar: boolean) {
    return html`<spatial-editor-toolbar
      class=${bar ? "" : "toolbar"}
      ?bar=${bar}
      ?disabled=${this._floor === "all"}
      .tool=${editor.tool}
      .canUndo=${editor.canUndo}
      .canRedo=${editor.canRedo}
      @tool-select=${(event: CustomEvent<{ tool: Tool }>) => this._selectTool(event.detail.tool)}
      @undo=${editor.undo}
      @redo=${editor.redo}
    ></spatial-editor-toolbar>`;
  }

  private _messages() {
    const noRooms =
      this._floors &&
      (this.floor && this.floor !== "all" ? !this._floors.includes(this.floor) : this._floors.length === 0);
    const messages = [
      noRooms ? "No rooms yet" : "",
      this._aligning ? "Click your house near the wall the rooms follow" : "",
      this._message,
      this._editor?.message ?? "",
      this._failed ? "Map could not load" : "",
    ].filter(Boolean);
    if (!messages.length) return nothing;
    return html`<div class="messages">
      ${messages.map((message) => html`<span>${message}</span>`)}
    </div>`;
  }

  updated(changed: PropertyValues<this>) {
    // MapLibre fixes interactivity at creation, so a new option rebuilds the map.
    if (changed.has("floor") && this._started) this._stop();
    // A render queued by _stop must not start a map for a panel that has left.
    if (!this.hass || !this.isConnected) return;
    if (!this._started) {
      this._started = true;
      this._failed = false;
      this._start(this.hass).catch((err) => {
        console.error(err);
        this._failed = true;
      });
    } else if (this._map && ![this._styleKey, this._pendingStyleKey].includes(this._wantedStyleKey())) {
      // A full reload fires `style.load`, which adds the rooms again.
      this._loadStyle()
        .then((style) => style && this._map?.setStyle(style, { diff: false }))
        .catch(console.error);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._phoneQuery.removeEventListener("change", this._phoneChanged);
    this._stop();
  }

  private _wantedStyleKey() {
    return `${this.hass!.themes.darkMode} ${this._mapVisible}`;
  }

  // Resolves to undefined when a newer style was asked for in the meantime. A failed fetch
  // leaves the style key as it was, so the next update asks again.
  private async _loadStyle(): Promise<StyleSpecification | undefined> {
    const key = this._wantedStyleKey();
    this._pendingStyleKey = key;
    const darkMode = this.hass!.themes.darkMode;
    try {
      const style = this._mapVisible
        ? await loadStyle(darkMode)
        : plainStyle(
            getComputedStyle(this).getPropertyValue("--primary-background-color").trim() ||
              (darkMode ? "#111111" : "#fafafa"),
          );
      if (key !== this._pendingStyleKey) return undefined;
      this._styleKey = key;
      return style;
    } finally {
      if (key === this._pendingStyleKey) this._pendingStyleKey = "";
    }
  }

  private _stop() {
    this._run++;
    this.hass?.connection.removeEventListener("ready", this._keepToken);
    clearInterval(this._tokenTimer);
    this._unsubscribe?.();
    this._editor?.detach();
    this._editor = undefined;
    this._map?.remove();
    this._map = undefined;
    this._started = false;
  }

  private _refreshToken = async () => {
    this._token = (
      await this.hass!.connection.sendMessagePromise<{ token: string }>({
        type: "map_tiles/access_token",
      })
    ).token;
  };

  // On failure the current token stays; the next interval or reconnect retries.
  // A reconnect matters because a restarted core has forgotten its tokens.
  private _keepToken = () => {
    this._refreshToken().catch(() => {});
  };

  private async _start(hass: Hass) {
    const run = this._run;
    const stopped = () => run !== this._run;
    const call = <T>(type: string) => hass.connection.sendMessagePromise<T>({ type });
    this._floor = this.floor ?? "all";
    await this._refreshToken();
    if (stopped()) return;
    this._tokenTimer = setInterval(this._keepToken, TOKEN_REFRESH_MS);
    hass.connection.addEventListener("ready", this._keepToken);

    const loadAreas = async () => {
      const feed = call<FeatureCollection>("spatial/geojson");
      const site = call<Site>("spatial/site");
      await editor?.refresh(feed, site);
      this._areas = await feed;
      this._floors = floorsByLevel(this._areas);
      this._map?.getSource<GeoJSONSource>("areas")?.setData(this._areas);
      this._outline = (await site).outline ?? EMPTY;
      this._map?.getSource<GeoJSONSource>("outline")?.setData(this._outline);
      return site;
    };
    const editor = this.card
      ? undefined
      : new RoomEditor(hass.connection, () => this.requestUpdate(), loadAreas, () => this._axisDeg);
    this._editor = editor;
    const site = await loadAreas();
    if (stopped()) return;
    // Only a new bearing is applied; re-centring would move the camera while
    // the user looks around. A static map has no user, so it frames again.
    const onUpdate = async () => {
      const { bearing_deg } = await loadAreas();
      if (this.floor) {
        this._bearing = bearing_deg;
        this._fit();
        return;
      }
      if (bearing_deg === this._bearing) return;
      this._bearing = bearing_deg;
      this._map?.setBearing(mapBearing(this._axisDeg));
    };
    // The editor's strip and floor buttons name areas and floors, which change outside this panel.
    const rereadRegistries = () => {
      loadAreas().catch(console.error);
    };
    const subscriptions = await Promise.all([
      hass.connection.subscribeMessage(onUpdate, { type: "spatial/subscribe" }),
      ...(editor ? REGISTRY_EVENTS.map((eventType) => hass.connection.subscribeEvents(rereadRegistries, eventType)) : []),
    ]);
    const unsubscribe = () => {
      for (const unsubscribeOne of subscriptions) unsubscribeOne();
    };
    if (stopped()) {
      unsubscribe();
      return;
    }
    this._unsubscribe = unsubscribe;

    this._bearing = site.bearing_deg;
    const style = await this._loadStyle();
    if (stopped() || !style) return;
    setWorkerUrl("/spatial_static/maplibre-gl-worker.mjs");
    this._mapBearingDeg = mapBearing(this._axisDeg);
    const map = new MapLibreMap({
      container: this.renderRoot.querySelector<HTMLElement>("#map")!,
      style,
      transformRequest: (url) => withMapTilesToken(url, location.origin, this._token),
      center: [site.lon, site.lat],
      zoom: 19,
      pitch: this._floor === "all" ? 50 : 0,
      bearing: this._mapBearingDeg,
      interactive: !this.floor,
    });
    this._map = map;
    map.on("style.load", () => this._addAreas());
    map.on("mousemove", (event) => this._previewWall(event));
    if (editor) {
      this._showBearing(this._mapBearingDeg);
      map.on("rotate", () => this._showBearing(map.getBearing()));
    }
    editor?.attach(map);
    // After the editor, so the click that ends Align is not also a room pick in Adjust.
    map.on("click", (event) => this._pick(event));
    if (this.floor) this._fit();
  }

  private _showBearing(bearingDeg: number) {
    this._mapBearingDeg = bearingDeg;
    const stack = this.renderRoot.querySelector<HTMLElement & { bearing: number }>("spatial-map-stack");
    if (stack) stack.bearing = bearingDeg;
  }

  // Frames the rooms in view, keeping the picked wall horizontal.
  private _fit() {
    const box = bounds(
      this._areas.features.filter(
        (f) => this._floor === "all" || f.properties?.floor_id === this._floor,
      ),
    );
    if (box) {
      this._map?.fitBounds(box, { bearing: mapBearing(this._axisDeg), padding: 16, animate: false });
    }
  }

  // "All" stacks the floors in 3D; one floor is a flat plan with room outlines.
  private _addAreas() {
    const map = this._map!;
    map.addSource("areas", { type: "geojson", data: this._areas });
    map.addLayer({
      id: "areas-3d",
      type: "fill-extrusion",
      source: "areas",
      paint: {
        "fill-extrusion-color": "#03a9f4",
        "fill-extrusion-base": ["get", "base_m"],
        "fill-extrusion-height": ["get", "top_m"],
        "fill-extrusion-opacity": 0.7,
      },
    });
    map.addLayer({
      id: "areas-2d",
      type: "fill",
      source: "areas",
      paint: { "fill-color": "#03a9f4", "fill-opacity": 0.4 },
    });
    map.addLayer({
      id: "areas-outline",
      type: "line",
      source: "areas",
      paint: { "line-color": "#212121", "line-width": 2 },
    });
    map.addSource("outline", { type: "geojson", data: this._outline });
    map.addLayer({
      id: "spatial-outline",
      type: "line",
      source: "outline",
      paint: { "line-color": "#ff9800", "line-width": 3 },
    });
    map.addSource("spatial-wall", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "spatial-wall",
      type: "line",
      source: "spatial-wall",
      paint: {
        "line-color": getComputedStyle(map.getContainer()).getPropertyValue("--primary-color").trim() || "#03a9f4",
        "line-width": 4,
      },
    });
    this._editor?.addLayers(map);
    this._applyFloor();
  }

  // The panel lists every registered floor, so an empty one can be drawn; the card only those with rooms.
  private _floorChoices(): FloorChoice[] {
    if (this.floor) return [];
    const floors: Floor[] = this._editor
      ? ["all", ...this._editor.floors.map((entry) => entry.floor_id), null]
      : ["all", ...(this._floors ?? [])];
    return floors.map((floor) => ({ floor, name: this._floorName(floor) }));
  }

  private _floorName(floor: Floor): string {
    if (floor === "all") return "All";
    if (floor === null) return "No floor";
    return (
      this._editor?.floors.find((entry) => entry.floor_id === floor)?.name ?? this.hass?.floors?.[floor]?.name ?? floor
    );
  }

  // The compass turns the house back the way Align set it, or north up before any Align.
  // Draw keeps this view, so it is safe there too.
  private _faceSite() {
    this._map?.easeTo({ bearing: mapBearing(this._axisDeg) });
  }

  private _selectTool(tool: Tool) {
    const editor = this._editor;
    if (!editor || editor.tool === tool) return;
    if (editor.tool === "align") this._showWall();
    this._message = "";
    editor.setTool(tool);
  }

  private _toggleMap() {
    this._mapShown = !this._mapShown;
    storeMapShown(this._mapShown);
  }

  private _showWall(wall?: [Position, Position]) {
    const data = wall ? lineString(wall) : EMPTY;
    this._map?.getSource<GeoJSONSource>("spatial-wall")?.setData(data);
  }

  private _buildingUnder(event: MapMouseEvent): Polygon | undefined {
    const map = this._map!;
    const layers = map
      .getStyle()
      .layers.filter((layer) => "source-layer" in layer && layer["source-layer"] === "buildings")
      .map((layer) => layer.id);
    const at: [number, number] = [event.lngLat.lng, event.lngLat.lat];
    return map
      .queryRenderedFeatures(event.point, { layers })
      .map((feature) => buildingAt(feature.geometry as Polygon | MultiPolygon, at))
      .find(Boolean);
  }

  private _previewWall(event: MapMouseEvent) {
    if (!this._aligning) return;
    const building = this._buildingUnder(event);
    this._showWall(building && wallAt(building, [event.lngLat.lng, event.lngLat.lat]));
  }

  // One tap sets the site axis from the wall of the building nearest to it, and goes back to Adjust.
  // The camera turns in place around the click, so the building stays in view. It turns before
  // the save, because Home Assistant sends the update event ahead of the reply.
  private _pick(event: MapMouseEvent) {
    if (!this._aligning) return;
    const building = this._buildingUnder(event);
    this._selectTool("adjust");
    if (!building) {
      this._message = "No building here";
      return;
    }
    const previousBearing = this._bearing;
    const newBearing = wallBearingAt(building, [event.lngLat.lng, event.lngLat.lat]);
    this._bearing = newBearing;
    // The picked wall lies low in the view with the building above it, its outside facing the viewer.
    const wallBelowCentre = (this._map?.getContainer().clientHeight ?? 0) * WALL_OFFSET_SHARE;
    this._map?.easeTo({ bearing: mapBearing(newBearing), center: event.lngLat, offset: [0, wallBelowCentre] });
    this.hass!.connection.sendMessagePromise({ type: "spatial/site/update", bearing_deg: newBearing }).then(
      () => {
        this._message = "";
      },
      (err) => {
        console.error(err);
        this._message = "Could not save";
        this._bearing = previousBearing;
        this._map?.easeTo({ bearing: mapBearing(this._axisDeg) });
      },
    );
  }

  private _applyFloor() {
    const map = this._map!;
    const flat = this._floor !== "all";
    map.setLayoutProperty("areas-3d", "visibility", flat ? "none" : "visible");
    for (const id of ["areas-2d", "areas-outline"]) {
      map.setLayoutProperty(id, "visibility", flat ? "visible" : "none");
      map.setFilter(id, flat ? ["==", ["get", "floor_id"], this._floor] : null);
    }
  }

  private _show(floor: Floor) {
    if (floor === this._floor) return;
    // All is a view only; Align would stay pressed on a disabled toolbar.
    if (floor === "all" && this._aligning) this._selectTool("adjust");
    this._floor = floor;
    this._editor?.setFloor(floor);
    // Before the style has loaded, `_addAreas` applies the floor.
    if (!this._map?.getLayer("areas-3d")) return;
    this._applyFloor();
    this._map.easeTo({ pitch: floor === "all" ? 50 : 0 });
  }
}

customElements.define("spatial-panel", SpatialPanel);
