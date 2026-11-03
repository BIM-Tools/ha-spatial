// @vitest-environment happy-dom
// Checks that the building carries Home Assistant's location name, on the map and in the strip, and that an admin renames it there.
import type { Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  type Reply,
  answer,
  buttonNamed,
  handlers,
  liveMarkers,
  mountPanel,
  resetFakes,
  settle,
  siteReply,
  toastMessages,
  toasts,
  unprojectPixel,
} from "./panel-harness";
import { METRIC_UNITS } from "./units-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

const OUTLINE: Polygon = {
  type: "Polygon",
  coordinates: [[[0, 0], [100, 0], [100, 80], [0, 80], [0, 0]].map((p) => unprojectPixel(p as [number, number]))],
};

type Message = Parameters<Reply>[0];

// One floor without rooms, so the outline names itself on the map and the building pill is active.
const mountHome = (locationName: string, isAdmin = true, overrides: Reply = async () => undefined) => {
  const reply: Reply = async (message) => {
    const overridden = await overrides(message);
    if (overridden !== undefined) return overridden;
    if (message.type === "spatial/site") return siteReply({ outline: OUTLINE });
    if (message.type === "spatial/geojson") return EMPTY;
    if (message.type === "config/floor_registry/list") return [{ floor_id: "ground", name: "Ground floor", level: 0 }];
    if (message.type === "config/core/update") return null;
    return answer(message);
  };
  const mounted = mountPanel(reply);
  setHass(mounted.panel, locationName, isAdmin);
  return mounted;
};

const setHass = (panel: HTMLElement & { hass: object }, locationName: string, isAdmin = true) => {
  panel.hass = {
    ...panel.hass,
    config: { ...METRIC_UNITS.config, location_name: locationName },
    user: { is_admin: isAdmin },
  };
};

const strip = (panel: HTMLElement) => panel.shadowRoot!.querySelector("spatial-area-strip")!;
const buildingPill = (panel: HTMLElement) => strip(panel).shadowRoot!.querySelector<HTMLButtonElement>("button.pill")!;
const nameField = (panel: HTMLElement) => strip(panel).shadowRoot!.querySelector("input");
const mapLabel = () =>
  liveMarkers().find((marker) => marker.element.classList.contains("building-label"))?.element.textContent;

const showGroundFloor = async (panel: HTMLElement) => {
  await vi.waitFor(() => expect(handlers["style.load"]).toBeDefined());
  handlers["style.load"]();
  await vi.waitFor(() => expect(buttonNamed(panel, "Ground floor")).toBeDefined());
  buttonNamed(panel, "Ground floor")!.click();
  await settle(panel);
};

const sentCoreUpdates = (connection: { sendMessagePromise: { mock: { calls: [Message][] } } }) =>
  connection.sendMessagePromise.mock.calls.map(([message]) => message).filter((message) => message.type === "config/core/update");

test("the building pill and the map label show Home Assistant's location name, and follow it", async () => {
  const { panel } = mountHome("Cottage");
  await showGroundFloor(panel);
  expect(buildingPill(panel).textContent?.trim()).toBe("Cottage");
  expect(mapLabel()).toBe("Cottage");
  setHass(panel, "Farmhouse");
  await settle(panel);
  expect(buildingPill(panel).textContent?.trim()).toBe("Farmhouse");
  expect(mapLabel()).toBe("Farmhouse");
});

test("without a location name the building is called Building", async () => {
  const { panel } = mountHome("");
  await showGroundFloor(panel);
  expect(buildingPill(panel).textContent?.trim()).toBe("Building");
  expect(mapLabel()).toBe("Building");
});

test("an admin renames the building like a room, which renames the location in Home Assistant", async () => {
  const { panel, connection } = mountHome("Home");
  await showGroundFloor(panel);
  buildingPill(panel).click();
  await settle(panel);
  const field = nameField(panel)!;
  expect(field.value).toBe("Home");
  field.value = "Cottage";
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() =>
    expect(sentCoreUpdates(connection)).toEqual([{ type: "config/core/update", location_name: "Cottage" }]),
  );
  expect(toastMessages()).toEqual([]);
});

test("a failed building rename offers Retry", async () => {
  let fail = true;
  const { panel, connection } = mountHome("Home", true, async (message) => {
    if (message.type === "config/core/update" && fail) throw new Error("connection lost");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await showGroundFloor(panel);
  buildingPill(panel).click();
  await settle(panel);
  nameField(panel)!.value = "Cottage";
  nameField(panel)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  fail = false;
  toasts[0].action!.action();
  await vi.waitFor(() => expect(sentCoreUpdates(connection)).toHaveLength(2));
  expect(sentCoreUpdates(connection)[1]).toEqual({ type: "config/core/update", location_name: "Cottage" });
});

test("a user who is not an admin sees the name but cannot rename the building", async () => {
  const { panel, connection } = mountHome("Home", false);
  await showGroundFloor(panel);
  expect(buildingPill(panel).textContent?.trim()).toBe("Home");
  buildingPill(panel).click();
  await settle(panel);
  expect(nameField(panel)).toBeNull();
  expect(sentCoreUpdates(connection)).toEqual([]);
});
