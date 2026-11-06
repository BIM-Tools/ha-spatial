// Checks where a draft's labels go on screen, so they never print over each other, over a small box or over its side controls.
import { expect, test } from "vitest";
import { type ScreenBox, placeDraftLabels } from "../src/draft-labels";
import type { Pixel } from "../src/edge-drag";

type Corners = [number, number][];

// The sides of a ring of screen corners, as the draft gives them.
const sidesOf = (corners: Corners) =>
  corners.map(([x, y], index) => {
    const [nextX, nextY] = corners[(index + 1) % corners.length];
    return { midpoint: { x: (x + nextX) / 2, y: (y + nextY) / 2 }, edge: { x: nextX - x, y: nextY - y } };
  });
// Every label is 50 x 22 px: 8 px clear of its edge puts a side label 19 px off a long side and 33 px off a short one.
const LABEL = { width: 50, height: 22 };
const up: Pixel = { x: 0, y: -19 };
const down: Pixel = { x: 0, y: 19 };
const left: Pixel = { x: -33, y: 0 };
const right: Pixel = { x: 33, y: 0 };
const centred: Pixel = { x: 0, y: 0 };
const RECTANGLE: Corners = [[0, 0], [200, 0], [200, 100], [0, 100]];
// A side control centred on the left edge of RECTANGLE, as on a resized draft.
const chipAt = (x: number): ScreenBox => ({ centre: { x, y: 50 }, size: { width: 60, height: 22 } });

test.each<[string, Corners, boolean, ScreenBox[], (Pixel | undefined)[], Pixel | undefined]>([
  ["a ring running clockwise on screen", RECTANGLE, true, [], [up, right, down, left], centred],
  ["a ring running counter-clockwise on screen", [[0, 0], [0, 100], [200, 100], [200, 0]], true, [], [left, down, right, up], centred],
  ["a box exactly 96 x 40 px", [[0, 0], [96, 0], [96, 40], [0, 40]], true, [], [up, right, down, left], centred],
  ["a box narrower than 96 px", [[0, 0], [95, 0], [95, 100], [0, 100]], true, [], [up, right, down, left], undefined],
  ["a box lower than 40 px", [[0, 0], [200, 0], [200, 39], [0, 39]], true, [], [up, right, down, left], undefined],
  ["a box a few pixels across, whose side labels would meet at the corners", [[0, 0], [4, 0], [4, 4], [0, 4]], true, [], [up, undefined, down, undefined], undefined],
  ["a resized draft whose side controls stay clear of the area", RECTANGLE, false, [chipAt(0)], [], centred],
  ["a resized draft whose side control reaches the area", [[60, 0], [160, 0], [160, 100], [60, 100]], false, [chipAt(60)], [], undefined],
])("%s", (_, corners, withSides, controls, sides, area) => {
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const box = { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  const areaLabel = { centre: { x: Math.min(...xs) + box.width / 2, y: Math.min(...ys) + box.height / 2 }, size: LABEL };
  const drawn = withSides ? sidesOf(corners) : [];
  const places = placeDraftLabels(drawn, drawn.map(() => LABEL), box, areaLabel, controls);
  // Adding 0 turns a -0 from a sign flip into 0, which toEqual tells apart.
  const plain = (offset: Pixel | undefined) => offset && { x: offset.x + 0, y: offset.y + 0 };
  expect({ sides: places.sides.map(plain), area: plain(places.area) }).toEqual({ sides, area });
});
