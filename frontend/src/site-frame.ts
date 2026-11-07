// Applies the site frame the integration publishes, so the panel draws on the same lattice.

import type { Position } from "geojson";

/** The `frame` of `spatial/site`: lattice units are `to_lattice @ ([lon, lat] - origin)`. */
export interface SiteFrameData {
  origin: [number, number];
  bearing_deg: number;
  unit_m: number;
  units_per_step: number;
  to_lattice: [[number, number], [number, number]];
}

/** A point in whole lattice units. */
export type LatticePoint = readonly [number, number];

/** Custom. The published affine map from lon/lat to lattice units and its 2 x 2 inverse. */
export class PlanFrame {
  private constructor(
    private readonly _origin: [number, number],
    private readonly _toLattice: [[number, number], [number, number]],
    private readonly _fromLattice: [[number, number], [number, number]],
    readonly unitM: number,
    readonly unitsPerStep: number,
    // The direction of the x-axis, clockwise from north, which the views of all floors turn from.
    readonly bearingDeg: number,
  ) {}

  static fromSite(frame: SiteFrameData): PlanFrame {
    const [[a, b], [c, d]] = frame.to_lattice;
    const det = a * d - b * c;
    const inverse: [[number, number], [number, number]] = [
      [d / det, -b / det],
      [-c / det, a / det],
    ];
    return new PlanFrame(frame.origin, frame.to_lattice, inverse, frame.unit_m, frame.units_per_step, frame.bearing_deg);
  }

  /** Lattice units, not rounded. */
  toLatticeUnits(lonLat: Position): [number, number] {
    const [[a, b], [c, d]] = this._toLattice;
    const dLon = lonLat[0] - this._origin[0];
    const dLat = lonLat[1] - this._origin[1];
    return [a * dLon + b * dLat, c * dLon + d * dLat];
  }

  /** The nearest lattice point. */
  toLattice(lonLat: Position): LatticePoint {
    const [x, y] = this.toLatticeUnits(lonLat);
    // Adding 0 turns -0 into 0, so equal points compare equal.
    return [Math.round(x) + 0, Math.round(y) + 0];
  }

  fromLattice(point: readonly [number, number]): Position {
    const [[a, b], [c, d]] = this._fromLattice;
    return [this._origin[0] + a * point[0] + b * point[1], this._origin[1] + c * point[0] + d * point[1]];
  }
}
