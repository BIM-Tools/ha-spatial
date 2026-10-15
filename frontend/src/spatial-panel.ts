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
import { bounds, floorsByLevel, mapBearing, styleUrl, withMapTilesToken } from "./map-view";
import { buildingAt, wallAt, wallBearingAt } from "./outline";
import { RoomEditor, type Tool } from "./room-editor";

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

// A floor_id, null for areas without a floor, or "all".
type Floor = string | null | "all";

interface Site {
  lon: number;
  lat: number;
  bearing_deg: number;
  outline: Polygon | null;
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const REGISTRY_EVENTS = ["area_registry_updated", "floor_registry_updated"];

// Core rotates the map tiles token every 30 minutes and keeps two live; this
// is the interval Home Assistant's own frontend refreshes at.
const TOKEN_REFRESH_MS = 20 * 60 * 1000;

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

class SpatialPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    // Set by the dashboard card.
    card: { type: Boolean },
    // Set by the card's `floor` option: a fixed, static view of "all" or one floor_id.
    floor: { attribute: false },
    panel: { attribute: false },
    _floors: { state: true },
    _floor: { state: true },
    _failed: { state: true },
    _picking: { state: true },
    _message: { state: true },
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
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 8px;
    }
    .bar button[aria-pressed="true"] {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
    }
    /* A static card has no buttons; a message still shows. */
    .bar:not(:has(*)) {
      display: none;
    }
    #map {
      flex: 1;
    }
  `;

  // `declare` keeps class fields from shadowing Lit's accessors.
  declare hass: Hass | undefined;
  declare narrow: boolean;
  declare card: boolean;
  declare floor: string | undefined;
  declare panel: object | undefined;
  declare _floors: (string | null)[] | undefined;
  declare _floor: Floor;
  declare _failed: boolean;
  declare _picking: boolean;
  declare _message: string;

  private _map?: MapLibreMap;
  private _started = false;
  // Bumped on disconnect, so a startup still awaiting creates nothing.
  private _run = 0;
  private _darkMode = false;
  private _token = "";
  private _bearing = 0;
  private _tokenTimer?: ReturnType<typeof setInterval>;
  private _unsubscribe?: () => void;
  private _areas: FeatureCollection = EMPTY;
  private _outline: Polygon | FeatureCollection = EMPTY;
  // Only the admin panel edits; the card stays read-only.
  private _editor?: RoomEditor;

  constructor() {
    super();
    this.narrow = false;
    this.card = false;
    this._floor = "all";
    this._picking = false;
    this._message = "";
  }

  render() {
    return html`
      <link rel="stylesheet" href="/static/map/maplibre-gl.css" />
      <div class="bar">
        ${this.card
          ? nothing
          : html`<ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button>`}
        ${this._floorButtons().map(
          (floor) => html`
            <button ?disabled=${floor === this._floor} @click=${() => this._show(floor)}>
              ${floor === "all"
                ? "All"
                : floor === null
                  ? "No floor"
                  : (this._editor?.floors.find((entry) => entry.floor_id === floor)?.name ??
                    this.hass?.floors?.[floor]?.name ??
                    floor)}
            </button>
          `,
        )}
        ${this._floors &&
        (this.floor && this.floor !== "all"
          ? !this._floors.includes(this.floor)
          : this._floors.length === 0)
          ? html`<span>No rooms yet</span>`
          : nothing}
        ${this._editor
          ? html`<button aria-pressed=${this._editor.tool === "draw"} @click=${() => this._toggleTool("draw")}>
                Draw
              </button>
              <button aria-pressed=${this._editor.tool === "adjust"} @click=${() => this._toggleTool("adjust")}>
                Adjust
              </button>
              <button ?disabled=${!this._editor.canUndo} @click=${this._editor.undo}>Undo</button>
              <button ?disabled=${!this._editor.canRedo} @click=${this._editor.redo}>Redo</button>`
          : nothing}
        ${this.card
          ? nothing
          : html`<button aria-pressed=${this._picking} @click=${this._toggleAlign}>Align</button>`}
        ${this._picking ? html`<span>Click your house near the wall the rooms follow</span>` : nothing}
        ${this._message ? html`<span>${this._message}</span>` : nothing}
        ${this._editor?.status ? html`<span>${this._editor.status}</span>` : nothing}
        ${this._failed ? html`<span>Map could not load</span>` : nothing}
      </div>
      ${this._editor?.render() ?? nothing}
      <div id="map"></div>
    `;
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has("_picking") && !this._picking) this._showWall();
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
    } else if (this._map && this.hass.themes.darkMode !== this._darkMode) {
      this._darkMode = this.hass.themes.darkMode;
      // A full reload fires `style.load`, which adds the rooms again.
      loadStyle(this._darkMode).then((style) => this._map?.setStyle(style, { diff: false }));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stop();
  }

  private _stop() {
    this._run++;
    this.hass?.connection.removeEventListener("ready", this._keepToken);
    clearInterval(this._tokenTimer);
    this._unsubscribe?.();
    this._picking = false;
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
      : new RoomEditor(hass.connection, () => this.requestUpdate(), loadAreas, () => this._bearing);
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
      this._map?.setBearing(mapBearing(bearing_deg));
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
    this._darkMode = hass.themes.darkMode;
    const style = await loadStyle(this._darkMode);
    if (stopped()) return;
    setWorkerUrl("/spatial_static/maplibre-gl-worker.mjs");
    this._map = new MapLibreMap({
      container: this.renderRoot.querySelector<HTMLElement>("#map")!,
      style,
      transformRequest: (url) => withMapTilesToken(url, location.origin, this._token),
      center: [site.lon, site.lat],
      zoom: 19,
      pitch: this._floor === "all" ? 50 : 0,
      bearing: mapBearing(site.bearing_deg),
      interactive: !this.floor,
    });
    this._map.on("style.load", () => this._addAreas());
    this._map.on("click", (event) => this._pick(event));
    this._map.on("mousemove", (event) => this._previewWall(event));
    editor?.attach(this._map);
    if (this.floor) this._fit();
  }

  // Frames the rooms in view, keeping the picked wall horizontal.
  private _fit() {
    const box = bounds(
      this._areas.features.filter(
        (f) => this._floor === "all" || f.properties?.floor_id === this._floor,
      ),
    );
    if (box) {
      this._map?.fitBounds(box, { bearing: mapBearing(this._bearing), padding: 16, animate: false });
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
  private _floorButtons(): Floor[] {
    if (this.floor) return [];
    if (this._editor) return ["all", ...this._editor.floors.map((entry) => entry.floor_id), null];
    return ["all", ...(this._floors ?? [])];
  }

  private _toggleTool(tool: Tool) {
    this._picking = false;
    this._message = "";
    this._editor?.setTool(this._editor.tool === tool ? undefined : tool);
  }

  private _toggleAlign() {
    this._picking = !this._picking;
    this._message = "";
    this._editor?.setTool(undefined);
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
    if (!this._picking) return;
    const building = this._buildingUnder(event);
    this._showWall(building && wallAt(building, [event.lngLat.lng, event.lngLat.lat]));
  }

  // One tap sets the site axis from the wall of the building nearest to it, and ends the mode.
  // The camera turns in place around the click, so the building stays in view. It turns before
  // the save, because Home Assistant sends the update event ahead of the reply.
  private _pick(event: MapMouseEvent) {
    if (!this._picking) return;
    this._picking = false;
    const building = this._buildingUnder(event);
    if (!building) {
      this._message = "No building here";
      return;
    }
    const previousBearing = this._bearing;
    const newBearing = wallBearingAt(building, [event.lngLat.lng, event.lngLat.lat]);
    this._bearing = newBearing;
    this._map?.easeTo({ bearing: mapBearing(newBearing), center: event.lngLat });
    this.hass!.connection.sendMessagePromise({ type: "spatial/site/update", bearing_deg: newBearing }).then(
      () => {
        this._message = "";
      },
      (err) => {
        console.error(err);
        this._message = "Could not save";
        this._bearing = previousBearing;
        this._map?.easeTo({ bearing: mapBearing(previousBearing) });
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
    this._floor = floor;
    this._editor?.setFloor(floor);
    // Before the style has loaded, `_addAreas` applies the floor.
    if (!this._map?.getLayer("areas-3d")) return;
    this._applyFloor();
    this._map.easeTo({ pitch: floor === "all" ? 50 : 0 });
  }
}

customElements.define("spatial-panel", SpatialPanel);
