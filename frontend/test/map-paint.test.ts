// @vitest-environment happy-dom
// Checks that the map colours keep what the theme says, including translucent theme colours.
import { afterEach, expect, test } from "vitest";
import { layerColours, readMapPaint } from "../src/map-paint";

afterEach(() => document.body.removeAttribute("style"));

test("a translucent text colour keeps its alpha in the Building outline", () => {
  document.body.style.setProperty("--primary-text-color", "rgba(0, 0, 0, 0.4)");
  document.body.style.setProperty("--secondary-text-color", "rgba(100, 100, 100, 0.4)");
  expect(readMapPaint(document.body, false).building).toBe("rgba(70,70,70,0.4)");
});

test("an unset theme falls back to Home Assistant's default colours", () => {
  const paint = readMapPaint(document.body, true);
  expect(paint.roomFill).toBe("rgba(3,169,244,0.25)");
  expect(paint.building).toBe("rgba(190,190,190,1)");
});

test("the snap highlight is painted in the accent colour, its dots on the card background, light and dark", () => {
  document.body.style.setProperty("--primary-color", "rgb(0, 128, 0)");
  document.body.style.setProperty("--accent-color", "rgb(255, 128, 0)");
  document.body.style.setProperty("--card-background-color", "rgb(1, 2, 3)");
  for (const dark of [false, true]) {
    const colours = layerColours(readMapPaint(document.body, dark));
    expect(colours["spatial-snap-line"]).toEqual({ "line-color": "rgba(255,128,0,1)" });
    expect(colours["spatial-snap-point"]).toEqual({ "circle-color": "rgba(255,128,0,1)", "circle-stroke-color": "rgba(1,2,3,1)" });
    expect(colours["spatial-snap-marker"]).toEqual({ "circle-color": "rgba(1,2,3,1)", "circle-stroke-color": "rgba(255,128,0,1)" });
  }
});

test.each([false, true])("an unset accent falls back to Home Assistant's default orange (dark %s)", (dark) => {
  expect(readMapPaint(document.body, dark).accent).toBe("rgba(255,152,0,1)");
});

test("dark rooms get a 25 % fill, a 40 % active fill and an opaque stroke; light stays", () => {
  const dark = readMapPaint(document.body, true);
  expect(dark.roomEdge).toBe("rgba(3,169,244,1)");
  // Active fill drawn over the room fill: 1 - (1 - 0.25)(1 - x) = 0.4.
  expect(dark.activeRoomFill).toBe("rgba(3,169,244,0.2)");
  const light = readMapPaint(document.body, false);
  expect(light.roomFill).toBe("rgba(3,169,244,0.1)");
  expect(light.roomEdge).toBe("rgba(3,169,244,0.7)");
});

test("map buildings are outlined in the secondary text colour", () => {
  document.body.style.setProperty("--secondary-text-color", "rgb(10, 20, 30)");
  const paint = readMapPaint(document.body, true);
  expect(paint.mapBuildingEdge).toBe("rgba(10,20,30,1)");
  expect(layerColours(paint)["spatial-map-buildings"]).toEqual({ "line-color": "rgba(10,20,30,1)" });
});
