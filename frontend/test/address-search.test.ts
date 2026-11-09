// @vitest-environment happy-dom
// Checks the panel's address search wiring: when the card opens, what it sends, what it shows and where the map goes;
// then the pick of the home's building and when the home question is asked about it.
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  buttonNamed,
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

// The map tiles' building around the Domtoren point.
const TOWER = { type: "Polygon", coordinates: [[[5.121, 52.0903], [5.1218, 52.0903], [5.1218, 52.0911], [5.121, 52.0911], [5.121, 52.0903]]] };
const toolPressed = (panel: HTMLElement, name: string) => buttonNamed(panel, name)?.getAttribute("aria-pressed");

// A synthetic building east of the tower, for a second pick.
const ANNEX = { type: "Polygon", coordinates: [[[5.1222, 52.0905], [5.1226, 52.0905], [5.1226, 52.0909], [5.1222, 52.0909], [5.1222, 52.0905]]] };
const PICK_LINE = "Click your home Point at a building to light it up, then click it.";
const PICKED_LINE = "Press Align, then click the front wall Wrong building? Click the right one first.";
// The map tiles' buildings under the pointer are `buildings`; no room is drawn there.
const buildingsUnderPointer = (buildings: object[]) =>
  queryRenderedFeatures.mockImplementation(((_where: unknown, options: { layers: string[] }) =>
    options.layers.includes("building-3d") ? buildings : []) as never);
const pointer = (event: "mousemove" | "click", [lng, lat]: [number, number]) => handlers[event]({ point: { x: 1, y: 2 }, lngLat: { lng, lat } });

const clickingHome = async () => {
  const mounted = mountPanel({ homeLocation: {}, site: { bearing_deg: null }, reply: searchingAnd([DOMTOREN], [DOMTOREN]) });
  await vi.waitFor(() => expect(card(mounted.panel)).not.toBeNull());
  handlers["style.load"]();
  await searchAndPick(mounted.panel);
  return mounted;
};

test("on a first visit without a home, a pick leaves the panel on a floor with Click your home, Align off, asking nothing yet", async () => {
  const { panel } = await clickingHome();
  expect(buttonNamed(panel, "No floor")!.getAttribute("aria-pressed")).toBe("true");
  expect(toolPressed(panel, "Align")).toBe("false");
  expect(guideText(panel)).toBe(PICK_LINE);
  expect(toasts).toEqual([]);
});

test("while the home is to be picked, the building under the pointer lights up", async () => {
  await clickingHome();
  buildingsUnderPointer([{ geometry: TOWER }]);
  pointer("mousemove", [5.1214, 52.0907]);
  await vi.waitFor(() => expect(sources["spatial-pick-hover"].data).toEqual(TOWER));
  buildingsUnderPointer([]);
  pointer("mousemove", [5.13, 52.0907]);
  await vi.waitFor(() => expect(sources["spatial-pick-hover"].data).toEqual(EMPTY));
});

test("a click makes the building the home: it shows dashed, and Align is next", async () => {
  const { panel } = await clickingHome();
  buildingsUnderPointer([{ geometry: TOWER }]);
  pointer("click", [5.1211, 52.0904]);
  await settle(panel);
  expect(sources["spatial-pick"].data).toEqual(TOWER);
  expect(guideText(panel)).toBe(PICKED_LINE);
  expect(toolPressed(panel, "Align")).toBe("false");
});

test("clicking another building before Align picks it instead", async () => {
  const { panel } = await clickingHome();
  buildingsUnderPointer([{ geometry: TOWER }]);
  pointer("click", [5.1214, 52.0907]);
  buildingsUnderPointer([{ geometry: ANNEX }]);
  pointer("click", [5.1224, 52.0907]);
  await settle(panel);
  expect(sources["spatial-pick"].data).toEqual(ANNEX);
  expect(guideText(panel)).toBe(PICKED_LINE);
});

test("a click beside a building reads the tiles within a few pixels of it and picks the building", async () => {
  const { panel } = await clickingHome();
  buildingsUnderPointer([{ geometry: TOWER }]);
  // About 0.3 m south of the tower.
  pointer("click", [5.1214, 52.090297]);
  await settle(panel);
  expect(sources["spatial-pick"].data).toEqual(TOWER);
  expect(queryRenderedFeatures).toHaveBeenCalledWith(
    [
      [-7, -6],
      [9, 10],
    ],
    { layers: ["building-3d"] },
  );
});

test("a click beyond any building's reach says so, and the home is still to be picked", async () => {
  const { panel } = await clickingHome();
  pointer("click", [5.13, 52.0907]);
  await settle(panel);
  expect(toasts.map((toast) => toast.message)).toEqual(["No building here"]);
  expect(guideText(panel)).toBe(PICK_LINE);
});

test("a new search before Align drops the pick", async () => {
  const { panel } = await clickingHome();
  buildingsUnderPointer([{ geometry: TOWER }]);
  pointer("click", [5.1214, 52.0907]);
  await settle(panel);
  await searchAndPick(panel);
  expect(sources["spatial-pick"].data).toEqual(EMPTY);
  expect(guideText(panel)).toBe(PICK_LINE);
});

