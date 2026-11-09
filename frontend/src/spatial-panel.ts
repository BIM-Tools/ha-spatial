// The space editor panel; the dashboard card embeds it to show the rooms on the map.

import { lineString } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import polylabel from "polylabel";
import {
  type GeoJSONSource,
  type MapMouseEvent,
  Map as MapLibreMap,
  type PointLike,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
import { type Place, cameraFor, homeQuestion, homeUnknown } from "./address";
import "./address-search";
import "./editor-toolbar";
import {
  type FloorStack,
  FloorLabels,
  VIEW_PITCH_DEG,
  VIEW_TURN_DEG,
  floorLabelStyles,
  floorStack,
  metresForPixels,
  stackFloors,
  stackView,
} from "./floor-stack";
import type { Floor, FloorChoice } from "./floor-selector";
import "./floor-selector";
import "./map-stack";
import { type MapPaint, layerColours, readMapPaint, repaint } from "./map-paint";
import { type ThemeState, bounds, darkModeOf, mapBearing, styleUrl, withMapTilesToken, workerUrl } from "./map-view";
import { type AlignFields, type TileBuildings, alignFields, buildingAt, reachesUnreadTiles, wallAt } from "./outline";
import "./panel-header";
import type { MenuItem } from "./panel-header";
import { type Control, type Step, nextStep } from "./onboarding";
import { EMPTY, PanelState, alignPlace } from "./panel-state";
import { mapOutlineBox } from "./plan";
import type { PlanFrame } from "./site-frame";
import { BUILDING } from "./area-strip";
import { RoomEditor, type Toast, type Tool } from "./room-editor";
import { type AreaInfo, RoomLabels, roomLabelStyles } from "./room-labels";
import { floatingSurface, litControl, phoneBar } from "./styles";
import { type HassUnits, formatDistance, isStillStarting, saveFailureMessage } from "./units";

// The parts of Home Assistant's `hass` object this panel uses.
interface Hass extends HassUnits {
  // The location name is the building's name; without a home location the panel starts at the address search.
  config: HassUnits["config"] & { location_name: string; latitude?: number; longitude?: number };
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
  ["stack-slab-edges", "slab-edge", 1, [0, 0]],
  ["stack-rooms", "room", 1, [0, 0]],
  ["stack-room-edges", "edge", 1, [0, 0]],
];
const REGISTRY_EVENTS = ["area_registry_updated", "floor_registry_updated"];
const START_ZOOM = 19;
const PHONE_QUERY = "(max-width: 600px)";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const MAP_SHOWN_KEY = "spatial-show-map";
// The whole globe in view, for a home that is not known yet.
const GLOBE_CENTRE: [number, number] = [0, 20];
const GLOBE_ZOOM = 1.5;
// How closely the middle of a clicked home is found, in degrees: about 0.1 m.
const HOME_MIDDLE_PRECISION_DEG = 1e-6;
// A building is read at the point, then from the tiles under it, and once more for one that reaches a third tile.
const MAX_BUILDING_READS = 3;

const tileId = (tile: TileBuildings) => `${tile.z}/${tile.x}/${tile.y}`;

// The screen box around a polygon, to read the map tiles under all of it.
const screenBox = (map: MapLibreMap, shape: Polygon): [PointLike, PointLike] => {
  const points = shape.coordinates[0].map(([lng, lat]) => map.project([lng, lat]));
  const [xs, ys] = [points.map((p) => p.x), points.map((p) => p.y)];
  return [
    [Math.min(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.max(...ys)],
  ];
};

type HomeLocation = { latitude: number; longitude: number };

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
    // Set by the card's `show_map` option.
    showMap: { attribute: false },
    panel: { attribute: false },
    _failed: { state: true },
    _hovered: { state: true },
    _mapShown: { state: true },
    _phone: { state: true },
    _searchOpen: { state: true },
    _searched: { state: true },
    _homeClicked: { state: true },
    _buildingAtHome: { state: true },
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
    .guide .lines {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-width: 0;
    }
    .guide .text {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    /* Two lines of text and any answers, which wrap below the text when narrow. */
    .guide.two-lines {
      flex-wrap: wrap;
      max-width: 560px;
      border-radius: 24px;
      padding: var(--ha-space-2) var(--ha-space-2) var(--ha-space-2) var(--ha-space-4);
    }
    .guide.two-lines .text {
      font-weight: 500;
      white-space: normal;
    }
    .guide .detail {
      color: var(--secondary-text-color);
      font-size: var(--ha-font-size-s);
    }
    .guide .actions {
      display: flex;
      gap: var(--ha-space-1);
      margin-left: auto;
    }
    .guide button {
      height: 36px;
      padding: 0 14px;
      border: none;
      border-radius: 18px;
      background: none;
      color: var(--primary-text-color);
      font: inherit;
      font-weight: 500;
      white-space: nowrap;
      cursor: pointer;
    }
    .guide button.lit {
      ${litControl}
    }
    @media (pointer: coarse) {
      .guide button {
        height: 44px;
        border-radius: 22px;
      }
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
    /* On a phone the search card spans the width under the header. */
    spatial-address-search.sheet {
      ${phoneBar}
      position: absolute;
      top: 0;
      right: 0;
      left: 0;
      width: auto;
      border-bottom: 1px solid var(--divider-color);
    }
  `,
  ];

  // `declare` keeps class fields from shadowing Lit's accessors.
  declare hass: Hass | undefined;
  declare card: boolean;
  declare floor: string | undefined;
  declare showMap: boolean | undefined;
  declare panel: object | undefined;
  declare _failed: boolean;
  declare _hovered: string | undefined;
  declare _mapShown: boolean;
  declare _phone: boolean;
  declare _searchOpen: boolean;
  // The address search was used or closed in this visit, which ends the step that offers it.
  declare _searched: boolean;
  // A building was clicked as the home in this visit, since the last search pick; Align comes after it.
  declare _homeClicked: boolean;
  // Whether the map draws a building at Home Assistant's home, once it has shown the home before any Align.
  declare _buildingAtHome: boolean | undefined;

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
  // The map tiles' building that Align picked, or the one at the site origin; kept for this visit only.
  private _mapBuilding?: Polygon;
  private readonly _phoneQuery = window.matchMedia(PHONE_QUERY);
  // Set at start when there is no home and no plan: the map opens on the globe with the address search.
  private _globe = false;
  // Set once the panel has offered to move the home to a picked place, so a second search in this visit stays quiet.
  private _homeAsked = false;
  // The building clicked as the home in this visit, since the last search pick.
  private _clickedHome?: Polygon;
  // The place last picked from the address search in this visit, where the home is.
  private _picked?: [number, number];
  // From a pick until the camera has landed there.
  private _flying = false;
  // The map's building at the home, once read there.
  private _home?: { at: [number, number]; building: Polygon };

  constructor() {
    super();
    this.card = false;
    this._hovered = undefined;
    this._mapShown = readMapShown();
    this._phone = false;
    this._searchOpen = false;
    this._searched = false;
    this._homeClicked = false;
    this._buildingAtHome = undefined;
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

  // The card's show_map option; without it a card of all floors shows the slabs on plain ground and one of a floor keeps the map.
  private get _mapVisible() {
    if (this.card) return this.showMap ?? this.floor !== "all";
    return this._mapShown || this._aligning;
  }

  render() {
    const editor = this._editor;
    const phone = this._phone && !this.card;
    const step = this._step();
    const searching = this._searchOpen || step?.kind === "find";
    const lit = step?.lit === "align" || step?.lit === "draw" ? step.lit : undefined;
    return html`
      <link rel="stylesheet" href="/static/map/maplibre-gl.css" />
      ${this.card ? nothing : html`<spatial-panel-header ?narrow=${phone} .menu=${this._menu()}></spatial-panel-header>`}
      ${phone ? this._floorSelector(true) : nothing}
      <div class="stage ${editor && !phone ? "with-strip" : ""}">
        <div id="map"></div>
        <div class="top ${phone ? "phone" : ""}">
          ${phone ? nothing : this._floorSelector(false)}
          ${editor && !phone ? this._toolbar(editor, false, lit) : nothing}
          ${searching && !phone ? html`<div class="guide-row">${this._searchCard(false)}</div>` : this._guide(step)}
        </div>
        ${editor
          ? html`<spatial-map-stack
              class="map-stack"
              ?round=${phone}
              .mapShown=${this._mapShown}
              .mapForced=${this._aligning}
              .bearing=${this._mapBearingDeg}
              .aligned=${alignPlace(this._state.bearing) === "menu"}
              @map-toggle=${this._toggleMap}
              @zoom-in=${() => this._map?.zoomIn()}
              @zoom-out=${() => this._map?.zoomOut()}
              @compass=${this._faceSite}
              @address-search=${() => (this._searchOpen = true)}
            ></spatial-map-stack>`
          : nothing}
        ${editor && !phone ? html`<div class="strip" @area-hover=${this._hoverFromStrip}>${editor.render(this._hovered)}</div>` : nothing}
        ${searching && phone ? this._searchCard(true) : nothing}
      </div>
      ${editor && phone ? html`<div class="strip-bar" @area-hover=${this._hoverFromStrip}>${editor.render(this._hovered)}</div>` : nothing}
      ${editor && phone ? this._toolbar(editor, true, lit) : nothing}
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

  private _toolbar(editor: RoomEditor, bar: boolean, lit: Tool | undefined) {
    return html`<spatial-editor-toolbar
      class=${bar ? "" : "toolbar"}
      ?bar=${bar}
      ?disabled=${this._state.floor === "all"}
      ?align=${alignPlace(this._state.bearing) === "toolbar"}
      .lit=${lit}
      .tool=${editor.tool}
      .canUndo=${editor.canUndo}
      .canRedo=${editor.canRedo}
      .canRemove=${editor.canRemove}
      @tool-select=${(event: CustomEvent<{ tool: Tool }>) => this._selectTool(event.detail.tool)}
      @undo=${editor.undo}
      @redo=${editor.redo}
      @remove=${editor.removeActiveShape}
    ></spatial-editor-toolbar>`;
  }

  // Once the site has a direction, Align moves out of the toolbar into the header menu. Like the
  // tools both entries need a floor; on All, a view only, they are off. No floor is not a floor to
  // clear, so it keeps the plain, disabled entry.
  private _menu(): MenuItem[] {
    const editor = this._editor;
    if (!editor) return [];
    const floor = this._state.floor;
    const onAll = floor === "all";
    const floorName = this._floorName(floor);
    const clear = {
      label: onAll || floor === null ? "Clear floor" : `Clear ${floorName}`,
      disabled: !editor.canClear,
      action: () => editor.clearFloor(floorName),
    };
    if (alignPlace(this._state.bearing) !== "menu") return [clear];
    return [{ label: "Change alignment", disabled: onAll, action: () => this._selectTool("align") }, clear];
  }

  // The plan's one next step, from what the panel and the editor know now; the card has none, and none
  // is known before the site is read.
  private _step(): Step | undefined {
    const editor = this._editor;
    const bearing = this._state.bearing;
    if (!editor || bearing === undefined || !this.hass) return undefined;
    return nextStep({
      homeKnown: !homeUnknown(this.hass.config),
      buildingAtHome: this._buildingAtHome,
      searched: this._searched,
      homeClicked: this._homeClicked,
      aligned: bearing !== null,
      floor: this._state.floor,
      ...editor.plan((floor) => this._floorName(floor)),
    });
  }

  // One line at a time, and only when there is something to say; what went wrong first. The panel
  // says its step; the card only that it has no rooms.
  private _guide(step: Step | undefined) {
    const noRooms = this.card && this._state.hasNoRooms(this.floor);
    const line: Step | undefined = this._failed
      ? { kind: "done", text: "Map could not load" }
      : noRooms
        ? { kind: "done", text: "No rooms yet" }
        : step;
    if (!line?.text) return nothing;
    const buttons = line.buttons ?? [];
    return html`<div class="guide-row">
      <div class="guide ${line.detail || buttons.length ? "two-lines" : ""}" role="status">
        <span class="lines"
          ><span class="text">${line.text}</span>${line.detail ? html`<span class="detail">${line.detail}</span>` : nothing}</span
        >
        ${buttons.length
          ? html`<span class="actions">
              ${buttons.map(
                ({ control, label }) =>
                  html`<button class=${control === line.lit ? "lit" : ""} @click=${() => this._press(control, line)}>${label}</button>`,
              )}
            </span>`
          : nothing}
      </div>
    </div>`;
  }

  private _press(control: Control, step: Step) {
    const editor = this._editor;
    if (control === "use-outline") editor?.useMapOutline();
    else if (control === "draw-myself") editor?.drawOutlineMyself();
    else if (control === "looks-right") editor?.lengthChecked();
    else if (control === "next-floor" && step.floor !== undefined) this._show(step.floor);
  }

  private _searchCard(sheet: boolean) {
    return html`<spatial-address-search
      class=${sheet ? "sheet" : ""}
      .search=${this._searchAddress}
      @place-pick=${this._flyToPlace}
      @search-close=${this._closeSearch}
    ></spatial-address-search>`;
  }

  private _closeSearch = () => {
    this._searchOpen = false;
    this._searched = true;
  };

  private _searchAddress = async (query: string): Promise<Place[]> =>
    (await this.hass!.connection.sendMessagePromise<{ places: Place[] }>({ type: "spatial/address/search", query })).places;

  // The map goes to the picked place, whose building then shows dashed. Before any Align the user then
  // clicks the home's building, which asks about the home; on an aligned site the pick asks at once.
  private _flyToPlace = (event: CustomEvent<{ place: Place }>) => {
    this._closeSearch();
    this._picked = [event.detail.place.lon, event.detail.place.lat];
    this._homeClicked = false;
    this._clickedHome = undefined;
    const map = this._map;
    if (!map) return;
    this._flying = true;
    map.once("moveend", () => (this._flying = false));
    const camera = cameraFor(event.detail.place);
    if ("bounds" in camera) map.fitBounds(camera.bounds, { maxZoom: camera.maxZoom, bearing: map.getBearing(), padding: 48 });
    else map.flyTo({ center: camera.center, zoom: camera.zoom });
    if (this._state.bearing !== null && !this._homeAsked) {
      this._homeAsked = true;
      this._offerHome(event.detail.place);
    }
  };

  // While the home is to be clicked, before any Align and with Select on, buildings light up under the
  // pointer, and a click makes the building the home: it shows dashed, the home question is asked for
  // its middle, and Align becomes the step. Another click picks again.
  private get _clickingHome() {
    const kind = this._step()?.kind;
    return this._state.bearing === null && this._editor?.tool === "select" && (kind === "click-home" || kind === "align");
  }

  private _previewHome(event: MapMouseEvent) {
    if (!this._clickingHome) return;
    this._map?.getSource<GeoJSONSource>("spatial-wall")?.setData(this._buildingUnder(event) ?? EMPTY);
  }

  private _clickHome(event: MapMouseEvent) {
    if (!this._clickingHome || this._roomUnder(event)) return;
    const building = this._buildingUnder(event);
    if (!building) {
      this._toast({ message: "No building here" });
      return;
    }
    this._clickedHome = building;
    this._homeClicked = true;
    this._showHome();
    const [lon, lat] = polylabel(building.coordinates as [number, number][][], HOME_MIDDLE_PRECISION_DEG);
    this._offerHome({ lat, lon });
  }

  // Nothing is stored, so a later visit may ask again.
  private _offerHome(place: Pick<Place, "lat" | "lon">) {
    const config = this.hass!.config;
    const question = homeQuestion(config, place);
    if (!question) return;
    const back = { latitude: config.latitude ?? 0, longitude: config.longitude ?? 0 };
    const to = { latitude: place.lat, longitude: place.lon };
    this._toast({
      message:
        question.kind === "use"
          ? "Use this as Home Assistant's home?"
          : `Move Home Assistant's home here? The home pin is ${formatDistance(question.metres, this.hass!)} away`,
      action: { text: question.kind === "use" ? "Use as home" : "Move", action: () => this._moveHome(to, back) },
      // A question waits for its answer: Close means not now, and another pick's question replaces it.
      duration: -1,
      dismissable: true,
    });
  }

  private async _moveHome(to: HomeLocation, back: HomeLocation) {
    if (!(await this._writeHome(to))) return;
    this._toast({ message: "Home location moved", action: { text: "Undo", action: () => this._writeHome(back) } });
  }

  // Only latitude and longitude change; Home Assistant's core config keeps everything else.
  private async _writeHome(location: HomeLocation): Promise<boolean> {
    try {
      await this.hass!.connection.sendMessagePromise({ type: "config/core/update", ...location });
      return true;
    } catch (err) {
      this._toast({ message: saveFailureMessage(err) });
      return false;
    }
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
      // MapLibre's globe turns into the flat map as it zooms in, so a home found on it is drawn as always.
      return this._globe ? { ...style, projection: { type: "globe" } } : style;
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
      this._offerMapOutline();
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
    // A plan still being drawn opens on the floor of its next step, as the tools are off on All.
    const opening = this._step();
    if (opening?.floor !== undefined) this._show(opening.floor);
    const planDrawn = this._state.areas.features.length > 0 || this._state.outline.type === "Polygon";
    this._globe = Boolean(editor) && !planDrawn && homeUnknown(hass.config);
    const style = await this._loadStyle();
    if (stopped() || !style) return;
    setWorkerUrl(workerUrl(import.meta.url));
    this._mapBearingDeg = this._viewBearing();
    const map = new MapLibreMap({
      container: this.renderRoot.querySelector<HTMLElement>("#map")!,
      style,
      transformRequest: (url) => withMapTilesToken(url, location.origin, this._token),
      center: this._globe ? GLOBE_CENTRE : [site.lon, site.lat],
      zoom: this._globe ? GLOBE_ZOOM : START_ZOOM,
      pitch: this._state.floor === "all" && !this._globe ? VIEW_PITCH_DEG : 0,
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
    map.on("zoomend", () => {
      if (this._state.floor === "all") this._buildStack();
    });
    map.on("mousemove", (event) => {
      this._previewWall(event);
      this._previewHome(event);
      this._pointAt(event);
    });
    map.on("mouseout", () => this._hover(undefined));
    if (editor) {
      this._showBearing(this._mapBearingDeg);
      map.on("rotate", () => this._showBearing(map.getBearing()));
      // The map's buildings can be read once their tiles are drawn.
      map.on("idle", () => {
        this._offerMapOutline();
        this._lookForHome();
        this._showHome();
      });
    }
    editor?.attach(map);
    // After the editor, so the click that ends Align is not also a room pick in Select.
    map.on("click", (event) => {
      this._clickHome(event);
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

  // The edges are drawn as strips a pixel or so wide at this zoom, so they are built again after a zoom.
  private _buildStack(zoom = this._map?.getZoom() ?? START_ZOOM) {
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
    const pixelM = metresForPixels(1, zoom, frame.fromLattice([0, 0])[1]);
    this._stack = floorStack(rooms, outline, stackFloors(rooms, levelOf), frame, pixelM);
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
    this._buildStack(camera.zoom);
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
    if (this._editor) {
      map.addSource("spatial-home", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "spatial-home",
        type: "line",
        source: "spatial-home",
        paint: { ...colours["spatial-home"], "line-width": 2, "line-dasharray": [2, 1] },
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
      // A card lies on its own background, the panel on the page.
      getComputedStyle(this).getPropertyValue(this.card ? "--card-background-color" : "--primary-background-color").trim() ||
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
    this._hover(this._roomUnder(event));
  }

  private _roomUnder(event: MapMouseEvent): string | undefined {
    if (!this._map?.getLayer("areas-2d")) return undefined;
    const [room] = this._map.queryRenderedFeatures(event.point, { layers: ["areas-2d"] });
    return room?.properties?.area_id === undefined ? undefined : String(room.properties.area_id);
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
    return this._buildingAt([event.lngLat.lng, event.lngLat.lat], event.point);
  }

  // The ids of the style's layers that draw the map tiles' buildings; none while the map is hidden.
  private _buildingLayers(): string[] {
    return (this._map?.getStyle().layers ?? [])
      .filter((layer) => "source-layer" in layer && layer["source-layer"] === "buildings")
      .map((layer) => layer.id);
  }

  // The map tiles' building at `at`, on screen at `point`, when the map shows it there. MapLibre cuts the
  // source's tiles again into the tiles of the view's zoom, so a building is cut at those edges too; it is
  // read from each tile it reaches and joined. Only the finest tiles under the point count, so a coarser
  // tile standing in while finer ones load does not mix in.
  private _buildingAt(at: [number, number], point?: PointLike): Polygon | undefined {
    const map = this._map;
    const layers = this._buildingLayers();
    if (!map || !layers.length) return undefined;
    const read = (where: PointLike | [PointLike, PointLike]): TileBuildings[] =>
      map.queryRenderedFeatures(where, { layers }).map((feature) => ({
        z: feature._z,
        x: feature._x,
        y: feature._y,
        geometry: feature.geometry as Polygon | MultiPolygon,
      }));
    let tiles = read(point ?? map.project(at));
    const zoom = Math.max(...tiles.map((tile) => tile.z));
    let building = buildingAt(tiles, at, zoom);
    for (let reads = 1; building && reads < MAX_BUILDING_READS && reachesUnreadTiles(building, tiles, zoom); reads++) {
      const known = new Set(tiles.map(tileId));
      const more = read(screenBox(map, building)).filter((tile) => !known.has(tileId(tile)));
      if (!more.length) break;
      tiles = [...tiles, ...more];
      building = buildingAt(tiles, at, zoom);
    }
    return building;
  }

  // Before any Align, the first time the map has drawn its buildings around Home Assistant's home, it
  // tells whether one stands there; without one the address search is the next step. Not stored.
  private _lookForHome() {
    const map = this._map;
    const config = this.hass?.config;
    if (!map || !config || this._buildingAtHome !== undefined || this._state.bearing !== null || homeUnknown(config)) return;
    const home: [number, number] = [config.longitude!, config.latitude!];
    const { x, y } = map.project(home);
    const container = map.getContainer();
    const inView = x >= 0 && y >= 0 && x <= container.clientWidth && y <= container.clientHeight;
    if (!inView || !this._buildingLayers().length) return;
    this._buildingAtHome = Boolean(this._buildingAt(home));
  }

  // Until the site has a direction, the map's building where the home is shows dashed: at the picked
  // place, else at Home Assistant's home. It is read on an idle map once the camera has landed, and kept
  // until the home moves, so it does not change as the map loads more tiles. Never stored.
  private _showHome() {
    const source = this._map?.getSource<GeoJSONSource>("spatial-home");
    const config = this.hass?.config;
    if (!source || !config || this._flying) return;
    const home: [number, number] | undefined =
      this._picked ?? (homeUnknown(config) ? undefined : [config.longitude!, config.latitude!]);
    if (this._state.bearing !== null || !(home || this._clickedHome)) {
      source.setData(EMPTY);
      return;
    }
    if (this._clickedHome || !home) {
      source.setData(this._clickedHome ?? EMPTY);
      return;
    }
    if (this._home?.at[0] !== home[0] || this._home.at[1] !== home[1]) {
      const building = this._buildingAt(home);
      this._home = building && { at: home, building };
    }
    source.setData(this._home?.building ?? EMPTY);
  }

  // Align on an empty plan puts the origin at the left end of the picked wall, with the building
  // along the x-axis and to its left, so a point one grid step in on both axes lies inside it.
  private _buildingAtOrigin(frame: PlanFrame): Polygon | undefined {
    const [lon, lat] = frame.fromLattice([frame.unitsPerStep, frame.unitsPerStep]);
    return this._buildingAt([lon, lat]);
  }

  // The map's building offers its outline once the site frame follows the stored bearing and until
  // the Building has an outline; the editor decides where it shows. Nothing about it is stored.
  private _offerMapOutline() {
    const [editor, frame] = [this._editor, this._state.frame];
    if (!editor || !frame) return;
    const aligned = this._state.bearing !== null && frame.bearingDeg === this._state.bearing;
    if (aligned && this._state.outline.type !== "Polygon") this._mapBuilding ??= this._buildingAtOrigin(frame);
    editor.setMapOutline(aligned && this._mapBuilding ? mapOutlineBox(frame, this._mapBuilding) : undefined);
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
    // Its outline is offered once the new frame arrives.
    this._mapBuilding = building;
    const at: Position = [event.lngLat.lng, event.lngLat.lat];
    const fields = alignFields(building, at, this._editor?.hasShapes ?? false);
    // The picked wall lies low in the view with the building above it, its outside facing the viewer.
    const wallBelowCentre = (this._map?.getContainer().clientHeight ?? 0) * WALL_OFFSET_SHARE;
    this._map?.easeTo({ bearing: mapBearing(fields.bearing_deg), center: event.lngLat, offset: [0, wallBelowCentre] });
    this._saveBearing(fields, this._state.bearing ?? null);
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
