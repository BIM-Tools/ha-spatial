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

/** The exterior edge nearest `at`, as its two positions with the building on its left. */
export function wallAt(building: Polygon, at: Position): [Position, Position] {
  const ring = (rewind(building) as Polygon).coordinates[0];
  const index = nearestPointOnLine(lineString(ring), point(at)).properties.segmentIndex;
  return [ring[index], ring[index + 1]];
}

/** The bearing of the exterior edge nearest `at`, in [0, 360). */
export function wallBearingAt(building: Polygon, at: Position): number {
  const [start, end] = wallAt(building, at);
  return ((bearing(point(start), point(end)) % 360) + 360) % 360;
}

/** The `spatial/site/update` fields an Align pick at `at` writes. */
export interface AlignFields {
  bearing_deg: number;
  origin?: Position;
}

/**
 * What an Align pick writes: the bearing of the wall nearest `at`, and on an empty plan the wall's left
 * end as origin. Once the plan has shapes the origin stays, so no room moves on the lattice.
 */
export function alignFields(building: Polygon, at: Position, planHasShapes: boolean): AlignFields {
  const bearing_deg = wallBearingAt(building, at);
  return planHasShapes ? { bearing_deg } : { bearing_deg, origin: wallAt(building, at)[0] };
}
