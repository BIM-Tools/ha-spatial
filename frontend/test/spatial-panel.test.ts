// @vitest-environment happy-dom
// Checks the panel against a fake MapLibre and a scripted Home Assistant connection.
import { afterEach, expect, test, vi } from "vitest";

const mapCreated = vi.fn();
const setBearing = vi.fn();
const fitBounds = vi.fn();
const queryRenderedFeatures = vi.fn((): object[] => []);
let handlers: Record<string, (event?: object) => void> = {};
let sources: Record<string, { data: unknown }> = {};
let layers: { id: string; type: string; source: string }[] = [];

interface FakeMarker {
  options: object;
  lngLat: { lng: number; lat: number };
  handlers: Record<string, () => void>;
  removed: boolean;
  element: HTMLElement;
}
let markers: FakeMarker[] = [];
const handles = () => markers.filter((marker) => !marker.removed);

// MapLibre needs WebGL; the panel's own behaviour does not.
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(),
  Marker: class implements FakeMarker {
    options: object;
    lngLat = { lng: 0, lat: 0 };
    handlers: Record<string, () => void> = {};
    removed = false;
    element = document.createElement("div");
    constructor(options: object) {
      this.options = options;
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
    constructor(options: object) {
      mapCreated(options);
      handlers = {};
      sources = {};
      layers = [];
    }
    on(event: string, handler: () => void) {
      handlers[event] = handler;
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
      setBearing(bearing);
    }
    fitBounds(...args: unknown[]) {
      fitBounds(...args);
    }
  },
}));

import { alignOutline, outlineBearing } from "../src/outline";
import "../src/spatial-panel";

const EMPTY = { type: "FeatureCollection", features: [] };

type Reply = (message: { type: string }) => Promise<unknown>;

const answer: Reply = async ({ type }) => {
  if (type === "map_tiles/access_token") return { token: "t" };
  if (type === "spatial/site") return { lon: 5, lat: 52, bearing_deg: 0, outline: null };
  if (type === "spatial/site/update") return null;
  if (type === "spatial/geojson") return EMPTY;
  throw new Error(type);
};

const mountPanel = (reply: Reply = answer, floors = {}, card = false, floor?: string) => {
  const sendMessagePromise = vi.fn(reply);
  const unsubscribe = vi.fn(async () => {});
  const listeners: Record<string, () => void> = {};
  const connection = {
    sendMessagePromise,
    subscribeMessage: vi.fn(async () => unsubscribe),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      listeners[event] = listener;
    }),
    removeEventListener: vi.fn((event: string) => {
      delete listeners[event];
    }),
  };
  const panel = document.createElement("spatial-panel") as HTMLElement & {
    hass: object;
    floor?: string;
  };
  panel.floor = floor;
  panel.hass = { connection, floors, themes: { darkMode: false } };
  panel.toggleAttribute("card", card);
  document.body.append(panel);
  const tokenCalls = () =>
    sendMessagePromise.mock.calls.filter(([message]) => message.type === "map_tiles/access_token").length;
  return { panel, connection, listeners, unsubscribe, tokenCalls };
};

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ json: async () => ({ sprite: [], glyphs: "/g", layers: [] }) })),
);

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  mapCreated.mockClear();
  setBearing.mockClear();
  fitBounds.mockClear();
  queryRenderedFeatures.mockReset();
  handlers = {};
  markers = [];
  queryRenderedFeatures.mockReturnValue([]);
});

test("the panel refreshes the map tiles token every 20 minutes", async () => {
  vi.useFakeTimers();
  const { tokenCalls } = mountPanel();
  await vi.advanceTimersByTimeAsync(0);
  expect(tokenCalls()).toBe(1);
  await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
  expect(tokenCalls()).toBe(2);
});

test("the panel refreshes the map tiles token when the connection is ready again", async () => {
  const { listeners, tokenCalls } = mountPanel();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(tokenCalls()).toBe(1);
  listeners.ready();
  expect(tokenCalls()).toBe(2);
});

test("the panel says so when there are no rooms", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain("No rooms yet"));
});

