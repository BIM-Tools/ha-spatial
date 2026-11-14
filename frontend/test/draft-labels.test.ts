// Checks where the chips and names around a shape go on screen: outside its sides, apart, off a small shape, and on screen while drawn.
import { expect, test } from "vitest";
import { type ScreenBox, type Size, isSmall, placeLabels, screenShape } from "../src/draft-labels";
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

const VIEW: Size = { width: 400, height: 300 };
const NAME = { width: 50, height: 22 };
const box = (left: number, top: number, right: number, bottom: number): Corners => [[left, top], [right, top], [right, bottom], [left, bottom]];
// A 100 x 50 px box is small: its chips are 19 px below the bottom side, 33 px right of the right side, 44 px above the box for a name.
const SMALL = box(100, 100, 200, 150);
const none = undefined;
const boxOf = (corners: Corners): Size => {
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

interface Case {
  corners: Corners;
  sides: (Pixel | undefined)[];
  area: Pixel | undefined;
  name?: Pixel;
  controls?: ScreenBox[];
  withName?: boolean;
  viewport?: Size;
  drawing?: boolean;
  withSides?: boolean;
}

test.each<[string, Case]>([
  ["a ring running clockwise on screen", { corners: RECTANGLE, sides: [up, right, down, left], area: centred }],
  ["a ring running counter-clockwise on screen", { corners: [[0, 0], [0, 100], [200, 100], [200, 0]], sides: [left, down, right, up], area: centred }],
  ["a box narrower than 96 px", { corners: box(0, 0, 95, 100), sides: [up, right, down, left], area: none }],
  ["a box lower than 40 px is small: width and depth chip only", { corners: box(0, 0, 200, 39), sides: [none, right, down, none], area: none }],
  ["a box exactly 96 x 40 px is small and keeps its area", { corners: box(0, 0, 96, 40), sides: [none, right, down, none], area: centred }],
  ["a box a few pixels across keeps its first spots when both are taken", { corners: box(0, 0, 4, 4), sides: [none, right, down, none], area: none }],
  ["small: the name chip goes above the box", { corners: SMALL, withName: true, sides: [none, right, down, none], name: { x: 0, y: -44 }, area: centred }],
  ["small without a name size places no name", { corners: SMALL, sides: [none, right, down, none], area: centred }],
  ["small: the width chip flips above when something sits below", { corners: SMALL, controls: [{ centre: { x: 150, y: 169 }, size: LABEL }], sides: [up, right, none, none], area: centred }],
  ["small: the depth chip flips left when something sits right", { corners: SMALL, controls: [{ centre: { x: 233, y: 125 }, size: LABEL }], sides: [none, none, down, left], area: centred }],
  ["small: the depth chip flips left at the right edge of the screen", { corners: box(300, 100, 390, 150), viewport: VIEW, sides: [none, none, down, left], area: none }],
  ["small: the width chip flips above at the bottom edge of the screen", { corners: box(100, 240, 200, 290), viewport: VIEW, sides: [up, right, none, none], area: centred }],
  ["small: the name chip flips below at the top edge of the screen", { corners: box(100, 10, 200, 60), viewport: VIEW, withName: true, sides: [none, right, down, none], name: { x: 0, y: 44 }, area: centred }],
  ["drawing in the top left: chips below and right, facing the centre", { corners: box(20, 20, 120, 70), viewport: VIEW, drawing: true, sides: [none, right, down, none], area: centred }],
  ["drawing in the bottom right: chips above and left, facing the centre", { corners: box(280, 230, 380, 280), viewport: VIEW, drawing: true, sides: [up, none, none, left], area: centred }],
  ["drawing off the left edge: the width chip is clamped 8 px inside", { corners: box(-50, 100, 100, 150), viewport: VIEW, drawing: true, sides: [none, right, { x: 8, y: 19 }, none], area: centred }],
  ["drawing off the right edge: the width chip is clamped 8 px inside", { corners: box(300, 100, 450, 150), viewport: VIEW, drawing: true, sides: [none, none, { x: -8, y: 19 }, left], area: centred }],
  ["drawing above the top edge: both chips are clamped 8 px inside", { corners: box(100, -100, 200, -50), viewport: VIEW, drawing: true, sides: [none, { x: 33, y: 94 }, { x: 0, y: 69 }, none], area: centred }],
  ["drawing below the bottom edge: both chips are clamped 8 px inside", { corners: box(100, 350, 200, 400), viewport: VIEW, drawing: true, sides: [{ x: 0, y: -69 }, { x: 33, y: -94 }, none, none], area: centred }],
  ["drawing without a measured viewport is not clamped", { corners: box(-50, 100, 100, 150), drawing: true, sides: [none, right, down, none], area: centred }],
  ["a resized draft whose side controls stay clear of the area", { corners: RECTANGLE, withSides: false, controls: [chipAt(0)], sides: [], area: centred }],
  ["a resized draft whose side control reaches the area", { corners: box(60, 0, 160, 100), withSides: false, controls: [chipAt(60)], sides: [], area: none }],
])("%s", (_, { corners, sides, area, name, controls, withName, viewport, drawing, withSides = true }) => {
  const size = boxOf(corners);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const areaLabel = { centre: { x: Math.min(...xs) + size.width / 2, y: Math.min(...ys) + size.height / 2 }, size: LABEL };
  const drawn = withSides ? sidesOf(corners) : [];
  const places = placeLabels({ sides: drawn, sideSizes: drawn.map(() => LABEL), box: size, area: areaLabel, controls, name: withName ? NAME : undefined, viewport, drawing });
  // Adding 0 turns a -0 from a sign flip into 0, which toEqual tells apart.
  const plain = (offset: Pixel | undefined) => offset && { x: offset.x + 0, y: offset.y + 0 };
  expect({ sides: places.sides.map(plain), area: plain(places.area), name: plain(places.name) }).toEqual({ sides, area, name });
});

test("a label that would overlap an earlier one is hidden", () => {
  const side = { midpoint: { x: 100, y: 0 }, edge: { x: 200, y: 0 } };
  const places = placeLabels({ sides: [side, side], sideSizes: [LABEL, LABEL], box: { width: 200, height: 100 }, area: { centre: { x: 100, y: 50 }, size: LABEL } });
  expect(places.sides.map((offset) => offset !== undefined)).toEqual([true, false]);
});

test("a side under 48 px on screen gets no label", () => {
  const places = placeLabels({
    sides: sidesOf([[0, 0], [200, 0], [200, 100], [20, 100], [0, 80]]),
    sideSizes: [LABEL, LABEL, LABEL, LABEL, LABEL],
    box: { width: 200, height: 100 },
    area: { centre: { x: 100, y: 50 }, size: LABEL },
  });
  expect(places.sides.map((offset) => offset !== undefined)).toEqual([true, true, true, false, true]);
});

// A thin triangle whose three sides all run more up and down than across: no side counts as horizontal.
const THIN: Corners = [[0, 0], [10, 100], [20, 40]];

test.each([
  ["small", false],
  ["drawn", true],
])("a %s shape with no side across the screen places no width chip and does not throw", (_, drawing) => {
  const drawn = sidesOf(THIN);
  const places = placeLabels({ sides: drawn, sideSizes: drawn.map(() => LABEL), box: boxOf(THIN), area: { centre: { x: 10, y: 50 }, size: LABEL }, drawing, viewport: VIEW });
  expect(places.sides.filter((offset) => offset !== undefined)).toHaveLength(1);
});

test.each([
  [{ width: 59, height: 200 }, true],
  [{ width: 200, height: 59 }, true],
  [{ width: 60, height: 60 }, false],
])("isSmall(%j) is %s", (size, small) => {
  expect(isSmall(size)).toBe(small);
});

test("screenShape gives the sides, the box size and the box centre of a ring of corners", () => {
  const shape = screenShape([{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 70 }, { x: 10, y: 70 }]);
  expect(shape.box).toEqual({ width: 100, height: 50 });
  expect(shape.centre).toEqual({ x: 60, y: 45 });
  expect(shape.sides[0]).toEqual({ midpoint: { x: 60, y: 20 }, edge: { x: 100, y: 0 } });
  expect(shape.sides[3]).toEqual({ midpoint: { x: 10, y: 45 }, edge: { x: 0, y: -50 } });
});
