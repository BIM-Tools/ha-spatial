// @vitest-environment happy-dom
// Checks the panel's address search wiring: when the card opens, what it sends, what it shows and where the map goes.
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  buttonNamed,
  camera,
  fitBounds,
  flyTo,
  guideText,
  handlers,
  mapCreated,
  type Mount,
  mountPanel,
  onUpdateOf,
  queryRenderedFeatures,
  type Reply,
  resetFakes,
  settle,
  sources,
  toasts,
} from "./panel-harness";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

const DOMTOREN = { label: "Domtoren, Domplein, Utrecht", lat: 52.0907, lon: 5.1214, bbox: [5.1212, 52.0905, 5.1216, 52.0909] };
const VOORBEELDSTRAAT = { label: "1, Voorbeeldstraat, Ergens, Voorbeeldland", lat: 52, lon: 5, bbox: null };

const card = (panel: HTMLElement) => panel.shadowRoot!.querySelector("spatial-address-search");
const inCard = (panel: HTMLElement) => card(panel)!.shadowRoot!;
const field = (panel: HTMLElement) => inCard(panel).querySelector("input")!;
const searchButton = (panel: HTMLElement) =>
  [...inCard(panel).querySelectorAll("button")].find((button) => button.textContent?.trim() === "Search")!;
const searches = (connection: ReturnType<typeof mountPanel>["connection"]) =>
  connection.sendMessagePromise.mock.calls.map(([message]) => message).filter((message) => message.type === "spatial/address/search");

const type = async (panel: HTMLElement, text: string) => {
  field(panel).value = text;
  field(panel).dispatchEvent(new InputEvent("input"));
  await settle(panel);
};

const pressEnter = async (panel: HTMLElement) => {
  field(panel).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await settle(panel);
};

const openSearch = async (reply?: Reply, mount: Mount = {}) => {
  const mounted = mountPanel({ ...mount, reply });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  await settle(mounted.panel);
  buttonNamed(mounted.panel, "Find an address")!.click();
  await settle(mounted.panel);
  return mounted;
};

const answering =
  (...answers: (() => unknown)[]): Reply =>
  async (message) => {
    if (message.type !== "spatial/address/search") return undefined;
    return answers.shift()!();
  };

test.each([
  ["no home location", {}, true],
  ["a home at 0, 0", { latitude: 0, longitude: 0 }, true],
  ["a home", { latitude: 52, longitude: 5 }, false],
])("with %s and an empty plan, the panel opens on the globe with the search card: %s", async (_, homeLocation, globe) => {
  const { panel } = mountPanel({ homeLocation, site: { bearing_deg: null } });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  await settle(panel);
  expect(card(panel) !== null).toBe(globe);
  expect(mapCreated.mock.calls[0][0].zoom < 5).toBe(globe);
});

test.each([
  ["no building", [], true],
  ["a building", [{ geometry: { type: "Polygon", coordinates: [[[4.9, 51.9], [5.1, 51.9], [5.1, 52.1], [4.9, 51.9]]] } }], false],
])("before any Align, a home with %s under it on the drawn map opens the search card: %s", async (_, buildings, opened) => {
  const { panel } = mountPanel({ site: { bearing_deg: null } });
  await vi.waitFor(() => expect(handlers.idle).toBeDefined());
  await settle(panel);
  expect(card(panel)).toBeNull();
  queryRenderedFeatures.mockReturnValue(buildings);
  handlers.idle();
  await settle(panel);
  expect(card(panel) !== null).toBe(opened);
});

test("a plan keeps the panel on the house without a home location", async () => {
  const { panel } = mountPanel({ homeLocation: {}, site: { outline: { type: "Polygon", coordinates: [] } } });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  await settle(panel);
  expect(card(panel)).toBeNull();
  expect(mapCreated.mock.calls[0][0]).toMatchObject({ center: [5, 52], zoom: 19 });
});

