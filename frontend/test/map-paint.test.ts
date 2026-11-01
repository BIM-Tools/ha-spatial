// @vitest-environment happy-dom
// Checks that the map colours keep what the theme says, including translucent theme colours.
import { afterEach, expect, test } from "vitest";
import { readMapPaint } from "../src/map-paint";

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
