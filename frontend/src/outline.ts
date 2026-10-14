import bearing from "@turf/bearing";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import buffer from "@turf/buffer";
import { lineString, point } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import rewind from "@turf/rewind";
import type { MultiPolygon, Polygon, Position } from "geojson";

// Half of a ~300 mm exterior wall is 150 mm, and the OSM outline is the outer face, so the
// reference line goes 0.25 m inward: 50 mm outside the inner face.
export const OUTLINE_OFFSET_M = 0.25;

const edgeBearing = (from: Position, to: Position): number => {
  const degrees = bearing(point(from), point(to));
  return ((degrees % 360) + 360) % 360;
};

export function buildingAt(geometry: Polygon | MultiPolygon, at: [number, number]): Polygon | undefined {
  const parts = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const hit = parts.find((coordinates) => booleanPointInPolygon(at, { type: "Polygon", coordinates }));
  return hit && { type: "Polygon", coordinates: hit };
}

export function alignOutline(
  building: Polygon,
  at: [number, number],
): { outline: Polygon; bearingDeg: number } {
  const inset = buffer(building, -OUTLINE_OFFSET_M, { units: "meters" });
  // Buffer returns the first Polygon part; a building too small to inset has no outline.
  const shell = (rewind(inset!.geometry as Polygon) as Polygon).coordinates[0];
  const closed = shell.slice(0, -1);
  const nearest = nearestPointOnLine(lineString(shell), point(at));
  const start = nearest.properties.index;
  const ring = [...closed.slice(start), ...closed.slice(0, start)];
  ring.push(ring[0]);
  return {
    outline: { type: "Polygon", coordinates: [ring] },
    bearingDeg: edgeBearing(ring[0], ring[1]),
  };
}

export function outlineBearing(outline: Polygon): number {
  const ring = outline.coordinates[0];
  return edgeBearing(ring[0], ring[1]);
}
