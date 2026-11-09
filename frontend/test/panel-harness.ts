// A fake MapLibre and a scripted Home Assistant connection, shared by the panel tests.
import bearing from "@turf/bearing";
import destination from "@turf/destination";
import distance from "@turf/distance";
import { vi } from "vitest";
import type { SiteFrameData } from "../src/site-frame";
import { siteFrameData } from "./site-frame-fixture";
import type { HassUnits } from "../src/units";
import { METRIC_UNITS } from "./units-fixture";

export const mapCreated = vi.fn();
export const setBearing = vi.fn();
export const easeTo = vi.fn();
export const fitBounds = vi.fn();
export const flyTo = vi.fn();
export const jumpTo = vi.fn();
export const zoomIn = vi.fn();
export const zoomOut = vi.fn();
export const setStyle = vi.fn();
export const queryRenderedFeatures = vi.fn((): object[] => []);
// Whether a flight lands at once; a test that holds it fires `moveend` itself.
export const camera = { lands: true };
export let handlers: Record<string, (event?: object) => void> = {};
export let sources: Record<string, { data: unknown }> = {};
export let layers: {
  id: string;
  type: string;
  source: string;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}[] = [];
export let mapBearingNow = 0;
// The canvas of the latest map, whose style carries the cursor.
export let mapCanvas = document.createElement("canvas");

export interface FakeMarker {
  removed: boolean;
  element: HTMLElement;
  lngLat?: [number, number];
}
export let markers: FakeMarker[] = [];
export const liveMarkers = () => markers.filter((marker) => !marker.removed);

const handler = () => {
  let enabled = true;
  let rotation = true;
  return {
    enable: () => (enabled = true),
    disable: () => (enabled = false),
    enableRotation: () => (rotation = true),
    disableRotation: () => (rotation = false),
    isEnabled: () => enabled,
    isRotationEnabled: () => rotation,
  };
};
export let dragPan = handler();
export let dragRotate = handler();
export let touchZoomRotate = handler();

// Pixels the view has moved since the map was created.
export let panned = { x: 0, y: 0 };
export const panMap = (x: number, y: number) => (panned = { x: panned.x + x, y: panned.y + y });

// Before a pan the site centre is at pixel (0, 0); 0.1 m per pixel, screen up at the map bearing.
export const METRES_PER_PIXEL = 0.1;
export const SITE: [number, number] = [5, 52];
export const unprojectPixel = ([x, y]: [number, number], screenUp = mapBearingNow): [number, number] => {
  const east = destination(SITE, (x + panned.x) * METRES_PER_PIXEL, screenUp + 90, { units: "meters" });
  return destination(east, (y + panned.y) * METRES_PER_PIXEL, screenUp + 180, { units: "meters" }).geometry
    .coordinates as [number, number];
};
const projectLngLat = ({ lng, lat }: { lng: number; lat: number }) => {
  const pixels = distance(SITE, [lng, lat], { units: "meters" }) / METRES_PER_PIXEL;
  const turn = ((bearing(SITE, [lng, lat]) - mapBearingNow) * Math.PI) / 180;
  return { x: pixels * Math.sin(turn) - panned.x, y: -pixels * Math.cos(turn) - panned.y };
};

// MapLibre tells each rendered feature the tile it came from; here that is the zoom 14 tile of the
// feature's first position, unless the test names one.
const TILE_ZOOM = 14;
const withTile = (feature: object) => {
  const geometry = (feature as { geometry?: { coordinates: unknown } }).geometry;
  if (!geometry || "_z" in feature) return feature;
  const [lng, lat] = (geometry.coordinates as unknown[]).flat(3) as number[];
  const phi = (lat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * 2 ** TILE_ZOOM);
  const y = Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** TILE_ZOOM);
  return { ...feature, _z: TILE_ZOOM, _x: x, _y: y };
};

// MapLibre hands every listener the same event, whose preventDefault the later listeners read; a
// test's own preventDefault spy is still called.
const mapEvent = (event?: object) => {
  if (!event) return event;
  const own = (event as { preventDefault?: () => void }).preventDefault;
  const shared = {
    ...event,
    defaultPrevented: false,
    preventDefault: () => {
      shared.defaultPrevented = true;
      own?.();
    },
  };
  return shared;
};

