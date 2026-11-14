// @vitest-environment happy-dom
// Checks the panel against a fake MapLibre and a scripted Home Assistant connection.
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  buttonNamed,
  buttonsIn,
  chooseFromMenu,
  headerButton,
  fitBounds,
  floorButtonNames,
  handlers,
  layers,
  mapCreated,
  guideText,
  toastMessages,
  toasts,
  onUpdateOf,
  mountPanel,
  queryRenderedFeatures,
  resetFakes,
  rooms,
  setBearing,
  setStyle,
  siteReply,
  settle,
  zoomIn,
  zoomOut,
  easeTo,
  fakeMapLibre,
  floorEntry,
  jumpTo,
  liveMarkers,
  mapFieldOfViewNow,
  touchZoomRotate,
  SITE,
  sources,
  unprojectPixel,
} from "./panel-harness";
import { US_UNIT_M, siteFrameData } from "./site-frame-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import { CARD_FIELD_OF_VIEW_DEG } from "../src/floor-stack";
import { PlanFrame } from "../src/site-frame";
import "../src/spatial-panel";

afterEach(resetFakes);

// About 14 m x 11 m, counter-clockwise.
const HOUSE = {
  type: "Polygon",
  coordinates: [[[5, 52], [5.0002, 52], [5.0002, 52.0001], [5, 52.0001], [5, 52]]],
};
// Aligned with an outline and no areas: nothing left to draw, so the panel opens on All.
const DONE_SITE = { outline: HOUSE };

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

test("an empty plan opens on No floor with its step, not a separate no-rooms message", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(guideText(panel)).toBe("Draw the outline of your home Click each corner; click the first corner to finish. Or click another building."));
  expect(buttonNamed(panel, "No floor")!.getAttribute("aria-pressed")).toBe("true");
  expect(panel.shadowRoot!.textContent).not.toContain("No rooms yet");
});

test("the panel says so when the map cannot load", async () => {
  const { panel } = mountPanel({
    reply: async () => {
      throw new Error("connection lost");
    },
  });
  await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain("Map could not load"));
});

test("the panel loads the MapLibre worker from next to its own bundle", async () => {
  mountPanel();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  // Here the panel module is the source file; in Home Assistant it is the served bundle.
  expect(fakeMapLibre.setWorkerUrl).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/.*\/src\/maplibre-gl-worker\.js$/));
});

test("leaving the panel during startup leaves nothing behind", async () => {
  vi.useFakeTimers();
  const pending: (() => void)[] = [];
  const { panel, connection, listeners, unsubscribe, unsubscribeEvents } = mountPanel({
    reply: () => new Promise((resolve) => pending.push(() => resolve(undefined))),
  });
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

test("the panel has a header, the editing tools and the area strip; the card has none of them", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("spatial-panel-header")).not.toBeNull());
  await settle(panel);
  expect(panel.shadowRoot!.querySelector("spatial-panel-header")!.shadowRoot!.querySelector("[role=heading]")?.textContent).toBe("Floor plan");
  for (const name of ["Draw", "Select", "Undo", "Redo", "Remove shape"]) expect(buttonNamed(panel, name)).toBeDefined();
  expect(panel.shadowRoot!.querySelector("spatial-area-strip")).not.toBeNull();
  const card = mountPanel({ card: true }).panel;
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalledTimes(2));
  await settle(card);
  expect(card.shadowRoot?.querySelector("spatial-panel-header")).toBeNull();
  expect(card.shadowRoot?.querySelector("spatial-area-strip")).toBeNull();
  for (const name of ["Align", "Draw", "Select", "Undo", "Redo", "Remove shape"]) expect(buttonNamed(card, name)).toBeUndefined();
});

const room = (floor_id: string | null, level: number | null) => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [[[5, 52], [5.0001, 52], [5.0001, 52.0001], [5, 52]]] },
  properties: { floor_id, level },
});

test("the card has one button per floor in the rooms, named by Home Assistant", async () => {
  const { panel } = mountPanel({
    geojson: rooms(room("loft", 1), room("ground", 0), room("annex", 0), room(null, null)),
    hassFloors: { ground: { name: "Ground floor" }, loft: { name: "Loft" } },
    card: true,
  });
  await vi.waitFor(() =>
    expect(floorButtonNames(panel)).toEqual(["All", "Ground floor", "annex", "Loft", "No floor"]),
  );
});

test("an update with a new site bearing turns the map", async () => {
  let bearing = 0;
  const { connection } = mountPanel({ site: () => ({ bearing_deg: bearing, outline: HOUSE }) });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  bearing = 90;
  const [[onUpdate]] = connection.subscribeMessage.mock.calls as unknown as [[() => Promise<void>]];
  await onUpdate();
  // Site bearing 90 lies right at map bearing 0; All looks from the front corner, 45 degrees less.
  expect(setBearing).toHaveBeenCalledWith(315);
});

