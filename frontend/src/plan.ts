// Plan-space geometry for drawing rooms: boxes from screen corners, side lengths, resizing and joining shapes.

import area from "@turf/area";
import bearing from "@turf/bearing";
import center from "@turf/center";
import destination from "@turf/destination";
import distance from "@turf/distance";
import { point, polygon } from "@turf/helpers";
import rewind from "@turf/rewind";
import union from "@turf/union";
import type { Polygon, Position } from "geojson";

export const MIN_SIDE_M = 0.2;
const AXIS_TOLERANCE_DEG = 0.5;

const metres = { units: "meters" } as const;
const corners = (shape: Polygon): Position[] => shape.coordinates[0].slice(0, -1);
const wrap = (degrees: number, turn: number): number => ((degrees % turn) + turn) % turn;
const edgeLength = (from: Position, to: Position): number => distance(point(from), point(to), metres);
const ringOf = (vertices: Position[]): Polygon => ({ type: "Polygon", coordinates: [[...vertices, vertices[0]]] });

export function edgeLengths(shape: Polygon): number[] {
  const vertices = corners(shape);
  return vertices.map((vertex, index) => edgeLength(vertex, vertices[(index + 1) % vertices.length]));
}

/** The four unprojected corners of a screen rectangle as a counter-clockwise box, or undefined when a side is too short. */
export function boxFromCorners(rectangle: [Position, Position, Position, Position]): Polygon | undefined {
  const box = rewind(ringOf(rectangle)) as Polygon;
  return edgeLengths(box).some((length) => length < MIN_SIDE_M) ? undefined : box;
}

export function sideLabels(shape: Polygon): { at: Position; edgeIndex: number; text: string }[] {
  const vertices = corners(shape);
  return edgeLengths(shape).map((length, edgeIndex) => {
    const next = vertices[(edgeIndex + 1) % vertices.length];
    const from = vertices[edgeIndex];
    return { at: [(from[0] + next[0]) / 2, (from[1] + next[1]) / 2], edgeIndex, text: `${length.toFixed(2)} m` };
  });
}

export const areaLabel = (shape: Polygon): string => `${area(shape).toFixed(1)} m²`;

/** Where the area label goes: the middle of the shape's bounding box. */
export const centreOf = (shape: Polygon): Position => center(shape).geometry.coordinates;

export function isAxisRectangle(shape: Polygon, bearingDeg: number): boolean {
  const vertices = corners(shape);
  return (
    shape.coordinates.length === 1 &&
    vertices.length === 4 &&
    vertices.every((vertex, index) => {
      const edge = bearing(point(vertex), point(vertices[(index + 1) % 4]));
      const offAxis = wrap(edge - bearingDeg, 90);
      return Math.min(offAxis, 90 - offAxis) <= AXIS_TOLERANCE_DEG;
    })
  );
}

/** Gives edge `edgeIndex` and its opposite the length; the edge's start vertex and the other two lengths stay. */
export function resizeSide(rectangle: Polygon, edgeIndex: number, lengthM: number): Polygon {
  const vertices = corners(rectangle);
  const at = (offset: number) => (edgeIndex + offset) % 4;
  const stretched = (anchor: Position, towards: Position) =>
    destination(anchor, lengthM, bearing(point(anchor), point(towards)), metres).geometry.coordinates;
  const result = [...vertices];
  result[at(1)] = stretched(vertices[at(0)], vertices[at(1)]);
  result[at(2)] = stretched(vertices[at(3)], vertices[at(2)]);
  return ringOf(result);
}

/** The footprint with the box added, or undefined when the result is not one Polygon. */
export function addToFootprint(existing: Polygon | undefined, box: Polygon): Polygon | undefined {
  if (!existing) return box;
  const joined = union({ type: "FeatureCollection", features: [polygon(existing.coordinates), polygon(box.coordinates)] });
  return joined?.geometry.type === "Polygon" ? joined.geometry : undefined;
}