test("the panel says so when the map cannot load", async () => {
  const { panel } = mountPanel(async () => {
    throw new Error("connection lost");
  });
  await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain("Map could not load"));
});

test("leaving the panel during startup leaves nothing behind", async () => {
  vi.useFakeTimers();
  const pending: (() => void)[] = [];
  const { panel, connection, listeners, unsubscribe } = mountPanel(
    (message) => new Promise((resolve) => pending.push(() => resolve(answer(message)))),
  );
  await vi.advanceTimersByTimeAsync(0);
  panel.remove();
  // Resolve every call the panel makes from here on, as they come.
  while (pending.length) {
    pending.shift()!();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(mapCreated).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(listeners).toEqual({});
  expect(connection.subscribeMessage.mock.calls.length).toBe(unsubscribe.mock.calls.length);
});

test("the panel has Home Assistant's menu button for narrow screens", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("ha-menu-button")).not.toBeNull());
});

const room = (floor_id: string | null, level: number | null) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: { floor_id, level },
});

test("the panel has one button per floor, named by Home Assistant", async () => {
  const collection = {
    type: "FeatureCollection",
    features: [room("loft", 1), room("ground", 0), room("annex", 0), room(null, null)],
  };
  const { panel } = mountPanel(
    async (message) => (message.type === "spatial/geojson" ? collection : answer(message)),
    { ground: { name: "Ground floor" }, loft: { name: "Loft" } },
  );
  const buttons = () =>
    [...(panel.shadowRoot?.querySelectorAll(".bar > button") ?? [])].map((button) =>
      button.textContent?.trim(),
    );
  await vi.waitFor(() =>
    expect(buttons()).toEqual(["All", "Ground floor", "annex", "Loft", "No floor", "Building"]),
  );
});

test("an update with a new site bearing turns the map", async () => {
  let bearing = 0;
  const { connection } = mountPanel(async (message) =>
    message.type === "spatial/site" ? { lon: 5, lat: 52, bearing_deg: bearing } : answer(message),
  );
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  bearing = 90;
  const [[onUpdate]] = connection.subscribeMessage.mock.calls as unknown as [[() => Promise<void>]];
  await onUpdate();
  expect(setBearing).toHaveBeenCalledWith(0);
});

test("the panel follows changes through spatial/subscribe, open to non-admin users", async () => {
  const { connection } = mountPanel();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(connection.subscribeMessage).toHaveBeenCalledWith(expect.any(Function), {
    type: "spatial/subscribe",
  });
});

test("the 3D rooms extrude from base_m to top_m of each feature", async () => {
  mountPanel();
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  expect(layers.find((layer) => layer.id === "areas-3d")).toMatchObject({
    paint: {
      "fill-extrusion-base": ["get", "base_m"],
      "fill-extrusion-height": ["get", "top_m"],
    },
  });
});

test("inside a card the panel has no menu button", async () => {
  const { panel } = mountPanel(answer, {}, true);
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(panel.shadowRoot?.querySelector("ha-menu-button")).toBeNull();
});

const square = (floor_id: string, west: number, south: number) => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [west + 1, south],
        [west + 1, south + 1],
        [west, south + 1],
        [west, south],
      ],
    ],
  },
  properties: { floor_id, level: 0 },
});

const TWO_FLOORS = {
  type: "FeatureCollection",
  features: [square("ground", 5, 52), square("first", 6, 53)],
};

const mountStatic = (floor: string, geojson: () => object = () => TWO_FLOORS) =>
  mountPanel(
    async (message) => (message.type === "spatial/geojson" ? geojson() : answer(message)),
    {},
    true,
    floor,
  );

const buttons = (panel: HTMLElement) => panel.shadowRoot?.querySelectorAll("button").length;

test("without a floor the map is interactive, with floor buttons", async () => {
  const { panel } = mountPanel(answer, {}, true);
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(mapCreated.mock.calls[0][0]).not.toHaveProperty("interactive", false);
  expect(buttons(panel)).toBeGreaterThan(0);
  expect(fitBounds).not.toHaveBeenCalled();
});

