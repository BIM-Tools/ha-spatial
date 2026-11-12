// Lights up what a point snaps to, so snapping is never hidden: a short stretch of each wall near the snapped point, a dot on a corner.

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { LayerColours } from "./map-paint";
import type { LatticePoint, PlanFrame } from "./site-frame";
import type { LatticeEdge, SnapSource } from "./snap";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** What lights up, in lattice units: a stretch of each wall snapped to, and a dot on each corner. */
export interface SnapMarks {
  walls: LatticeEdge[];
  dots: LatticePoint[];
}

/** Each source once, in order, without the missing ones, so a wall or corner lights up once. */
export function distinctSources(sources: readonly (SnapSource | undefined)[]): SnapSource[] {
  const keys = sources.map((source) => JSON.stringify(source));
  return sources.filter((source, index): source is SnapSource => source !== undefined && keys.indexOf(keys[index]) === index);
}

const samePoint = (a: LatticePoint, b: LatticePoint) => a[0] === b[0] && a[1] === b[1];
const sameEdge = ([a, b]: LatticeEdge, [c, d]: LatticeEdge) => (samePoint(a, c) && samePoint(b, d)) || (samePoint(a, d) && samePoint(b, c));
const ringEdges = (ring: readonly LatticePoint[]): LatticeEdge[] => ring.map((point, index) => [point, ring[(index + 1) % ring.length]]);

// The point `distance` along the wall from its start, its ends exactly.
const pointAlong = ([from, to]: LatticeEdge, length: number, distance: number): LatticePoint => {
  if (distance <= 0) return from;
  if (distance >= length) return to;
  return [from[0] + ((to[0] - from[0]) * distance) / length, from[1] + ((to[1] - from[1]) * distance) / length];
};

// How far along the wall from its start the point nearest `point` lies, and how far `point` is from it.
const projectOnto = (edge: LatticeEdge, length: number, point: LatticePoint) => {
  const [from, to] = edge;
  const projected = length ? ((point[0] - from[0]) * (to[0] - from[0]) + (point[1] - from[1]) * (to[1] - from[1])) / length : 0;
  const along = Math.min(Math.max(projected, 0), length);
  const [x, y] = pointAlong(edge, length, along);
  return { along, distance: Math.hypot(point[0] - x, point[1] - y) };
};

/**
 * Custom. The marks of a snap, so only the part of a wall where the shape touches it lights up, not
 * the whole wall of a room. Of each wall in `sources`, the stretch within `halfLength` either side of
 * the snapped point on it, clamped to the wall's ends; the snapped point is the one of `points`
 * nearest the wall, on a tie the one nearest `pointer`. Where that point is a wall's end, its corner
 * gets a dot too; so does a corner source. An axis line lights whole, from its corner, which gets a dot,
 * to the snapped point, so the person sees what the point lines up with. The walls and corners of the
 * `own` rings, the active shape, never light up.
 */
export function snapMarks(
  sources: readonly SnapSource[],
  points: readonly LatticePoint[],
  pointer: readonly [number, number],
  halfLength: number,
  own: readonly (readonly LatticePoint[])[] = [],
): SnapMarks {
  const ownEdges = own.flatMap(ringEdges);
  const ownCorners = own.flat();
  const walls: LatticeEdge[] = [];
  const dots: LatticePoint[] = [];
  const addDot = (at: LatticePoint) => {
    if (!dots.some((dot) => samePoint(dot, at))) dots.push(at);
  };
  for (const source of sources) {
    if (source.kind === "corner") {
      if (!ownCorners.some((corner) => samePoint(corner, source.at))) addDot(source.at);
      continue;
    }
    if (source.kind === "aligned") {
      walls.push(source.edge);
      addDot(source.edge[0]);
      continue;
    }
    const { edge } = source;
    if (ownEdges.some((ownEdge) => sameEdge(ownEdge, edge)) || !points.length) continue;
    const length = Math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]);
    const toPointer = (point: LatticePoint) => Math.hypot(point[0] - pointer[0], point[1] - pointer[1]);
    const nearest = points
      .map((point) => ({ point, ...projectOnto(edge, length, point) }))
      .reduce((best, next) =>
        next.distance < best.distance || (next.distance === best.distance && toPointer(next.point) < toPointer(best.point)) ? next : best,
      );
    walls.push([pointAlong(edge, length, nearest.along - halfLength), pointAlong(edge, length, nearest.along + halfLength)]);
    for (const end of edge) if (samePoint(nearest.point, end)) addDot(end);
  }
  return { walls, dots };
}

export class SnapHighlight {
  // Kept for a new style, which drops the sources.
  private _data: FeatureCollection = EMPTY;
  private _marker: FeatureCollection = EMPTY;

  constructor(private readonly _map: MapLibreMap) {}

  /** Above the handles: added after them. */
  addLayers(colours: LayerColours) {
    this._map.addSource("spatial-snap", { type: "geojson", data: this._data });
    this._map.addSource("spatial-snap-marker", { type: "geojson", data: this._marker });
    this._map.addLayer({
      id: "spatial-snap-line",
      type: "line",
      source: "spatial-snap",
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round" },
      paint: { ...colours["spatial-snap-line"], "line-width": 4 },
    });
    this._map.addLayer({
      id: "spatial-snap-point",
      type: "circle",
      source: "spatial-snap",
      filter: ["==", ["geometry-type"], "Point"],
      paint: { ...colours["spatial-snap-point"], "circle-radius": 6, "circle-stroke-width": 2 },
    });
    // A small ring on top, so it stays visible on a lit wall or corner.
    this._map.addLayer({
      id: "spatial-snap-marker",
      type: "circle",
      source: "spatial-snap-marker",
      paint: { ...colours["spatial-snap-marker"], "circle-radius": 4, "circle-stroke-width": 2 },
    });
  }

  /**
   * The walls as lines under the dots; nothing for a snap to the grid or the lattice, which the shape
   * itself shows. `marker` is where a point would land before there is a shape, on the grid too.
   */
  show(frame: PlanFrame, { walls, dots }: SnapMarks, marker?: LatticePoint) {
    this._setMarker(
      marker
        ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: frame.fromLattice(marker) }, properties: {} }] }
        : EMPTY,
    );
    this._set({
      type: "FeatureCollection",
      features: [
        ...walls.map((wall) => ({
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: wall.map((end) => frame.fromLattice(end)) },
          properties: {},
        })),
        ...dots.map((dot) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: frame.fromLattice(dot) },
          properties: {},
        })),
      ],
    });
  }

  clear() {
    this._set(EMPTY);
    this._setMarker(EMPTY);
  }

  private _set(data: FeatureCollection) {
    this._data = data;
    this._map.getSource<GeoJSONSource>("spatial-snap")?.setData(data);
  }

  private _setMarker(data: FeatureCollection) {
    this._marker = data;
    this._map.getSource<GeoJSONSource>("spatial-snap-marker")?.setData(data);
  }
}
