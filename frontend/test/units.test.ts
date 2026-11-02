// Checks lengths and areas in both of Home Assistant's unit systems and in several number formats.

import { expect, test } from "vitest";
import { type HassUnits, formatArea, formatLength, parseLength } from "../src/units";

const hassWith = (length: "km" | "mi", number_format = "language", language = "en"): HassUnits => ({
  config: { unit_system: { length } },
  locale: { language, number_format },
});

const METRIC = hassWith("km");
const US = hassWith("mi");
const INCH_M = 0.0254;
// Rounding to half a step can land a float rounding error past it.
const FLOAT_SLACK = 1e-9;

test("metric lengths have two decimals and areas one", () => {
  expect(formatLength(4.254, METRIC)).toBe("4.25 m");
  expect(formatLength(0.2, METRIC)).toBe("0.20 m");
  expect(formatArea(18.44, METRIC)).toBe("18.4 m²");
});

test("lengths and areas follow the user's number format", () => {
  expect(formatLength(4.25, hassWith("km", "language", "nl"))).toBe("4,25 m");
  expect(formatLength(4.25, hassWith("km", "decimal_comma"))).toBe("4,25 m");
  expect(formatLength(4.25, hassWith("km", "comma_decimal", "nl"))).toBe("4.25 m");
  expect(formatArea(1234.5, hassWith("km", "language", "en"))).toBe("1,234.5 m²");
  expect(formatArea(1234.5, hassWith("km", "none", "nl"))).toBe("1234.5 m²");
  expect(formatArea(18.44, hassWith("km", "space_comma"))).toBe("18,4 m²");
});

test("US customary lengths are feet and inches to the nearest inch", () => {
  expect(formatLength(150 * INCH_M, US)).toBe(`12' 6"`);
  expect(formatLength(150.4 * INCH_M, US)).toBe(`12' 6"`);
  expect(formatLength(0.2, US)).toBe(`8"`);
});

test("an inch rounded up to twelve carries into the feet", () => {
  expect(formatLength(11.6 * INCH_M, US)).toBe(`1' 0"`);
  expect(formatLength((12 * 12 + 11.6) * INCH_M, US)).toBe(`13' 0"`);
});

test("US customary areas are whole square feet", () => {
  expect(formatArea(18.4, US)).toBe("198 ft²");
  expect(formatArea(1000, US)).toBe("10,764 ft²");
});

test.each([
  [`12' 6"`, 150],
  [`12'6"`, 150],
  [`12'6`, 150],
  ["12 6", 150],
  [`150"`, 150],
  ["12.5'", 150],
  ["12,5'", 150],
  ["12", 144],
  ["12'", 144],
  [` 12' 6" `, 150],
])("US customary %j reads as %d inches", (text, inches) => {
  expect(parseLength(text, US)).toBeCloseTo(inches * INCH_M, 9);
});

test.each(["4,25", "4.25", "4.25 m", "4,25m"])("metric %j reads as 4.25 m", (text) => {
  expect(parseLength(text, METRIC)).toBeCloseTo(4.25, 9);
});

test.each(["", "abc", "4.2.5", "-3", `12' 6'`, `1' 2' 3"`, "12 ft", "m"])("%j reads as nothing", (text) => {
  expect(parseLength(text, METRIC)).toBeUndefined();
  expect(parseLength(text, US)).toBeUndefined();
});

test("metric does not read feet and inches", () => {
  expect(parseLength(`12' 6"`, METRIC)).toBeUndefined();
  expect(parseLength("12 6", METRIC)).toBeUndefined();
});

test("a shown length reads back within half an inch, or half a centimetre", () => {
  for (let metres = 0.2; metres < 30; metres += 0.137) {
    expect(Math.abs(parseLength(formatLength(metres, US), US)! - metres)).toBeLessThanOrEqual(INCH_M / 2 + FLOAT_SLACK);
    expect(Math.abs(parseLength(formatLength(metres, METRIC), METRIC)! - metres)).toBeLessThanOrEqual(0.005 + FLOAT_SLACK);
    const dutch = hassWith("km", "language", "nl");
    expect(Math.abs(parseLength(formatLength(metres, dutch), dutch)! - metres)).toBeLessThanOrEqual(0.005 + FLOAT_SLACK);
  }
});