test("a fixed floor all shows a static 3D map framed on all rooms", async () => {
  const { panel } = mountStatic("all");
  await vi.waitFor(() => expect(fitBounds).toHaveBeenCalled());
  expect(mapCreated.mock.calls[0][0]).toMatchObject({ interactive: false, pitch: 50 });
  expect(buttons(panel)).toBe(0);
  expect(fitBounds.mock.calls[0][0]).toEqual([5, 52, 7, 54]);
  // Site bearing 0 puts the site's x-axis to the right at map bearing 270.
  expect(fitBounds.mock.calls[0][1]).toMatchObject({ bearing: 270 });
});

test("a fixed floor id shows a static flat plan framed on that floor", async () => {
  const { panel } = mountStatic("first");
  await vi.waitFor(() => expect(fitBounds).toHaveBeenCalled());
  expect(mapCreated.mock.calls[0][0]).toMatchObject({ interactive: false, pitch: 0 });
  expect(buttons(panel)).toBe(0);
  expect(fitBounds.mock.calls[0][0]).toEqual([6, 53, 7, 54]);
});

test("a static map frames the rooms again on every update", async () => {
  let geojson: object = TWO_FLOORS;
  const { connection } = mountStatic("ground", () => geojson);
  await vi.waitFor(() => expect(fitBounds).toHaveBeenCalled());
  geojson = { type: "FeatureCollection", features: [square("ground", 4, 51)] };
  const [[onUpdate]] = connection.subscribeMessage.mock.calls as unknown as [[() => Promise<void>]];
  await onUpdate();
  expect(fitBounds.mock.calls.at(-1)?.[0]).toEqual([4, 51, 5, 52]);
});

test("an unknown fixed floor says there are no rooms", async () => {
  const { panel } = mountStatic("attic");
  await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain("No rooms yet"));
  expect(fitBounds).not.toHaveBeenCalled();
});

test("a new floor option rebuilds the map, as interactivity is fixed at creation", async () => {
  const { panel } = mountStatic("all");
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(1));
  panel.floor = undefined;
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(2));
  expect(mapCreated.mock.calls[1][0]).not.toHaveProperty("interactive", false);
});

const barText = (panel: HTMLElement) => panel.shadowRoot?.querySelector(".bar")?.textContent ?? "";

const buildingButton = (panel: HTMLElement) =>
  [...(panel.shadowRoot?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === "Building",
  );

// About 14 m x 11 m, counter-clockwise.
const HOUSE = {
  type: "Polygon",
  coordinates: [[[5, 52], [5.0002, 52], [5.0002, 52.0001], [5, 52.0001], [5, 52]]],
};
const SHED = {
  type: "Polygon",
  coordinates: [[[5, 52], [5.000001, 52], [5.000001, 52.000001], [5, 52.000001], [5, 52]]],
};
const SOUTH_WALL = { lng: 5.0001, lat: 52.00001 };

const click = (lngLat = SOUTH_WALL, target: Node | null = null) =>
  handlers.click({ point: { x: 1, y: 2 }, lngLat, originalEvent: { target } });

const startPicking = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  buildingButton(panel)!.click();
};

// A second tap does nothing once the mode has ended, so the map is not queried again.
const expectModeEnded = async () => {
  const queried = queryRenderedFeatures.mock.calls.length;
  click();
  expect(queryRenderedFeatures).toHaveBeenCalledTimes(queried);
};

const updates = (connection: { sendMessagePromise: { mock: { calls: [{ type: string }][] } } }) =>
  connection.sendMessagePromise.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "spatial/site/update");

test("the panel has a Building button, the card does not", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(buildingButton(panel)).toBeDefined());
  const card = mountPanel(answer, {}, true).panel;
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(2));
  expect(buildingButton(card)).toBeUndefined();
});

test("in building mode a click on a building saves its outline, aligned to the nearest wall", async () => {
  const { panel, connection } = mountPanel();
  // The buildings layer is one MultiPolygon per tile.
  const tile = { type: "MultiPolygon", coordinates: [SHED.coordinates, HOUSE.coordinates] };
  queryRenderedFeatures.mockReturnValue([{ geometry: tile }]);
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  click();
  expect(updates(connection)).toEqual([]);
  await startPicking(panel);
  click();
  expect(queryRenderedFeatures).toHaveBeenLastCalledWith({ x: 1, y: 2 }, { layers: ["building-3d"] });
  const { outline, bearingDeg } = alignOutline(HOUSE as never, [SOUTH_WALL.lng, SOUTH_WALL.lat])!;
  expect(updates(connection)).toEqual([
    { type: "spatial/site/update", outline, bearing_deg: bearingDeg },
  ]);
  // One tap ends the mode.
  click();
  expect(updates(connection)).toHaveLength(1);
});

