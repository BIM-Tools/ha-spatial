// Checks lengths and areas in both of Home Assistant's unit systems and in several number formats.

import { expect, test } from "vitest";
import { type HassUnits, type Refusal, formatArea, formatLength, formatSize, parseLength, refusalMessage, saveFailureMessage, typedLength } from "../src/units";
import { METRIC_UNITS as METRIC, US_UNITS as US, unitsOf } from "./units-fixture";

const INCH_M = 0.0254;
// Rounding to half a step can land a float rounding error past it.
const FLOAT_SLACK = 1e-9;

test("metric lengths state the lattice point exactly, with at least two decimals, and areas one decimal", () => {
  expect(formatLength(3.4, METRIC)).toBe("3.40 m");
  expect(formatLength(3.45, METRIC)).toBe("3.45 m");
  expect(formatLength(3.475, METRIC)).toBe("3.475 m");
  expect(formatLength(3.425, METRIC)).toBe("3.425 m");
  expect(formatLength(3.4612, METRIC)).toBe("3.45 m");
  expect(formatLength(3.463, METRIC)).toBe("3.475 m");
  expect(formatLength(0.2, METRIC)).toBe("0.20 m");
  expect(formatArea(18.44, METRIC)).toBe("18.4 m²");
});

test("a metric length with a decimal comma keeps its lattice digits", () => {
  const dutch = unitsOf("km", "language", "nl");
  expect(formatLength(3.475, dutch)).toBe("3,475 m");
  expect(formatLength(3.4, dutch)).toBe("3,40 m");
});

test("lengths and areas follow the user's number format", () => {
  expect(formatLength(4.25, unitsOf("km", "language", "nl"))).toBe("4,25 m");
  expect(formatLength(4.25, unitsOf("km", "decimal_comma"))).toBe("4,25 m");
  expect(formatLength(4.25, unitsOf("km", "comma_decimal", "nl"))).toBe("4.25 m");
  expect(formatArea(1234.5, unitsOf("km", "language", "en"))).toBe("1,234.5 m²");
  expect(formatArea(1234.5, unitsOf("km", "none", "nl"))).toBe("1234.5 m²");
  expect(formatArea(18.44, unitsOf("km", "space_comma"))).toBe("18,4 m²");
});

test("US customary lengths are feet and inches with primes to the nearest inch, also below a foot", () => {
  expect(formatLength(136 * INCH_M, US)).toBe("11′ 4″");
  expect(formatLength(150.4 * INCH_M, US)).toBe("12′ 6″");
  expect(formatLength(8 * INCH_M, US)).toBe("0′ 8″");
  expect(formatLength(12 * INCH_M, US)).toBe("1′ 0″");
});

test("an inch rounded up to twelve carries into the feet", () => {
  expect(formatLength(11.6 * INCH_M, US)).toBe("1′ 0″");
  expect(formatLength((12 * 12 + 11.6) * INCH_M, US)).toBe("13′ 0″");
});

test("lengths with primes read back to the same metres", () => {
  expect(parseLength("11′ 4″", US)).toBeCloseTo(136 * INCH_M, 9);
  expect(parseLength("0′ 8″", US)).toBeCloseTo(8 * INCH_M, 9);
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

test.each([".5", ",5", "0.5 m"])("metric %j reads as 0.5 m", (text) => {
  expect(parseLength(text, METRIC)).toBeCloseTo(0.5, 9);
});

test.each([`12’ 6”`, `12′ 6″`, `12‘6“`])("US customary %j with curly quotes or primes reads as 150 inches", (text) => {
  expect(parseLength(text, US)).toBeCloseTo(150 * INCH_M, 9);
});

test("metric does not read feet and inches", () => {
  expect(parseLength(`12' 6"`, METRIC)).toBeUndefined();
  expect(parseLength("12 6", METRIC)).toBeUndefined();
});

test("a field starts with ASCII digits and a dot in every number format", () => {
  expect(typedLength(4.254, unitsOf("km", "language", "fa"))).toBe("4.25 m");
  expect(typedLength(4.254, unitsOf("km", "decimal_comma"))).toBe("4.25 m");
  expect(typedLength(3.475, unitsOf("km", "decimal_comma"))).toBe("3.475 m");
  expect(typedLength(3.4, METRIC)).toBe("3.40 m");
  expect(typedLength(150 * INCH_M, US)).toBe(formatLength(150 * INCH_M, US));
  expect(typedLength(8 * INCH_M, US)).toBe(formatLength(8 * INCH_M, US));
});

test("a field's starting length reads back within half an inch, or half a lattice unit", () => {
  for (let metres = 0.2; metres < 30; metres += 0.137) {
    expect(Math.abs(parseLength(typedLength(metres, US), US)! - metres)).toBeLessThanOrEqual(INCH_M / 2 + FLOAT_SLACK);
    for (const [numberFormat, language] of [["language", "en"], ["language", "nl"], ["language", "fa"], ["quote_decimal", "en"]]) {
      const local = unitsOf("km", numberFormat, language);
      expect(Math.abs(parseLength(typedLength(metres, local), local)! - metres)).toBeLessThanOrEqual(0.0125 + FLOAT_SLACK);
    }
  }
});

test("a metric length shown with a comma decimal reads back", () => {
  const dutch = unitsOf("km", "language", "nl");
  expect(parseLength(formatLength(4.25, dutch), dutch)).toBeCloseTo(4.25, 9);
});

test.each<[Refusal, HassUnits, string]>([
  ["apart", METRIC, "A room is one shape: draw against it"],
  ["too_small", METRIC, "Too small: every side needs at least 10 cm"],
  ["too_small", US, "Too small: every side needs at least 4 in"],
])("refusalMessage words %s", (refusal, units, message) => {
  expect(refusalMessage(refusal, units)).toBe(message);
});

test.each<[string, unknown, string]>([
  ["a command Home Assistant does not know yet", { code: "unknown_command", message: "Unknown command." }, "Spatial is still starting, try again in a moment"],
  ["another error code", { code: "home_assistant_error", message: "Something broke" }, "Could not save"],
  ["a lost connection", new Error("connection lost"), "Could not save"],
  ["a non-object error", 3, "Could not save"],
])("saveFailureMessage words %s", (_case, error, message) => {
  expect(saveFailureMessage(error)).toBe(message);
});
test.each<[number, number, HassUnits, string]>([
  [9.8, 7.6, METRIC, "9.80 × 7.60 m"],
  [9.8, 7.625, METRIC, "9.800 × 7.625 m"],
  [12.4, 7.6, unitsOf("km", "decimal_comma"), "12,40 × 7,60 m"],
  [386 * INCH_M, 300 * INCH_M, US, "32′ 2″ × 25′ 0″"],
])("a size of %d by %d m shows as %j", (width, depth, units, text) => {
  expect(formatSize(width, depth, units)).toBe(text);
});