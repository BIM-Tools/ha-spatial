// Builds site frames as the integration publishes them, on turf's sphere so they agree with the fake map.
import type { SiteFrameData } from "../src/site-frame";

// turf's earth radius, which the fake map's unproject uses.
const EARTH_RADIUS_M = 6371008.8;
const RADIANS = Math.PI / 180;

export const METRIC_UNIT_M = 0.025;
export const US_UNIT_M = 0.0254;

/** The published frame at `origin` along `bearingDeg`, with lattice unit `unitM`. */
export function siteFrameData(origin: [number, number], bearingDeg: number, unitM = METRIC_UNIT_M): SiteFrameData {
  const mlat = EARTH_RADIUS_M * RADIANS;
  const mlon = mlat * Math.cos(origin[1] * RADIANS);
  const s = Math.sin(bearingDeg * RADIANS);
  const c = Math.cos(bearingDeg * RADIANS);
  return {
    origin,
    bearing_deg: bearingDeg,
    unit_m: unitM,
    units_per_step: 4,
    to_lattice: [
      [(mlon * s) / unitM, (mlat * c) / unitM],
      [(-mlon * c) / unitM, (mlat * s) / unitM],
    ],
  };
}
