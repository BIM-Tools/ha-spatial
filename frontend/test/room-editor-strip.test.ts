// @vitest-environment happy-dom
// Checks the area strip in the panel: floors, pills, names, new areas and the guide.
import { afterEach, expect, test, vi } from "vitest";
import {
  buttonNamed,
  buttonsIn,
  handlers,
  floorButtonNames,
  liveMarkers,
  layers,
  mapCreated,
  guideText,
  toastMessages,
  toasts,
  onUpdateOf,
  queryRenderedFeatures,
  settle,
  resetFakes,
} from "./panel-harness";
import {
  mountEditor,
  chips,
  activeFilter,
  chipNames,
  activeChip,
  chip,
  showFloor,
  startDrawing,
  mouse,
  tap,
  sent,
  saves,
  pixelShape,
  feature,
  startSelecting,
  renameField,
  toolPressed,
  hoverFilter,
  tapRoom,
  handleCorners,
  sideButtons,
  buildingHighlight,
  key,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

test("the panel's floor buttons come from the floor registry in level order, with No floor, and the toolbar has the tools", async () => {
  const { panel } = mountEditor(async (message) =>
    message.type === "config/floor_registry/list"
      ? [
          { floor_id: "loft", name: "Loft", level: 1 },
          { floor_id: "ground", name: "Ground floor", level: 0 },
        ]
      : undefined,
  );
  await vi.waitFor(() => expect(floorButtonNames(panel)).toEqual(["All", "Ground floor", "Loft", "No floor"]));
  for (const name of ["Draw", "Select", "Undo", "Redo"]) expect(buttonNamed(panel, name)).toBeDefined();
});
test("an update that removes the active area makes the first area in the order active", async () => {
  const { panel, connection, setRegistry, setFeed } = mountEditor();
  await startDrawing(panel);
  chip(panel, "Kitchen").click();
  await settle(panel);
  setRegistry([
    { area_id: "bath", name: "Bath", floor_id: "ground" },
    { area_id: "hall", name: "Hall", floor_id: "ground" },
  ]);
  setFeed([]);
  await onUpdateOf(connection)();
  await vi.waitFor(() => expect(chipNames(panel)).toEqual(["Building", "Bath", "Hall", "New area"]));
  expect(activeChip(panel)).toBe("Bath");
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "bath"]);
});

test("a failed registry read does not stop the map", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { panel } = mountEditor(async (message) => {
    if (message.type === "config/area_registry/list") throw new Error("connection lost");
    return undefined;
  });
  await vi.waitFor(() => expect(mapCreated).toHaveBeenCalled());
  expect(guideText(panel)).not.toContain("Map could not load");
  errors.mockRestore();
});

test("on a floor each room is labelled with its area's icon, name and net m² from the feed", async () => {
  const { panel, connection, setFeed } = mountEditor();
  const living = pixelShape([0, 0], [200, 0], [200, 120], [0, 120]);
  await startSelecting(panel);
  (panel as HTMLElement & { hass: object }).hass = {
    ...(panel as HTMLElement & { hass: object }).hass,
    areas: { kitchen: { name: "Kitchen", icon: "mdi:stove" } },
  };
  setFeed([feature("kitchen", living, 21.46)]);
  await onUpdateOf(connection)();
  const label = liveMarkers().find((marker) => marker.element.dataset.area === "kitchen")!.element;
  expect(label.querySelector("ha-icon")?.getAttribute("icon")).toBe("mdi:stove");
  expect(label.querySelector(".name")?.textContent).toBe("Kitchen");
  expect(label.querySelector(".size")?.textContent).toBe("21.5 m²");
});

test("choosing a pill without a shape picks Draw; a pill with one keeps the tool", async () => {
  const { panel } = mountEditor();
  await startSelecting(panel);
  chip(panel, "Kitchen").click();
  await settle(panel);
  expect(toolPressed(panel, "Select")).toBe("true");
  chip(panel, "Hall").click();
  await settle(panel);
  expect(toolPressed(panel, "Draw")).toBe("true");
  expect(activeChip(panel)).toBe("Hall");
});

test("New area creates the area on the floor at once, makes it active in Draw and opens its name", async () => {
  const { panel, connection } = mountEditor();
  await startSelecting(panel);
  chip(panel, "New area").click();
  await vi.waitFor(() => expect(renameField(panel)?.value).toBe("Room 1"));
  expect(sent(connection, "config/area_registry/create")).toEqual([
    { type: "config/area_registry/create", name: "Room 1", floor_id: "ground" },
  ]);
  expect(toolPressed(panel, "Draw")).toBe("true");
  expect(guideText(panel)).toBe("Draw Room 1 2 of 4 on the Ground floor");
  const field = renameField(panel)!;
  field.value = "Study";
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() =>
    expect(sent(connection, "config/area_registry/update")).toEqual([
      { type: "config/area_registry/update", area_id: "room_1", name: "Study" },
    ]),
  );
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  expect(Object.keys(saves(connection)[0].areas)).toEqual(["room_1"]);
});

const litControls = (panel: HTMLElement) =>
  buttonsIn(panel.shadowRoot!)
    .filter((button) => button.classList.contains("lit"))
    .map((button) => button.textContent?.trim());

