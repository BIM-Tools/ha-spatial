// A fake MapLibre and a scripted Home Assistant connection, shared by the panel tests.
import bearing from "@turf/bearing";
import destination from "@turf/destination";
import distance from "@turf/distance";
import { vi } from "vitest";

export const mapCreated = vi.fn();
export const setBearing = vi.fn();
export const fitBounds = vi.fn();
export const jumpTo = vi.fn();
export const queryRenderedFeatures = vi.fn((): object[] => []);
export let handlers: Record<string, (event?: object) => void> = {};
export let sources: Record<string, { data: unknown }> = {};
export let layers: { id: string; type: string; source: string }[] = [];
export let mapBearingNow = 0;

export interface FakeMarker {
  options: object;
  lngLat: { lng: number; lat: number };
  handlers: Record<string, () => void>;
  removed: boolean;
  element: HTMLElement;
}
export let markers: FakeMarker[] = [];
export const handles = () => markers.filter((marker) => !marker.removed);

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
    options: object;
    lngLat = { lng: 0, lat: 0 };
    handlers: Record<string, () => void> = {};
    removed = false;
    element: HTMLElement;
    constructor(options: { element?: HTMLElement } = {}) {
      this.options = options;
      this.element = options.element ?? document.createElement("div");
      markers.push(this);
    }
    setLngLat([lng, lat]: [number, number]) {
      this.lngLat = { lng, lat };
      return this;
    }
    getElement() {
      return this.element;
    }
    getLngLat() {
      return this.lngLat;
    }
    addTo() {
      return this;
    }
    on(event: string, handler: () => void) {
      this.handlers[event] = handler;
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
    on(event: string, handler: (event?: object) => void) {
      const before = handlers[event];
      handlers[event] = (e) => {
        before?.(e);
        handler(e);
      };
    }
    remove() {}
    addSource(id: string, source: { data: unknown }) {
      sources[id] = { data: source.data };
    }
    getSource(id: string) {
      const source = sources[id];
      return source && { setData: (data: unknown) => (source.data = data) };
    }
    addLayer(layer: { id: string; type: string; source: string }) {
      layers.push(layer);
    }
    getLayer(id: string) {
      return layers.find((layer) => layer.id === id);
    }
    setLayoutProperty() {}
    setFilter() {}
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
    easeTo() {}
    fitBounds(...args: unknown[]) {
      fitBounds(...args);
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
  jumpTo.mockClear();
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