test("the picked building shows dashed until the site has a direction", async () => {
  let bearing: number | null = null;
  const { panel, connection } = mountPanel({ homeLocation: {}, site: () => ({ bearing_deg: bearing }), reply: searchingAnd([DOMTOREN]) });
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await searchAndPick(panel);
  buildingsUnderPointer([{ geometry: TOWER }]);
  pointer("click", [5.1214, 52.0907]);
  expect(sources["spatial-pick"].data).toEqual(TOWER);
  bearing = 0;
  await onUpdateOf(connection)();
  handlers.idle();
  expect(sources["spatial-pick"].data).toEqual(EMPTY);
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
  const { panel } = await clickingHome();
  // The click reads only the eastern tile; the building's box then reads both.
  let buildingReads = 0;
  queryRenderedFeatures.mockImplementation(((_where: unknown, options: { layers: string[] }) =>
    options.layers.includes("building-3d") ? (buildingReads++ ? [WEST_PART, EAST_PART] : [EAST_PART]) : []) as never);
  pointer("click", [5.1214, 52.0907]);
  await settle(panel);
  expect(lngRange(sources["spatial-pick"].data)).toEqual([5.119, 5.122]);
});

test("a picked building is read from the tiles MapLibre renders at the view's zoom, without a coarser stand-in", async () => {
  const { panel } = await clickingHome();
  // Past the source's zoom 14 MapLibre cuts its tiles into zoom 18 tiles, and features carry those.
  buildingsUnderPointer([
    { _z: 17, _x: 67400, _y: 43241, geometry: hallPart(5.1, 5.13) },
    { _z: 18, _x: 134801, _y: 86482, geometry: TOWER },
  ]);
  pointer("click", [5.1214, 52.0907]);
  await settle(panel);
  expect(sources["spatial-pick"].data).toEqual(TOWER);
});

// Synthetic buildings beside the site centre, a home and the one next door; each centre is its middle.
const houseBetween = (west: number, east: number) => ({
  type: "Polygon",
  coordinates: [[[west, 52.0001], [east, 52.0001], [east, 52.0002], [west, 52.0002], [west, 52.0001]]],
});
const HOUSE = houseBetween(5.0001, 5.0003);
const NEXT_DOOR = houseBetween(5.0004, 5.0006);
// About 11 km north of both.
const FAR_HOME = { latitude: 52.1, longitude: 5 };

// On a floor, Align is pressed and the house's south wall clicked; the site then has the saved direction.
const alignOnHouse = async (homeLocation: Mount["homeLocation"]) => {
  let bearing: number | null = null;
  const mounted = mountPanel({ homeLocation, site: () => ({ bearing_deg: bearing }), reply: searchingAnd() });
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await settle(mounted.panel);
  buttonNamed(mounted.panel, "No floor")!.click();
  await settle(mounted.panel);
  buildingsUnderPointer([{ geometry: HOUSE }]);
  buttonNamed(mounted.panel, "Align")!.click();
  await settle(mounted.panel);
  pointer("click", [5.0002, 52.0001]);
  const [saved] = mounted.connection.sendMessagePromise.mock.calls.filter(([message]) => message.type === "spatial/site/update");
  bearing = saved[0].bearing_deg as number;
  await onUpdateOf(mounted.connection)();
  await settle(mounted.panel);
  return mounted;
};

// While the map's outline is offered, a click on the house next door picks it instead.
const repickNextDoor = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(guideText(panel)).toMatch(/^Use the map's outline\?/));
  buildingsUnderPointer([{ geometry: NEXT_DOOR }]);
  pointer("click", [5.0005, 52.00015]);
  await settle(panel);
};

test.each([
  ["Align asks for the middle of the building it was clicked on", async () => await alignOnHouse(FAR_HOME), [5.0002, 52.00015]],
  [
    "a re-pick before the outline is stored asks again, for the new building's middle",
    async () => {
      const mounted = await alignOnHouse(FAR_HOME);
      await repickNextDoor(mounted.panel);
      return mounted;
    },
    [5.0005, 52.00015],
  ],
])("%s; the question waits for its answer, Move writes it and Undo the old home", async (_, act, [lon, lat]) => {
  const { connection } = await act();
  await vi.waitFor(() => expect(toasts.at(-1)?.action?.text).toBe("Move"));
  const question = toasts.at(-1)!;
  expect(question.message).toMatch(/^Move Home Assistant's home here\? The home pin is 1\d\.\d km away$/);
  expect(question).toMatchObject({ duration: -1, dismissable: true });
  question.action!.action();
  await vi.waitFor(() => expect(toasts.at(-1)).toMatchObject({ message: "Home location moved", action: { text: "Undo" } }));
  toasts.at(-1)!.action!.action();
  await vi.waitFor(() => expect(homeWrites(connection)).toHaveLength(2));
  const [moved, back] = homeWrites(connection) as unknown as { latitude: number; longitude: number }[];
  expect(moved.latitude).toBeCloseTo(lat, 5);
  expect(moved.longitude).toBeCloseTo(lon, 5);
  expect(back).toEqual({ type: "config/core/update", ...FAR_HOME });
});

test("without a home location, Align offers the building's middle as the home", async () => {
  const { connection } = await alignOnHouse({});
  await vi.waitFor(() => expect(toasts.map((toast) => [toast.message, toast.action?.text])).toEqual([["Use this as Home Assistant's home?", "Use as home"]]));
  toasts[0].action!.action();
  await vi.waitFor(() => expect(homeWrites(connection)).toHaveLength(1));
});

test.each([
  [
    "a click on a building before Align",
    async () => {
      const { panel } = await clickingHome();
      buildingsUnderPointer([{ geometry: TOWER }]);
      pointer("click", [5.1214, 52.0907]);
      await settle(panel);
      expect(sources["spatial-pick"].data).toEqual(TOWER);
    },
  ],
  [
    "a search pick on an aligned site far from the home",
    async () => {
      const { panel } = await openSearch(searchingAnd([DOMTOREN]));
      await searchAndPick(panel);
      expect(fitBounds).toHaveBeenCalled();
    },
  ],
])("%s asks nothing about the home", async (_, act) => {
  await act();
  expect(toasts).toEqual([]);
});