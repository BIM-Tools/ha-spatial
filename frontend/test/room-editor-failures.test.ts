// @vitest-environment happy-dom
// Checks what a refused or failed save shows, and that Retry sends it again.
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
  KITCHEN,
  mountEditor,
  chipNames,
  activeChip,
  activeFilter,
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
  handleCorners,
} from "./room-editor-fixture";

vi.mock("maplibre-gl", async () => (await import("./panel-harness")).fakeMapLibre);

import "../src/spatial-panel";

afterEach(resetFakes);

type Panel = HTMLElement;
type Connection = { sendMessagePromise: unknown };

const drawBox = () => {
  tap(100, 0);
  tap(140, 30);
};

// A room with a stored shape shows only that one, still active; a failed first box stays on the map.
const expectStoredKitchen = async (panel: Panel) => {
  await settle(panel);
  expect(sources["spatial-draft"].data).toEqual(EMPTY);
  expect(activeFilter()).toEqual(["==", ["get", "area_id"], "kitchen"]);
  expect(handleCorners()).toEqual(KITCHEN.coordinates[0].slice(0, -1));
};

// Each row: how to get there, the action whose save fails, what the map shows after, and whether Undo stays available.
type Step = (panel: Panel, connection: Connection) => Promise<void>;

test.each<[string, Step, (panel: Panel) => void, Step, boolean]>([
  ["box", (panel) => startDrawing(panel), drawBox, async (_panel, connection) => expect(draftGeometry()).toEqual(saves(connection)[0].areas.bath), false],
  [
    "move",
    async (panel) => {
      await startAdjusting(panel);
      await tapRoom(panel, "kitchen");
    },
    () => drag([25, 25], [45, 25]),
    expectStoredKitchen,
    false,
  ],
  [
    "resize",
    async (panel) => {
      await startAdjusting(panel);
      await tapRoom(panel, "kitchen");
    },
    () => typeSide(0, "7"),
    expectStoredKitchen,
    false,
  ],
  [
    "extension",
    async (panel) => {
      await startDrawing(panel);
      await activateKitchen(panel);
    },
    () => {
      tap(50, 0);
      tap(100, 50);
    },
    expectStoredKitchen,
    false,
  ],
  [
    "undo",
    async (panel, connection) => {
      await startDrawing(panel);
      drawBox();
      await vi.waitFor(() => expect(saves(connection)).toHaveLength(1));
      await vi.waitFor(() => expect(buttonNamed(panel, "Undo")!.disabled).toBe(false));
    },
    (panel) => buttonNamed(panel, "Undo")!.click(),
    async () => {},
    true,
  ],
])(
  "a failed %s reloads the rooms, says so, records nothing, and Retry sends the same batch",
  async (_name, arrange, act, expectShown, undoAvailable) => {
    let fail = false;
    const { panel, connection } = mountEditor(async (message) => {
      if (message.type === "spatial/area/update_geometries" && fail) throw new Error("connection lost");
      return undefined;
    });
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    await arrange(panel, connection);
    fail = true;
    const feedLoads = sent(connection, "spatial/geojson").length;
    const savesBefore = saves(connection).length;
    act(panel);
    await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
    const [failure] = toasts;
    expect(failure).toMatchObject({ action: { text: "Retry" }, duration: -1, dismissable: true });
    await vi.waitFor(() => expect(sent(connection, "spatial/geojson").length).toBe(feedLoads + 1));
    await settle(panel);
    expect(buttonNamed(panel, "Undo")!.disabled).toBe(!undoAvailable);
    expect(buttonNamed(panel, "Redo")!.disabled).toBe(true);
    await expectShown(panel, connection);
    fail = false;
    failure.action!.action();
    await vi.waitFor(() => expect(saves(connection)).toHaveLength(savesBefore + 2));
    expect(saves(connection)[savesBefore + 1]).toEqual(saves(connection)[savesBefore]);
    await vi.waitFor(() => expect(toasts.at(-1)).toEqual({ id: failure.id, message: "", duration: 0 }));
    expect(sources["spatial-draft"].data).toEqual(EMPTY);
  },
);

test("a save while Spatial is still starting says so and offers Retry", async () => {
  const { panel } = mountEditor(async (message) => {
    if (message.type === "spatial/area/update_geometries") throw { code: "unknown_command", message: "Unknown command." };
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementationOnce(() => {});
  await startDrawing(panel);
  drawBox();
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Spatial is still starting, try again in a moment"]));
  expect(toasts[0]).toMatchObject({ action: { text: "Retry" }, duration: -1, dismissable: true });
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
  drawBox();
  await vi.waitFor(() => expect(toastMessages()).toContain("Could not save"));
  drawBox();
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
  drawBox();
  await vi.waitFor(() => expect(activeChip(panel)).toBe("Hall"));
  release();
  await refreshed;
  await settle(panel);
  expect(chipNames(panel)).toContain("Bath");
});

test("a new map style keeps the shape of a failed save on the map", async () => {
  const { panel } = failingFirstSave();
  await startDrawing(panel);
  drawBox();
  await vi.waitFor(() => expect(toastMessages()).toEqual(["Could not save"]));
  const kept = draftGeometry();
  handlers["style.load"]();
  expect(draftGeometry()).toEqual(kept);
});

test("Ctrl+Z with nothing to undo keeps the failure toast and the failed shape", async () => {
  const { panel } = failingFirstSave();
  await startDrawing(panel);
  drawBox();
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
  drawBox();
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
