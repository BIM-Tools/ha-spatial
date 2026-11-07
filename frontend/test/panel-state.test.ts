// Checks where the panel offers Align, from the stored site direction.
import { expect, test } from "vitest";
import { alignPlace } from "../src/panel-state";

test.each([
  ["the site is not read yet", undefined, undefined],
  ["no Align yet", null, "toolbar"],
  ["a direction of 0, north", 0, "menu"],
  ["any other direction", 237.5, "menu"],
])("where Align is offered with %s",(_name, bearing, place) => {
  expect(alignPlace(bearing)).toBe(place);
});