test("the card searches on Enter or Search only, with a query of three characters or more", async () => {
  const { panel, connection } = await openSearch(answering(() => ({ places: [] }), () => ({ places: [] })));
  await type(panel, "Da");
  expect(searchButton(panel).disabled).toBe(true);
  await pressEnter(panel);
  await type(panel, " Voorbeeldstraat 1 ");
  expect(searches(connection)).toEqual([]);
  expect(searchButton(panel).disabled).toBe(false);
  await pressEnter(panel);
  searchButton(panel).click();
  await settle(panel);
  expect(searches(connection)).toEqual([
    { type: "spatial/address/search", query: "Voorbeeldstraat 1" },
    { type: "spatial/address/search", query: "Voorbeeldstraat 1" },
  ]);
});

test("the Search button is disabled while a search runs", async () => {
  let answer: (value: unknown) => void = () => {};
  const { panel } = await openSearch(answering(() => new Promise((resolve) => (answer = resolve))));
  await type(panel, "Voorbeeldstraat 1");
  await pressEnter(panel);
  expect(searchButton(panel).disabled).toBe(true);
  answer({ places: [] });
  await vi.waitFor(() => expect(searchButton(panel).disabled).toBe(false));
});

test("results show the street over the town, and picking one flies there and closes the card", async () => {
  const { panel } = await openSearch(answering(() => ({ places: [DOMTOREN, VOORBEELDSTRAAT] })));
  await type(panel, "straat");
  await pressEnter(panel);
  const results = [...inCard(panel).querySelectorAll<HTMLButtonElement>("li button")];
  expect(results.map((result) => result.getAttribute("aria-label"))).toEqual(["Domtoren, Domplein, Utrecht", "Voorbeeldstraat 1, Ergens, Voorbeeldland"]);
  expect(results[0].querySelector(".street")?.textContent).toBe("Domtoren");
  results[0].click();
  await settle(panel);
  expect(fitBounds).toHaveBeenCalledWith(
    [
      [5.1212, 52.0905],
      [5.1216, 52.0909],
    ],
    expect.objectContaining({ maxZoom: 18 }),
  );
  expect(card(panel)).toBeNull();
});

test("a result without a box flies to its point", async () => {
  const { panel } = await openSearch(answering(() => ({ places: [VOORBEELDSTRAAT] })));
  await type(panel, "Voorbeeldstraat 1");
  await pressEnter(panel);
  inCard(panel).querySelector<HTMLButtonElement>("li button")!.click();
  await settle(panel);
  expect(flyTo).toHaveBeenCalledWith({ center: [5, 52], zoom: 18 });
});