test("the panel opens on the floor with work left and shows only its step, one line, with Draw current", async () => {
  const { panel, connection } = mountEditor();
  await showFloor(panel);
  expect(buttonNamed(panel, "Ground floor")!.getAttribute("aria-pressed")).toBe("true");
  expect(panel.shadowRoot!.querySelectorAll(".guide")).toHaveLength(1);
  expect(guideText(panel)).toBe("Draw Bath 2 of 3 on the Ground floor");
  // The guide asks to draw, so Draw is current and the only filled tool.
  expect(buttonNamed(panel, "Draw")!.getAttribute("aria-pressed")).toBe("true");
  expect(buttonNamed(panel, "Select")!.getAttribute("aria-pressed")).toBe("false");
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
  await settle(panel);
  expect(guideText(panel)).toBe("Draw Hall 3 of 3 on the Ground floor");
  buttonNamed(panel, "All")!.click();
  await settle(panel);
  expect(guideText(panel)).toBe("Choose a floor to edit its rooms");
});

test("a floor done offers Next floor, lit, which opens the next floor with an area to draw", async () => {
  const { panel, connection } = mountEditor();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(guideText(panel)).toBe("Draw Hall 3 of 3 on the Ground floor"));
  tap(100, 60);
  tap(140, 90);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  await settle(panel);
  expect(guideText(panel)).toBe("Ground floor done Next floor");
  expect(litControls(panel)).toEqual(["Next floor"]);
  // A finished floor leaves nothing selected.
  expect(activeChip(panel)).toBeUndefined();
  buttonNamed(panel, "Next floor")!.click();
  await settle(panel);
  expect(buttonNamed(panel, "Loft")!.getAttribute("aria-pressed")).toBe("true");
  expect(guideText(panel)).toBe("Draw Attic 1 of 1 on the Loft");
});

test("pointing at a pill outlines its room, and pointing at a room marks its pill", async () => {
  const { panel } = mountEditor();
  await showFloor(panel);
  chip(panel, "Kitchen").dispatchEvent(new MouseEvent("mouseenter"));
  await settle(panel);
  expect(hoverFilter()).toEqual(["==", ["get", "area_id"], "kitchen"]);
  chip(panel, "Kitchen").dispatchEvent(new MouseEvent("mouseleave"));
  chip(panel, "Building").dispatchEvent(new MouseEvent("mouseenter"));
  await settle(panel);
  expect(hoverFilter()).not.toEqual(["==", ["get", "area_id"], "kitchen"]);
  expect(layers.find((layer) => layer.id === "spatial-hover-building")?.layout?.visibility).toBe("visible");
  queryRenderedFeatures.mockReturnValue([{ properties: { area_id: "kitchen" } }]);
  handlers.mousemove(mouse(10, 10));
  await settle(panel);
  expect(chips(panel).filter((c) => c.hasAttribute("data-hovered")).map((c) => c.textContent?.trim())).toEqual([
    "Kitchen",
  ]);
  handlers.mouseout();
  await settle(panel);
  expect(chips(panel).some((c) => c.hasAttribute("data-hovered"))).toBe(false);
});

test("a failed rename offers Retry, which renames the area", async () => {
  let fail = true;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "config/area_registry/update" && fail) throw new Error("connection lost");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await showFloor(panel);
  chip(panel, "Bath").click();
  await settle(panel);
  renameField(panel)!.value = "Scullery";
  renameField(panel)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  fail = false;
  toasts[0].action!.action();
  await vi.waitFor(() => expect(sent(connection, "config/area_registry/update")).toHaveLength(2));
  expect(sent(connection, "config/area_registry/update")[1]).toEqual({
    type: "config/area_registry/update",
    area_id: "bath",
    name: "Scullery",
  });
});

test("Retry of a failed New area creates it on the floor it was asked on, with the same name", async () => {
  let fail = true;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "config/area_registry/create" && fail) {
      fail = false;
      throw new Error("connection lost");
    }
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await showFloor(panel);
  chip(panel, "New area").click();
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  buttonNamed(panel, "Loft")!.click();
  await settle(panel);
  toasts[0].action!.action();
  await vi.waitFor(() => expect(sent(connection, "config/area_registry/create")).toHaveLength(2));
  expect(sent(connection, "config/area_registry/create")[1]).toEqual({
    type: "config/area_registry/create",
    name: "Room 1",
    floor_id: "ground",
  });
});

test("two quick taps on New area create one area", async () => {
  const { panel, connection } = mountEditor();
  await showFloor(panel);
  chip(panel, "New area").click();
  chip(panel, "New area").click();
  await vi.waitFor(() => expect(renameField(panel)?.value).toBe("Room 1"));
  expect(sent(connection, "config/area_registry/create")).toHaveLength(1);
});

test("in Select a click on empty map deselects, a click inside the outline selects the Building, and Draw then takes the first area to draw", async () => {
  const { panel, connection } = mountEditor();
  await startSelecting(panel);
  await tapRoom(panel, "kitchen");
  expect(handleCorners()).toHaveLength(4);
  expect(sideButtons()).not.toEqual([]);
  queryRenderedFeatures.mockReturnValue([]);
  handlers.click(mouse(300, 300));
  await settle(panel);
  expect(activeChip(panel)).toBeUndefined();
  expect(handleCorners()).toEqual([]);
  expect(sideButtons()).toEqual([]);
  expect(buttonNamed(panel, "Remove shape")!.disabled).toBe(true);
  key("keydown", "Delete");
  handlers.click(mouse(50, 150));
  await settle(panel);
  expect(buildingHighlight()).toBe("visible");
  handlers.click(mouse(300, 300));
  await settle(panel);
  buttonNamed(panel, "Draw")!.click();
  await settle(panel);
  expect(activeChip(panel)).toBe("Bath");
  expect(saves(connection)).toEqual([]);
  expect(toasts).toEqual([]);
});
