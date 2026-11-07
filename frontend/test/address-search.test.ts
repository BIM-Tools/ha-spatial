// @vitest-environment happy-dom
// Checks the panel's address search wiring: when the card opens, what it sends, what it shows and where the map goes.
import { afterEach, expect, test, vi } from "vitest";
import { buttonNamed, fitBounds, flyTo, mapCreated, mountPanel, type Reply, resetFakes, settle } from "./panel-harness";

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

const openSearch = async (reply?: Reply) => {
  const mounted = mountPanel({ reply });
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
  const { panel } = mountPanel({ homeLocation });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  await settle(panel);
  expect(card(panel) !== null).toBe(globe);
  expect(mapCreated.mock.calls[0][0].zoom < 5).toBe(globe);
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
