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

// numberFormatToLocale, ported from home-assistant/frontend src/common/number/format_number.ts, release 20260930.3.
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

// The `none` format is en-US without grouping, as in formatNumberToParts of the same file.
const numberFormat = (hass: HassUnits, fractionDigits: number): Intl.NumberFormat => {
  const none = hass.locale.number_format === "none";
  return new Intl.NumberFormat(none ? "en-US" : numberFormatToLocale(hass.locale), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    ...(none && { useGrouping: false }),
  });
};

const formatNumber = (value: number, hass: HassUnits, fractionDigits: number): string =>
  numberFormat(hass, fractionDigits).format(value);

// The user's digits and decimal mark as ASCII digits and a dot, so a length shown in any number format reads back.
const asciiDigits = (text: string, hass: HassUnits): string => {
  const parts = numberFormat(hass, 1).formatToParts(1234567890.1);
  const digits = parts.filter(({ type }) => type === "integer" || type === "fraction").map(({ value }) => value).join("");
  const decimal = parts.find(({ type }) => type === "decimal")?.value;
  return [...text].map((char) => (char === decimal ? "." : ("12345678901"[digits.indexOf(char)] ?? char))).join("");
};

/** Metres with two decimals, or feet and inches to the nearest inch. */
export function formatLength(metres: number, hass: HassUnits): string {
  if (!isUsCustomary(hass)) return `${formatNumber(metres, hass, 2)} m`;
  const inches = Math.round(metres / METRES_PER_INCH);
  const feet = Math.floor(inches / INCHES_PER_FOOT);
  return feet ? `${feet}' ${inches % INCHES_PER_FOOT}"` : `${inches}"`;
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

/**
 * A typed length in metres, or undefined when it is not one. Metric takes metres with a comma, a dot
 * or the user's own decimal mark; US customary takes feet and inches, inches with `"`, or feet with
 * `'` or no mark. Thousands separators are not read: a comma is a decimal mark.
 */
export function parseLength(text: string, hass: HassUnits): number | undefined {
  const typed = asciiDigits(text, hass).trim();
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
