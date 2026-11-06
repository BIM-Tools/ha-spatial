// Lights up what a point snaps to, so snapping is never hidden: a dot on a corner, a line on a wall.

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { LayerColours } from "./map-paint";
import type { PlanFrame } from "./site-frame";
import type { SnapSource } from "./snap";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Each source once, in order, without the missing ones, so a wall or corner lights up once. */
export function distinctSources(sources: readonly (SnapSource | undefined)[]): SnapSource[] {
  const keys = sources.map((source) => JSON.stringify(source));
  return sources.filter((source, index): source is SnapSource => source !== undefined && keys.indexOf(keys[index]) === index);
}

export class SnapHighlight {
  // Kept for a new style, which drops the source.
  private _data: FeatureCollection = EMPTY;

  constructor(private readonly _map: MapLibreMap) {}

  /** Above the handles: added after them. */
  addLayers(colours: LayerColours) {
    this._map.addSource("spatial-snap", { type: "geojson", data: this._data });
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
      paint: { ...colours["spatial-snap-point"], "circle-radius": 6 },
    });
  }

  /** Each source as a dot or a line; none for a snap to the grid or the lattice, which the shape itself shows. */
  show(frame: PlanFrame, sources: readonly SnapSource[]) {
    this._set({
      type: "FeatureCollection",
      features: sources.map((source) => ({
        type: "Feature",
        geometry:
          source.kind === "corner"
            ? { type: "Point", coordinates: frame.fromLattice(source.at) }
            : { type: "LineString", coordinates: source.edge.map((corner) => frame.fromLattice(corner)) },
        properties: {},
      })),
    });
  }

  clear() {
    this._set(EMPTY);
  }

  private _set(data: FeatureCollection) {
    this._data = data;
    this._map.getSource<GeoJSONSource>("spatial-snap")?.setData(data);
  }
}