test("in building mode a click without a building saves nothing", async () => {
  const { panel, connection } = mountPanel();
  await startPicking(panel);
  click();
  await vi.waitFor(() => expect(barText(panel)).toContain("No building here"));
  await expectModeEnded();
  expect(updates(connection)).toEqual([]);
});

test("in building mode a building too small to inset saves nothing", async () => {
  const { panel, connection } = mountPanel();
  queryRenderedFeatures.mockReturnValue([{ geometry: SHED }]);
  await startPicking(panel);
  click({ lng: 5.0000005, lat: 52.0000005 });
  await vi.waitFor(() => expect(barText(panel)).toContain("Building too small or irregular"));
  await expectModeEnded();
  expect(updates(connection)).toEqual([]);
});

test.each([false, true])("the stored outline is drawn on start and after updates (card %s)", async (card) => {
  let outline: object | null = HOUSE;
  const { connection } = mountPanel(
    async (message) =>
      message.type === "spatial/site" ? { lon: 5, lat: 52, bearing_deg: 0, outline } : answer(message),
    {},
    card,
  );
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  expect(layers.find((layer) => layer.id === "spatial-outline")).toMatchObject({
    type: "line",
    source: "outline",
  });
  expect(sources.outline.data).toEqual(HOUSE);
  outline = null;
  const [[onUpdate]] = connection.subscribeMessage.mock.calls as unknown as [[() => Promise<void>]];
  await onUpdate();
  expect(sources.outline.data).toEqual(EMPTY);
});

test("in building mode a failed save says so", async () => {
  const { panel } = mountPanel(async (message) => {
    if (message.type === "spatial/site/update") throw new Error("connection lost");
    return answer(message);
  });
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startPicking(panel);
  click();
  await vi.waitFor(() => expect(barText(panel)).toContain("Could not save"));
});

const mountWithOutline = (reply: Reply = answer) =>
  mountPanel(async (message) =>
    message.type === "spatial/site"
      ? { lon: 5, lat: 52, bearing_deg: 90, outline: HOUSE }
      : reply(message),
  );

const corners = () => handles().map(({ lngLat }) => [lngLat.lng, lngLat.lat]);

const startEditing = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  buildingButton(panel)!.click();
  await vi.waitFor(() => expect(handles()).toHaveLength(4));
};

test("in building mode each corner of the stored outline gets a draggable handle", async () => {
  const { panel } = mountWithOutline();
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  expect(handles()).toEqual([]);
  buildingButton(panel)!.click();
  // The closing vertex shares the first handle.
  await vi.waitFor(() => expect(corners()).toEqual(HOUSE.coordinates[0].slice(0, -1)));
  expect(handles().map((marker) => marker.options)).toEqual(
    Array(4).fill(expect.objectContaining({ draggable: true })),
  );
  // Pressing Building again leaves the mode.
  buildingButton(panel)!.click();
  await vi.waitFor(() => expect(handles()).toEqual([]));
  // A pick also ends the mode.
  buildingButton(panel)!.click();
  await vi.waitFor(() => expect(handles()).toHaveLength(4));
  click();
  await vi.waitFor(() => expect(handles()).toEqual([]));
});

test("in building mode without an outline there are no handles", async () => {
  const { panel } = mountPanel();
  await startPicking(panel);
  await vi.waitFor(() => expect(barText(panel)).toContain("Click a building"));
  expect(handles()).toEqual([]);
});

