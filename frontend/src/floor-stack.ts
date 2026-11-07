// All floors at a glance: an exploded stack of floor slabs and the camera that frames it, worked out without a map so both can be tested.

import type { Feature, FeatureCollection, Polygon, Position } from "geojson";
import { css } from "lit";
import { Marker, type Map as MapLibreMap } from "maplibre-gl";
import { byLevel, mapBearing } from "./map-view";
import type { PlanFrame } from "./site-frame";

/** A point in the site frame, in metres: x along the site bearing, y to its left, z up. */
export type StackPoint = [number, number, number];

/** From one slab to the next: more than a storey, so each floor shows between the ones above and below it. */
export const SLAB_SPACING_M = 5;
/** A thin sheet, about a hand's width. */
export const SLAB_THICKNESS_M = 0.1;
// The rooms lie on the slab as a thin fill and the edges a little higher, so both clear its top face.
const ROOM_FILL_M = 0.02;
const EDGE_HEIGHT_M = 0.04;
const SHADOW_DEPTH_M = 0.05;
/** On-screen widths of the slab's edge and of the rooms' edges, in pixels. */
export const SLAB_EDGE_PX = 1.5;
export const ROOM_EDGE_PX = 1.2;

/** The default view: 45 degrees off the front facade, which runs down to the right, and 35 degrees above the horizon. */
export const VIEW_TURN_DEG = -45;
export const VIEW_PITCH_DEG = 55;
/** Room around the stack, as a share of its size on screen. */
export const FIT_MARGIN = 0.15;

// MapLibre's tile size and earth radius, which set its scale.
const TILE_SIZE = 512;
const EARTH_RADIUS_M = 6371008.8;
const RADIANS = Math.PI / 180;

/** The floors a room lies on: those it occupies, else its own floor; `null` is No floor. */
const floorsOf = (room: Feature): (string | null)[] => {
  const occupied = room.properties?.floor_ids;
  return Array.isArray(occupied) && occupied.length ? occupied : [room.properties?.floor_id ?? null];
};

/**
 * The floors that get a slab, lowest first: every floor a room lies on or reaches into, by level.
 * No floor gets none; its rooms lie on the ground.
 */
export const stackFloors = (rooms: Feature[], levelOf: (floorId: string) => number | null): string[] => {
  const floorIds = new Set<string>();
  for (const room of rooms) for (const floorId of floorsOf(room)) if (floorId !== null) floorIds.add(floorId);
  return [...floorIds]
    .map((floor_id) => ({ floor_id, level: levelOf(floor_id) }))
    .sort(byLevel)
    .map((floor) => floor.floor_id);
};

/** The base of the slab at this place in the stack, in metres; the lowest floor lies on the ground. */
export const slabBase = (index: number): number => index * SLAB_SPACING_M;

/** A floor's slab: its floor, how many rooms lie on it, and the corners of its top face, for the floor's label. */
export interface Slab {
  floorId: string;
  rooms: number;
  top: StackPoint[];
}

export interface FloorStack {
  /** Slabs, their shadows and edges, rooms and their edges as `kind` with `base_m` and `top_m`, for MapLibre's fill-extrusion. */
  features: FeatureCollection<Polygon>;
  slabs: Slab[];
  /** Every corner of the slabs and rooms, top and bottom, for framing the stack. */
  corners: StackPoint[];
}

const toMetres = (frame: PlanFrame, position: Position): [number, number] => {
  const [x, y] = frame.toLatticeUnits(position);
  return [x * frame.unitM, y * frame.unitM];
};

const fromMetres = (frame: PlanFrame, [x, y]: [number, number]): Position =>
  frame.fromLattice([x / frame.unitM, y / frame.unitM]);

/** The width in metres that shows as `pixels` at MapLibre's zoom and this latitude. */
export const metresForPixels = (pixels: number, zoom: number, latitude: number): number =>
  pixels / pixelsPerMetre(zoom, latitude);

/**
 * Custom: one thin rectangle `widthM` wide along every edge of the rings, a little longer than the
 * edge, so the edges meet at the corners. MapLibre cannot raise a line, so an edge on a raised slab
 * is drawn as a low extrusion.
 */