test("the panel follows changes through spatial/subscribe, open to non-admin users", async () => {
  const { connection } = mountPanel();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(connection.subscribeMessage).toHaveBeenCalledWith(expect.any(Function), {
    type: "spatial/subscribe",
  });
});

const stackKinds = () =>
  (sources.stack.data as { features: { properties: { kind: string } }[] }).features.map((f) => f.properties.kind);

test("All draws the stack's outline, rooms and walls from base_m to top_m instead of the ground outline, and a floor the other way round", async () => {
  const { panel } = mountPanel({ geojson: TWO_FLOORS, site: DONE_SITE });
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  for (const [id, kind] of [
    ["stack-outline", "outline"],
    ["stack-rooms", "room"],
    ["stack-room-edges", "edge"],
  ]) {
    expect(layers.find((layer) => layer.id === id)).toMatchObject({
      type: "fill-extrusion",
      source: "stack",
      filter: ["==", ["get", "kind"], kind],
      layout: { visibility: "visible" },
      paint: { "fill-extrusion-base": ["get", "base_m"], "fill-extrusion-height": ["get", "top_m"] },
    });
  }
  expect(new Set(stackKinds())).toEqual(new Set(["outline", "room", "edge"]));
  const visibility = (id: string) => layers.find((layer) => layer.id === id)?.layout?.visibility;
  expect(visibility("spatial-outline")).toBe("none");
  await settle(panel);
  buttonNamed(panel, "No floor")!.click();
  await settle(panel);
  expect(visibility("stack-outline")).toBe("none");
  expect(visibility("spatial-outline")).toBe("visible");
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

const TWO_FLOORS = rooms(square("ground", 5, 52), square("first", 6, 53));

const mountStatic = (floor: string, geojson: () => object = () => TWO_FLOORS) => mountPanel({ geojson, card: true, floor });

const buttons = (panel: HTMLElement) => buttonsIn(panel.shadowRoot!).length;

test("without a floor the map is interactive, with floor buttons", async () => {
  const { panel } = mountPanel({ card: true });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(mapCreated.mock.calls[0][0]).not.toHaveProperty("interactive", false);
  expect(buttons(panel)).toBeGreaterThan(0);
  expect(fitBounds).not.toHaveBeenCalled();
});

const floorLabels = () =>
  liveMarkers()
    .filter((marker) => marker.element.className === "floor-label")
    .map((marker) => [...marker.element.children].map((line) => line.textContent).join(", "));

test("a fixed floor all shows a static stack from the front corner, each floor named by Home Assistant", async () => {
  const { panel } = mountPanel({
    geojson: () => TWO_FLOORS,
    card: true,
    floor: "all",
    hassFloors: { ground: { name: "Ground floor" }, first: { name: "First floor" } },
  });
  await vi.waitFor(() => expect(jumpTo).toHaveBeenCalled());
  expect(mapCreated.mock.calls[0][0]).toMatchObject({ interactive: false });
  expect(buttons(panel)).toBe(0);
  expect(fitBounds).not.toHaveBeenCalled();
  // Site bearing 0 puts the site's x-axis to the right at map bearing 270; the front corner is 45 degrees less.
  expect(jumpTo.mock.calls[0][0]).toMatchObject({ bearing: 225, pitch: 55 });
  expect(floorLabels()).toEqual(["Ground floor, 1 room", "First floor, 1 room"]);
});

test("the card neither turns nor tilts and looks from afar; the panel's All view may orbit in MapLibre's perspective", async () => {
  mountPanel({ card: true });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(mapCreated.mock.calls[0][0]).toMatchObject({ dragRotate: false, touchPitch: false });
  expect(touchZoomRotate.isRotationEnabled()).toBe(false);
  expect(mapFieldOfViewNow).toBe(CARD_FIELD_OF_VIEW_DEG);
  resetFakes();
  mountPanel();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(mapCreated.mock.calls[0][0]).toMatchObject({ dragRotate: true, touchPitch: true });
  // The guide asks to draw a room, so Draw is current, which holds the map still.
  expect(touchZoomRotate.isRotationEnabled()).toBe(false);
  expect(mapFieldOfViewNow).toBe(36.87);
});

test("leaving All lays the plan flat with the wall horizontal and drops the floor labels; the compass in All returns to the front corner", async () => {
  const { panel } = mountPanel({ geojson: TWO_FLOORS, floors: [floorEntry("ground", "Ground floor")], site: DONE_SITE });
  await vi.waitFor(() => expect(jumpTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 225, pitch: 55 })));
  expect(floorLabels()).toEqual(["Ground floor, 1 room", "first, 1 room"]);
  await settle(panel);
  buttonNamed(panel, "Ground floor")!.click();
  await settle(panel);
  expect(easeTo).toHaveBeenLastCalledWith({ pitch: 0, bearing: 270 });
  expect(floorLabels()).toEqual([]);
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  buttonNamed(panel, "Face the house")!.click();
  expect(easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 225, pitch: 55 }));
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
  geojson = rooms(square("ground", 4, 51));
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

