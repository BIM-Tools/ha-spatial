// The unit system and number format parts of `hass`, as Home Assistant sends them, shared by the tests.
import type { HassUnits } from "../src/units";

export const unitsOf = (length: "km" | "mi", number_format = "language", language = "en"): HassUnits => ({
  config: { unit_system: { length } },
  locale: { language, number_format },
});

export const METRIC_UNITS = unitsOf("km");
export const US_UNITS = unitsOf("mi");
