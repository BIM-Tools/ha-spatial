// Finds a building in Home Assistant's map tiles and the bearing of the wall the rooms follow.

import bearing from "@turf/bearing";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { lineString, point } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import rewind from "@turf/rewind";
import type { MultiPolygon, Polygon, Position } from "geojson";

export function buildingAt(geometry: Polygon | MultiPolygon, at: [number, number]): Polygon | undefined {
  const parts = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const hit = parts.find((coordinates) => booleanPointInPolygon(at, { type: "Polygon", coordinates }));
  return hit && { type: "Polygon", coordinates: hit };
}

/** The bearing of the exterior edge nearest `at`, in [0, 360), with the building on its left. */
export function wallBearingAt(building: Polygon, at: Position): number {
  const ring = (rewind(building) as Polygon).coordinates[0];
  const index = nearestPointOnLine(lineString(ring), point(at)).properties.segmentIndex;
  const degrees = bearing(point(ring[index]), point(ring[index + 1]));
  return ((degrees % 360) + 360) % 360;
}
