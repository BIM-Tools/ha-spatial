import type { FeatureCollection } from "geojson";
import { LitElement, css, html, nothing } from "lit";
import {
  type GeoJSONSource,
  Map as MapLibreMap,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
import { levels, mapBearing, styleUrl, withMapTilesToken } from "./map-view";

// The parts of Home Assistant's `hass` object this panel uses.
interface Hass {
  connection: {
    sendMessagePromise<T>(message: { type: string }): Promise<T>;
    subscribeEvents(callback: () => void, eventType: string): Promise<() => Promise<void>>;
  };
  themes: { darkMode: boolean };
}

type Level = number | null | "all";

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
    _levels: { state: true },
    _level: { state: true },
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
  declare _levels: (number | null)[] | undefined;
  declare _level: Level;

  private _map?: MapLibreMap;
  private _started = false;
  private _darkMode = false;
  private _token = "";
  private _timer?: ReturnType<typeof setInterval>;
  private _unsubscribe?: () => Promise<void>;
  private _areas: FeatureCollection = { type: "FeatureCollection", features: [] };

  constructor() {
    super();
    this.narrow = false;
    this._level = "all";
  }

  render() {
    return html`
      <link rel="stylesheet" href="/static/map/maplibre-gl.css" />
      <div class="bar">
        <ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button>
        ${(["all", ...(this._levels ?? [])] as Level[]).map(
          (level) => html`
            <button ?disabled=${level === this._level} @click=${() => this._show(level)}>
              ${level === "all" ? "All" : level === null ? "No floor" : `Level ${level}`}
            </button>
          `,
        )}
        ${this._levels?.length === 0 ? html`<span>No rooms yet</span>` : nothing}
      </div>
      <div id="map"></div>
    `;
  }

  updated() {
    if (!this.hass) return;
    if (!this._started) {
      this._started = true;
      this._start(this.hass);
    } else if (this._map && this.hass.themes.darkMode !== this._darkMode) {
      this._darkMode = this.hass.themes.darkMode;
      // A full reload fires `style.load`, which adds the rooms again.
      loadStyle(this._darkMode).then((style) => this._map?.setStyle(style, { diff: false }));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this._timer);
    this._unsubscribe?.();
    this._map?.remove();
    this._map = undefined;
    this._started = false;
  }

  private async _start(hass: Hass) {
    const call = <T>(type: string) => hass.connection.sendMessagePromise<T>({ type });
    const refreshToken = async () => {
      this._token = (await call<{ token: string }>("map_tiles/access_token")).token;
    };
    await refreshToken();
    // On failure the current token stays; the next interval retries.
    this._timer = setInterval(() => refreshToken().catch(() => {}), TOKEN_REFRESH_MS);

    const loadAreas = async () => {
      this._areas = await call<FeatureCollection>("spatial/geojson");
      this._levels = levels(this._areas);
      this._map?.getSource<GeoJSONSource>("areas")?.setData(this._areas);
    };
    await loadAreas();
    this._unsubscribe = await hass.connection.subscribeEvents(loadAreas, "spatial_updated");

    const site = await call<{ lon: number; lat: number; bearing_deg: number }>("spatial/site");
    this._darkMode = hass.themes.darkMode;
    setWorkerUrl("/spatial_static/maplibre-gl-worker.mjs");
    this._map = new MapLibreMap({
      container: this.renderRoot.querySelector<HTMLElement>("#map")!,
      style: await loadStyle(this._darkMode),
      transformRequest: (url) => withMapTilesToken(url, location.origin, this._token),
      center: [site.lon, site.lat],
      zoom: 19,
      pitch: 50,
      bearing: mapBearing(site.bearing_deg),
    });
    this._map.on("style.load", () => this._addAreas());
  }

  // "All" stacks the floors in 3D; one level is a flat plan with room outlines.
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
    this._applyLevel();
  }

  private _applyLevel() {
    const map = this._map!;
    const flat = this._level !== "all";
    map.setLayoutProperty("areas-3d", "visibility", flat ? "none" : "visible");
    for (const id of ["areas-2d", "areas-outline"]) {
      map.setLayoutProperty(id, "visibility", flat ? "visible" : "none");
      map.setFilter(id, flat ? ["==", ["get", "level"], this._level] : null);
    }
  }

  private _show(level: Level) {
    this._level = level;
    // Before the style has loaded, `_addAreas` applies the level.
    if (!this._map?.getLayer("areas-3d")) return;
    this._applyLevel();
    this._map.easeTo({ pitch: level === "all" ? 50 : 0 });
  }
}

customElements.define("spatial-panel", SpatialPanel);
