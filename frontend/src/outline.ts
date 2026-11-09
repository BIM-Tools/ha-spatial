// Finds a building in Home Assistant's map tiles, whole where tile edges cut it, and the bearing of the wall the rooms follow.

import bearing from "@turf/bearing";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection, lineString, point, polygon } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import rewind from "@turf/rewind";
import union from "@turf/union";
import type { MultiPolygon, Polygon, Position } from "geojson";
import polylabel from "polylabel";

/** The buildings layer of one rendered vector tile: the tile and its one MultiPolygon of buildings, in WGS84. */
export interface TileBuildings {
  z: number;
  x: number;
  y: number;
  geometry: Polygon | MultiPolygon;
}

// One unit of a vector tile 4096 units across, as a share of the tile: about 0.4 m at zoom 14 in mid latitudes.
const SEAM_TOLERANCE = 1 / 4096;

// Slippy map tile names to WGS84 and back: https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
const tileLng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const tileX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;
const tileY = (lat: number, z: number) => {
  const phi = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** z;
};

const tileKey = (x: number, y: number) => `${x}/${y}`;

interface Part {
  tile: TileBuildings;
  rings: Position[][];
  // West, south, east, north.
  box: [number, number, number, number];
}

const partOf = (tile: TileBuildings, rings: Position[][]): Part => {
  const [lngs, lats] = [rings[0].map((p) => p[0]), rings[0].map((p) => p[1])];
  return { tile, rings, box: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)] };
};

// A tile edge on a line of longitude (axis 0) or latitude (axis 1); `below` when the tile lies on its lower side.
interface Seam {
  axis: 0 | 1;
  at: number;
  tolerance: number;
  below: boolean;
  neighbour: string;
}

const seamsOf = ({ z, x, y }: TileBuildings): Seam[] => {
  const lngTolerance = (SEAM_TOLERANCE / 2 ** z) * 360;
  const latTolerance = tileLat(y, z) - tileLat(y + SEAM_TOLERANCE, z);
  return [
    { axis: 0, at: tileLng(x + 1, z), tolerance: lngTolerance, below: true, neighbour: tileKey(x + 1, y) },
    { axis: 0, at: tileLng(x, z), tolerance: lngTolerance, below: false, neighbour: tileKey(x - 1, y) },
    // Tile rows count southwards, so a tile lies below its northern edge.
    { axis: 1, at: tileLat(y, z), tolerance: latTolerance, below: true, neighbour: tileKey(x, y - 1) },
    { axis: 1, at: tileLat(y + 1, z), tolerance: latTolerance, below: false, neighbour: tileKey(x, y + 1) },
  ];
};

const reachesSeam = (box: Part["box"], seam: Seam, below: boolean) =>
  below ? box[seam.axis + 2] >= seam.at - seam.tolerance : box[seam.axis] <= seam.at + seam.tolerance;

// A part that ends at the seam, rather than running on into its tile's buffer, has its corners within
// the tolerance moved onto the seam, so it meets the part across without a gap.
const snapToSeam = (rings: Position[][], box: Part["box"], seam: Seam, below: boolean): Position[][] => {
  const runsOn = below ? box[seam.axis + 2] >= seam.at + seam.tolerance : box[seam.axis] <= seam.at - seam.tolerance;
  if (runsOn) return rings;
  const onSeam = (p: Position): Position => (seam.axis === 0 ? [seam.at, p[1]] : [p[0], seam.at]);
  return rings.map((ring) => ring.map((p) => (Math.abs(p[seam.axis] - seam.at) <= seam.tolerance ? onSeam(p) : p)));
};

// Where the rings cross the line `axis = at`, as intervals along the other axis, even-odd.
const crossings = (rings: Position[][], axis: 0 | 1, at: number): [number, number][] => {
  const other = 1 - axis;
  const hits: number[] = [];
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]];
      if (a[axis] < at === b[axis] < at) continue;
      hits.push(a[other] + ((b[other] - a[other]) * (at - a[axis])) / (b[axis] - a[axis]));
    }
  }
  hits.sort((first, second) => first - second);
  const intervals: [number, number][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) intervals.push([hits[i], hits[i + 1]]);
  return intervals;
};

const overlapping = (first: [number, number][], second: [number, number][]) =>
  first.some(([a0, a1]) => second.some(([b0, b1]) => Math.min(a1, b1) > Math.max(a0, b0)));

/**
 * Custom. The building at `at` in the map tiles' buildings layer, from the tiles at `zoom`; tiles of other
 * zooms, which MapLibre shows while finer ones load, are left out. A building across a tile edge arrives
 * as one part per tile, each cut at the tile edge plus the tile's buffer. Parts in edge neighbouring tiles
 * that cross their shared edge along the same stretch are joined into one polygon; parts in one tile never
 * are, so terraced neighbours sharing a wall stay apart. A building within one tile comes back as the tile
 * has it.
 *
 * Limits: a part that ends within the tolerance (one unit of a tile 4096 units across, about 0.4 m at
 * zoom 14 in mid latitudes) of a tile edge is moved onto it, so seams that quantisation left a little apart
 * still join; two neighbours whose shared wall lies within that tolerance of a tile edge join as one; a
 * building that crosses only at a tile corner stays in pieces; seams are compared in degrees, with edges
 * straight in WGS84 rather than in Web Mercator, which at building size differs far less than the tolerance.
 */
