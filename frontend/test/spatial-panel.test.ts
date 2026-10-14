// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

// MapLibre needs WebGL; the panel's own behaviour does not.
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(),
  Map: class {
    on() {}
    remove() {}
  },
}));

import "../src/spatial-panel";

const EMPTY = { type: "FeatureCollection", features: [] };

const mountPanel = () => {
  const sendMessagePromise = vi.fn(async ({ type }: { type: string }) => {
    if (type === "map_tiles/access_token") return { token: "t" };
    if (type === "spatial/site") return { lon: 5, lat: 52, bearing_deg: 0 };
    if (type === "spatial/geojson") return EMPTY;
    throw new Error(type);
  });
  const panel = document.createElement("spatial-panel") as HTMLElement & { hass: object };
  panel.hass = {
    connection: { sendMessagePromise, subscribeEvents: vi.fn(async () => async () => {}) },
    themes: { darkMode: false },
  };
  document.body.append(panel);
  return { panel, sendMessagePromise };
};

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ json: async () => ({ sprite: [], glyphs: "/g", layers: [] }) })),
);

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

test("the panel refreshes the map tiles token every 20 minutes", async () => {
  vi.useFakeTimers();
  const { sendMessagePromise } = mountPanel();
  await vi.advanceTimersByTimeAsync(0);
  const tokenCalls = () =>
    sendMessagePromise.mock.calls.filter(([m]) => m.type === "map_tiles/access_token").length;
  expect(tokenCalls()).toBe(1);
  await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
  expect(tokenCalls()).toBe(2);
});

test("the panel says so when there are no rooms", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain("No rooms yet"));
});

test("the panel has Home Assistant's menu button for narrow screens", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("ha-menu-button")).not.toBeNull());
});
