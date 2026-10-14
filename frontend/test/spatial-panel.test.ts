// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

const mapCreated = vi.fn();
const setBearing = vi.fn();
const fitBounds = vi.fn();
const queryRenderedFeatures = vi.fn((): object[] => []);
let handlers: Record<string, (event?: object) => void> = {};
let sources: Record<string, { data: unknown }> = {};
let layers: { id: string; type: string; source: string }[] = [];

// MapLibre needs WebGL; the panel's own behaviour does not.
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(),
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

import { alignOutline } from "../src/outline";
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
    sendMessagePromise.mock.calls.filter(([m]) => m.type === "map_tiles/access_token").length;
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
  const fc = {
    type: "FeatureCollection",
    features: [room("loft", 1), room("ground", 0), room("annex", 0), room(null, null)],
  };
  const { panel } = mountPanel(
    async (message) => (message.type === "spatial/geojson" ? fc : answer(message)),
    { ground: { name: "Ground floor" }, loft: { name: "Loft" } },
  );
  const buttons = () =>
    [...(panel.shadowRoot?.querySelectorAll(".bar > button") ?? [])].map((b) =>
      b.textContent?.trim(),
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

const mountStatic = (floor: string, fc: () => object = () => TWO_FLOORS) =>
  mountPanel(
    async (message) => (message.type === "spatial/geojson" ? fc() : answer(message)),
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
  let fc: object = TWO_FLOORS;
  const { connection } = mountStatic("ground", () => fc);
  await vi.waitFor(() => expect(fitBounds).toHaveBeenCalled());
  fc = { type: "FeatureCollection", features: [square("ground", 4, 51)] };
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
    (b) => b.textContent?.trim() === "Building",
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

const click = (lngLat = SOUTH_WALL) => handlers.click({ point: { x: 1, y: 2 }, lngLat });

const startPicking = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  buildingButton(panel)!.click();
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
  expect(updates(connection)).toEqual([]);
});

test("in building mode a building too small to inset saves nothing", async () => {
  const { panel, connection } = mountPanel();
  queryRenderedFeatures.mockReturnValue([{ geometry: SHED }]);
  await startPicking(panel);
  click({ lng: 5.0000005, lat: 52.0000005 });
  await vi.waitFor(() => expect(barText(panel)).toContain("Building too small or irregular"));
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
