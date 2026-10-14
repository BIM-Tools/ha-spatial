// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

const mapCreated = vi.fn();
const setBearing = vi.fn();
const fitBounds = vi.fn();

// MapLibre needs WebGL; the panel's own behaviour does not.
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(),
  Map: class {
    constructor(options: object) {
      mapCreated(options);
    }
    on() {}
    remove() {}
    getSource() {}
    setBearing(bearing: number) {
      setBearing(bearing);
    }
    fitBounds(...args: unknown[]) {
      fitBounds(...args);
    }
  },
}));

import "../src/spatial-panel";

const EMPTY = { type: "FeatureCollection", features: [] };

type Reply = (message: { type: string }) => Promise<unknown>;

const answer: Reply = async ({ type }) => {
  if (type === "map_tiles/access_token") return { token: "t" };
  if (type === "spatial/site") return { lon: 5, lat: 52, bearing_deg: 0 };
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
  await vi.waitFor(() => expect(buttons()).toEqual(["All", "Ground floor", "annex", "Loft", "No floor"]));
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
