import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import {
  type GeoJSONSource,
  type MapMouseEvent,
  Map as MapLibreMap,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
import { bounds, floors, mapBearing, styleUrl, withMapTilesToken } from "./map-view";
import { alignOutline, buildingAt } from "./outline";

// The parts of Home Assistant's `hass` object this panel uses.
interface Hass {
  connection: {
    sendMessagePromise<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
    subscribeMessage(callback: () => void, message: { type: string }): Promise<() => Promise<void>>;
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
  private _timer?: ReturnType<typeof setInterval>;
  private _unsubscribe?: () => Promise<void>;
  private _areas: FeatureCollection = EMPTY;
  private _outline: Polygon | FeatureCollection = EMPTY;

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
        ${(this.floor ? [] : (["all", ...(this._floors ?? [])] as Floor[])).map(
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
        ${this._floors &&
        (this.floor && this.floor !== "all"
          ? !this._floors.includes(this.floor)
          : this._floors.length === 0)
          ? html`<span>No rooms yet</span>`
          : nothing}
        ${this.card
          ? nothing
          : html`<button ?disabled=${this._picking} @click=${this._startPicking}>Building</button>`}
        ${this._picking ? html`<span>Click a building near the wall to align with</span>` : nothing}
        ${this._message ? html`<span>${this._message}</span>` : nothing}
        ${this._failed ? html`<span>Map could not load</span>` : nothing}
      </div>
      <div id="map"></div>
    `;
  }

  updated(changed: PropertyValues<this>) {
    // MapLibre fixes interactivity at creation, so a new option rebuilds the map.
    if (changed.has("floor") && this._started) this._stop();
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
    this._stop();
  }

  private _stop() {
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
    this._floor = this.floor ?? "all";
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
    // the user looks around. A static map has no user, so it frames again.
    const onUpdate = async () => {
      await loadAreas();
      const { bearing_deg, outline } = await call<Site>("spatial/site");
      this._showOutline(outline);
      if (this.floor) {
        this._bearing = bearing_deg;
        this._fit();
        return;
      }
      if (bearing_deg === this._bearing) return;
      this._bearing = bearing_deg;
      this._map?.setBearing(mapBearing(bearing_deg));
    };
    const unsubscribe = await hass.connection.subscribeMessage(onUpdate, {
      type: "spatial/subscribe",
    });
    if (left()) {
      unsubscribe();
      return;
    }
    this._unsubscribe = unsubscribe;

    const site = await call<Site>("spatial/site");
    this._bearing = site.bearing_deg;
    this._outline = site.outline ?? EMPTY;
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
      pitch: this._floor === "all" ? 50 : 0,
      bearing: mapBearing(site.bearing_deg),
      interactive: !this.floor,
    });
    this._map.on("style.load", () => this._addAreas());
    this._map.on("click", (event) => this._pick(event));
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
    map.addSource("outline", { type: "geojson", data: this._outline });
    map.addLayer({
      id: "spatial-outline",
      type: "line",
      source: "outline",
      paint: { "line-color": "#ff9800", "line-width": 3 },
    });
    this._applyFloor();
  }

  private _showOutline(outline: Polygon | null) {
    this._outline = outline ?? EMPTY;
    this._map?.getSource<GeoJSONSource>("outline")?.setData(this._outline);
  }

  private _startPicking() {
    this._picking = true;
    this._message = "";
  }

  // One tap picks the building under it and the wall nearest to it. The saved site
  // update comes back through `spatial/subscribe`, which draws the outline and turns the map.
  private _pick(event: MapMouseEvent) {
    if (!this._picking) return;
    this._picking = false;
    const map = this._map!;
    const layers = map
      .getStyle()
      .layers.filter((layer) => "source-layer" in layer && layer["source-layer"] === "buildings")
      .map((layer) => layer.id);
    const at: [number, number] = [event.lngLat.lng, event.lngLat.lat];
    const building = map
      .queryRenderedFeatures(event.point, { layers })
      .map((feature) => buildingAt(feature.geometry as Polygon | MultiPolygon, at))
      .find(Boolean);
    if (!building) {
      this._message = "No building here";
      return;
    }
    const aligned = alignOutline(building, at);
    if (!aligned) {
      this._message = "Building too small or irregular";
      return;
    }
    this.hass!.connection.sendMessagePromise({
      type: "spatial/site/update",
      outline: aligned.outline,
      bearing_deg: aligned.bearingDeg,
    }).catch((err) => {
      console.error(err);
      this._message = "Could not save";
    });
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
