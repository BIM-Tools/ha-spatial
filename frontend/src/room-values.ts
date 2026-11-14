// Reads one live value per area from Home Assistant's states and turns it into a room fill and the text under the name.

/** What the card's `colour_by` option can show. */
export type ColourBy = "brightness" | "temperature";

export const COLOUR_BY: readonly ColourBy[] = ["brightness", "temperature"];

/** The parts of Home Assistant's `hass` object this module reads. */
export interface RoomHass {
  states: Record<string, { state: string; attributes: Record<string, unknown> }>;
  entities: Record<string, { area_id?: string | null; device_id?: string | null }>;
  devices: Record<string, { area_id?: string | null }>;
  locale: { language: string; number_format: string };
}

/** The text under a room's name, and its fill; no fill leaves the room as it is. */
export interface RoomValue {
  text: string;
  fill?: string;
}

type Rgb = [number, number, number];

// Cold, middle and warm stops at 15, 21 and 28 °C.
const STOPS: Record<"light" | "dark", Rgb[]> = {
  light: [[91, 155, 213], [236, 236, 236], [239, 108, 62]],
  dark: [[61, 122, 184], [74, 74, 74], [217, 87, 43]],
};
const STOP_CELSIUS = [15, 21, 28];

const temperatureFill = (celsius: number, dark: boolean): string => {
  const stops = STOPS[dark ? "dark" : "light"];
  const at = Math.min(Math.max(celsius, STOP_CELSIUS[0]), STOP_CELSIUS[2]);
  const upper = at <= STOP_CELSIUS[1] ? 1 : 2;
  const share = (at - STOP_CELSIUS[upper - 1]) / (STOP_CELSIUS[upper] - STOP_CELSIUS[upper - 1]);
  const [r, g, b] = stops[upper - 1].map((channel, index) => Math.round(channel + (stops[upper][index] - channel) * share));
  return `rgb(${r},${g},${b})`;
};

const AMBER = "255,179,0";

// The area of an entity, else that of its device.
const areaOf = (hass: RoomHass, entityId: string): string | undefined => {
  const entry = hass.entities[entityId];
  const device = entry?.device_id ? hass.devices[entry.device_id] : undefined;
  return entry?.area_id || device?.area_id || undefined;
};

const NOT_A_VALUE = new Set(["unavailable", "unknown"]);

const brightness = (hass: RoomHass): Record<string, RoomValue> => {
  // Per area the brightest light that is on, in percent; 0 when every known light is off.
  const brightest: Record<string, number> = {};
  for (const [entityId, { state, attributes }] of Object.entries(hass.states)) {
    if (!entityId.startsWith("light.") || NOT_A_VALUE.has(state)) continue;
    const area = areaOf(hass, entityId);
    if (!area) continue;
    const percent = state === "on" ? Math.round(((typeof attributes.brightness === "number" ? attributes.brightness : 255) / 255) * 100) : 0;
    brightest[area] = Math.max(brightest[area] ?? 0, percent);
  }
  return Object.fromEntries(
    Object.entries(brightest).map(([area, percent]) => [
      area,
      percent > 0
        ? { text: `${percent} %`, fill: `rgba(${AMBER},${Math.round((0.12 + 0.6 * (percent / 100)) * 1000) / 1000})` }
        : { text: "Off" },
    ]),
  );
};

const temperature = (hass: RoomHass, dark: boolean): Record<string, RoomValue> => {
  // Per area the readings in °C, and the unit of the first sensor, which the text uses.
  const readings: Record<string, { celsius: number[]; fahrenheit: boolean }> = {};
  for (const [entityId, { state, attributes }] of Object.entries(hass.states)) {
    if (!entityId.startsWith("sensor.") || attributes.device_class !== "temperature" || NOT_A_VALUE.has(state)) continue;
    const value = Number(state);
    const area = areaOf(hass, entityId);
    if (!area || state.trim() === "" || Number.isNaN(value)) continue;
    const fahrenheit = attributes.unit_of_measurement === "°F";
    const entry = (readings[area] ??= { celsius: [], fahrenheit });
    entry.celsius.push(fahrenheit ? ((value - 32) * 5) / 9 : value);
  }
  const number = new Intl.NumberFormat(hass.locale.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return Object.fromEntries(
    Object.entries(readings).map(([area, { celsius, fahrenheit }]) => {
      const average = celsius.reduce((sum, value) => sum + value, 0) / celsius.length;
      return [area, { text: `${number.format(fahrenheit ? (average * 9) / 5 + 32 : average)}°`, fill: temperatureFill(average, dark) }];
    }),
  );
};

/**
 * The value and fill per area id for one kind; an area with no usable entity is left out.
 * SIMPLIFIED: scans every state on each change of `hass`; the caller repaints only when the result changes.
 */
export const roomValues = (kind: ColourBy, hass: RoomHass, dark: boolean): Record<string, RoomValue> =>
  kind === "brightness" ? brightness(hass) : temperature(hass, dark);
