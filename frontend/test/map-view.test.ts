import type { FeatureCollection } from "geojson";
import { expect, test } from "vitest";
import { levels, mapBearing, styleUrl, withMapTilesToken } from "../src/map-view";

test("mapBearing turns the site's x-axis to point right", () => {
  expect(mapBearing(0)).toBe(270);
  expect(mapBearing(90)).toBe(0);
  expect(mapBearing(359)).toBe(269);
});

test("styleUrl picks Home Assistant's shipped style", () => {
  expect(styleUrl(true)).toBe("/static/map/dark.json");
  expect(styleUrl(false)).toBe("/static/map/light.json");
});

test("withMapTilesToken sends the token to the proxy only", () => {
  expect(withMapTilesToken("/api/map_tiles/tilejson.json", "http://ha:8123", "t")).toEqual({
    url: "http://ha:8123/api/map_tiles/tilejson.json",
    headers: { "X-Map-Tiles-Token": "t" },
  });
  expect(withMapTilesToken("/static/map/sprites/base.json", "http://ha:8123", "t")).toEqual({
    url: "http://ha:8123/static/map/sprites/base.json",
  });
});

test("levels lists distinct levels, sorted, null last", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [1, 0, null, 1].map((level) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { level },
    })),
  };
  expect(levels(fc)).toEqual([0, 1, null]);
});
