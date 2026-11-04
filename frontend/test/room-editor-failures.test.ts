// @vitest-environment happy-dom
// Checks what a refused or failed save shows, and that Retry sends it again.
import type { Feature, Polygon } from "geojson";
import { afterEach, expect, test, vi } from "vitest";
import {
  EMPTY,
  buttonNamed,
  handlers,
  toastMessages,
  toasts,
  onUpdateOf,
  settle,
  sources,
  resetFakes,
} from "./panel-harness";
import {
  mountEditor,
  chipNames,
  activeChip,
  startDrawing,
  tap,
  drag,
  sent,
  saves,
  activateKitchen,
  startAdjusting,
  tapRoom,
  typeSide,
  ctrlZ,
  failingFirstSave,
  draftGeometry,
  failingSaves,
  expectOnlyStoredKitchen,
  expectRetrySendsTheSame,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

test("a rejected move reloads the rooms, says so and records nothing", async () => {
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries") throw new Error("not allowed");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  await activateKitchen(panel);
  const feedLoads = sent(connection, "spatial/geojson").length;
  drag([25, 25], [45, 25]);
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("a rejected save reloads the rooms, says so and records nothing", async () => {
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries") throw new Error("not allowed");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  const feedLoads = sent(connection, "spatial/geojson").length;
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("a rejected resize reloads the rooms, says so and records nothing", async () => {
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries") throw new Error("not allowed");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  const feedLoads = sent(connection, "spatial/geojson").length;
  typeSide(0, "7");
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1);
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(true);
});

test("a reload that hangs after a failed save does not block the next box", async () => {
  let failed = false;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && !failed) {
      failed = true;
      throw new Error("connection lost");
    }
    if (message.type === "spatial/geojson" && failed) return new Promise(() => {});
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
});

test("a refresh held back until after a save is acknowledged keeps the saved footprint", async () => {
  let release = () => {};
  let hold = false;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type !== "config/area_registry/list" || !hold) return undefined;
    hold = false;
    await new Promise<void>((resolve) => (release = resolve));
    return undefined;
  });
  await startDrawing(panel);
  hold = true;
  const refreshed = onUpdateOf(connection)();
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Hall"));
  release();
  await refreshed;
  await settle(panel);
  expect(chipNames(panel)).toContain("Bath");
});

test("Retry after a failed box saves it again, the box stays on the map until then, and success closes the toast", async () => {
  let fail = true;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && fail) throw new Error("connection lost");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  const [failure] = toasts;
  expect(failure).toMatchObject({ action: { text: "Retry" }, duration: -1, dismissable: true });
  const kept = (sources["spatial-draft"].data as Feature<Polygon>).geometry;
  expect(kept).toEqual(saves(connection)[0].areas.bath);
  fail = false;
  failure.action!.action();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(2));
  expect(saves(connection)[1]).toEqual(saves(connection)[0]);
  await vi.waitFor(() => expect(sources["spatial-draft"].data).toEqual(EMPTY));
  expect(toasts.at(-1)).toEqual({ id: failure.id, message: "", duration: 0 });
  expect(buttonNamed(panel, "Undo")!.disabled).toBe(false);
});

test("a new map style keeps the shape of a failed save on the map", async () => {
  const { panel } = failingFirstSave();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  const kept = draftGeometry();
  handlers["style.load"]();
  expect(draftGeometry()).toEqual(kept);
});

test("Ctrl+Z with nothing to undo keeps the failure toast and the failed shape", async () => {
  const { panel } = failingFirstSave();
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  ctrlZ();
  ctrlZ(true);
  await settle(panel);
  expect(toasts).toHaveLength(1);
  expect(draftGeometry()).toBeDefined();
});

test("an undo that saves after a failed first box clears the failed shape and its toast", async () => {
  let saveCount = 0;
  const { panel, connection } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries" && ++saveCount === 2) throw new Error("connection lost");
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  tap(100, 0);
  tap(140, 30);
  await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
  tap(100, 60);
  tap(140, 90);
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  await vi.waitFor(() => expect(draftGeometry()).toBeDefined());
  ctrlZ();
  await vi.waitFor(() => expect(saves(connection)).toHaveLength(3));
  await vi.waitFor(() => expect(sources["spatial-draft"].data).toEqual(EMPTY));
  expect(toasts.at(-1)).toMatchObject({ message: "", duration: 0 });
});

test("a refused move shows only the stored room, still active, and Retry sends the same move", async () => {
  const { panel, connection, stopFailing } = failingSaves();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  drag([25, 25], [45, 25]);
  await expectOnlyStoredKitchen(panel);
  await expectRetrySendsTheSame(connection, stopFailing);
});

test("a refused resize shows only the stored room, still active, and Retry sends the same resize", async () => {
  const { panel, connection, stopFailing } = failingSaves();
  await startAdjusting(panel);
  await tapRoom(panel, "kitchen");
  typeSide(0, "7");
  await expectOnlyStoredKitchen(panel);
  await expectRetrySendsTheSame(connection, stopFailing);
});

test("a refused extension shows only the stored room, still active, and Retry sends the same extension", async () => {
  const { panel, connection, stopFailing } = failingSaves();
  await startDrawing(panel);
  await activateKitchen(panel);
  tap(50, 0);
  tap(100, 50);
  await expectOnlyStoredKitchen(panel);
  await expectRetrySendsTheSame(connection, stopFailing);
});