export function buildingAt(tiles: TileBuildings[], at: Position, zoom: number): Polygon | undefined {
  const byTile = new Map<string, Part[]>();
  for (const tile of tiles) {
    const key = tileKey(tile.x, tile.y);
    if (tile.z !== zoom || byTile.has(key)) continue;
    const polygons = tile.geometry.type === "Polygon" ? [tile.geometry.coordinates] : tile.geometry.coordinates;
    byTile.set(key, polygons.map((rings) => partOf(tile, rings)));
  }
  const hits = [...byTile.values()].flat().filter((part) => booleanPointInPolygon(at, { type: "Polygon", coordinates: part.rings }));
  if (!hits.length) return undefined;
  // Each part of the building, with its rings moved onto the seams it ends at.
  const joined = new Map<Part, Position[][]>(hits.map((part) => [part, part.rings]));
  const queue = [...hits];
  while (queue.length) {
    const part = queue.shift()!;
    for (const seam of seamsOf(part.tile)) {
      if (!reachesSeam(part.box, seam, seam.below)) continue;
      const own = snapToSeam(joined.get(part)!, part.box, seam, seam.below);
      // Each side is read just inside its own tile, where a part that ends at the seam still has width.
      const inside = seam.below ? -seam.tolerance / 2 : seam.tolerance / 2;
      const ownStretch = crossings(own, seam.axis, seam.at + inside);
      const other = 1 - seam.axis;
      for (const candidate of byTile.get(seam.neighbour) ?? []) {
        const alongside = candidate.box[other] <= part.box[other + 2] && candidate.box[other + 2] >= part.box[other];
        if (joined.has(candidate) || !alongside || !reachesSeam(candidate.box, seam, !seam.below)) continue;
        const theirs = snapToSeam(candidate.rings, candidate.box, seam, !seam.below);
        if (!overlapping(ownStretch, crossings(theirs, seam.axis, seam.at - inside))) continue;
        joined.set(part, own);
        joined.set(candidate, theirs);
        queue.push(candidate);
      }
    }
  }
  if (joined.size === 1) return { type: "Polygon", coordinates: hits[0].rings };
  const whole = union(featureCollection([...joined.values()].map((rings) => polygon(rings))))?.geometry;
  if (whole?.type !== "MultiPolygon") return whole;
  const containing = whole.coordinates.find((coordinates) => booleanPointInPolygon(at, { type: "Polygon", coordinates }));
  return containing && { type: "Polygon", coordinates: containing };
}

// How closely a point inside a building near a click is found, in degrees: about 1 cm.
const INSIDE_PRECISION_DEG = 1e-7;

/**
 * Custom. The building a click at `at` picks, from the tiles at `zoom`: the one that holds it, joined as
 * `buildingAt` joins it; else the one whose edge lies nearest, within `maxM` metres. On a wall two
 * buildings share, the side the click is on decides.
 *
 * Limits: the distance is to each part as its tile has it, so a part cut at a tile edge counts its cut
 * as an edge; edges are taken straight in WGS84.
 */
export function nearestBuilding(tiles: TileBuildings[], at: Position, maxM: number, zoom: number): Polygon | undefined {
  const inside = buildingAt(tiles, at, zoom);
  if (inside || maxM <= 0) return inside;
  let nearest: { metres: number; rings: Position[][] } | undefined;
  for (const tile of tiles) {
    if (tile.z !== zoom) continue;
    const polygons = tile.geometry.type === "Polygon" ? [tile.geometry.coordinates] : tile.geometry.coordinates;
    for (const rings of polygons) {
      for (const ring of rings) {
        const metres = nearestPointOnLine(lineString(ring), point(at), { units: "meters" }).properties.dist;
        if (metres <= maxM && (!nearest || metres < nearest.metres)) nearest = { metres, rings };
      }
    }
  }
  return nearest && buildingAt(tiles, polylabel(nearest.rings as [number, number][][], INSIDE_PRECISION_DEG), zoom);
}

/** Whether `building` reaches into a tile at `zoom` that is not among `tiles`, where the map may hold more of it. */
export function reachesUnreadTiles(building: Polygon, tiles: TileBuildings[], zoom: number): boolean {
  const read = new Set(tiles.filter((tile) => tile.z === zoom).map((tile) => tileKey(tile.x, tile.y)));
  const xs = building.coordinates[0].map((p) => Math.floor(tileX(p[0], zoom)));
  const ys = building.coordinates[0].map((p) => Math.floor(tileY(p[1], zoom)));
  for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) if (!read.has(tileKey(x, y))) return true;
  }
  return false;
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
