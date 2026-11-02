// Map logic that needs no map, so it can be tested without MapLibre or a browser.

import type { Feature, FeatureCollection, Polygon } from "geojson";

/** MapLibre bearing that puts the site's x-axis (the picked wall) horizontal, pointing right. */
export const mapBearing = (bearingDeg: number): number => (((bearingDeg - 90) % 360) + 360) % 360;

/** Home Assistant's shipped vector style, served by its frontend. */
export const styleUrl = (darkMode: boolean): string =>
  `/static/map/${darkMode ? "dark" : "light"}.json`;

// The parts of Home Assistant's `hass` object that decide between light and dark.
export interface ThemeState {
  themes: {
    darkMode?: boolean;
    default_theme?: string;
    default_dark_theme?: string | null;
    themes?: Record<string, { modes?: Record<string, unknown> }>;
  };
  selectedTheme?: { theme?: string; dark?: boolean } | null;
}

/**
 * Whether Home Assistant shows its dark mode. Home Assistant can hand over its themes before it
 * has resolved `darkMode` (it skips that while its configuration has not arrived), so an unset
 * `darkMode` is resolved here as _applyTheme in home-assistant/frontend
 * src/state/themes-mixin.ts, release 20260930.3, does:
 * https://github.com/home-assistant/frontend/blob/20260930.3/src/state/themes-mixin.ts
 * Copyright Home Assistant contributors, Apache License 2.0.
 *
 * Limit: recovery and safe mode, which force the default theme, are not followed.
 */
export const darkModeOf = ({ themes, selectedTheme }: ThemeState, darkPreferred: boolean): boolean => {
  if (themes.darkMode !== undefined) return themes.darkMode;
  let darkMode = selectedTheme?.dark === undefined ? darkPreferred : selectedTheme.dark;
  const themeName =
    selectedTheme?.theme || (darkMode && themes.default_dark_theme ? themes.default_dark_theme : themes.default_theme);
  const theme = themeName ? themes.themes?.[themeName] : undefined;
  if (theme) {
    if (!theme.modes || !("dark" in theme.modes)) {
      darkMode = false;
    } else if (!("light" in theme.modes)) {
      darkMode = true;
    }
  }
  return darkMode;
};

const MAP_TILES_PATH = "/api/map_tiles";
const TOKEN_HEADER = "X-Map-Tiles-Token";

/**
 * Port of the same-origin branch of withMapTilesToken in home-assistant/frontend
 * src/data/map_tiles.ts, release 20260930.3:
 * https://github.com/home-assistant/frontend/blob/20260930.3/src/data/map_tiles.ts
 * Copyright Home Assistant contributors, Apache License 2.0.
 *
 * MapLibre hands tile URLs to a worker, which has no document to resolve a
 * relative URL against, so the result has to be absolute.
 */
export const withMapTilesToken = (
  url: string,
  origin: string,
  token: string,
): { url: string; headers?: Record<string, string> } => {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return { url };
  }

  if (!parsed.pathname.startsWith(`${MAP_TILES_PATH}/`)) {
    return { url: parsed.href };
  }

  const onInstance = new URL(`${origin}${parsed.pathname}${parsed.search}`);
  return { url: onInstance.href, headers: { [TOKEN_HEADER]: token } };
};

export interface FloorLevel {
  floor_id: string | null;
  level: number | null;
}

/** Orders floors by level: floors without a level after those with one, no floor (`null`) last. */
export const byLevel = (a: FloorLevel, b: FloorLevel) => {
  const group = (floor: FloorLevel) => (floor.floor_id === null ? 2 : floor.level === null ? 1 : 0);
  return group(a) - group(b) || (a.level ?? 0) - (b.level ?? 0);
};

/**
 * Distinct `properties.floor_id` of the features, by level. Several floors may
 * share a level; they keep feed order.
 */
export const floorsByLevel = (collection: FeatureCollection): (string | null)[] => {
  const levelOf = new Map<string | null, number | null>();
  for (const feature of collection.features) {
    levelOf.set(feature.properties?.floor_id ?? null, feature.properties?.level ?? null);
  }
  return [...levelOf]
    .map(([floor_id, level]) => ({ floor_id, level }))
    .sort(byLevel)
    .map((floor) => floor.floor_id);
};

/**
 * Custom: `[west, south, east, north]` around the outer rings of the polygon
 * features, for framing them; undefined without features.
 */
export const bounds = (features: Feature[]): [number, number, number, number] | undefined => {
  const points = features.flatMap((f) => (f.geometry as Polygon).coordinates[0]);
  if (!points.length) return undefined;
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
};