export const edgeStrips = (polygon: Polygon, frame: PlanFrame, widthM: number): Polygon[] =>
  polygon.coordinates.flatMap((ring) =>
    ring.slice(1).flatMap((end, index) => {
      const [ax, ay] = toMetres(frame, ring[index]);
      const [bx, by] = toMetres(frame, end);
      const length = Math.hypot(bx - ax, by - ay);
      if (!length) return [];
      const half = widthM / 2;
      const [dx, dy] = [((bx - ax) / length) * half, ((by - ay) / length) * half];
      const corners: [number, number][] = [
        [ax - dx - dy, ay - dy + dx],
        [bx + dx - dy, by + dy + dx],
        [bx + dx + dy, by + dy - dx],
        [ax - dx + dy, ay - dy - dx],
      ];
      const positions = corners.map((corner) => fromMetres(frame, corner));
      return [{ type: "Polygon", coordinates: [[...positions, positions[0]]] } as Polygon];
    }),
  );

/**
 * The stack: a slab per floor in `floors`, under the building outline or, without one, under that
 * floor's rooms, with its edge; each room as a fill with its edge on every slab it occupies. Rooms
 * on No floor lie on the ground without a slab. `pixelM` is the size of a screen pixel in metres,
 * which keeps the edges thin lines.
 */
export const floorStack = (
  rooms: Feature<Polygon>[],
  outline: Polygon | undefined,
  floors: string[],
  frame: PlanFrame,
  pixelM: number,
): FloorStack => {
  const features: Feature<Polygon>[] = [];
  const corners: StackPoint[] = [];
  const add = (kind: string, geometry: Polygon, base: number, top: number) =>
    features.push({ type: "Feature", geometry, properties: { kind, base_m: base, top_m: top } });
  const addCorners = (geometry: Polygon, heights: number[]) => {
    for (const position of geometry.coordinates[0]) {
      const [x, y] = toMetres(frame, position);
      for (const z of heights) corners.push([x, y, z]);
    }
  };
  const slabs = floors.map((floorId, index) => {
    const base = slabBase(index);
    const top = base + SLAB_THICKNESS_M;
    const footprints = outline
      ? [outline]
      : rooms.filter((room) => floorsOf(room).includes(floorId)).map((room) => room.geometry);
    const topCorners: StackPoint[] = [];
    for (const footprint of footprints) {
      add("shadow", footprint, base - SHADOW_DEPTH_M, base);
      add("slab", footprint, base, top);
      for (const strip of edgeStrips(footprint, frame, SLAB_EDGE_PX * pixelM)) add("slab-edge", strip, base, top);
      addCorners(footprint, [base, top]);
      for (const position of footprint.coordinates[0]) topCorners.push([...toMetres(frame, position), top]);
    }
    const roomCount = rooms.filter((room) => floorsOf(room).includes(floorId)).length;
    return { floorId, rooms: roomCount, top: topCorners };
  });
  for (const room of rooms) {
    for (const floorId of floorsOf(room)) {
      const index = floorId === null ? -1 : floors.indexOf(floorId);
      const floorTop = index < 0 ? 0 : slabBase(index) + SLAB_THICKNESS_M;
      add("room", room.geometry, floorTop, floorTop + ROOM_FILL_M);
      for (const strip of edgeStrips(room.geometry, frame, ROOM_EDGE_PX * pixelM)) {
        add("edge", strip, floorTop, floorTop + EDGE_HEIGHT_M);
      }
      addCorners(room.geometry, [floorTop]);
    }
  }
  return { features: { type: "FeatureCollection", features }, slabs, corners };
};

/** A camera on the stack: its centre on the ground in the site frame, MapLibre's zoom and pitch, and its turn from the frame's x-axis. */
export interface StackCamera {
  centre: [number, number];
  zoom: number;
  turnDeg: number;
  pitchDeg: number;
}

