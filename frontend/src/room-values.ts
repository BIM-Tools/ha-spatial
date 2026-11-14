// Custom: reads one live number per area from Home Assistant's states, with the text under the room's name. Colours are MapLibre's job (map-paint.ts).
// Home Assistant has no helper that gives an area's brightest light or its temperature as a number, so areaOf, brightness and temperature are ours.

/** What the card's `colour_by` option can show. */
export type ColourBy = "brightness" | "temperature";

/** The parts of Home Assistant's `hass` object this module reads. */
export interface RoomHass {
  states: Record<string, { state: string; attributes: Record<string, unknown> }>;
  entities: Record<string, { area_id?: string | null; device_id?: string | null }>;
  devices: Record<string, { area_id?: string | null }>;
  areas?: Record<string, { temperature_entity_id?: string | null }>;
  locale: { language: string };
}

/** The text under a room's name, and the number its colour follows (percent, or °C); no value leaves the room's plain fill. */
export interface RoomValue {
  text: string;
  value?: number;
}

// The area of an entity, else that of its device.
const areaOf = (hass: RoomHass, entityId: string): string | undefined => {
  const entry = hass.entities[entityId];
  const device = entry?.device_id ? hass.devices[entry.device_id] : undefined;
  return entry?.area_id || device?.area_id || undefined;
};

const NOT_A_VALUE = new Set(["unavailable", "unknown"]);

const brightness = (hass: RoomHass): Record<string, RoomValue> => {
  // Per area the brightest light that is on, in percent, at least 1 for a light that is on; 0 when every known light is off.
  const brightest: Record<string, number> = {};
  for (const [entityId, { state, attributes }] of Object.entries(hass.states)) {
    if (!entityId.startsWith("light.") || NOT_A_VALUE.has(state)) continue;
    const area = areaOf(hass, entityId);
    if (!area) continue;
    const level = typeof attributes.brightness === "number" ? attributes.brightness : 255;
    const percent = state === "on" ? Math.max(1, Math.round((level / 255) * 100)) : 0;
    brightest[area] = Math.max(brightest[area] ?? 0, percent);
  }
  return Object.fromEntries(
    Object.entries(brightest).map(([area, percent]) => [area, percent > 0 ? { text: `${percent} %`, value: percent } : { text: "Off" }]),
  );
};

// A temperature sensor's reading in °C, and whether it reads in °F; undefined when it is no number.
const reading = (hass: RoomHass, entityId: string) => {
  const entity = hass.states[entityId];
  const number = Number(entity?.state);
  if (!entity || NOT_A_VALUE.has(entity.state) || entity.state.trim() === "" || Number.isNaN(number)) return undefined;
  const fahrenheit = entity.attributes.unit_of_measurement === "°F";
  return { celsius: fahrenheit ? ((number - 32) * 5) / 9 : number, fahrenheit };
};

const temperature = (hass: RoomHass): Record<string, RoomValue> => {
  // Per area the readings of its temperature sensors; the unit of the first one is the one the text uses.
  const readings: Record<string, { celsius: number[]; fahrenheit: boolean }> = {};
  for (const [entityId, { attributes }] of Object.entries(hass.states)) {
    if (!entityId.startsWith("sensor.") || attributes.device_class !== "temperature") continue;
    const area = areaOf(hass, entityId);
    const value = area ? reading(hass, entityId) : undefined;
    if (!area || !value) continue;
    (readings[area] ??= { celsius: [], fahrenheit: value.fahrenheit }).celsius.push(value.celsius);
  }
  // The sensor chosen for an area in Home Assistant, which its own area card shows, wins over the average.
  for (const [area, { temperature_entity_id: chosen }] of Object.entries(hass.areas ?? {})) {
    const value = chosen ? reading(hass, chosen) : undefined;
    if (value) readings[area] = { celsius: [value.celsius], fahrenheit: value.fahrenheit };
  }
  const number = new Intl.NumberFormat(hass.locale.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return Object.fromEntries(
    Object.entries(readings).map(([area, { celsius, fahrenheit }]) => {
      const average = celsius.reduce((sum, value) => sum + value, 0) / celsius.length;
      return [area, { text: `${number.format(fahrenheit ? (average * 9) / 5 + 32 : average)}°`, value: average }];
    }),
  );
};

/**
 * The text and number per area id for one kind; an area with no usable entity is left out.
 * SIMPLIFIED: scans every state on each change of `hass`; the caller applies only what changed.
 */
export const roomValues = (kind: ColourBy, hass: RoomHass): Record<string, RoomValue> =>
  kind === "brightness" ? brightness(hass) : temperature(hass);
