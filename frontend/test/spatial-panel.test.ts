// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

const mapCreated = vi.fn();

// MapLibre needs WebGL; the panel's own behaviour does not.
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(),
  Map: class {
    constructor() {
      mapCreated();
    }
    on() {}
    remove() {}
  },
}));

import "../src/spatial-panel";

const EMPTY = { type: "FeatureCollection", features: [] };

const answer = async ({ type }: { type: string }) => {
  if (type === "map_tiles/access_token") return { token: "t" };
  if (type === "spatial/site") return { lon: 5, lat: 52, bearing_deg: 0 };
  if (type === "spatial/geojson") return EMPTY;
  throw new Error(type);
};

const mountPanel = (reply = answer) => {
  const sendMessagePromise = vi.fn(reply);
  const unsubscribe = vi.fn(async () => {});
  const listeners: Record<string, () => void> = {};
  const connection = {
    sendMessagePromise,
    subscribeEvents: vi.fn(async () => unsubscribe),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      listeners[event] = listener;
    }),
    removeEventListener: vi.fn((event: string) => {
      delete listeners[event];
    }),
  };
  const panel = document.createElement("spatial-panel") as HTMLElement & { hass: object };
  panel.hass = { connection, themes: { darkMode: false } };
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
  expect(connection.subscribeEvents.mock.calls.length).toBe(unsubscribe.mock.calls.length);
});

test("the panel has Home Assistant's menu button for narrow screens", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("ha-menu-button")).not.toBeNull());
});
