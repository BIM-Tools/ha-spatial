// @vitest-environment happy-dom
// Checks the panel against a fake MapLibre and a scripted Home Assistant connection.
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  answer,
  buttonNamed,
  buttonsIn,
  fitBounds,
  floorButtonNames,
  handlers,
  layers,
  mapCreated,
  messageText,
  mountPanel,
  queryRenderedFeatures,
  resetFakes,
  resetNorth,
  setBearing,
  setStyle,
  settle,
  easeTo,
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

test("the panel has a header with back and help, the card none", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("spatial-panel-header")).not.toBeNull());
  await settle(panel);
  const header = panel.shadowRoot!.querySelector("spatial-panel-header")!.shadowRoot!;
  expect(header.textContent).toContain("Spaces");
  expect(header.querySelector("a")?.getAttribute("href")).toBe("https://github.com/BIM-Tools/ha-spatial");
  expect(header.querySelector("a")?.getAttribute("target")).toBe("_blank");
  const card = mountPanel(answer, {}, true).panel;
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(2));
  expect(card.shadowRoot?.querySelector("spatial-panel-header")).toBeNull();
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
  await vi.waitFor(() =>
    expect(floorButtonNames(panel)).toEqual(["All", "Ground floor", "annex", "Loft", "No floor"]),
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

const buttons = (panel: HTMLElement) => buttonsIn(panel.shadowRoot!).length;

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

const alignButton = (panel: HTMLElement) => buttonNamed(panel, "Align");

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

// All floors is a view only, so Align needs a floor.
const startAligning = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  await settle(panel);
  buttonNamed(panel, "No floor")!.click();
  await settle(panel);
  alignButton(panel)!.click();
  await settle(panel);
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
  queryRenderedFeatures.mockReturnValue([{ geometry: tile, properties: {} }]);
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  click();
  expect(updates(connection)).toEqual([]);
  await startAligning(panel);
  await vi.waitFor(() => expect(messageText(panel)).toContain("Click your house near the wall the rooms follow"));
  click();
  expect(queryRenderedFeatures).toHaveBeenLastCalledWith({ x: 1, y: 2 }, { layers: ["building-3d"] });
  const [saved] = updates(connection) as unknown as [{ bearing_deg: number }];
  expect(Object.keys(saved)).toEqual(["type", "bearing_deg"]);
  // The counter-clockwise ring runs north along the east wall.
  expect(saved.bearing_deg).toBeCloseTo(0, 1);
  click();
  expect(updates(connection)).toHaveLength(1);
  await vi.waitFor(() => expect(messageText(panel)).not.toContain("Click your house"));
});

test("in Align a click turns the camera so the wall lies low in the view, and the update does not turn it again", async () => {
  Object.defineProperty(document.body, "clientHeight", { value: 600, configurable: true });
  const { panel, connection } = mountPanel();
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(easeTo).toHaveBeenCalled());
  expect(easeTo).toHaveBeenCalledWith({ bearing: 270, center: EAST_WALL, offset: [0, 180] });
  const [[onUpdate]] = connection.subscribeMessage.mock.calls as unknown as [[() => Promise<void>]];
  setBearing.mockClear();
  await onUpdate();
  expect(setBearing).not.toHaveBeenCalled();
});

const wallSource = () => sources["spatial-wall"].data as { geometry?: { coordinates: number[][] } };
const hover = (lngLat = EAST_WALL) => handlers.mousemove({ point: { x: 1, y: 2 }, lngLat });

test("in Align hovering a building draws the wall a click would pick, and leaving it clears the wall", async () => {
  const { panel } = mountPanel();
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  await startAligning(panel);
  handlers["style.load"]();
  expect(layers.find((layer) => layer.id === "spatial-wall")).toMatchObject({ type: "line", source: "spatial-wall" });
  hover();
  expect(wallSource().geometry?.coordinates).toEqual([[5.0002, 52], [5.0002, 52.0001]]);
  queryRenderedFeatures.mockReturnValue([]);
  hover();
  expect(sources["spatial-wall"].data).toEqual(EMPTY);
});

test("the wall is cleared when Align ends, and hovering outside Align does nothing", async () => {
  const { panel } = mountPanel();
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  hover();
  expect(sources["spatial-wall"].data).toEqual(EMPTY);
  await startAligning(panel);
  hover();
  expect(wallSource().geometry).toBeDefined();
  buttonNamed(panel, "Adjust")!.click();
  await vi.waitFor(() => expect(sources["spatial-wall"].data).toEqual(EMPTY));
});

test("in Align a click without a building saves nothing", async () => {
  const { panel, connection } = mountPanel();
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(messageText(panel)).toContain("No building here"));
  const buildingQueries = () =>
    queryRenderedFeatures.mock.calls.filter((call) => JSON.stringify(call).includes("building-3d")).length;
  const queried = buildingQueries();
  click();
  expect(buildingQueries()).toBe(queried);
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

test("in Align a failed save says so and turns the map back", async () => {
  const { panel } = mountPanel(async (message) => {
    if (message.type === "spatial/site/update") throw new Error("connection lost");
    return answer(message);
  });
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(messageText(panel)).toContain("Could not save"));
  // The fixture's stored bearing gives the same map bearing as the clicked wall.
  expect(easeTo).toHaveBeenLastCalledWith({ bearing: 270 });
});

