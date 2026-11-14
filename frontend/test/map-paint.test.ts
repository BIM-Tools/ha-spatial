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
  expect(paint.roomFill).toBe("rgba(3,169,244,0.12)");
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

test("a coloured card paints rooms by their feature state, a plain one with the fixed fill", () => {
  const paint = readMapPaint(document.body, false);
  const plain = ["==", ["feature-state", "value"], null];
  expect(layerColours(paint)["areas-2d"]["fill-color"]).toBe(paint.roomFill);
  expect(layerColours(paint)["areas-outline"]["line-color"]).toBe(paint.roomEdge);
  expect(layerColours(paint, "brightness")["areas-2d"]["fill-color"]).toEqual([
    "case", plain, paint.roomFill, ["interpolate", ["linear"], ["feature-state", "value"], 0, paint.lightLow, 100, paint.lightHigh],
  ]);
  expect(layerColours(paint, "temperature")["areas-2d"]["fill-color"]).toEqual([
    "case", plain, paint.roomFill, ["interpolate", ["linear"], ["feature-state", "value"], 15, paint.cool, 21, paint.neutral, 28, paint.heat],
  ]);
  expect(layerColours(paint, "temperature")["areas-outline"]["line-color"]).toEqual(["case", plain, paint.roomEdge, "rgba(0,0,0,0.22)"]);
  expect(readMapPaint(document.body, true).valueEdge).toBe("rgba(255,255,255,0.28)");
});

test("the room colours come from Home Assistant's state colours, with its defaults", () => {
  const paint = readMapPaint(document.body, false);
  expect(paint.lightHigh).toBe("rgba(255,193,7,0.72)");
  expect(paint.cool).toBe("rgba(33,150,243,0.6)");
  expect(paint.heat).toBe("rgba(255,87,34,0.6)");
});
