// Checks what each colour_by kind reads from Home Assistant's states and the number and text each room gets.
import { expect, test } from "vitest";
import { type RoomHass, roomValues } from "../src/room-values";

const hass = (states: RoomHass["states"], entities: RoomHass["entities"] = {}, devices: RoomHass["devices"] = {}, areas: RoomHass["areas"] = {}): RoomHass => ({
  states,
  entities,
  devices,
  areas,
  locale: { language: "en" },
});

const light = (state: string, brightness?: number) => ({ state, attributes: brightness === undefined ? {} : { brightness } });
const temperature = (state: string, unit = "°C") => ({
  state,
  attributes: { device_class: "temperature", unit_of_measurement: unit },
});

test.each([
  ["the brightest light that is on wins", { "light.a": light("on", 51), "light.b": light("on", 204) }, { text: "80 %", value: 80 }],
  ["an on light without brightness counts 100 %", { "light.a": light("on") }, { text: "100 %", value: 100 }],
  ["an on light never reads below 1 %", { "light.a": light("on", 1) }, { text: "1 %", value: 1 }],
  ["every light off is Off with no value", { "light.a": light("off"), "light.b": light("off") }, { text: "Off" }],
])("brightness: %s", (_name, states, expected) => {
  const entities = Object.fromEntries(Object.keys(states).map((id) => [id, { area_id: "x" }]));
  expect(roomValues("brightness", hass(states, entities)).x).toEqual(expected);
});

test("a light takes the area of its device when it has none of its own; unavailable lights count for nothing", () => {
  const rooms = roomValues(
    "brightness",
    hass(
      { "light.a": light("on", 255), "light.b": light("unavailable") },
      { "light.a": { device_id: "dev" }, "light.b": { area_id: "y" } },
      { dev: { area_id: "x" } },
    ),
  );
  expect(rooms.x.text).toBe("100 %");
  expect(rooms.y).toBeUndefined();
});

const SENSORS = { "sensor.a": { area_id: "x" }, "sensor.b": { area_id: "x" }, "sensor.c": { area_id: "x" } };

test.each([
  ["averages the area's sensors, one decimal", { "sensor.a": temperature("21"), "sensor.b": temperature("22") }, {}, { text: "21.5°", value: 21.5 }],
  ["skips sensors that are no number or no temperature", { "sensor.a": temperature("21"), "sensor.b": temperature("unknown"), "sensor.c": { state: "50", attributes: { device_class: "humidity" } } }, {}, { text: "21.0°", value: 21 }],
  ["reads in the unit of the sensor and keeps °C for the value", { "sensor.a": temperature("70", "°F") }, {}, { text: "70.0°", value: (70 - 32) * 5 / 9 }],
  ["the sensor chosen for the area wins over the average", { "sensor.a": temperature("21"), "sensor.b": temperature("25") }, { x: { temperature_entity_id: "sensor.b" } }, { text: "25.0°", value: 25 }],
  ["a chosen sensor that is no number falls back to the average", { "sensor.a": temperature("21"), "sensor.b": temperature("unavailable") }, { x: { temperature_entity_id: "sensor.b" } }, { text: "21.0°", value: 21 }],
])("temperature: %s", (_name, states, areas, expected) => {
  expect(roomValues("temperature", hass(states, SENSORS, {}, areas)).x).toEqual(expected);
});

test("an area without a matching entity is left out", () => {
  expect(roomValues("temperature", hass({ "light.a": light("on") }, { "light.a": { area_id: "x" } }))).toEqual({});
});