test("Align turns the map before the save is answered", async () => {
  let answerSave = () => {};
  const { panel } = mountPanel(async (message) => {
    if (message.type === "spatial/site/update") return new Promise<null>((resolve) => (answerSave = () => resolve(null)));
    return answer(message);
  });
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  await startAligning(panel);
  click();
  expect(easeTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 270, center: EAST_WALL }));
  answerSave();
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

const pressedTools = (panel: HTMLElement) =>
  ["Align", "Draw", "Adjust"].filter((name) => buttonNamed(panel, name)?.getAttribute("aria-pressed") === "true");

const showNoFloor = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(buttonNamed(panel, "No floor")).toBeDefined());
  buttonNamed(panel, "No floor")!.click();
  await settle(panel);
};

test("Adjust is the default tool, and exactly one tool is active", async () => {
  const { panel } = mountPanel();
  await showNoFloor(panel);
  expect(pressedTools(panel)).toEqual(["Adjust"]);
  for (const name of ["Draw", "Draw", "Align", "Adjust"]) {
    buttonNamed(panel, name)!.click();
    await settle(panel);
    expect(pressedTools(panel)).toEqual([name]);
  }
});

test("in All floors every tool is disabled and none is pressed; Align ends there", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(buttonNamed(panel, "Align")).toBeDefined());
  await settle(panel);
  for (const name of ["Align", "Draw", "Adjust", "Undo", "Redo"]) expect(buttonNamed(panel, name)!.disabled).toBe(true);
  expect(pressedTools(panel)).toEqual([]);
  await startAligning(panel);
  buttonNamed(panel, "All")!.click();
  buttonNamed(panel, "No floor")!.click();
  await settle(panel);
  expect(pressedTools(panel)).toEqual(["Adjust"]);
});

test("the selected floor is pressed and stays enabled", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(buttonNamed(panel, "All")).toBeDefined());
  await settle(panel);
  expect(buttonNamed(panel, "All")!.getAttribute("aria-pressed")).toBe("true");
  await showNoFloor(panel);
  expect(buttonNamed(panel, "No floor")!.getAttribute("aria-pressed")).toBe("true");
  expect(buttonNamed(panel, "No floor")!.disabled).toBe(false);
  expect(buttonNamed(panel, "All")!.getAttribute("aria-pressed")).toBe("false");
});

const groundOnly = (style: { layers: { type: string }[] }) => style.layers.map((layer) => layer.type).join() === "background";

test("the map toggle is on by default; off shows the plan on plain ground, and it is remembered", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  await settle(panel);
  expect(groundOnly(mapCreated.mock.calls[0][0].style)).toBe(false);
  expect(buttonNamed(panel, "Show map")!.getAttribute("aria-pressed")).toBe("true");
  buttonNamed(panel, "Show map")!.click();
  await settle(panel);
  expect(buttonNamed(panel, "Show map")!.getAttribute("aria-pressed")).toBe("false");
  await vi.waitFor(() => expect(setStyle).toHaveBeenCalledTimes(1));
  expect(groundOnly(setStyle.mock.calls[0][0])).toBe(true);
  panel.remove();
  const again = mountPanel().panel;
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(2));
  await settle(again);
  expect(groundOnly(mapCreated.mock.calls[1][0].style)).toBe(true);
  expect(buttonNamed(again, "Show map")!.getAttribute("aria-pressed")).toBe("false");
});

test("Align turns the map on with the toggle disabled, and its end turns it off again", async () => {
  localStorage.setItem("spatial-show-map", "false");
  const { panel } = mountPanel();
  await startAligning(panel);
  expect(buttonNamed(panel, "Show map")!.disabled).toBe(true);
  expect(buttonNamed(panel, "Show map")!.getAttribute("aria-pressed")).toBe("true");
  await vi.waitFor(() => expect(setStyle).toHaveBeenCalledTimes(1));
  expect(groundOnly(setStyle.mock.calls[0][0])).toBe(false);
  buttonNamed(panel, "Adjust")!.click();
  await settle(panel);
  await vi.waitFor(() => expect(setStyle).toHaveBeenCalledTimes(2));
  expect(groundOnly(setStyle.mock.calls[1][0])).toBe(true);
  expect(buttonNamed(panel, "Show map")!.disabled).toBe(false);
});

test("the compass turns with the map and a click faces north", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(handlers.rotate).toBeDefined());
  await settle(panel);
  const needle = () => buttonNamed(panel, "Face north")!.querySelector("ha-svg-icon")!.getAttribute("style");
  // Site bearing 0 turns the map to 270.
  expect(needle()).toContain("rotate(-270deg)");
  buttonNamed(panel, "Face north")!.click();
  expect(resetNorth).toHaveBeenCalledTimes(1);
  handlers.rotate();
  await settle(panel);
  expect(needle()).toContain("rotate(0deg)");
});
