// Shows and reads lengths and areas in Home Assistant's unit system and the user's number format; storage stays metric.

/** The parts of Home Assistant's `hass` object that decide the unit system and the number format. */
export interface HassUnits {
  config: { unit_system: { length: string } };
  locale: { language: string; number_format: string };
}

const METRES_PER_INCH = 0.0254;
const SQUARE_METRES_PER_SQUARE_FOOT = METRES_PER_INCH * METRES_PER_INCH * 144;
const INCHES_PER_FOOT = 12;

const isUsCustomary = (hass: HassUnits): boolean => hass.config.unit_system.length === "mi";

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

/** Metres with two decimals, or feet and inches to the nearest inch. */
export function formatLength(metres: number, hass: HassUnits): string {
  if (!isUsCustomary(hass)) return `${formatNumber(metres, hass, 2)} m`;
  const inches = Math.round(metres / METRES_PER_INCH);
  const feet = Math.floor(inches / INCHES_PER_FOOT);
  return feet ? `${feet}' ${inches % INCHES_PER_FOOT}"` : `${inches}"`;
}

/** A length as a field starts with it: in ASCII digits with a dot, which parseLength reads in every number format. */
export const typedLength = (metres: number, hass: HassUnits): string =>
  isUsCustomary(hass) ? formatLength(metres, hass) : `${metres.toFixed(2)} m`;

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
