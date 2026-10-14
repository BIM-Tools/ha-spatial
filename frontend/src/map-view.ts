import type { FeatureCollection } from "geojson";

/** MapLibre bearing that puts the site's x-axis (the picked wall) horizontal, pointing right. */
export const mapBearing = (bearingDeg: number): number => (((bearingDeg - 90) % 360) + 360) % 360;

/** Home Assistant's shipped vector style, served by its frontend. */
export const styleUrl = (darkMode: boolean): string =>
  `/static/map/${darkMode ? "dark" : "light"}.json`;

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

/** Distinct `properties.level` of the features, sorted, `null` (no floor) last. */
export const levels = (fc: FeatureCollection): (number | null)[] =>
  [...new Set(fc.features.map((f) => (f.properties?.level ?? null) as number | null))].sort(
    (a, b) => (a === null ? 1 : b === null ? -1 : a - b),
  );