const UNALIGNED = { site: { bearing_deg: null } };
const ALIGN_LINE = "Click the front wall of your home The view turns so that wall lies flat.";
const SHED = {
  type: "Polygon",
  coordinates: [[[5, 52], [5.000001, 52], [5.000001, 52.000001], [5, 52.000001], [5, 52]]],
};
const EAST_WALL = { lng: 5.00019, lat: 52.00005 };

const click = (lngLat = EAST_WALL) =>
  handlers.click({ point: { x: 1, y: 2 }, lngLat });

// All floors is a view only, so Align needs a floor. Align is a tool until the site has a direction, then a menu entry.
const startAligning = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  await settle(panel);
  buttonNamed(panel, "No floor")!.click();
  await settle(panel);
  const tool = buttonNamed(panel, "Align");
  if (tool) tool.click();
  else await chooseFromMenu(panel, "Change alignment");
  await settle(panel);
};

// Opens the header menu, reads its entries and closes it again.
const menuEntries = async (panel: HTMLElement) => {
  headerButton(panel, "More options")!.click();
  await settle(panel);
  const header = panel.shadowRoot!.querySelector("spatial-panel-header")!.shadowRoot!;
  const entries = [...header.querySelectorAll("[role=menuitem]")].map((entry) => entry.textContent?.trim());
  headerButton(panel, "More options")!.click();
  await settle(panel);
  return entries;
};

const toolbarButtonNames = (panel: HTMLElement) =>
  buttonsIn(panel.shadowRoot!.querySelector("spatial-editor-toolbar")!.shadowRoot!).map(
    (button) => button.getAttribute("aria-label") ?? button.textContent?.trim(),
  );

const updates = (connection: { sendMessagePromise: { mock: { calls: [{ type: string }][] } } }) =>
  connection.sendMessagePromise.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "spatial/site/update");


test("Align on an empty plan sends the bearing and the wall's left end as origin, and ends the mode", async () => {
  const { panel, connection } = mountPanel(UNALIGNED);
  // The buildings layer is one MultiPolygon per tile.
  const tile = { type: "MultiPolygon", coordinates: [SHED.coordinates, HOUSE.coordinates] };
  queryRenderedFeatures.mockReturnValue([{ geometry: tile, properties: {} }]);
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  click();
  expect(updates(connection)).toEqual([]);
  await startAligning(panel);
  await vi.waitFor(() => expect(guideText(panel)).toMatch(ALIGN_LINE));
  click();
  expect(queryRenderedFeatures).toHaveBeenLastCalledWith({ x: 1, y: 2 }, { layers: ["building-3d"] });
  // Which fields and their values are alignFields' rule; here only that the empty plan reaches it.
  const [saved] = updates(connection);
  expect(Object.keys(saved)).toEqual(["type", "bearing_deg", "origin"]);
  click();
  expect(updates(connection)).toHaveLength(1);
  await vi.waitFor(() => expect(guideText(panel)).not.toBe(ALIGN_LINE));
});

