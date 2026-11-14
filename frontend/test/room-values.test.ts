// Checks what each colour_by kind reads from Home Assistant's states and how it colours a room.
import { expect, test } from "vitest";
import { type RoomHass, roomValues } from "../src/room-values";

const hass = (states: RoomHass["states"], entities: RoomHass["entities"] = {}, devices: RoomHass["devices"] = {}): RoomHass => ({
  states,
  entities,
  devices,
  locale: { language: "en", number_format: "language" },
});

const light = (state: string, brightness?: number) => ({ state, attributes: brightness === undefined ? {} : { brightness } });
const temperature = (state: string, unit = "°C") => ({
  state,
  attributes: { device_class: "temperature", unit_of_measurement: unit },
});

test("brightness reads the brightest light that is on, an on light without brightness counts 100 %", () => {
  const rooms = roomValues(
    "brightness",
    hass(
      { "light.a": light("on", 51), "light.b": light("on", 204), "light.c": light("on"), "light.d": light("off") },
      { "light.a": { area_id: "x" }, "light.b": { area_id: "x" }, "light.c": { area_id: "y" }, "light.d": { area_id: "z" } },
    ),
    false,
  );
  expect(rooms.x.text).toBe("80 %");
  expect(rooms.x.fill).toBe("rgba(255,179,0,0.6)");
  expect(rooms.y.text).toBe("100 %");
  expect(rooms.z).toEqual({ text: "Off" });
});

test("a light takes the area of its device when it has none of its own; unavailable lights count for nothing", () => {
  const rooms = roomValues(
    "brightness",
    hass(
      { "light.a": light("on", 255), "light.b": light("unavailable") },
      { "light.a": { device_id: "dev" }, "light.b": { area_id: "y" } },
      { dev: { area_id: "x" } },
    ),
    false,
  );
  expect(rooms.x.text).toBe("100 %");
  expect(rooms.y).toBeUndefined();
});

test("temperature averages the area's temperature sensors and shows one decimal in their own unit", () => {
  const rooms = roomValues(
    "temperature",
    hass(
      {
        "sensor.a": temperature("21"),
        "sensor.b": temperature("22"),
        "sensor.c": temperature("unknown"),
        "sensor.d": { state: "50", attributes: { device_class: "humidity" } },
        "sensor.f": temperature("70", "°F"),
      },
      { "sensor.a": { area_id: "x" }, "sensor.b": { area_id: "x" }, "sensor.c": { area_id: "x" }, "sensor.d": { area_id: "x" }, "sensor.f": { area_id: "y" } },
    ),
    false,
  );
  expect(rooms.x.text).toBe("21.5°");
  expect(rooms.y.text).toBe("70.0°");
  // 70 °F is 21.1 °C, just above the middle stop.
  expect(rooms.y.fill).toBe("rgb(236,234,233)");
});

test("the temperature ramp runs 15, 21, 28 and is clamped, with its own stops per theme", () => {
  const fill = (celsius: string, dark: boolean) =>
    roomValues("temperature", hass({ "sensor.a": temperature(celsius) }, { "sensor.a": { area_id: "x" } }), dark).x.fill;
  expect(fill("10", false)).toBe("rgb(91,155,213)");
  expect(fill("15", false)).toBe("rgb(91,155,213)");
  expect(fill("21", false)).toBe("rgb(236,236,236)");
  expect(fill("28", false)).toBe("rgb(239,108,62)");
  expect(fill("35", false)).toBe("rgb(239,108,62)");
  expect(fill("18", false)).toBe("rgb(164,196,225)");
  expect(fill("15", true)).toBe("rgb(61,122,184)");
  expect(fill("21", true)).toBe("rgb(74,74,74)");
  expect(fill("28", true)).toBe("rgb(217,87,43)");
});

test("an area without a matching entity is left out", () => {
  expect(roomValues("temperature", hass({ "light.a": light("on") }, { "light.a": { area_id: "x" } }), false)).toEqual({});
});
