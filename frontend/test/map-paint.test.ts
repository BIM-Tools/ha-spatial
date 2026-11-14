// @vitest-environment happy-dom
// Checks that the map colours keep what the theme says, including translucent theme colours.
import { afterEach, expect, test } from "vitest";
import { createPropertyExpression, latest } from "@maplibre/maplibre-gl-style-spec";
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

// Evaluates a room's fill the way MapLibre does, for a room whose feature state is `state`.
const fillOf = (kind: "brightness" | "temperature" | undefined, state: object) => {
  const expression = createPropertyExpression(layerColours(readMapPaint(document.body, false), kind)["areas-2d"]["fill-color"], "fill-color", latest.paint_fill["fill-color"] as never);
  if (expression.result !== "success") throw new Error("not a valid fill expression");
  const { r, g, b, a } = expression.value.evaluate({ zoom: 0 }, { properties: {} } as never, state) as { r: number; g: number; b: number; a: number };
  return { r: Math.round(r * a * 255), g: Math.round(g * a * 255), b: Math.round(b * a * 255), a };
};

test("a room without a value keeps the plain fill, a room with one follows the scale", () => {
  const plain = fillOf(undefined, {});
  expect(fillOf("brightness", {})).toEqual(plain);
  expect(fillOf("temperature", {})).toEqual(plain);
  expect(fillOf("brightness", { value: 100 })).not.toEqual(plain);
  expect(fillOf("brightness", { value: 0 }).a).toBeLessThan(fillOf("brightness", { value: 100 }).a);
  expect(fillOf("temperature", { value: 15 })).not.toEqual(fillOf("temperature", { value: 28 }));
});

test("the value edge follows the primary text colour, lighter in the dark theme", () => {
  document.body.style.setProperty("--primary-text-color", "rgb(10, 20, 30)");
  expect(readMapPaint(document.body, false).valueEdge).toBe("rgba(10,20,30,0.22)");
  expect(readMapPaint(document.body, true).valueEdge).toBe("rgba(10,20,30,0.28)");
});

test("the room colours come from Home Assistant's state colours, with its defaults", () => {
  const paint = readMapPaint(document.body, false);
  expect(paint.lightHigh).toBe("rgba(255,193,7,0.72)");
  expect(paint.cool).toBe("rgba(33,150,243,0.6)");
  expect(paint.heat).toBe("rgba(255,87,34,0.6)");
});
