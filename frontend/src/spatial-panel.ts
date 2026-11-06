// The space editor panel; the dashboard card embeds it to show the rooms on the map.

import { lineString } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import {
  type GeoJSONSource,
  type MapMouseEvent,
  Map as MapLibreMap,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
import "./editor-toolbar";
import {
  type FloorStack,
  FloorLabels,
  VIEW_PITCH_DEG,
  VIEW_TURN_DEG,
  floorLabelStyles,
  floorStack,
  stackFloors,
  stackView,
} from "./floor-stack";
import type { Floor, FloorChoice } from "./floor-selector";
import "./floor-selector";
import "./map-stack";
import { type MapPaint, layerColours, readMapPaint, repaint } from "./map-paint";
import { type ThemeState, bounds, darkModeOf, mapBearing, styleUrl, withMapTilesToken, workerUrl } from "./map-view";
import { type AlignFields, alignFields, buildingAt, wallAt } from "./outline";
import "./panel-header";
import { EMPTY, PanelState } from "./panel-state";
import { BUILDING } from "./area-strip";
import { type Guide, RoomEditor, type Toast, type Tool } from "./room-editor";
import { type AreaInfo, RoomLabels, roomLabelStyles } from "./room-labels";
import { floatingSurface, phoneBar } from "./styles";
import { type HassUnits, isStillStarting, saveFailureMessage } from "./units";

// The parts of Home Assistant's `hass` object this panel uses.
interface Hass extends HassUnits {
  // The location name is the building's name.
  config: HassUnits["config"] & { location_name: string };
  user?: { is_admin: boolean };
  connection: {
    sendMessagePromise<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
    subscribeMessage(callback: () => void, message: { type: string }): Promise<() => Promise<void>>;
    subscribeEvents(callback: () => void, eventType: string): Promise<() => Promise<void>>;
    addEventListener(eventType: "ready", listener: () => void): void;
    removeEventListener(eventType: "ready", listener: () => void): void;
  };
  areas?: Record<string, AreaInfo>;
  floors?: Record<string, { name: string; level?: number | null }>;
  themes: ThemeState["themes"];
  selectedTheme?: ThemeState["selectedTheme"];
}

// Share of the map height the aligned wall sits below the centre.
const WALL_OFFSET_SHARE = 0.3;
// The stack's layers, bottom up: id, feature kind, opacity, and a shift on screen that lets the shadow show below its slab.
const STACK_LAYERS: [string, string, number, [number, number]][] = [
  ["stack-shadow", "shadow", 0.2, [5, 9]],
  ["stack-slabs", "slab", 1, [0, 0]],
  ["stack-rooms", "room", 1, [0, 0]],
  ["stack-walls", "wall", 1, [0, 0]],
];
const REGISTRY_EVENTS = ["area_registry_updated", "floor_registry_updated"];
const PHONE_QUERY = "(max-width: 600px)";
const DARK_QUERY = "(prefers-color-scheme: dark)";
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
    _failed: { state: true },
    _hovered: { state: true },
    _mapShown: { state: true },
    _phone: { state: true },
  };

  static styles = [
    roomLabelStyles,
    floorLabelStyles,
    css`
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
      top: var(--ha-space-4);
      right: var(--ha-space-4);
      left: var(--ha-space-4);
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: var(--ha-space-2);
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
      top: var(--ha-space-3);
      right: 68px;
      left: var(--ha-space-3);
    }
    .map-stack {
      position: absolute;
      right: var(--ha-space-4);
      bottom: 96px;
    }
    .map-stack[round] {
      top: 64px;
      right: var(--ha-space-3);
      bottom: auto;
    }
    /* A row of its own, so it sits centred under the floors and tools. */
    .guide-row {
      display: flex;
      flex-basis: 100%;
      justify-content: center;
      margin-top: 14px;
      pointer-events: none;
    }
    .top.phone .guide-row {
      margin-top: 0;
    }
    .guide {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      min-height: 40px;
      box-sizing: border-box;
      padding: 0 var(--ha-space-4);
      ${floatingSurface}
      border-radius: 20px;
      font-size: var(--ha-font-size-m);
      pointer-events: auto;
    }
    .top.phone .guide {
      gap: var(--ha-space-2);
    }
    .guide .text {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .guide .step {
      flex: none;
      color: var(--secondary-text-color);
    }
    /* MapLibre's attribution sits bottom right, where a wide strip would cover it. */
    .stage.with-strip .maplibregl-ctrl-bottom-right {
      bottom: 68px;
    }
    .stage.with-strip .maplibregl-ctrl-bottom-right .maplibregl-ctrl {
      margin: 0 var(--ha-space-4) var(--ha-space-1) 0;
    }
    /* Centred by its margins, so it can grow to the full stage width before it scrolls. */
    .strip {
      ${floatingSurface}
      position: absolute;
      right: var(--ha-space-4);
      bottom: var(--ha-space-4);
      left: var(--ha-space-4);
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
  `,
  ];

  // `declare` keeps class fields from shadowing Lit's accessors.
  declare hass: Hass | undefined;
  declare card: boolean;
  declare floor: string | undefined;
  declare panel: object | undefined;
  declare _failed: boolean;
  declare _hovered: string | undefined;
  declare _mapShown: boolean;
  declare _phone: boolean;

  // The site, its frame, the rooms and the floor in view.
  private readonly _state = new PanelState(this);
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
  private _labels?: RoomLabels;
  private _floorLabels?: FloorLabels;
  // All floors as slabs, built again with every load of the rooms.
  private _stack?: FloorStack;
  // Only the admin panel edits; the card stays read-only.
  private _editor?: RoomEditor;
  private readonly _phoneQuery = window.matchMedia(PHONE_QUERY);

  constructor() {
    super();
    this.card = false;
    this._hovered = undefined;
    this._mapShown = readMapShown();
    this._phone = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._phone = this._phoneQuery.matches;
    this._phoneQuery.addEventListener("change", this._phoneChanged);
  }

  private _phoneChanged = () => {
    this._phone = this._phoneQuery.matches;
  };

  private get _aligning() {
    return this._editor?.tool === "align";
  }

  // Read on every use: when Home Assistant resolves darkMode later, it hands over new themes, which updates the panel.
  private get _darkMode() {
    return darkModeOf(this.hass!, window.matchMedia(DARK_QUERY).matches);
  }

  // The card keeps the map until it has its own option.
  private get _mapVisible() {
    return this.card || this._mapShown || this._aligning;
  }

  render() {
    const editor = this._editor;
    const phone = this._phone && !this.card;
    return html`
      <link rel="stylesheet" href="/static/map/maplibre-gl.css" />
      ${this.card ? nothing : html`<spatial-panel-header ?narrow=${phone}></spatial-panel-header>`}
      ${phone ? this._floorSelector(true) : nothing}
      <div class="stage ${editor && !phone ? "with-strip" : ""}">
        <div id="map"></div>
        <div class="top ${phone ? "phone" : ""}">
          ${phone ? nothing : this._floorSelector(false)}
          ${editor && !phone ? this._toolbar(editor, false) : nothing} ${this._guide()}
        </div>
        ${editor
          ? html`<spatial-map-stack
              class="map-stack"
              ?round=${phone}
              .mapShown=${this._mapShown}
              .mapForced=${this._aligning}
              .bearing=${this._mapBearingDeg}
              .aligned=${this._state.bearing !== null}
              @map-toggle=${this._toggleMap}
              @zoom-in=${() => this._map?.zoomIn()}
              @zoom-out=${() => this._map?.zoomOut()}
              @compass=${this._faceSite}
            ></spatial-map-stack>`
          : nothing}
        ${editor && !phone ? html`<div class="strip" @area-hover=${this._hoverFromStrip}>${editor.render(this._hovered)}</div>` : nothing}
      </div>
      ${editor && phone ? html`<div class="strip-bar" @area-hover=${this._hoverFromStrip}>${editor.render(this._hovered)}</div>` : nothing}
      ${editor && phone ? this._toolbar(editor, true) : nothing}
    `;
  }

  private _floorSelector(chips: boolean) {
    const choices = this._floorChoices();
    if (!choices.length) return nothing;
    return html`<spatial-floor-selector
      ?chips=${chips}
      .choices=${choices}
      .selected=${this._state.floor}
      @floor-select=${(event: CustomEvent<{ floor: Floor }>) => this._show(event.detail.floor)}
    ></spatial-floor-selector>`;
  }

  private _toolbar(editor: RoomEditor, bar: boolean) {
    return html`<spatial-editor-toolbar
      class=${bar ? "" : "toolbar"}
      ?bar=${bar}
      ?disabled=${this._state.floor === "all"}
      .tool=${editor.tool}
      .canUndo=${editor.canUndo}
      .canRedo=${editor.canRedo}
      @tool-select=${(event: CustomEvent<{ tool: Tool }>) => this._selectTool(event.detail.tool)}
      @undo=${editor.undo}
      @redo=${editor.redo}
    ></spatial-editor-toolbar>`;
  }

  // One line at a time, and only when there is something to say; what went wrong first.
  private _guide() {
    const noRooms = this._state.hasNoRooms(this.floor);
    const guide: Guide | undefined = this._failed
      ? { text: "Map could not load" }
      : (this._editor?.guide ?? (noRooms ? { text: "No rooms yet" } : undefined));
    if (!guide) return nothing;
    return html`<div class="guide-row">
      <div class="guide" role="status">
        <span class="text">${guide.text}</span>${guide.step ? html`<span class="step">${guide.step}</span>` : nothing}
      </div>
    </div>`;
  }

  /** Fires Home Assistant's toast, which its notification manager shows and announces. */
  private _toast(toast: Toast) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: toast, bubbles: true, composed: true }));
  }

  private _hoverFromStrip = (event: CustomEvent<{ areaId: string | undefined }>) => this._hover(event.detail.areaId);

  // Pointing at a pill outlines its room and pointing at a room outlines its pill, so the strip is the legend.
  private _hover(areaId: string | undefined) {
    this._hovered = areaId;
    this._labels?.point(areaId === BUILDING ? undefined : areaId);
    const map = this._map;
    if (!map?.getLayer("spatial-hover")) return;
    map.setFilter("spatial-hover", ["==", ["get", "area_id"], areaId ?? ""]);
    map.setLayoutProperty("spatial-hover-building", "visibility", areaId === BUILDING ? "visible" : "none");
  }

  updated(changed: PropertyValues<this>) {
    // MapLibre fixes interactivity at creation, so a new option rebuilds the map.
    if (changed.has("floor") && this._started) this._stop();
    const previous = changed.get("hass") as Hass | undefined;
    if (previous && this.hass) {
      // Home Assistant hands over a new themes object only when the theme changes.
      if (previous.themes !== this.hass.themes) this._repaint();
      const unitsChanged = previous.config !== this.hass.config || previous.locale !== this.hass.locale;
      if (previous.areas !== this.hass.areas || unitsChanged) this._showLabels();
      if (previous.floors !== this.hass.floors) this._showFloorLabels();
    }
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
    return `${this._darkMode} ${this._mapVisible}`;
  }

  // Resolves to undefined when a newer style was asked for in the meantime. A failed fetch
  // leaves the style key as it was, so the next update asks again.
  private async _loadStyle(): Promise<StyleSpecification | undefined> {
    const key = this._wantedStyleKey();
    this._pendingStyleKey = key;
    const darkMode = this._darkMode;
    try {
      const style = this._mapVisible
        ? await loadStyle(darkMode)
        : plainStyle(this._groundColour());
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
    this._labels?.destroy();
    this._labels = undefined;
    this._floorLabels?.destroy();
    this._floorLabels = undefined;
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
    this._state.floor = this.floor ?? "all";
    await this._refreshToken();
    if (stopped()) return;
    this._tokenTimer = setInterval(this._keepToken, TOKEN_REFRESH_MS);
    hass.connection.addEventListener("ready", this._keepToken);

    const loadAreas = async () => {
      const site = await this._state.load(hass.connection, editor);
      this._map?.getSource<GeoJSONSource>("areas")?.setData(this._state.areas);
      this._map?.getSource<GeoJSONSource>("outline")?.setData(this._state.outline);
      this._buildStack();
      this._showLabels();
      return site;
    };
    const editor = this.card
      ? undefined
      : new RoomEditor(hass.connection, {
          requestUpdate: () => this.requestUpdate(),
          reloadRooms: async () => {
            await loadAreas();
          },
          siteBearing: () => this._state.axisDeg,
          siteFrame: () => this._state.frame,
          units: () => this.hass!,
          selectTool: (tool) => this._selectTool(tool),
          toast: (toast) => this._toast(toast),
          buildingName: () => this._buildingName(),
          // Renaming writes Home Assistant's core config, which only an admin may change.
          canRenameBuilding: () => this.hass?.user?.is_admin === true,
          hideLabels: (areaIds) => this._labels?.hide(areaIds),
        });
    this._editor = editor;
    const site = await loadAreas();
    if (stopped()) return;
    // Only a new bearing is applied; re-centring would move the camera while
    // the user looks around. A static map has no user, so it frames again.
    const onUpdate = async () => {
      const { bearing_deg } = await loadAreas();
      if (this.floor) {
        this._state.bearing = bearing_deg;
        this._fit();
        return;
      }
      if (bearing_deg === this._state.bearing) return;
      this._state.bearing = bearing_deg;
      this._map?.setBearing(this._viewBearing());
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

    this._state.bearing = site.bearing_deg;
    const style = await this._loadStyle();
    if (stopped() || !style) return;
    setWorkerUrl(workerUrl(import.meta.url));
    this._mapBearingDeg = this._viewBearing();
    const map = new MapLibreMap({
      container: this.renderRoot.querySelector<HTMLElement>("#map")!,
      style,
      transformRequest: (url) => withMapTilesToken(url, location.origin, this._token),
      center: [site.lon, site.lat],
      zoom: 19,
      pitch: this._state.floor === "all" ? VIEW_PITCH_DEG : 0,
      bearing: this._mapBearingDeg,
      interactive: !this.floor,
      // A dashboard scrolls under the card, so the card neither turns nor tilts; the panel's All view may orbit.
      dragRotate: !this.card,
      touchPitch: !this.card,
    });
    if (this.card) map.touchZoomRotate.disableRotation();
    this._map = map;
    this._labels = new RoomLabels(map, !this.card, () => this.hass!, () => this._buildingName());
    this._floorLabels = new FloorLabels(map);
    this._showLabels();
    this._showFloorLabels();
    map.on("style.load", () => this._addAreas());
    map.on("mousemove", (event) => {
      this._previewWall(event);
      this._pointAt(event);
    });
    map.on("mouseout", () => this._hover(undefined));
    if (editor) {
      this._showBearing(this._mapBearingDeg);
      map.on("rotate", () => this._showBearing(map.getBearing()));
    }
    editor?.attach(map);
    // After the editor, so the click that ends Align is not also a room pick in Select.
    map.on("click", (event) => {
      this._pick(event);
      this._pointAt(event);
    });
    if (this.floor || this._state.floor === "all") this._fit();
  }

  private _showBearing(bearingDeg: number) {
    this._mapBearingDeg = bearingDeg;
    const stack = this.renderRoot.querySelector<HTMLElement & { bearing: number }>("spatial-map-stack");
    if (stack) stack.bearing = bearingDeg;
  }

  // Frames the rooms in view: all floors from the front corner, one floor with the picked wall horizontal.
  private _fit() {
    if (this._state.floor === "all") {
      this._viewStack(false);
      return;
    }
    const box = bounds(this._state.roomsInView());
    if (box) {
      this._map?.fitBounds(box, { bearing: mapBearing(this._state.axisDeg), padding: 16, animate: false });
    }
  }

  // All floors look at the house from its front corner; one floor keeps the picked wall horizontal.
  private _viewBearing() {
    return mapBearing(this._state.axisDeg + (this._state.floor === "all" ? VIEW_TURN_DEG : 0));
  }

  private _buildStack() {
    const frame = this._state.frame;
    if (!frame) return;
    const rooms = this._state.areas.features as Feature<Polygon>[];
    const levels = new Map<string, number | null>();
    for (const room of rooms) levels.set(room.properties?.floor_id, room.properties?.level ?? null);
    const levelOf = (floorId: string) =>
      this._editor?.floors.find((entry) => entry.floor_id === floorId)?.level ??
      this.hass?.floors?.[floorId]?.level ??
      levels.get(floorId) ??
      null;
    const outline = this._state.outline.type === "Polygon" ? this._state.outline : undefined;
    this._stack = floorStack(rooms, outline, stackFloors(rooms, levelOf), frame);
    this._map?.getSource<GeoJSONSource>("stack")?.setData(this._stack.features);
    this._showFloorLabels();
  }

  // Each slab is named while All is on screen.
  private _showFloorLabels() {
    const slabs = this._state.floor === "all" ? (this._stack?.slabs ?? []) : [];
    this._floorLabels?.show(slabs, this._state.frame, (floorId) => this._floorName(floorId));
  }

  // The whole stack in view from the front corner, clear of the floating controls and the floor labels.
  private _viewStack(animate: boolean) {
    const map = this._map;
    const frame = this._state.frame;
    if (!map || !frame || !this._stack) return;
    const container = map.getContainer();
    const screen = { width: container.clientWidth, height: container.clientHeight, fovDeg: map.getVerticalFieldOfView() };
    const camera = stackView(this._stack, frame, this._state.axisDeg, screen, this._freeSpace());
    if (!camera) return;
    if (animate) map.easeTo(camera);
    else map.jumpTo(camera);
  }

  // Custom: what the controls floating over the map take from each side, and room for the floor labels on the right.
  private _freeSpace() {
    const stage = this.renderRoot.querySelector(".stage")?.getBoundingClientRect();
    const covers = (selector: string) => this.renderRoot.querySelector(selector)?.getBoundingClientRect();
    if (!stage) return { top: 0, right: 0, bottom: 0, left: 0 };
    const top = covers(".top");
    const strip = covers(".strip");
    // A phone's round map toggle sits at the top, above the labels.
    const controls = covers(".map-stack:not([round])");
    const labels = this._floorLabels?.width ?? 0;
    return {
      top: top && top.height ? top.bottom - stage.top : 0,
      right: labels + (controls && controls.width ? stage.right - controls.left : 0),
      bottom: strip && strip.height ? stage.bottom - strip.top : 0,
      left: 0,
    };
  }

  // "All" stacks the floors as slabs; one floor is a flat plan with room outlines.
  private _addAreas() {
    const map = this._map!;
    const colours = layerColours(this._readPaint());
    map.addSource("stack", { type: "geojson", data: this._stack?.features ?? EMPTY });
    for (const [id, kind, opacity, translate] of STACK_LAYERS) {
      map.addLayer({
        id,
        type: "fill-extrusion",
        source: "stack",
        filter: ["==", ["get", "kind"], kind],
        paint: {
          ...colours[id],
          "fill-extrusion-base": ["get", "base_m"],
          "fill-extrusion-height": ["get", "top_m"],
          "fill-extrusion-opacity": opacity,
          "fill-extrusion-translate": translate,
          "fill-extrusion-translate-anchor": "viewport",
        },
      });
    }
    map.addSource("areas", { type: "geojson", data: this._state.areas });
    map.addLayer({ id: "areas-2d", type: "fill", source: "areas", paint: colours["areas-2d"] });
    map.addLayer({
      id: "areas-outline",
      type: "line",
      source: "areas",
      paint: { ...colours["areas-outline"], "line-width": 1.5 },
    });
    if (this._editor) {
      map.addLayer({
        id: "spatial-hover",
        type: "line",
        source: "areas",
        filter: ["==", ["get", "area_id"], this._hovered ?? ""],
        paint: { ...colours["spatial-hover"], "line-width": 2 },
      });
    }
    map.addSource("outline", { type: "geojson", data: this._state.outline });
    map.addLayer({
      id: "spatial-outline",
      type: "line",
      source: "outline",
      paint: { ...colours["spatial-outline"], "line-width": 2 },
    });
    if (this._editor) {
      map.addLayer({
        id: "spatial-hover-building",
        type: "line",
        source: "outline",
        layout: { visibility: this._hovered === BUILDING ? "visible" : "none" },
        paint: { ...colours["spatial-hover-building"], "line-width": 2 },
      });
    }
    map.addSource("spatial-wall", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "spatial-wall",
      type: "line",
      source: "spatial-wall",
      paint: { ...colours["spatial-wall"], "line-width": 4 },
    });
    this._editor?.addLayers(map, colours);
    this._applyFloor();
  }

  private _groundColour(): string {
    return (
      getComputedStyle(this).getPropertyValue("--primary-background-color").trim() ||
      (this._darkMode ? "#111111" : "#fafafa")
    );
  }

  private _readPaint(): MapPaint {
    return readMapPaint(this, this._darkMode);
  }

  // A new primary colour repaints the rooms; dark mode also reloads the style, which adds them again.
  // Home Assistant may set the theme's variables after handing over `hass`, so they are read a frame later.
  private _repaint() {
    requestAnimationFrame(() => {
      if (!this._map?.getLayer("areas-2d") || !this.hass) return;
      repaint(this._map, this._readPaint());
      // Without the map the ground is the page colour, which a theme in the same mode changes too.
      if (this._map.getLayer("ground")) this._map.setPaintProperty("ground", "background-color", this._groundColour());
    });
  }

  private _buildingName() {
    return this.hass?.config.location_name || "Building";
  }

  // Labels name the rooms of one floor; the 3D view of all floors has none.
  private _showLabels() {
    if (!this._labels) return;
    const onFloor = this._state.floor !== "all";
    const rooms = onFloor ? this._state.roomsInView() : [];
    const outline = onFloor && this._state.outline.type === "Polygon" ? this._state.outline : undefined;
    this._labels.show(rooms, outline, this.hass?.areas ?? {});
  }

  private _pointAt(event: MapMouseEvent) {
    if (!this._map?.getLayer("areas-2d")) return;
    const [room] = this._map.queryRenderedFeatures(event.point, { layers: ["areas-2d"] });
    this._hover(room?.properties?.area_id === undefined ? undefined : String(room.properties.area_id));
  }

  // The panel lists every registered floor, so an empty one can be drawn; the card only those with rooms.
  private _floorChoices(): FloorChoice[] {
    if (this.floor) return [];
    const floors: Floor[] = this._editor
      ? ["all", ...this._editor.floors.map((entry) => entry.floor_id), null]
      : ["all", ...(this._state.floorsWithRooms ?? [])];
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
  // Draw keeps this view, so it is safe there too. In All it returns to the view from the front corner.
  private _faceSite() {
    if (this._state.floor === "all") this._viewStack(true);
    else this._map?.easeTo({ bearing: mapBearing(this._state.axisDeg) });
  }

  private _selectTool(tool: Tool) {
    const editor = this._editor;
    if (!editor || editor.tool === tool) return;
    if (editor.tool === "align") this._showWall();
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

  // One tap sets the site axis from the wall of the building nearest to it, and goes back to Select.
  // The camera turns in place around the click, so the building stays in view. It turns before
  // the save, because Home Assistant sends the update event ahead of the reply.
  private _pick(event: MapMouseEvent) {
    if (!this._aligning) return;
    const building = this._buildingUnder(event);
    this._selectTool("select");
    if (!building) {
      this._toast({ message: "No building here" });
      return;
    }
    const at: Position = [event.lngLat.lng, event.lngLat.lat];
    const fields = alignFields(building, at, this._editor?.hasShapes ?? false);
    // The picked wall lies low in the view with the building above it, its outside facing the viewer.
    const wallBelowCentre = (this._map?.getContainer().clientHeight ?? 0) * WALL_OFFSET_SHARE;
    this._map?.easeTo({ bearing: mapBearing(fields.bearing_deg), center: event.lngLat, offset: [0, wallBelowCentre] });
    this._saveBearing(fields, this._state.bearing);
  }

  // A failed save turns the view back. A refusal shows Spatial's reason, as trying again would not
  // help; otherwise Retry turns the view to the picked wall again and saves the same fields once more.
  private _saveBearing(fields: AlignFields, previousBearing: number | null) {
    const newBearing = fields.bearing_deg;
    this._state.bearing = newBearing;
    this.hass!.connection.sendMessagePromise({ type: "spatial/site/update", ...fields }).catch((err) => {
      console.error(err);
      this._state.bearing = previousBearing;
      this._map?.easeTo({ bearing: mapBearing(this._state.axisDeg) });
      if (typeof err?.code === "string" && typeof err.message === "string" && !isStillStarting(err)) {
        this._toast({ message: err.message });
        return;
      }
      const retry = () => {
        this._map?.easeTo({ bearing: mapBearing(newBearing) });
        this._saveBearing(fields, previousBearing);
      };
      this._toast({ message: saveFailureMessage(err), action: { text: "Retry", action: retry }, duration: -1, dismissable: true });
    });
  }

  private _applyFloor() {
    const map = this._map!;
    const flat = this._state.floor !== "all";
    for (const [id] of STACK_LAYERS) map.setLayoutProperty(id, "visibility", flat ? "none" : "visible");
    // The slabs carry the outline in All; on the ground it would cross them.
    map.setLayoutProperty("spatial-outline", "visibility", flat ? "visible" : "none");
    for (const id of ["areas-2d", "areas-outline"]) {
      map.setLayoutProperty(id, "visibility", flat ? "visible" : "none");
      map.setFilter(id, flat ? ["==", ["get", "floor_id"], this._state.floor] : null);
    }
  }

  private _show(floor: Floor) {
    const previous = this._state.floor;
    if (floor === previous) return;
    // All is a view only; Align would stay pressed on a disabled toolbar.
    if (floor === "all" && this._aligning) this._selectTool("select");
    this._state.floor = floor;
    this._editor?.setFloor(floor);
    this._showLabels();
    this._showFloorLabels();
    // Before the style has loaded, `_addAreas` applies the floor.
    if (this._map?.getLayer("stack-slabs")) this._applyFloor();
    // Drawing needs the plan flat with the picked wall horizontal again.
    if (floor === "all") this._viewStack(true);
    else if (previous === "all") this._map?.easeTo({ pitch: 0, bearing: mapBearing(this._state.axisDeg) });
  }
}

customElements.define("spatial-panel", SpatialPanel);