test("arrow keys walk from the field through the results and back", async () => {
  const { panel } = await openSearch(answering(() => ({ places: [DOMTOREN, VOORBEELDSTRAAT] })));
  await type(panel, "straat");
  await pressEnter(panel);
  const results = [...inCard(panel).querySelectorAll<HTMLButtonElement>("li button")];
  const press = (key: string) =>
    (inCard(panel).activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  field(panel).focus();
  press("ArrowDown");
  expect(inCard(panel).activeElement).toBe(results[0]);
  press("ArrowDown");
  expect(inCard(panel).activeElement).toBe(results[1]);
  press("ArrowUp");
  press("ArrowUp");
  expect(inCard(panel).activeElement).toBe(field(panel));
});

test("no results say how to search again", async () => {
  const { panel } = await openSearch(answering(() => ({ places: [] })));
  await type(panel, "Nowhere 1");
  await pressEnter(panel);
  expect(inCard(panel).textContent).toContain("No address found. Check the spelling or add the town.");
});

test.each([
  ["the search server fails", () => Promise.reject({ code: "search_failed", message: "The search server could not be reached" })],
  ["the connection is lost", () => Promise.reject(new Error("Connection lost"))],
])("when %s, the card offers Retry and panning, and Retry searches again", async (_, failure) => {
  const { panel, connection } = await openSearch(answering(failure, () => ({ places: [VOORBEELDSTRAAT] })));
  await type(panel, "Voorbeeldstraat 1");
  await pressEnter(panel);
  expect(inCard(panel).textContent).toContain("Address search isn't available right now.");
  expect(inCard(panel).textContent).toContain("You can also pan the map to your home.");
  [...inCard(panel).querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry")!.click();
  await settle(panel);
  expect(searches(connection)).toHaveLength(2);
  expect(inCard(panel).querySelectorAll("li button")).toHaveLength(1);
});

test("Close and Escape close the card", async () => {
  const { panel } = await openSearch();
  buttonNamed(panel, "Close")!.click();
  await settle(panel);
  expect(card(panel)).toBeNull();
  buttonNamed(panel, "Find an address")!.click();
  await settle(panel);
  field(panel).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await settle(panel);
  expect(card(panel)).toBeNull();
});

const homeWrites = (connection: ReturnType<typeof mountPanel>["connection"]) =>
  connection.sendMessagePromise.mock.calls.map(([message]) => message).filter((message) => message.type === "config/core/update");

// Answers the searches with these places and every core config write with success.
const searchingAnd =
  (...answers: object[][]): Reply =>
  async (message) => {
    if (message.type === "config/core/update") return null;
    if (message.type !== "spatial/address/search") return undefined;
    return { places: answers.shift() };
  };

const searchAndPick = async (panel: HTMLElement) => {
  if (!card(panel)) {
    buttonNamed(panel, "Find an address")!.click();
    await settle(panel);
  }
  await type(panel, "Domtoren");
  await pressEnter(panel);
  inCard(panel).querySelector<HTMLButtonElement>("li button")!.click();
  await settle(panel);
};

test("a place far from the home offers Move, which writes the place as the home, and Undo writes the old home back", async () => {
  const { panel, connection } = await openSearch(searchingAnd([DOMTOREN]));
  await searchAndPick(panel);
  expect(toasts).toHaveLength(1);
  expect(toasts[0].message).toMatch(/^Move Home Assistant's home here\? The home pin is 1\d\.\d km away$/);
  expect(toasts[0].action!.text).toBe("Move");
  toasts[0].action!.action();
  await vi.waitFor(() => expect(toasts).toHaveLength(2));
  expect(toasts[1]).toMatchObject({ message: "Home location moved", action: { text: "Undo" } });
  toasts[1].action!.action();
  await vi.waitFor(() => expect(homeWrites(connection)).toHaveLength(2));
  expect(homeWrites(connection)).toEqual([
    { type: "config/core/update", latitude: 52.0907, longitude: 5.1214 },
    { type: "config/core/update", latitude: 52, longitude: 5 },
  ]);
});

test("without a home location, a picked place offers Use as home", async () => {
  const { panel, connection } = await openSearch(searchingAnd([DOMTOREN]), { homeLocation: {} });
  await searchAndPick(panel);
  expect(toasts.map((toast) => [toast.message, toast.action?.text])).toEqual([["Use this as Home Assistant's home?", "Use as home"]]);
  toasts[0].action!.action();
  await vi.waitFor(() => expect(homeWrites(connection)).toEqual([{ type: "config/core/update", latitude: 52.0907, longitude: 5.1214 }]));
});

// The map tiles' building around the Domtoren point.
const TOWER = { type: "Polygon", coordinates: [[[5.121, 52.0903], [5.1218, 52.0903], [5.1218, 52.0911], [5.121, 52.0911], [5.121, 52.0903]]] };
const toolPressed = (panel: HTMLElement, name: string) => buttonNamed(panel, name)?.getAttribute("aria-pressed");

test("on a first visit without a home, a pick leaves the panel on a floor with Align on and its line", async () => {
  const { panel } = mountPanel({ homeLocation: {}, site: { bearing_deg: null }, reply: searchingAnd([DOMTOREN]) });
  await vi.waitFor(() => expect(card(panel)).not.toBeNull());
  await searchAndPick(panel);
  expect(buttonNamed(panel, "No floor")!.getAttribute("aria-pressed")).toBe("true");
  expect(toolPressed(panel, "Align")).toBe("true");
  expect(buttonNamed(panel, "Align")!.disabled).toBe(false);
  expect(guideText(panel)).toBe("Click the front wall of your home The view turns so that wall lies flat.");
});

test("the picked place's building shows dashed until the site has a direction", async () => {
  let bearing: number | null = null;
  const { panel, connection } = mountPanel({ homeLocation: {}, site: () => ({ bearing_deg: bearing }), reply: searchingAnd([DOMTOREN]) });
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  queryRenderedFeatures.mockReturnValue([{ geometry: TOWER }]);
  await searchAndPick(panel);
  handlers.idle();
  expect(sources["spatial-home"].data).toEqual(TOWER);
  bearing = 0;
  await onUpdateOf(connection)();
  handlers.idle();
  expect(sources["spatial-home"].data).toEqual(EMPTY);
});

// A synthetic hall around the Domtoren point across the edge between tiles 8424 and 8425 at zoom 14, as
// each tile has it: cut at the edge plus a buffer of 8 of its 4096 units.
const TILE_EDGE = (8425 / 2 ** 14) * 360 - 180;
const TILE_BUFFER = (8 / 4096 / 2 ** 14) * 360;
const hallPart = (west: number, east: number) => ({
  type: "Polygon",
  coordinates: [[[west, 52.0905], [east, 52.0905], [east, 52.0909], [west, 52.0909], [west, 52.0905]]],
});
const WEST_PART = { _z: 14, _x: 8424, _y: 5405, geometry: hallPart(5.119, TILE_EDGE + TILE_BUFFER) };
const EAST_PART = { _z: 14, _x: 8425, _y: 5405, geometry: hallPart(TILE_EDGE - TILE_BUFFER, 5.122) };
const lngRange = (data: unknown) => {
  const lngs = (data as { coordinates: number[][][] }).coordinates[0].map(([lng]) => lng);
  return [Math.min(...lngs), Math.max(...lngs)];
};

test("a picked building across a tile edge is read from the tiles under it and shows whole", async () => {
  const { panel } = mountPanel({ homeLocation: {}, site: { bearing_deg: null }, reply: searchingAnd([DOMTOREN]) });
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await searchAndPick(panel);
  queryRenderedFeatures.mockReturnValueOnce([EAST_PART]).mockReturnValue([WEST_PART, EAST_PART]);
  handlers.idle();
  expect(Array.isArray((queryRenderedFeatures.mock.lastCall as unknown[])[0])).toBe(true);
  expect(lngRange(sources["spatial-home"].data)).toEqual([5.119, 5.122]);
});

test("a coarser tile standing in under the picked place is not mixed in", async () => {
  const { panel } = mountPanel({ homeLocation: {}, site: { bearing_deg: null }, reply: searchingAnd([DOMTOREN]) });
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await searchAndPick(panel);
  queryRenderedFeatures.mockReturnValue([{ _z: 13, _x: 4212, _y: 2702, geometry: hallPart(5.1, 5.13) }, { geometry: TOWER }]);
  handlers.idle();
  expect(sources["spatial-home"].data).toEqual(TOWER);
});

test("the picked place's building is read once the camera has landed, and then kept", async () => {
  const { panel } = mountPanel({ homeLocation: {}, site: { bearing_deg: null }, reply: searchingAnd([DOMTOREN]) });
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  queryRenderedFeatures.mockReturnValue([{ geometry: TOWER }]);
  camera.lands = false;
  await searchAndPick(panel);
  handlers.idle();
  expect(sources["spatial-home"].data).toEqual(EMPTY);
  handlers.moveend();
  handlers.idle();
  expect(sources["spatial-home"].data).toEqual(TOWER);
  queryRenderedFeatures.mockReturnValue([EAST_PART]);
  handlers.idle();
  expect(sources["spatial-home"].data).toEqual(TOWER);
});

test("a place within 25 m of the home asks nothing", async () => {
  const { panel } = await openSearch(searchingAnd([VOORBEELDSTRAAT]));
  await searchAndPick(panel);
  expect(toasts).toEqual([]);
});

test("a second pick in the same visit asks nothing, whatever the first answer", async () => {
  const { panel, connection } = await openSearch(searchingAnd([DOMTOREN], [DOMTOREN]));
  await searchAndPick(panel);
  await searchAndPick(panel);
  expect(toasts).toHaveLength(1);
  expect(homeWrites(connection)).toEqual([]);
});