// The expected bearings are plane trigonometry on the local metres per degree at 52 N
// (111 257 m north, 111 320 cos 52 = 68 535 m east), an independent reference for turf.
test.each([
  [0, [5.0001, 51.9999], 31.6],
  [1, [5.0002, 51.9999], 129.1],
])("dragging corner %i saves the outline and its first wall's bearing", async (index, to, expected) => {
  const { panel, connection } = mountWithOutline();
  await startEditing(panel);
  const marker = handles()[index];
  marker.lngLat = { lng: to[0], lat: to[1] };
  marker.handlers.dragend();
  const ring = HOUSE.coordinates[0].map((vertex, i) => (i % 4 === index ? to : vertex));
  const outline = { type: "Polygon", coordinates: [ring] };
  const [saved] = updates(connection) as unknown as [{ bearing_deg: number }];
  expect(saved).toEqual({
    type: "spatial/site/update",
    outline,
    bearing_deg: outlineBearing(outline as never),
  });
  expect(saved.bearing_deg).toBeCloseTo(expected, 0);
  expect(sources.outline.data).toEqual(outline);
});

test("dragging a corner keeps the courtyards of the stored outline", async () => {
  const hole = [
    [5.00005, 52.00003],
    [5.00007, 52.00003],
    [5.00007, 52.00005],
    [5.00005, 52.00003],
  ];
  const withHole = { type: "Polygon", coordinates: [...HOUSE.coordinates, hole] };
  const { panel, connection } = mountPanel(async (message) =>
    message.type === "spatial/site"
      ? { lon: 5, lat: 52, bearing_deg: 90, outline: withHole }
      : answer(message),
  );
  await startEditing(panel);
  const marker = handles()[0];
  marker.lngLat = { lng: 5.0001, lat: 51.9999 };
  marker.handlers.dragend();
  const [saved] = updates(connection) as unknown as [{ outline: { coordinates: unknown[] } }];
  expect(saved.outline.coordinates.slice(1)).toEqual([hole]);
});

test("a rejected corner drag restores the stored outline and says so", async () => {
  const { panel } = mountWithOutline(async (message) => {
    if (message.type === "spatial/site/update") throw new Error("not allowed");
    return answer(message);
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startEditing(panel);
  const marker = handles()[2];
  marker.lngLat = { lng: 5.0003, lat: 52.0002 };
  marker.handlers.dragend();
  await vi.waitFor(() => expect(barText(panel)).toContain("Could not save the outline"));
  expect(sources.outline.data).toEqual(HOUSE);
  expect(corners()).toEqual(HOUSE.coordinates[0].slice(0, -1));
});

test("a click on a handle is not a pick", async () => {
  const { panel, connection } = mountWithOutline();
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  await startEditing(panel);
  const pin = document.createElement("span");
  handles()[1].element.append(pin);
  click(SOUTH_WALL, pin);
  expect(updates(connection)).toEqual([]);
  expect(handles()).toHaveLength(4);
});

test("removing the panel removes the corner handles", async () => {
  const { panel } = mountWithOutline();
  await startEditing(panel);
  panel.remove();
  expect(handles()).toEqual([]);
});

test("a removed panel does not start again", async () => {
  const { panel } = mountWithOutline();
  await startEditing(panel);
  panel.remove();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mapCreated).toHaveBeenCalledTimes(1);
});

test("an outline that arrives during building mode offers the corner drag", async () => {
  let outline: object | null = null;
  const { panel, connection } = mountPanel(async (message) =>
    message.type === "spatial/site" ? { lon: 5, lat: 52, bearing_deg: 0, outline } : answer(message),
  );
  await startPicking(panel);
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await vi.waitFor(() => expect(barText(panel)).toContain("Click a building"));
  expect(barText(panel)).not.toContain("drag a corner");
  outline = HOUSE;
  const [[onUpdate]] = connection.subscribeMessage.mock.calls as unknown as [[() => Promise<void>]];
  await onUpdate();
  await vi.waitFor(() => expect(barText(panel)).toContain("drag a corner"));
});

test("a drag that ends after the handles are gone saves nothing", async () => {
  const { panel, connection } = mountWithOutline();
  await startEditing(panel);
  const { dragend } = handles()[0].handlers;
  buildingButton(panel)!.click();
  await vi.waitFor(() => expect(handles()).toEqual([]));
  dragend();
  expect(updates(connection)).toEqual([]);
});
