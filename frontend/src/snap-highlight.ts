// Lights up what a point snaps to, so snapping is never hidden: a dot on a corner, a line on a wall.

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { LayerColours } from "./map-paint";
import type { PlanFrame } from "./site-frame";
import type { SnapSource } from "./snap";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

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

  /** The grid and the lattice are what the shape itself shows, so they light up nothing. */
  show(frame: PlanFrame, source: SnapSource) {
    const geometry =
      source.kind === "corner"
        ? { type: "Point" as const, coordinates: frame.fromLattice(source.at) }
        : source.kind === "edge"
          ? { type: "LineString" as const, coordinates: source.edge.map((corner) => frame.fromLattice(corner)) }
          : undefined;
    this._set(geometry ? { type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: {} }] } : EMPTY);
  }

  clear() {
    this._set(EMPTY);
  }

  private _set(data: FeatureCollection) {
    this._data = data;
    this._map.getSource<GeoJSONSource>("spatial-snap")?.setData(data);
  }
}