// MapLibre needs WebGL; the panel's own behaviour does not.
export const fakeMapLibre = {
  setWorkerUrl: vi.fn(),
  Marker: class implements FakeMarker {
    removed = false;
    element: HTMLElement;
    lngLat?: [number, number];
    constructor(options: { element?: HTMLElement } = {}) {
      this.element = options.element ?? document.createElement("div");
      markers.push(this);
    }
    setLngLat(lngLat: [number, number]) {
      this.lngLat = lngLat;
      return this;
    }
    getElement() {
      return this.element;
    }
    setOffset() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.removed = true;
      return this;
    }
  },
  Map: class {
    dragPan = dragPan;
    dragRotate = dragRotate;
    touchZoomRotate = touchZoomRotate;
    touchPitch = handler();
    canvas = (mapCanvas = document.createElement("canvas"));
    constructor(options: { bearing?: number }) {
      mapCreated(options);
      handlers = {};
      sources = {};
      layers = [];
      mapBearingNow = options.bearing ?? 0;
    }
    listeners: Record<string, ((event?: object) => void)[]> = {};
    on(event: string, handler: (event?: object) => void) {
      (this.listeners[event] ??= []).push(handler);
      handlers[event] = (e) => {
        const shared = mapEvent(e);
        this.listeners[event].forEach((listener) => listener(shared));
      };
    }
    once(event: string, handler: (event?: object) => void) {
      const once = (e?: object) => {
        this.off(event, once);
        handler(e);
      };
      this.on(event, once);
    }
    off(event: string, handler: (event?: object) => void) {
      this.listeners[event] = this.listeners[event].filter((listener) => listener !== handler);
    }
    remove() {}
    getContainer() {
      return document.body;
    }
    getCanvas() {
      return this.canvas;
    }
    addSource(id: string, source: { data: unknown }) {
      sources[id] = { data: source.data };
    }
    getSource(id: string) {
      const source = sources[id];
      return source && { setData: (data: unknown) => (source.data = data) };
    }
    addLayer(layer: (typeof layers)[number]) {
      layers.push(layer);
    }
    getLayer(id: string) {
      return layers.find((layer) => layer.id === id);
    }
    setLayoutProperty(id: string, name: string, value: unknown) {
      const layer = layers.find((entry) => entry.id === id);
      if (layer) layer.layout = { ...layer.layout, [name]: value };
    }
    setPaintProperty(id: string, name: string, value: unknown) {
      const layer = layers.find((entry) => entry.id === id);
      if (layer) layer.paint = { ...layer.paint, [name]: value };
    }
    setFilter(id: string, filter: unknown) {
      const layer = layers.find((entry) => entry.id === id);
      if (layer) layer.filter = filter;
    }
    getStyle() {
      return {
        layers: [
          { id: "water", type: "fill", "source-layer": "water" },
          { id: "building-3d", type: "fill-extrusion", "source-layer": "buildings" },
        ],
      };
    }
    queryRenderedFeatures(...args: unknown[]) {
      return (queryRenderedFeatures as (...a: unknown[]) => object[])(...args).map(withTile);
    }
    setBearing(bearing: number) {
      mapBearingNow = bearing;
      setBearing(bearing);
    }
    jumpTo(options: { bearing?: number }) {
      mapBearingNow = options.bearing ?? mapBearingNow;
      jumpTo(options);
    }
    easeTo(options: { bearing?: number }) {
      mapBearingNow = options.bearing ?? mapBearingNow;
      easeTo(options);
    }
    flyTo(...args: unknown[]) {
      flyTo(...args);
      if (camera.lands) handlers.moveend?.();
    }
    fitBounds(...args: unknown[]) {
      fitBounds(...args);
      if (camera.lands) handlers.moveend?.();
    }
    getBearing() {
      return mapBearingNow;
    }
    getCenter() {
      return { lng: SITE[0], lat: SITE[1] };
    }
    getZoom() {
      return 19;
    }
    getPitch() {
      return 0;
    }
    getVerticalFieldOfView() {
      return 36.87;
    }
    zoomIn() {
      zoomIn();
    }
    zoomOut() {
      zoomOut();
    }
    setStyle(...args: unknown[]) {
      setStyle(...args);
    }
    project(lngLat: { lng: number; lat: number } | [number, number]) {
      return projectLngLat(Array.isArray(lngLat) ? { lng: lngLat[0], lat: lngLat[1] } : lngLat);
    }
    unproject(point: [number, number]) {
      const [lng, lat] = unprojectPixel(point);
      return { lng, lat, toArray: () => [lng, lat] };
    }
  },
};

