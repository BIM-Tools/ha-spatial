// Finds a building in Home Assistant's map tiles and the bearing of the wall the rooms follow.

import bearing from "@turf/bearing";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { lineString, point } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type { MultiPolygon, Polygon, Position } from "geojson";

export function buildingAt(geometry: Polygon | MultiPolygon, at: [number, number]): Polygon | undefined {
  const parts = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const hit = parts.find((coordinates) => booleanPointInPolygon(at, { type: "Polygon", coordinates }));
  return hit && { type: "Polygon", coordinates: hit };
}

/**
 * The bearing of the exterior edge nearest `at`, in [0, 360), in the ring's own direction.
 * Map tiles and GeoJSON wind exterior rings counter-clockwise, so the building lies left of it.
 */
export function wallBearingAt(building: Polygon, at: Position): number {
  const ring = building.coordinates[0];
  const index = nearestPointOnLine(lineString(ring), point(at)).properties.segmentIndex;
  const degrees = bearing(point(ring[index]), point(ring[index + 1]));
  return ((degrees % 360) + 360) % 360;
}
