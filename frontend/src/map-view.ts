// Map logic that needs no map, so it can be tested without MapLibre or a browser.

import type { Feature, FeatureCollection, Polygon } from "geojson";

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

/**
 * Distinct `properties.floor_id` of the features, by level: floors without a
 * level after those with one, `null` (no floor) last. Several floors may share
 * a level; they keep feed order.
 */
export const floorsByLevel = (collection: FeatureCollection): (string | null)[] => {
  const levelOf = new Map<string | null, number | null>();
  for (const feature of collection.features) {
    levelOf.set(feature.properties?.floor_id ?? null, feature.properties?.level ?? null);
  }
  const sortKey = (floorId: string | null) => {
    const level = levelOf.get(floorId) ?? null;
    return [floorId === null ? 2 : level === null ? 1 : 0, level ?? 0];
  };
  return [...levelOf.keys()].sort((a, b) => {
    const [groupA, levelA] = sortKey(a);
    const [groupB, levelB] = sortKey(b);
    return groupA - groupB || levelA - levelB;
  });
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