test("a pick then Align offers the outline of the building Align was clicked on, without reading the map again", async () => {
  let bearing: number | null = null;
  const { panel, connection } = mountPanel({ site: () => ({ bearing_deg: bearing }) });
  queryRenderedFeatures.mockImplementation(((_where: unknown, options: { layers: string[] }) =>
    options.layers.includes("building-3d") ? [{ geometry: HOUSE }] : []) as never);
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await settle(panel);
  buttonNamed(panel, "No floor")!.click();
  await settle(panel);
  click();
  await settle(panel);
  expect(guideText(panel)).toBe(`${ALIGN_LINE} Pick another building`);
  click();
  queryRenderedFeatures.mockReturnValue([]);
  bearing = (updates(connection)[0] as unknown as { bearing_deg: number }).bearing_deg;
  await onUpdateOf(connection)();
  await vi.waitFor(() => expect(guideText(panel)).toMatch(/^Use the map's outline\?/));
});

test("Align is a tool until the first Align; then it leaves the toolbar and the header menu's Change alignment starts it", async () => {
  const { panel } = mountPanel(UNALIGNED);
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  await startAligning(panel);
  expect(pressedTools(panel)).toEqual(["Align"]);
  expect(await menuEntries(panel)).toEqual(["Clear floor", "Start over"]);
  click();
  await settle(panel);
  expect(toolbarButtonNames(panel)).toEqual(["Draw", "Select", "Undo", "Redo", "Remove shape"]);
  await chooseFromMenu(panel, "Change alignment");
  expect(guideText(panel)).toBe(ALIGN_LINE);
  expect(buttonNamed(panel, "Show map")!.disabled).toBe(true);
});

test("before the site is read neither the toolbar nor the menu offers Align", async () => {
  let answerSite: ((site: object) => void) | undefined;
  const { panel } = mountPanel({
    reply: async (message) =>
      message.type === "spatial/site" ? new Promise((resolve) => (answerSite = resolve)) : undefined,
  });
  await vi.waitFor(() => expect(answerSite).toBeDefined());
  // Any render while the site is pending, such as one from a changed hass.
  (panel as unknown as { requestUpdate(): void }).requestUpdate();
  await settle(panel);
  expect(buttonNamed(panel, "Draw")).toBeDefined();
  expect(buttonNamed(panel, "Align")).toBeUndefined();
  expect(await menuEntries(panel)).toEqual(["Clear floor", "Start over"]);
  answerSite!(siteReply({ bearing_deg: null }));
  await vi.waitFor(() => expect(buttonNamed(panel, "Align")).toBeDefined());
});

test("the header menu is disabled in All, closes on Escape giving focus back, and on a press outside", async () => {
  const { panel } = mountPanel({ site: DONE_SITE });
  await vi.waitFor(() => expect(headerButton(panel, "More options")).toBeDefined());
  await settle(panel);
  const more = headerButton(panel, "More options")!;
  const menu = () => panel.shadowRoot!.querySelector("spatial-panel-header")!.shadowRoot!.querySelector("[role=menu]");
  more.click();
  await settle(panel);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(buttonNamed(panel, "Change alignment")!.disabled).toBe(true);
  const focus = vi.spyOn(more, "focus");
  const editorKeys = vi.fn();
  window.addEventListener("keydown", editorKeys);
  menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  window.removeEventListener("keydown", editorKeys);
  await settle(panel);
  expect(menu()).toBeNull();
  expect(editorKeys).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalled();
  more.click();
  await settle(panel);
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
  await settle(panel);
  expect(menu()).toBeNull();
});

const ROOM_FEED = rooms({ type: "Feature", id: "kitchen", geometry: SHED, properties: { floor_id: null, level: null } });

test.each([
  ["a footprint", ROOM_FEED, null],
  ["an outline", EMPTY, SHED],
])("Align with %s sends only the bearing", async (_name, feed, outline) => {
  const { panel, connection } = mountPanel({ geojson: feed, site: { outline } });
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  await startAligning(panel);
  click();
  const [saved] = updates(connection);
  expect(Object.keys(saved)).toEqual(["type", "bearing_deg"]);
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
  buttonNamed(panel, "Select")!.click();
  await vi.waitFor(() => expect(sources["spatial-wall"].data).toEqual(EMPTY));
});

test("in Align a click without a building saves nothing", async () => {
  // With an outline stored, Select picks no building, so the next click reads none.
  const { panel, connection } = mountPanel({ site: DONE_SITE });
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(toasts).toEqual([{ message: "No building here" }]));
  const buildingQueries = () =>
    queryRenderedFeatures.mock.calls.filter((call) => JSON.stringify(call).includes("building-3d")).length;
  const queried = buildingQueries();
  click();
  expect(buildingQueries()).toBe(queried);
  expect(updates(connection)).toEqual([]);
});

test.each([false, true])("the stored outline is drawn on start and after updates (card %s)", async (card) => {
  let outline: object | null = HOUSE;
  const { connection } = mountPanel({ site: () => ({ outline }), card });
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

test("in Align a save Spatial refuses turns the map back and shows its reason, without Retry", async () => {
  const refusal = { code: "outside_outline", message: "Beyond the building outline: kitchen" };
  const { panel } = mountPanel({
    reply: async (message) => {
      if (message.type === "spatial/site/update") throw refusal;
    },
  });
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Rooms must stay inside the outline"]));
  expect(toasts[0].action).toBeUndefined();
  expect(easeTo).toHaveBeenLastCalledWith({ bearing: 270 });
});

test("in Align a failed save turns the map back and offers Retry, which saves the same bearing again", async () => {
  let fail = true;
  const { panel, connection } = mountPanel({
    reply: async (message) => {
      if (message.type === "spatial/site/update" && fail) throw new Error("connection lost");
    },
  });
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  const [failure] = toasts;
  expect(failure).toMatchObject({ action: { text: "Retry" }, duration: -1, dismissable: true });
  // The fixture's stored bearing gives the same map bearing as the clicked wall.
  expect(easeTo).toHaveBeenLastCalledWith({ bearing: 270 });
  fail = false;
  failure.action!.action();
  await vi.waitFor(() => expect(updates(connection)).toHaveLength(2));
  expect(updates(connection)[1]).toEqual(updates(connection)[0]);
});

test("in Align a save while Spatial is still starting says so and offers Retry", async () => {
  const { panel } = mountPanel({
    reply: async (message) => {
      if (message.type === "spatial/site/update") throw { code: "unknown_command", message: "Unknown command." };
    },
  });
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startAligning(panel);
  click();
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Spatial is still starting, try again in a moment"]));
  expect(toasts[0]).toMatchObject({ action: { text: "Retry" }, duration: -1, dismissable: true });
});

test("a toast replaced by another restarts the timer and keeps the chrome lifted until the second one ends", async () => {
  const { panel } = mountPanel(UNALIGNED);
  queryRenderedFeatures.mockReturnValue([]);
  await showNoFloor(panel);
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  vi.useFakeTimers();
  try {
    click();
    vi.advanceTimersByTime(2000);
    click();
    vi.advanceTimersByTime(2000);
    expect(panel.hasAttribute("toasting")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(panel.hasAttribute("toasting")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

const retryToast = async () => {
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  const { panel } = mountPanel({
    reply: async (message) => {
      if (message.type === "spatial/site/update") throw { code: "unknown_command", message: "Unknown command." };
    },
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startAligning(panel);
  await vi.waitFor(() => expect(guideText(panel)).toMatch(/^Click the front wall/));
  click();
  await vi.waitFor(() => expect(toasts[0]).toMatchObject({ duration: -1 }));
  return panel;
};

test("a toast that waits keeps the chrome lifted until its action runs", async () => {
  const panel = await retryToast();
  expect(panel.hasAttribute("toasting")).toBe(true);
  toasts[0].action!.action();
  expect(panel.hasAttribute("toasting")).toBe(false);
});

test("a toast that waits keeps the chrome lifted until the guide changes step", async () => {
  const panel = await retryToast();
  expect(panel.hasAttribute("toasting")).toBe(true);
  // The failed save left Align; asking for it again moves the guide to the align step.
  await chooseFromMenu(panel, "Change alignment");
  await settle(panel);
  expect(panel.hasAttribute("toasting")).toBe(false);
});

test("entering the align step frames the picked building above the strip's own place, not where a toast lifted it", async () => {
  queryRenderedFeatures.mockReturnValue([{ geometry: HOUSE }]);
  const { panel } = mountPanel(UNALIGNED);
  await showNoFloor(panel);
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  await vi.waitFor(() => expect(guideText(panel)).toMatch(/^Click your home/));
  // A stage 800 px tall; the strip is 72 px high at 712 px, and a toast has lifted it to 648 px.
  const root = panel.shadowRoot!;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
  root.querySelector(".stage")!.getBoundingClientRect = () => rect(0, 800);
  const strip = root.querySelector<HTMLElement>(".strip")!;
  strip.getBoundingClientRect = () => rect(648, 72);
  Object.defineProperty(strip, "offsetTop", { value: 712 });
  fitBounds.mockClear();
  // Picking the home turns Align on, which is the step that frames the building.
  click();
  await settle(panel);
  expect(fitBounds).toHaveBeenCalledTimes(1);
  expect(fitBounds.mock.calls[0][1]).toMatchObject({ padding: { top: 16, bottom: 112, left: 48, right: 48 } });
});

test("the header's Help opens a sheet of symbols and keys that Escape closes, giving focus back to Help", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("spatial-panel-header")).not.toBeNull());
  await settle(panel);
  const header = panel.shadowRoot!.querySelector("spatial-panel-header")!.shadowRoot!;
  const dialog = header.querySelector("dialog")!;
  const help = headerButton(panel, "Help")!;
  const focus = vi.spyOn(help, "focus");
  expect(dialog.open).toBe(false);
  help.click();
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("No shape yet");
  expect(dialog.textContent).toContain("Remove the active shape");
  expect(dialog.querySelector("a")).toMatchObject({ href: "https://github.com/BIM-Tools/ha-spatial", target: "_blank" });
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
  const editorKeys = vi.fn();
  window.addEventListener("keydown", editorKeys);
  dialog.dispatchEvent(escape);
  window.removeEventListener("keydown", editorKeys);
  expect(dialog.open).toBe(false);
  expect(editorKeys).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalled();
  help.click();
  headerButton(panel, "Close")!.click();
  expect(dialog.open).toBe(false);
  expect(focus).toHaveBeenCalledTimes(2);
});

test.each([
  [false, true],
  [true, false],
])("Help on a coarse pointer (%s) names Alt for placing without snapping: %s", async (coarse, named) => {
  const query = vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        matches: coarse && media === "(pointer: coarse)",
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("spatial-panel-header")).not.toBeNull());
  await settle(panel);
  const dialog = panel.shadowRoot!.querySelector("spatial-panel-header")!.shadowRoot!.querySelector("dialog")!;
  expect(dialog.textContent?.includes("Hold Alt to place without snapping")).toBe(named);
  query.mockRestore();
});

test("Align turns the map before the save is answered", async () => {
  let answerSave = () => {};
  const { panel } = mountPanel({
    reply: async (message) =>
      message.type === "spatial/site/update" ? new Promise<null>((resolve) => (answerSave = () => resolve(null))) : undefined,
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
  const { connection } = mountPanel({ card: true });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(connection.subscribeEvents).not.toHaveBeenCalled();
});

test("a unit system change uses the refetched frame", async () => {
  let frame = siteFrameData(SITE, 0);
  const { panel, connection } = mountPanel({ site: () => ({ frame }) });
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await showNoFloor(panel);
  buttonNamed(panel, "Draw")!.click();
  await settle(panel);
  frame = siteFrameData(SITE, 0, US_UNIT_M);
  await onUpdateOf(connection)();
  const mouse = (x: number, y: number) => {
    const [lng, lat] = unprojectPixel([x, y]);
    return { point: { x, y }, lngLat: { lng, lat }, originalEvent: { button: 0 }, preventDefault: vi.fn() };
  };
  for (const [x, y] of [
    [10.3, 0.2],
    [47.1, 0.4],
    [47.1, 31.7],
    [10.3, 0.2],
  ]) {
    handlers.click(mouse(x, y));
  }
  await vi.waitFor(() => expect(updates(connection)).toHaveLength(1));
  const [{ outline }] = updates(connection) as unknown as [{ outline: { coordinates: number[][][] } }];
  const inches = PlanFrame.fromSite(frame);
  for (const corner of outline.coordinates[0]) {
    for (const units of inches.toLatticeUnits(corner)) expect(Math.abs(units / 4 - Math.round(units / 4))).toBeLessThan(1e-6);
  }
});

const pressedTools = (panel: HTMLElement) =>
  ["Align", "Draw", "Select"].filter((name) => buttonNamed(panel, name)?.getAttribute("aria-pressed") === "true");

const showNoFloor = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(buttonNamed(panel, "No floor")).toBeDefined());
  buttonNamed(panel, "No floor")!.click();
  await settle(panel);
};

test("no tool is current before the first pick; after that exactly one is", async () => {
  const { panel } = mountPanel(UNALIGNED);
  await showNoFloor(panel);
  expect(pressedTools(panel)).toEqual([]);
  for (const name of ["Draw", "Draw", "Align"]) {
    buttonNamed(panel, name)!.click();
    await settle(panel);
    expect(pressedTools(panel)).toEqual([name]);
  }
});

test("in All floors every tool is disabled and none is pressed; Align ends there", async () => {
  const { panel } = mountPanel(UNALIGNED);
  await vi.waitFor(() => expect(buttonNamed(panel, "Align")).toBeDefined());
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  for (const name of ["Align", "Draw", "Select", "Undo", "Redo", "Remove shape"]) expect(buttonNamed(panel, name)!.disabled).toBe(true);
  expect(pressedTools(panel)).toEqual([]);
  await startAligning(panel);
  buttonNamed(panel, "All")!.click();
  buttonNamed(panel, "No floor")!.click();
  await settle(panel);
  expect(pressedTools(panel)).toEqual([]);
});

test("the selected floor is pressed and stays enabled", async () => {
  const { panel } = mountPanel({ site: DONE_SITE });
  await vi.waitFor(() => expect(buttonNamed(panel, "All")).toBeDefined());
  await settle(panel);
  expect(buttonNamed(panel, "All")!.getAttribute("aria-pressed")).toBe("true");
  await showNoFloor(panel);
  expect(buttonNamed(panel, "No floor")!.getAttribute("aria-pressed")).toBe("true");
  expect(buttonNamed(panel, "No floor")!.disabled).toBe(false);
  expect(buttonNamed(panel, "All")!.getAttribute("aria-pressed")).toBe("false");
});

const groundOnly = (style: { layers: { type: string }[] }) => style.layers.map((layer) => layer.type).join() === "background";

test.each([
  { name: "a card of all floors shows no map", floor: "all", showMap: undefined, map: false },
  { name: "a card of one floor keeps the map", floor: "ground", showMap: undefined, map: true },
  { name: "a card with floor buttons keeps the map", floor: undefined, showMap: undefined, map: true },
  { name: "show_map true shows it on all floors", floor: "all", showMap: true, map: true },
  { name: "show_map false hides it on one floor", floor: "ground", showMap: false, map: false },
])("the card's map: $name", async ({ floor, showMap, map }) => {
  mountPanel({ geojson: TWO_FLOORS, card: true, floor, showMap });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(groundOnly(mapCreated.mock.calls[0][0].style)).toBe(!map);
});

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
  buttonNamed(panel, "Select")!.click();
  await settle(panel);
  await vi.waitFor(() => expect(setStyle).toHaveBeenCalledTimes(2));
  expect(groundOnly(setStyle.mock.calls[1][0])).toBe(true);
  expect(buttonNamed(panel, "Show map")!.disabled).toBe(false);
});

test("the compass turns with the map", async () => {
  let bearing = 0;
  const { panel, connection } = mountPanel({ site: () => ({ bearing_deg: bearing, outline: HOUSE }) });
  await vi.waitFor(() => expect(handlers.rotate).toBeDefined());
  await settle(panel);
  const needle = () => buttonNamed(panel, "Face the house")!.querySelector("ha-svg-icon")!.getAttribute("style");
  // Site bearing 0 turns the map to 270, and All looks from the front corner, 45 degrees less.
  expect(needle()).toContain("rotate(-225deg)");
  bearing = 90;
  await onUpdateOf(connection)();
  handlers.rotate();
  await settle(panel);
  expect(needle()).toContain("rotate(-315deg)");
});

test("before any Align the map opens north up and the compass faces north, also in Draw", async () => {
  const { panel } = mountPanel(UNALIGNED);
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  // The plan opens flat on No floor, where Align is the next step.
  expect(mapCreated.mock.calls[0][0]).toMatchObject({ bearing: 0, pitch: 0 });
  await showNoFloor(panel);
  buttonNamed(panel, "Draw")!.click();
  await settle(panel);
  expect(buttonNamed(panel, "Face the house")).toBeUndefined();
  expect(buttonNamed(panel, "Face north")!.disabled).toBe(false);
  buttonNamed(panel, "Face north")!.click();
  expect(easeTo).toHaveBeenLastCalledWith({ bearing: 0 });
});

test("before any Align a static card shows its stack from the front corner of the north-up plan", async () => {
  mountPanel({ ...UNALIGNED, geojson: TWO_FLOORS, card: true, floor: "all" });
  await vi.waitFor(() => expect(jumpTo).toHaveBeenCalled());
  expect(jumpTo.mock.calls[0][0]).toMatchObject({ bearing: 315 });
});

test("a stored bearing of 0 is a wall direction too: the compass returns the view to 270, also in Draw", async () => {
  const { panel } = mountPanel({ site: DONE_SITE });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(mapCreated.mock.calls[0][0]).toMatchObject({ bearing: 225 });
  await showNoFloor(panel);
  buttonNamed(panel, "Draw")!.click();
  await settle(panel);
  expect(buttonNamed(panel, "Face the house")!.disabled).toBe(false);
  buttonNamed(panel, "Face the house")!.click();
  expect(easeTo).toHaveBeenLastCalledWith({ bearing: 270 });
});

test("zoom in and zoom out zoom the map", async () => {
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  await settle(panel);
  buttonNamed(panel, "Zoom in")!.click();
  buttonNamed(panel, "Zoom out")!.click();
  expect(zoomIn).toHaveBeenCalledTimes(1);
  expect(zoomOut).toHaveBeenCalledTimes(1);
});

test("a style that fails to load is asked for again on the next update", async () => {
  const { panel } = mountPanel({ site: DONE_SITE });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  await settle(panel);
  buttonNamed(panel, "Show map")!.click();
  await vi.waitFor(() => expect(setStyle).toHaveBeenCalledTimes(1));
  vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  buttonNamed(panel, "Show map")!.click();
  await vi.waitFor(() => expect(errors).toHaveBeenCalled());
  expect(setStyle).toHaveBeenCalledTimes(1);
  await showNoFloor(panel);
  await vi.waitFor(() => expect(setStyle).toHaveBeenCalledTimes(2));
  expect(groundOnly(setStyle.mock.calls[1][0])).toBe(false);
  errors.mockRestore();
});

test("Back opens Spatial's integration page in Home Assistant, and is a link for a new tab", async () => {
  history.replaceState(null, "", "/spatial");
  const changed = vi.fn();
  window.addEventListener("location-changed", changed);
  const { panel } = mountPanel();
  await settle(panel);
  const back = headerButton(panel, "Back to Spatial") as HTMLElement & { href?: string };
  expect(back.href).toBe("/config/integrations/integration/spatial");
  back.click();
  expect(location.pathname).toBe("/config/integrations/integration/spatial");
  expect(changed).toHaveBeenCalledTimes(1);
  window.removeEventListener("location-changed", changed);
});

test("on a phone the floors are chips under the header, the tools a bottom bar, and the map toggle round", async () => {
  const phone = { matches: true, addEventListener: () => {}, removeEventListener: () => {} };
  const query = vi.spyOn(window, "matchMedia").mockReturnValue(phone as unknown as MediaQueryList);
  const { panel } = mountPanel();
  await vi.waitFor(() => expect(buttonNamed(panel, "Draw")).toBeDefined());
  await settle(panel);
  const root = panel.shadowRoot!;
  expect(toolbarButtonNames(panel)).toEqual(["Draw", "Select", "Undo", "Redo", "Remove shape"]);
  expect(root.querySelector("spatial-floor-selector")?.hasAttribute("chips")).toBe(true);
  expect(root.querySelector(".stage spatial-floor-selector")).toBeNull();
  expect(root.querySelector("spatial-editor-toolbar")?.hasAttribute("bar")).toBe(true);
  expect(root.querySelector("spatial-map-stack")?.hasAttribute("round")).toBe(true);
  expect(buttonNamed(panel, "Zoom in")).toBeUndefined();
  expect(buttonNamed(panel, "Undo")?.textContent?.trim()).toBe("Undo");
  query.mockRestore();
});

const paintOf = (layerId: string) => layers.find((layer) => layer.id === layerId)?.paint;

test("the rooms are painted from the theme's primary colour and follow a changed theme", async () => {
  const { panel } = mountPanel();
  panel.style.setProperty("--primary-color", "rgb(0, 128, 0)");
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  expect(paintOf("areas-2d")).toEqual({ "fill-color": "rgba(0,128,0,0.1)" });
  expect(paintOf("areas-outline")).toMatchObject({ "line-color": "rgba(0,128,0,0.7)", "line-width": 1.5 });
  panel.style.setProperty("--primary-color", "rgb(200, 0, 100)");
  panel.hass = { ...panel.hass, themes: { darkMode: false } };
  await vi.waitFor(() => expect(paintOf("areas-2d")).toEqual({ "fill-color": "rgba(200,0,100,0.1)" }));
  expect(paintOf("spatial-active")).toMatchObject({ "line-color": "rgba(200,0,100,1)", "line-width": 2 });
});


// Home Assistant can hand over its themes before it has resolved darkMode, and then resolve it much later.
test("a dark Home Assistant without darkMode in its themes gets the dark map, and the light one once it says light", async () => {
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockClear();
  const query = vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        matches: media === "(prefers-color-scheme: dark)",
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const unresolved = { default_theme: "default", default_dark_theme: null, themes: {} };
  const { panel } = mountPanel();
  panel.style.setProperty("--primary-color", "rgb(0, 128, 0)");
  panel.hass = { ...panel.hass, themes: unresolved };
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  expect(fetchMock).toHaveBeenLastCalledWith("/static/map/dark.json");
  handlers["style.load"]();
  expect(paintOf("areas-2d")).toEqual({ "fill-color": "rgba(0,128,0,0.12)" });
  panel.hass = { ...panel.hass, themes: { ...unresolved, darkMode: false } };
  await vi.waitFor(() => expect(setStyle).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenLastCalledWith("/static/map/light.json");
  query.mockRestore();
});

test("before the first pick no tool is current", async () => {
  const { panel } = mountPanel(UNALIGNED);
  await showNoFloor(panel);
  expect(pressedTools(panel)).toEqual([]);
});

test("Spatial's own toast lifts the bottom chrome until its duration ends", async () => {
  const { panel } = mountPanel(UNALIGNED);
  queryRenderedFeatures.mockReturnValue([]);
  await showNoFloor(panel);
  await vi.waitFor(() => expect(handlers.click).toBeDefined());
  vi.useFakeTimers();
  try {
    click();
    expect(panel.hasAttribute("toasting")).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(panel.hasAttribute("toasting")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