/** The map on screen: its size in pixels, MapLibre's vertical field of view and the latitude that sets the scale. */
export interface StackScreen {
  width: number;
  height: number;
  fovDeg: number;
  latitude: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The turn of a MapLibre bearing from the frame's x-axis, which lies to the right at turn 0. */
export const turnFromFrame = (mapBearingDeg: number, frameBearingDeg: number): number =>
  mapBearingDeg - mapBearing(frameBearingDeg);

/** Screen pixels per metre at MapLibre's zoom and this latitude, in Web Mercator. */
export const pixelsPerMetre = (zoom: number, latitude: number): number =>
  (TILE_SIZE * 2 ** zoom) / (2 * Math.PI * EARTH_RADIUS_M * Math.cos(latitude * RADIANS));

/**
 * Custom: the screen pixel of a point in the site frame, or undefined behind the camera. MapLibre's
 * perspective camera without padding: the centre on the ground is the middle of the screen, and the
 * camera stands back from it by half the screen height over the tangent of half the field of view.
 * Exact to Web Mercator's scale change over the stack, which is negligible at building size.
 */
export const projectPoint = (
  [x, y, z]: StackPoint,
  { centre, zoom, turnDeg, pitchDeg }: StackCamera,
  { width, height, fovDeg, latitude }: StackScreen,
): [number, number] | undefined => {
  const scale = pixelsPerMetre(zoom, latitude);
  const [turn, pitch] = [turnDeg * RADIANS, pitchDeg * RADIANS];
  const [dx, dy] = [x - centre[0], y - centre[1]];
  const right = (dx * Math.cos(turn) - dy * Math.sin(turn)) * scale;
  const ahead = (dx * Math.sin(turn) + dy * Math.cos(turn)) * scale;
  const up = z * scale;
  const distance = height / 2 / Math.tan((fovDeg * RADIANS) / 2);
  const depth = distance + ahead * Math.sin(pitch) - up * Math.cos(pitch);
  if (depth <= 0) return undefined;
  const raised = ahead * Math.cos(pitch) + up * Math.sin(pitch);
  return [width / 2 + (right * distance) / depth, height / 2 - (raised * distance) / depth];
};

const FIT_STEPS = 24;

/**
 * Custom: the centre and zoom that fit every point inside the screen less its padding, with
 * FIT_MARGIN to spare, at this turn and pitch. Perspective has no closed form, so it moves and
 * zooms a few times until the points settle in the middle of the free space.
 */
export const fitStack = (
  points: StackPoint[],
  turnDeg: number,
  pitchDeg: number,
  screen: StackScreen,
  padding: Padding,
): { centre: [number, number]; zoom: number } | undefined => {
  if (!points.length) return undefined;
  // Never fit into less than half the screen, however much the controls take.
  const freeWidth = Math.max(screen.width - padding.left - padding.right, screen.width / 2);
  const freeHeight = Math.max(screen.height - padding.top - padding.bottom, screen.height / 2);
  const target = [
    Math.min(padding.left, screen.width - freeWidth) + freeWidth / 2,
    Math.min(padding.top, screen.height - freeHeight) + freeHeight / 2,
  ];
  const [turn, pitch] = [turnDeg * RADIANS, pitchDeg * RADIANS];
  let centre: [number, number] = [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
  let zoom = 20;
  for (let step = 0; step < FIT_STEPS; step++) {
    const camera = { centre, zoom, turnDeg, pitchDeg };
    const projected = points.map((point) => projectPoint(point, camera, screen));
    if (projected.some((pixel) => !pixel)) {
      zoom -= 1;
      continue;
    }
    const xs = projected.map((pixel) => pixel![0]);
    const ys = projected.map((pixel) => pixel![1]);
    const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = pixelsPerMetre(zoom, screen.latitude);
    const along = ((left + right) / 2 - target[0]) / scale;
    const ahead = -((top + bottom) / 2 - target[1]) / (scale * Math.cos(pitch));
    centre = [
      centre[0] + along * Math.cos(turn) + ahead * Math.sin(turn),
      centre[1] - along * Math.sin(turn) + ahead * Math.cos(turn),
    ];
    const room = Math.min(freeWidth / Math.max(right - left, 1), freeHeight / Math.max(bottom - top, 1));
    zoom += Math.log2(room / (1 + FIT_MARGIN));
  }
  return { centre, zoom };
};

/** Where a floor's label starts: just right of its slab's rightmost top corner on screen. */
export const labelAnchor = (
  top: StackPoint[],
  camera: StackCamera,
  screen: StackScreen,
): [number, number] | undefined => {
  const pixels = top.map((corner) => projectPoint(corner, camera, screen));
  if (!pixels.length || pixels.some((pixel) => !pixel)) return undefined;
  return pixels.reduce((rightmost, pixel) => (pixel![0] > rightmost![0] ? pixel : rightmost))!;
};

/** The second line of a floor's label. */
export const roomCount = (rooms: number): string => (rooms === 1 ? "1 room" : `${rooms} rooms`);

/** The label elements; the panel adds them to its styles. */
export const floorLabelStyles = css`
  .floor-label {
    display: flex;
    flex-direction: column;
    padding-left: var(--ha-space-3);
    pointer-events: none;
    color: var(--secondary-text-color);
    font-size: 13px;
    line-height: 16px;
    white-space: nowrap;
    text-shadow:
      0 0 3px var(--card-background-color),
      0 0 3px var(--card-background-color);
  }
  .floor-label .count {
    font-size: 11px;
    line-height: 14px;
  }
`;

/** The camera of a map, in the terms of `projectPoint`. */
const cameraOf = (map: MapLibreMap, frame: PlanFrame): { camera: StackCamera; screen: StackScreen } => {
  const { lng, lat } = map.getCenter();
  const container = map.getContainer();
  return {
    camera: {
      centre: toMetres(frame, [lng, lat]),
      zoom: map.getZoom(),
      turnDeg: turnFromFrame(map.getBearing(), frame.bearingDeg),
      pitchDeg: map.getPitch(),
    },
    screen: { width: container.clientWidth, height: container.clientHeight, fovDeg: map.getVerticalFieldOfView(), latitude: lat },
  };
};

/** Names each slab with its Home Assistant floor, right of the slab, placed again on every camera move. */
export class FloorLabels {
  private _slabs: { slab: Slab; marker: Marker }[] = [];
  private _frame?: PlanFrame;

  constructor(private readonly _map: MapLibreMap) {
    _map.on("move", this.update);
    _map.on("resize", this.update);
  }

  destroy() {
    this._map.off("move", this.update);
    this._map.off("resize", this.update);
    this.show([], undefined, () => "");
  }

  /** The slabs to name, none outside All, in the frame they were built in. */
  show(slabs: Slab[], frame: PlanFrame | undefined, floorName: (floorId: string) => string) {
    for (const { marker } of this._slabs) marker.remove();
    this._frame = frame;
    this._slabs = slabs.map((slab) => {
      const element = Object.assign(document.createElement("div"), { className: "floor-label" });
      const line = (className: string, text: string) =>
        Object.assign(document.createElement("span"), { className, textContent: text });
      element.append(line("name", floorName(slab.floorId)), line("count", roomCount(slab.rooms)));
      return { slab, marker: new Marker({ element, anchor: "left" }).setLngLat([0, 0]).addTo(this._map) };
    });
    this.update();
  }

  /** The widest label in pixels, which the stack leaves room for on its right. */
  get width(): number {
    return Math.max(0, ...this._slabs.map(({ marker }) => marker.getElement().offsetWidth));
  }

  update = () => {
    const frame = this._frame;
    if (!frame || !this._slabs.length) return;
    const { camera, screen } = cameraOf(this._map, frame);
    for (const { slab, marker } of this._slabs) {
      const anchor = labelAnchor(slab.top, camera, screen);
      marker.getElement().hidden = !anchor;
      if (anchor) marker.setLngLat(this._map.unproject(anchor));
    }
  };
}

/** The camera that shows the whole stack from the front corner, as MapLibre's camera options; undefined without a stack. */
export const stackView = (
  stack: FloorStack,
  frame: PlanFrame,
  siteAxisDeg: number,
  screen: Omit<StackScreen, "latitude">,
  padding: Padding,
): { center: [number, number]; zoom: number; bearing: number; pitch: number } | undefined => {
  const bearing = mapBearing(siteAxisDeg + VIEW_TURN_DEG);
  const latitude = frame.fromLattice([0, 0])[1];
  const fit = fitStack(stack.corners, turnFromFrame(bearing, frame.bearingDeg), VIEW_PITCH_DEG, { ...screen, latitude }, padding);
  if (!fit) return undefined;
  const [lon, lat] = fromMetres(frame, fit.centre);
  return { center: [lon, lat], zoom: fit.zoom, bearing, pitch: VIEW_PITCH_DEG };
};