export const EMPTY = { type: "FeatureCollection", features: [] };

/** A `spatial/geojson` reply with these room features. */
export const rooms = (...features: object[]) => ({ type: "FeatureCollection", features });

export interface SiteFields {
  bearing_deg?: number | null;
  outline?: unknown;
  frame?: SiteFrameData;
}

/** A `spatial/site` reply at the site centre; its frame has its origin there and follows the bearing (null faces north). */
export const siteReply = (fields: SiteFields = {}) => {
  const bearing = fields.bearing_deg === undefined ? 0 : fields.bearing_deg;
  return { lon: 5, lat: 52, origin: null, outline: null, frame: siteFrameData(SITE, bearing ?? 0), ...fields, bearing_deg: bearing };
};

/** A floor registry entry. */
export const floorEntry = (floor_id: string, name: string, level: number | null = 0) => ({ floor_id, name, level });

/** An area registry entry. */
export const areaEntry = (area_id: string, name: string, floor_id: string | null) => ({ area_id, name, floor_id });

export type Reply = (message: { type: string; [key: string]: unknown }) => Promise<unknown>;

// A fixed value, or one read again on every message, for a test that changes it between updates.
type Live<T> = T | (() => T);
const now = <T>(value: Live<T>): T => (typeof value === "function" ? (value as () => T)() : value);

/** What Home Assistant and Spatial hold; each part has a default, so a test names only what it is about. */
export interface Home {
  site?: Live<SiteFields>;
  geojson?: Live<object>;
  floors?: Live<object[]>;
  areas?: Live<object[]>;
}

/** Answers the panel's reads and writes from `home`. */
export const homeReply =
  ({ site = {}, geojson = EMPTY, floors = [], areas = [] }: Home = {}): Reply =>
  async ({ type }) => {
    if (type === "map_tiles/access_token") return { token: "t" };
    if (type === "spatial/site") return siteReply(now(site));
    if (type === "spatial/site/update") return null;
    if (type === "spatial/geojson") return now(geojson);
    if (type === "config/floor_registry/list") return now(floors);
    if (type === "config/area_registry/list") return now(areas);
    throw new Error(type);
  };

export interface Mount extends Home {
  /** Answers first; a reply of undefined leaves the message to the home. */
  reply?: Reply;
  /** `hass.floors`: Home Assistant's floor names. */
  hassFloors?: Record<string, { name: string }>;
  card?: boolean;
  /** The card's fixed floor option. */
  floor?: string;
  /** The card's show_map option. */
  showMap?: boolean;
  units?: HassUnits;
  /** Home Assistant's home location; at the site centre unless a test says otherwise. */
  homeLocation?: { latitude?: number; longitude?: number };
}

export const mountPanel = ({
  reply,
  hassFloors = {},
  card = false,
  floor,
  showMap,
  units = METRIC_UNITS,
  homeLocation = { latitude: SITE[1], longitude: SITE[0] },
  ...home
}: Mount = {}) => {
  const fromHome = homeReply(home);
  const sendMessagePromise = vi.fn<Reply>(async (message) => {
    const answered = reply && (await reply(message));
    return answered === undefined ? fromHome(message) : answered;
  });
  const unsubscribe = vi.fn(async () => {});
  const unsubscribeEvents = vi.fn(async () => {});
  const listeners: Record<string, () => void> = {};
  const connection = {
    sendMessagePromise,
    subscribeMessage: vi.fn(async () => unsubscribe),
    subscribeEvents: vi.fn(async () => unsubscribeEvents),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      listeners[event] = listener;
    }),
    removeEventListener: vi.fn((event: string) => {
      delete listeners[event];
    }),
  };
  const panel = document.createElement("spatial-panel") as HTMLElement & {
    updateComplete: Promise<boolean>;
    hass: object;
    floor?: string;
    showMap?: boolean;
  };
  panel.floor = floor;
  panel.showMap = showMap;
  panel.hass = { connection, floors: hassFloors, themes: { darkMode: false }, ...units, config: { ...units.config, ...homeLocation } };  panel.toggleAttribute("card", card);
  document.body.append(panel);
  const tokenCalls = () =>
    sendMessagePromise.mock.calls.filter(([message]) => message.type === "map_tiles/access_token").length;
  return { panel, connection, listeners, unsubscribe, unsubscribeEvents, tokenCalls };
};

