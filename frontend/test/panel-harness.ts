// A fake MapLibre and a scripted Home Assistant connection, shared by the panel tests.
import bearing from "@turf/bearing";
import destination from "@turf/destination";
import distance from "@turf/distance";
import { vi } from "vitest";

export const mapCreated = vi.fn();
export const setBearing = vi.fn();
export const easeTo = vi.fn();
export const fitBounds = vi.fn();
export const jumpTo = vi.fn();
export const resetNorth = vi.fn();
export const zoomIn = vi.fn();
export const zoomOut = vi.fn();
export const setStyle = vi.fn();
export const queryRenderedFeatures = vi.fn((): object[] => []);
export let handlers: Record<string, (event?: object) => void> = {};
export let sources: Record<string, { data: unknown }> = {};
export let layers: { id: string; type: string; source: string; filter?: unknown; layout?: Record<string, unknown> }[] = [];
export let mapBearingNow = 0;

export interface FakeMarker {
  removed: boolean;
  element: HTMLElement;
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

// MapLibre needs WebGL; the panel's own behaviour does not.
export const fakeMapLibre = {
  setWorkerUrl: vi.fn(),
  Marker: class implements FakeMarker {
    removed = false;
    element: HTMLElement;
    constructor(options: { element?: HTMLElement } = {}) {
      this.element = options.element ?? document.createElement("div");
      markers.push(this);
    }
    setLngLat() {
      return this;
    }
    getElement() {
      return this.element;
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
      handlers[event] = (e) => this.listeners[event].forEach((listener) => listener(e));
    }
    off(event: string, handler: (event?: object) => void) {
      this.listeners[event] = this.listeners[event].filter((listener) => listener !== handler);
    }
    remove() {}
    getContainer() {
      return document.body;
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
      return (queryRenderedFeatures as (...a: unknown[]) => object[])(...args);
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
    fitBounds(...args: unknown[]) {
      fitBounds(...args);
    }
    getBearing() {
      return mapBearingNow;
    }
    resetNorth() {
      mapBearingNow = 0;
      resetNorth();
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
    project(lngLat: { lng: number; lat: number }) {
      return projectLngLat(lngLat);
    }
    unproject(point: [number, number]) {
      const [lng, lat] = unprojectPixel(point);
      return { lng, lat, toArray: () => [lng, lat] };
    }
  },
};

export const EMPTY = { type: "FeatureCollection", features: [] };

export type Reply = (message: { type: string; [key: string]: unknown }) => Promise<unknown>;

export const answer: Reply = async ({ type }) => {
  if (type === "map_tiles/access_token") return { token: "t" };
  if (type === "spatial/site") return { lon: 5, lat: 52, bearing_deg: 0, outline: null };
  if (type === "spatial/site/update") return null;
  if (type === "spatial/geojson") return EMPTY;
  if (type === "config/area_registry/list" || type === "config/floor_registry/list") return [];
  throw new Error(type);
};

export const mountPanel = (reply: Reply = answer, floors = {}, card = false, floor?: string) => {
  const sendMessagePromise = vi.fn(reply);
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
  };
  panel.floor = floor;
  panel.hass = { connection, floors, themes: { darkMode: false } };
  panel.toggleAttribute("card", card);
  document.body.append(panel);
  const tokenCalls = () =>
    sendMessagePromise.mock.calls.filter(([message]) => message.type === "map_tiles/access_token").length;
  return { panel, connection, listeners, unsubscribe, unsubscribeEvents, tokenCalls };
};

export const onUpdateOf = (connection: { subscribeMessage: { mock: { calls: unknown[][] } } }) =>
  connection.subscribeMessage.mock.calls[0][0] as () => Promise<void>;

export const resetFakes = () => {
  document.body.replaceChildren();
  vi.useRealTimers();
  mapCreated.mockClear();
  setBearing.mockClear();
  fitBounds.mockClear();
  easeTo.mockClear();
  jumpTo.mockClear();
  resetNorth.mockClear();
  zoomIn.mockClear();
  zoomOut.mockClear();
  setStyle.mockClear();
  localStorage.clear();
  queryRenderedFeatures.mockReset();
  queryRenderedFeatures.mockReturnValue([]);
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

export const floorButtonNames = (panel: HTMLElement) =>
  [...(panel.shadowRoot?.querySelector("spatial-floor-selector")?.shadowRoot?.querySelectorAll("button") ?? [])].map(
    (button) => button.textContent?.trim(),
  );

export const messageText = (panel: HTMLElement) => panel.shadowRoot?.querySelector(".messages")?.textContent ?? "";

type Updating = Element & { updateComplete?: Promise<boolean> };

/** Waits for the panel and the elements it renders to finish rendering. */
export const settle = async (panel: HTMLElement) => {
  await (panel as Updating).updateComplete;
  for (const element of panel.shadowRoot?.querySelectorAll<Updating>("*") ?? []) await element.updateComplete;
};
