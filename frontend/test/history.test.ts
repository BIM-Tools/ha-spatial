// Checks the session undo history: what each step hands back to the caller.
import { expect, test } from "vitest";
import { History, clearChange } from "../src/history";

const change = (name: string) => ({
  before: { [name]: null },
  after: { [name]: { type: "Polygon" as const, coordinates: [] } },
});

test("undo returns the recorded change and redo returns it again", () => {
  const history = new History();
  const recorded = change("kitchen");
  history.record(recorded);
  expect(history.canUndo).toBe(true);
  expect(history.undo()).toBe(recorded);
  expect(history.canUndo).toBe(false);
  expect(history.canRedo).toBe(true);
  expect(history.redo()).toBe(recorded);
  expect(history.canRedo).toBe(false);
});

test("recording after an undo clears redo", () => {
  const history = new History();
  history.record(change("a"));
  history.undo();
  history.record(change("b"));
  expect(history.canRedo).toBe(false);
  expect(history.redo()).toBeUndefined();
});

test("undo and redo on an empty history return nothing", () => {
  const history = new History();
  expect(history.undo()).toBeUndefined();
  expect(history.redo()).toBeUndefined();
});

const square = (size: number) => ({
  type: "Polygon" as const,
  coordinates: [[[0, 0], [size, 0], [size, size], [0, size], [0, 0]]],
});
const FOOTPRINTS = new Map([
  ["kitchen", square(1)],
  ["hall", square(2)],
  ["attic", square(3)],
]);

test.each([
  [
    "the floor's shaped areas, not those of other floors",
    ["kitchen", "hall", "study"],
    { before: { kitchen: square(1), hall: square(2) }, after: { kitchen: null, hall: null } },
  ],
  ["one shaped area", ["hall"], { before: { hall: square(2) }, after: { hall: null } }],
  ["nothing when no area has a shape", ["study"], undefined],
  ["nothing for a floor without areas", [], undefined],
])("clearing a floor removes %s", (_name, areaIds, change) => {
  expect(clearChange(areaIds, FOOTPRINTS)).toEqual(change);
});
