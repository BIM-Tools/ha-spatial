// Shows and reads lengths and areas in Home Assistant's unit system and the user's number format, and words why a save did not happen; storage stays metric.

/** The parts of Home Assistant's `hass` object that decide the unit system and the number format. */
export interface HassUnits {
  config: { unit_system: { length: string } };
  locale: { language: string; number_format: string };
}

const METRES_PER_INCH = 0.0254;
const SQUARE_METRES_PER_SQUARE_FOOT = METRES_PER_INCH * METRES_PER_INCH * 144;
const INCHES_PER_FOOT = 12;
const METRES_PER_MILE = 1609.344;

export const isUsCustomary =(hass: HassUnits): boolean => hass.config.unit_system.length === "mi";

/**
 * Why a gesture saves nothing: a box apart from its room, a side under one grid step, a ring of
 * corners with fewer than three, or one whose sides cross or touch.
 */
export type Refusal = "apart" | "too_small" | "too_few_corners" | "crossing";

/** The toast for a refused gesture; the minimum side is the drawing grid step of the unit system. */
export const refusalMessage = (refusal: Refusal, hass: HassUnits): string => {
  switch (refusal) {
    case "apart":
      return "A room is one shape: draw against it";
    case "too_few_corners":
      return "An outline needs at least three corners";
    case "crossing":
      return "The outline cannot cross itself";
    case "too_small":
      return `Too small: every side needs at least ${isUsCustomary(hass) ? "4 in" : "10 cm"}`;
  }
};

/** What a toast says about a save that did not happen, and whether sending it again could succeed. */
export interface SaveFailure {
  message: string;
  retry: boolean;
}

// Home Assistant answers a refused command with a string code; a lost connection has a numeric one.
const refusalCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

const serverMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "";

/**
 * The toast for a save that did not happen. A write Home Assistant or Spatial refused fails the same
 * way again, so it says why and offers no Retry; a lost connection or a Spatial still starting may
 * pass on a second try. Spatial's own codes get plain words; other refusals show Home Assistant's message.
 */
export function saveFailure(error: unknown): SaveFailure {
  const code = refusalCode(error);
  if (code === undefined) return { message: "Could not save", retry: true };
  const message = serverMessage(error);
  switch (code) {
    // Right after a restart, before the integration has registered its commands.
    case "unknown_command":
      return { message: "Spatial is still starting, try again in a moment", retry: true };
    case "outside_outline":
      return { message: "Rooms must stay inside the outline", retry: false };
    case "conflict":
      return { message: "Changed elsewhere meanwhile", retry: false };
    case "not_found":
      return { message: "This room was removed meanwhile", retry: false };
    case "invalid_format":
      // Spatial names the area after its reason, "(kitchen)", or lists the areas after a colon.
      return message.startsWith("No net area")
        ? { message: "Too small: no floor is left inside the walls", retry: false }
        : { message: message.replace(/\s*\([^()]*\)$/, "") || "Spatial cannot store this shape", retry: false };
    default:
      return { message: message || "Could not save", retry: false };
  }
}

/*!
 * numberFormatToLocale and formatNumber are ported from home-assistant/frontend
 * src/common/number/format_number.ts, release 20260930.3:
 * https://github.com/home-assistant/frontend/blob/20260930.3/src/common/number/format_number.ts
 * Copyright Home Assistant contributors, Apache License 2.0.
 * Changed: the formatter cache is left out, and the `none` format (en-US without grouping) is
 * folded into formatNumber.
 */
const numberFormatToLocale = (localeOptions: HassUnits["locale"]): string | string[] | undefined => {
  switch (localeOptions.number_format) {
    case "comma_decimal":
      return ["en-US", "en"]; // Use United States with fallback to English formatting 1,234,567.89
    case "decimal_comma":
      return ["de", "es", "it"]; // Use German with fallback to Spanish then Italian formatting 1.234.567,89
    case "space_comma":
      return ["fr", "sv", "cs"]; // Use French with fallback to Swedish and Czech formatting 1 234 567,89
    case "quote_decimal":
      return ["de-CH"]; // Use German (Switzerland) formatting 1'234'567.89
    case "system":
      return undefined;
    default:
      return localeOptions.language;
  }
};