export const onUpdateOf = (connection: { subscribeMessage: { mock: { calls: unknown[][] } } }) =>
  connection.subscribeMessage.mock.calls[0][0] as () => Promise<void>;

export const resetFakes = () => {
  document.body.replaceChildren();
  toasts.length = 0;
  vi.useRealTimers();
  mapCreated.mockClear();
  setBearing.mockClear();
  fitBounds.mockClear();
  flyTo.mockClear();
  easeTo.mockClear();
  jumpTo.mockClear();
  zoomIn.mockClear();
  zoomOut.mockClear();
  setStyle.mockClear();
  localStorage.clear();
  queryRenderedFeatures.mockReset();
  queryRenderedFeatures.mockReturnValue([]);
  camera.lands = true;
  handlers = {};
  markers = [];
  panned = { x: 0, y: 0 };
  dragPan = handler();
  dragRotate = handler();
  touchZoomRotate = handler();
};

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ json: async () => ({ sprite: [], glyphs: "/g", layers: [] }) })),
);

// Every button in the panel, its floating controls and the area strip, through their shadow roots.
export const buttonsIn = (root: ParentNode): HTMLButtonElement[] =>
  [...root.querySelectorAll("*")].flatMap((element) => [
    ...(element instanceof HTMLButtonElement ? [element] : []),
    ...(element.shadowRoot ? buttonsIn(element.shadowRoot) : []),
  ]);

/** A button by its aria-label, else by its text. */
export const buttonNamed = (panel: HTMLElement, name: string) =>
  buttonsIn(panel.shadowRoot!).find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name);

/** The header's icon button with this label; Home Assistant's `ha-icon-button` is not defined here, so it is clicked as a plain element. */
export const headerButton = (panel: HTMLElement, label: string) =>
  [
    ...panel.shadowRoot!.querySelector("spatial-panel-header")!.shadowRoot!.querySelectorAll<HTMLElement & { label?: string }>(
      "ha-icon-button",
    ),
  ].find((button) => button.label === label);

/** Opens the header's More options menu and chooses an entry. */
export const chooseFromMenu = async (panel: HTMLElement, entry: string) => {
  headerButton(panel, "More options")!.click();
  await settle(panel);
  buttonNamed(panel, entry)!.click();
  await settle(panel);
};

export const floorButtonNames =(panel: HTMLElement) =>
  [...(panel.shadowRoot?.querySelector("spatial-floor-selector")?.shadowRoot?.querySelectorAll("button") ?? [])].map(
    (button) => button.textContent?.trim(),
  );

/** The guide's lines and buttons, one space apart; "" without a guide. */
export const guideText = (panel: HTMLElement) =>
  [...(panel.shadowRoot?.querySelector(".guide")?.querySelectorAll(".text, .detail, button") ?? [])]
    .map((part) => part.textContent?.trim())
    .join(" ");

/** The text of each part of an element's shadow root, one space apart. */
export const partsText = (element: Element) =>
  [...(element.shadowRoot?.children ?? [])].map((part) => part.textContent?.trim()).join(" ");

export interface ToastDetail {
  message: string;
  action?: { text: string; action: () => void };
  duration?: number;
  dismissable?: boolean;
  id?: string;
}

/** Every toast the panel asked Home Assistant to show, in order. */
export const toasts: ToastDetail[] = [];
window.addEventListener("hass-notification", (event) => toasts.push((event as CustomEvent<ToastDetail>).detail));

export const toastMessages = () => toasts.map((toast) => toast.message);

type Updating = Element & { updateComplete?: Promise<boolean> };

/** Waits for the panel and the elements it renders to finish rendering. */
/** Resolves after the next animation frame, once what the panel read in that frame is shown. */
export const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

export const settle = async (panel: HTMLElement) => {
  await (panel as Updating).updateComplete;
  for (const element of panel.shadowRoot?.querySelectorAll<Updating>("*") ?? []) await element.updateComplete;
};
