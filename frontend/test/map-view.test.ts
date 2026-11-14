// Checks the map logic that runs without a map.

import type { FeatureCollection } from "geojson";
import { expect, test } from "vitest";
import { darkModeOf, floorsByLevel, freeAreaPadding, mapBearing, styleUrl, withMapTilesToken, workerUrl } from "../src/map-view";

test("the worker is loaded from next to the panel bundle, with the same version", () => {
  // The bundle version covers the worker, so a cached old worker is never reused.
  expect(workerUrl("http://ha:8123/spatial_static/spatial-panel.js?v=abc")).toBe(
    "http://ha:8123/spatial_static/maplibre-gl-worker.js?v=abc",
  );
});

test("mapBearing turns the site's x-axis to point right", () => {
  expect(mapBearing(0)).toBe(270);
  expect(mapBearing(90)).toBe(0);
  expect(mapBearing(359)).toBe(269);
});

test("styleUrl picks Home Assistant's shipped style", () => {
  expect(styleUrl(true)).toBe("/static/map/dark.json");
  expect(styleUrl(false)).toBe("/static/map/light.json");
});

test("darkModeOf takes Home Assistant's darkMode once it has resolved it", () => {
  expect(darkModeOf({ themes: { darkMode: false } }, true)).toBe(false);
  expect(darkModeOf({ themes: { darkMode: true } }, false)).toBe(true);
});

test("darkModeOf resolves an unset darkMode the way Home Assistant does", () => {
  const themes = {
    default_theme: "default",
    default_dark_theme: null,
    themes: {
      light_only: { modes: { light: {} } },
      dark_only: { modes: { dark: {} } },
      both: { modes: { light: {}, dark: {} } },
      plain: {},
    },
  };
  expect(darkModeOf({ themes }, true)).toBe(true);
  expect(darkModeOf({ themes }, false)).toBe(false);
  expect(darkModeOf({ themes, selectedTheme: { dark: false } }, true)).toBe(false);
  expect(darkModeOf({ themes, selectedTheme: { dark: true } }, false)).toBe(true);
  expect(darkModeOf({ themes, selectedTheme: { theme: "light_only" } }, true)).toBe(false);
  expect(darkModeOf({ themes, selectedTheme: { theme: "plain" } }, true)).toBe(false);
  expect(darkModeOf({ themes, selectedTheme: { theme: "dark_only" } }, false)).toBe(true);
  expect(darkModeOf({ themes, selectedTheme: { theme: "both" } }, true)).toBe(true);
  expect(darkModeOf({ themes: { ...themes, default_dark_theme: "light_only" } }, true)).toBe(false);
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

test("floorsByLevel lists distinct floors by level, no level after, no floor last", () => {
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      ["up", 1],
      ["ground", 0],
      [null, null],
      ["attic", null],
      ["annex", 0],
      ["up", 1],
    ].map(([floor_id, level]) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { floor_id, level },
    })),
  };
  expect(floorsByLevel(collection)).toEqual(["ground", "annex", "up", "attic", null]);
});

test("the free area starts 16 px under the guide and ends 24 px over the strip, with 48 px at the sides", () => {
  // A desktop stage 800 px tall whose strip starts 72 px above its bottom edge.
  expect(freeAreaPadding({ top: 80, bottom: 72 })).toEqual({ top: 96, bottom: 96, left: 48, right: 48 });
  // A phone: the strip sits over the tool bar, 126 px from the bottom.
  expect(freeAreaPadding({ top: 40, bottom: 126 })).toEqual({ top: 56, bottom: 150, left: 48, right: 48 });
});

test("without a guide or a strip the padding is 16 px at the top and bottom", () => {
  expect(freeAreaPadding({ top: 0, bottom: 0 })).toEqual({ top: 16, bottom: 16, left: 48, right: 48 });
});
