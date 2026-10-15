// @vitest-environment happy-dom
// Checks the panel against a fake MapLibre and a scripted Home Assistant connection.
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  answer,
  fitBounds,
  handlers,
  layers,
  mapCreated,
  mountPanel,
  queryRenderedFeatures,
  resetFakes,
  setBearing,
  sources,
} from "./panel-harness";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

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
  const { panel, connection, listeners, unsubscribe, unsubscribeEvents } = mountPanel(
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
  expect(connection.subscribeEvents.mock.calls.length).toBe(unsubscribeEvents.mock.calls.length);
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

test("the card has one button per floor in the rooms, named by Home Assistant", async () => {
  const collection = {
    type: "FeatureCollection",
    features: [room("loft", 1), room("ground", 0), room("annex", 0), room(null, null)],
  };
  const { panel } = mountPanel(
    async (message) => (message.type === "spatial/geojson" ? collection : answer(message)),
    { ground: { name: "Ground floor" }, loft: { name: "Loft" } },
    true,
  );
  const buttons = () =>
    [...(panel.shadowRoot?.querySelectorAll(".bar > button") ?? [])].map((button) =>
      button.textContent?.trim(),
    );
  await vi.waitFor(() =>
    expect(buttons()).toEqual(["All", "Ground floor", "annex", "Loft", "No floor"]),
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

const alignButton = (panel: HTMLElement) =>
  [...(panel.shadowRoot?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === "Align",
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
const EAST_WALL = { lng: 5.00019, lat: 52.00005 };

const click = (lngLat = EAST_WALL) =>
  handlers.click({ point: { x: 1, y: 2 }, lngLat });

const startAligning = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  alignButton(panel)!.click();
};

const updates = (connection: { sendMessagePromise: { mock: { calls: [{ type: string }][] } } }) =>
  connection.sendMessagePromise.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "spatial/site/update");

test("the panel has an Align button, the card does not", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(alignButton(panel)).toBeDefined());
  const card = mountPanel(answer, {}, true).panel;
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(2));
  expect(alignButton(card)).toBeUndefined();
});

test("in Align a click on a building saves only the bearing of the wall nearest to it, and ends the mode", async () => {
  const { panel, connection } = mountPanel();
  // The buildings layer is one MultiPolygon per tile.
  const tile = { type: "MultiPolygon", coordinates: [SHED.coordinates, HOUSE.coordinates] };
  queryRenderedFeatures.mockReturnValue([{ geometry: tile }]);
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  click();
  expect(updates(connection)).toEqual([]);
  await startAligning(panel);
  await vi.waitFor(() => expect(barText(panel)).toContain("Click your house near the wall the rooms follow"));
  click();
  expect(queryRenderedFeatures).toHaveBeenLastCalledWith({ x: 1, y: 2 }, { layers: ["building-3d"] });
  const [saved] = updates(connection) as unknown as [{ bearing_deg: number }];
  expect(Object.keys(saved)).toEqual(["type", "bearing_deg"]);
  // The counter-clockwise ring runs north along the east wall.
  expect(saved.bearing_deg).toBeCloseTo(0, 1);
  click();
  expect(updates(connection)).toHaveLength(1);
  await vi.waitFor(() => expect(barText(panel)).not.toContain("Click your house"));
});

test("in Align a click without a building saves nothing", async () => {
  const { panel, connection } = mountPanel();
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(barText(panel)).toContain("No building here"));
  const queried = queryRenderedFeatures.mock.calls.length;
  click();
  expect(queryRenderedFeatures).toHaveBeenCalledTimes(queried);
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

test("in Align a failed save says so", async () => {
  const { panel } = mountPanel(async (message) => {
    if (message.type === "spatial/site/update") throw new Error("connection lost");
    return answer(message);
  });
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(barText(panel)).toContain("Could not save"));
});

test("a removed panel does not start again", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  panel.remove();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mapCreated).toHaveBeenCalledTimes(1);
});


test("the panel reads the areas and floors again on registry changes, until it is left", async () => {
  const { panel, connection, unsubscribeEvents } = mountPanel();
  await vi.waitFor(() => expect(connection.subscribeEvents).toHaveBeenCalledTimes(2));
  const subscriptions = connection.subscribeEvents.mock.calls as unknown as [() => void, string][];
  expect(subscriptions.map(([, eventType]) => eventType)).toEqual(["area_registry_updated", "floor_registry_updated"]);
  const reads = () =>
    connection.sendMessagePromise.mock.calls.filter(([message]) => message.type === "config/area_registry/list").length;
  const before = reads();
  for (const [onEvent] of subscriptions) onEvent();
  await vi.waitFor(() => expect(reads()).toBe(before + 2));
  panel.remove();
  expect(unsubscribeEvents).toHaveBeenCalledTimes(2);
});

test("the card does not follow the registries", async () => {
  const { connection } = mountPanel(answer, {}, true);
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(connection.subscribeEvents).not.toHaveBeenCalled();
});
