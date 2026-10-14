import type { FeatureCollection } from "geojson";
import { LitElement, css, html, nothing } from "lit";
import {
  type GeoJSONSource,
  Map as MapLibreMap,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
import { floors, mapBearing, styleUrl, withMapTilesToken } from "./map-view";

// The parts of Home Assistant's `hass` object this panel uses.
interface Hass {
  connection: {
    sendMessagePromise<T>(message: { type: string }): Promise<T>;
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
}

// Core rotates the map tiles token every 30 minutes and keeps two live; this
// is the interval Home Assistant's own frontend refreshes at.
const TOKEN_REFRESH_MS = 20 * 60 * 1000;

const loadStyle = async (darkMode: boolean): Promise<StyleSpecification> => {
  const style = await (await fetch(styleUrl(darkMode))).json();
  // The shipped style is root-relative; MapLibre needs absolute sprite and
  // glyph URLs. Glyphs are concatenated so `{fontstack}` is not encoded.
  style.sprite = style.sprite.map((s: { url: string }) => ({
    ...s,
    url: new URL(s.url, location.origin).href,
  }));
  style.glyphs = location.origin + style.glyphs;
  return style;
};

class SpatialPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    panel: { attribute: false },
    _floors: { state: true },
    _floor: { state: true },
    _failed: { state: true },
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
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 8px;
    }
    #map {
      flex: 1;
    }
  `;

  // `declare` keeps class fields from shadowing Lit's accessors.
  declare hass: Hass | undefined;
  declare narrow: boolean;
  declare panel: object | undefined;
  declare _floors: (string | null)[] | undefined;
  declare _floor: Floor;
  declare _failed: boolean;

  private _map?: MapLibreMap;
  private _started = false;
  // Bumped on disconnect, so a startup still awaiting creates nothing.
  private _run = 0;
  private _darkMode = false;
  private _token = "";
  private _bearing = 0;
  private _timer?: ReturnType<typeof setInterval>;
  private _unsubscribe?: () => Promise<void>;
  private _areas: FeatureCollection = { type: "FeatureCollection", features: [] };

  constructor() {
    super();
    this.narrow = false;
    this._floor = "all";
  }

  render() {
    return html`
      <link rel="stylesheet" href="/static/map/maplibre-gl.css" />
      <div class="bar">
        <ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button>
        ${(["all", ...(this._floors ?? [])] as Floor[]).map(
          (floor) => html`
            <button ?disabled=${floor === this._floor} @click=${() => this._show(floor)}>
              ${floor === "all"
                ? "All"
                : floor === null
                  ? "No floor"
                  : (this.hass?.floors?.[floor]?.name ?? floor)}
            </button>
          `,
        )}
        ${this._floors?.length === 0 ? html`<span>No rooms yet</span>` : nothing}
        ${this._failed ? html`<span>Map could not load</span>` : nothing}
      </div>
      <div id="map"></div>
    `;
  }

  updated() {
    if (!this.hass) return;
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
    this._run++;
    this.hass?.connection.removeEventListener("ready", this._keepToken);
    clearInterval(this._timer);
    this._unsubscribe?.();
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
    const left = () => run !== this._run;
    const call = <T>(type: string) => hass.connection.sendMessagePromise<T>({ type });
    await this._refreshToken();
    if (left()) return;
    this._timer = setInterval(this._keepToken, TOKEN_REFRESH_MS);
    hass.connection.addEventListener("ready", this._keepToken);

    const loadAreas = async () => {
      this._areas = await call<FeatureCollection>("spatial/geojson");
      this._floors = floors(this._areas);
      this._map?.getSource<GeoJSONSource>("areas")?.setData(this._areas);
    };
    await loadAreas();
    if (left()) return;
    // Only a new bearing is applied; re-centring would move the camera while
    // the user looks around.
    const onUpdate = async () => {
      await loadAreas();
      const { bearing_deg } = await call<Site>("spatial/site");
      if (bearing_deg === this._bearing) return;
      this._bearing = bearing_deg;
      this._map?.setBearing(mapBearing(bearing_deg));
    };
    const unsubscribe = await hass.connection.subscribeEvents(onUpdate, "spatial_updated");
    if (left()) {
      unsubscribe();
      return;
    }
    this._unsubscribe = unsubscribe;

    const site = await call<Site>("spatial/site");
    this._bearing = site.bearing_deg;
    this._darkMode = hass.themes.darkMode;
    const style = await loadStyle(this._darkMode);
    if (left()) return;
    setWorkerUrl("/spatial_static/maplibre-gl-worker.mjs");
    this._map = new MapLibreMap({
      container: this.renderRoot.querySelector<HTMLElement>("#map")!,
      style,
      transformRequest: (url) => withMapTilesToken(url, location.origin, this._token),
      center: [site.lon, site.lat],
      zoom: 19,
      pitch: 50,
      bearing: mapBearing(site.bearing_deg),
    });
    this._map.on("style.load", () => this._addAreas());
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
        "fill-extrusion-base": ["get", "base_height"],
        "fill-extrusion-height": ["get", "height"],
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
    this._applyFloor();
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
    // Before the style has loaded, `_addAreas` applies the floor.
    if (!this._map?.getLayer("areas-3d")) return;
    this._applyFloor();
    this._map.easeTo({ pitch: floor === "all" ? 50 : 0 });
  }
}

customElements.define("spatial-panel", SpatialPanel);