const formatNumber = (value: number, hass: HassUnits, fractionDigits: number): string => {
  const none = hass.locale.number_format === "none";
  return new Intl.NumberFormat(none ? "en-US" : numberFormatToLocale(hass.locale), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    ...(none && { useGrouping: false }),
  }).format(value);
};

const feetAndInches = (metres: number): string => {
  const inches = Math.round(metres / METRES_PER_INCH);
  return `${Math.floor(inches / INCHES_PER_FOOT)}′ ${inches % INCHES_PER_FOOT}″`;
};

/** Metres with two decimals (centimetres, rounded as typedLength does), or feet and inches with primes to the nearest inch. */
export function formatLength(metres: number, hass: HassUnits): string {
  return isUsCustomary(hass) ? feetAndInches(metres) : `${formatNumber(Number(metres.toFixed(2)), hass, 2)} m`;
}

/** The offered size of a rectangle, width first: `9.8 × 7.6 m` with one decimal, or feet and inches each. */
export function formatSize(widthM: number, depthM: number, hass: HassUnits): string {
  if (isUsCustomary(hass)) return `${feetAndInches(widthM)} × ${feetAndInches(depthM)}`;
  return `${formatNumber(widthM, hass, 1)} × ${formatNumber(depthM, hass, 1)} m`;
}

/** A length as a field starts with it: in ASCII digits with a dot, which parseLength reads in every number format. */
export function typedLength(metres: number, hass: HassUnits): string {
  if (isUsCustomary(hass)) return feetAndInches(metres);
  return `${metres.toFixed(2)} m`;
}

/** A distance on the map: whole metres up to a kilometre, then kilometres with one decimal; or feet up to a mile, then miles. */
export function formatDistance(metres: number, hass: HassUnits): string {
  const [small, smallUnit, large, largeUnit] = isUsCustomary(hass)
    ? [metres / (METRES_PER_INCH * INCHES_PER_FOOT), "ft", metres / METRES_PER_MILE, "mi"]
    : [metres, "m", metres / 1000, "km"];
  return large < 1 ? `${formatNumber(small, hass, 0)} ${smallUnit}` : `${formatNumber(large, hass, 1)} ${largeUnit}`;
}

/** Square metres with one decimal, or whole square feet. */
export const formatArea = (squareMetres: number, hass: HassUnits): string =>
  isUsCustomary(hass)
    ? `${formatNumber(squareMetres / SQUARE_METRES_PER_SQUARE_FOOT, hass, 0)} ft²`
    : `${formatNumber(squareMetres, hass, 1)} m²`;

const NUMBER = String.raw`(\d*[.,]?\d+)`;
const METRIC_LENGTH = new RegExp(String.raw`^${NUMBER}\s*m?$`);
// 12' 6", 12'6 or 12 6.
const FEET_AND_INCHES = new RegExp(String.raw`^${NUMBER}\s*(?:'\s*|\s+)${NUMBER}\s*"?$`);
// 150", 12.5' or 12.
const FEET_OR_INCHES = new RegExp(String.raw`^${NUMBER}\s*(['"]?)$`);
const numberOf = (text: string): number => Number(text.replace(",", "."));
// Phones and word processors turn ' and " into curly quotes; primes are the proper feet and inch marks.
const straightQuotes = (text: string): string => text.replace(/[’‘′]/g, "'").replace(/[”“″]/g, '"');

/**
 * A typed length in metres, or undefined when it is not one. Metric takes metres with a comma or a
 * dot decimal; US customary takes feet and inches, inches with `"`, or feet with `'` or no mark,
 * with straight or curly quotes or primes. Thousands separators are not read: a comma is a decimal mark.
 */
export function parseLength(text: string, hass: HassUnits): number | undefined {
  const typed = straightQuotes(text).trim();
  if (!isUsCustomary(hass)) {
    const metric = METRIC_LENGTH.exec(typed);
    return metric ? numberOf(metric[1]) : undefined;
  }
  const both = FEET_AND_INCHES.exec(typed);
  if (both) return (numberOf(both[1]) * INCHES_PER_FOOT + numberOf(both[2])) * METRES_PER_INCH;
  const one = FEET_OR_INCHES.exec(typed);
  if (!one) return undefined;
  return numberOf(one[1]) * (one[2] === '"' ? 1 : INCHES_PER_FOOT) * METRES_PER_INCH;
}
