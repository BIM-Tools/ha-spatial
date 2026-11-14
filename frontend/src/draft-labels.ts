// Places the length chips and names around a shape on screen: outside its sides, apart from each other, kept on screen when drawn, and moved off a small shape.

import type { Pixel } from "./edge-drag";

export interface Size {
  width: number;
  height: number;
}

/** A label or control on screen: its centre and size in pixels. */
export interface ScreenBox {
  centre: Pixel;
  size: Size;
}

/** A side of the draft on screen: the middle of its edge, and the edge from its start corner to its end corner. */
export interface ScreenSide {
  midpoint: Pixel;
  edge: Pixel;
}

/** Where each label goes, as an offset from its anchor in pixels; undefined when it is hidden or not placed here. */
export interface LabelPlaces {
  /** Per side, from the side's midpoint. */
  sides: (Pixel | undefined)[];
  /** From the centre of the shape's box on screen (`area.centre`). */
  area: Pixel | undefined;
  /** The name chip of a small shape, from the centre of the shape's box on screen (`area.centre`); undefined unless `name` was given and the shape is small. */
  name: Pixel | undefined;
}

export interface LabelRequest {
  /** The sides on screen; empty on a resized draft, whose side controls carry the lengths. */
  sides: readonly ScreenSide[];
  /** The size of each side's label, in the order of `sides`. */
  sideSizes: readonly Size[];
  /** The size of the shape's box on screen. */
  box: Size;
  /** The area label, centred on the shape's box. */
  area: ScreenBox;
  /** Other rooms' labels and side controls to keep clear of. */
  controls?: readonly ScreenBox[];
  /** The size of the room's name chip, when the caller wants a small shape's name placed. */
  name?: Size;
  /** The map container, for flipping off the edge of the screen and for clamping a drawn shape's chips. */
  viewport?: Size;
  /** True while the shape is being drawn. */
  drawing?: boolean;
}

const CLEARANCE_PX = 8;
const MIN_SIDE_PX = 48;
const SMALL_PX = 60;

/** A shape whose shorter side on screen is under 60 px is small: it gets chips by the small rule, not one per side. */
export const isSmall = (box: Size) => Math.min(box.width, box.height) < SMALL_PX;

/** The sides, box size and box centre of a ring of screen corners, as `placeLabels` takes them. */
export const screenShape = (corners: readonly Pixel[]): { sides: ScreenSide[]; box: Size; centre: Pixel } => {
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return {
    sides: corners.map(({ x, y }, index) => {
      const next = corners[(index + 1) % corners.length];
      return { midpoint: { x: (x + next.x) / 2, y: (y + next.y) / 2 }, edge: { x: next.x - x, y: next.y - y } };
    }),
    box: { width: right - left, height: bottom - top },
    centre: { x: (left + right) / 2, y: (top + bottom) / 2 },
  };
};
const AREA_ROOM: Size = { width: 96, height: 40 };

const overlap = (a: ScreenBox, b: ScreenBox) =>
  Math.abs(a.centre.x - b.centre.x) < (a.size.width + b.size.width) / 2 && Math.abs(a.centre.y - b.centre.y) < (a.size.height + b.size.height) / 2;

const within = ({ centre, size }: ScreenBox, view: Size | undefined) =>
  !view || (centre.x >= size.width / 2 && centre.x <= view.width - size.width / 2 && centre.y >= size.height / 2 && centre.y <= view.height - size.height / 2);

const clamp = (value: number, half: number, limit: number) => Math.max(CLEARANCE_PX + half, Math.min(limit - CLEARANCE_PX - half, value));

// The side along (horizontal) or across the screen that lies furthest in a direction, as an index into `sides`;
// undefined when no side runs that way, as on a thin triangle, whose chip is then not placed.
const furthest = (sides: readonly ScreenSide[], horizontal: boolean, towards: (side: ScreenSide) => number) => {
  const candidates = sides.map((side, index) => ({ side, index })).filter(({ side }) => (Math.abs(side.edge.x) >= Math.abs(side.edge.y)) === horizontal);
  return candidates.length ? candidates.reduce((best, next) => (towards(next.side) > towards(best.side) ? next : best)).index : undefined;
};

// Twice the signed area of the ring the sides run along; on screen, with y down, positive is clockwise.
const ringTurn = (sides: readonly ScreenSide[]) => {
  const corners = sides.map(({ midpoint, edge }) => ({ x: midpoint.x - edge.x / 2, y: midpoint.y - edge.y / 2 }));
  return corners.reduce((sum, { x, y }, index) => {
    const next = corners[(index + 1) % corners.length];
    return sum + x * next.y - next.x * y;
  }, 0);
};

/**
 * Custom: the one rule for the chips around a shape; distances are screen pixels.
 * Side labels sit `CLEARANCE_PX` outside their edge, centred on it; one that would overlap an earlier one in
 * ring order is hidden, and so is one on a side under 48 px. The area label sits at its anchor when the box is
 * at least 96 x 40 px and clear of the side labels and `controls`.
 * When `name` is given, the name chip goes above the box, first of all the chips, on any shape that is not drawn.
 * Small shape (the shorter side of `box` is under 60 px): only the width chip (below the bottom side) and the depth
 * chip (right of the right side) are placed besides it; each moves
 * to the opposite side when its spot meets `controls`, an earlier chip or the edge of `viewport`, and keeps its
 * first spot when both are taken.
 * Drawing: one chip per axis, on the side of that axis facing the centre of `viewport`, clamped 8 px inside it.
 * Limit: the small and drawing rules pick sides by screen direction and place chips straight up, down or right,
 * which is exact for a rectangle and rough for a rotated or concave shape.
 */
export function placeLabels({ sides, sideSizes, box, area, controls = [], name, viewport, drawing = false }: LabelRequest): LabelPlaces {
  const offsets: (Pixel | undefined)[] = sides.map(() => undefined);
  const placed: ScreenBox[] = [];
  let nameOffset: Pixel | undefined;
  const small = sides.length > 0 && isSmall(box);
  const at = (anchor: Pixel, offset: Pixel, size: Size): ScreenBox => ({ centre: { x: anchor.x + offset.x, y: anchor.y + offset.y }, size });
  // index -1 is the name chip, anchored on the box centre.
  const put = (index: number, offset: Pixel, size: Size) => {
    placed.push(at(index < 0 ? area.centre : sides[index].midpoint, offset, size));
    if (index < 0) nameOffset = offset;
    else offsets[index] = offset;
  };
  const free = (index: number, offset: Pixel, size: Size) => {
    const label = at(index < 0 ? area.centre : sides[index].midpoint, offset, size);
    return within(label, viewport) && ![...controls, ...placed].some((other) => overlap(label, other));
  };
  const flipping = (index: number, other: number, offset: Pixel, size: Size) => {
    const opposite = { x: -offset.x, y: -offset.y };
    if (free(index, offset, size) || !free(other, opposite, size)) put(index, offset, size);
    else put(other, opposite, size);
  };
  if (name && !drawing && sides.length) flipping(-1, -1, { x: 0, y: -(box.height / 2 + CLEARANCE_PX + name.height / 2) }, name);
  if (drawing && sides.length) {
    const centre = viewport && { x: viewport.width / 2, y: viewport.height / 2 };
    for (const horizontal of [true, false]) {
      const forward = furthest(sides, horizontal, ({ midpoint }) => (horizontal ? midpoint.y : midpoint.x));
      const backward = furthest(sides, horizontal, ({ midpoint }) => (horizontal ? -midpoint.y : -midpoint.x));
      if (forward === undefined || backward === undefined) continue;
      // The side whose outside faces the view centre: the one away from the box's own edge of the screen.
      const facing = centre && (horizontal ? area.centre.y > centre.y : area.centre.x > centre.x) ? backward : forward;
      const size = sideSizes[facing];
      const sign = facing === forward ? 1 : -1;
      const offset = horizontal ? { x: 0, y: sign * (CLEARANCE_PX + size.height / 2) } : { x: sign * (CLEARANCE_PX + size.width / 2), y: 0 };
      const { midpoint } = sides[facing];
      const target = viewport
        ? { x: clamp(midpoint.x + offset.x, size.width / 2, viewport.width), y: clamp(midpoint.y + offset.y, size.height / 2, viewport.height) }
        : { x: midpoint.x + offset.x, y: midpoint.y + offset.y };
      put(facing, { x: target.x - midpoint.x, y: target.y - midpoint.y }, size);
    }
  } else if (small) {
    const bottom = furthest(sides, true, ({ midpoint }) => midpoint.y);
    const top = furthest(sides, true, ({ midpoint }) => -midpoint.y);
    const right = furthest(sides, false, ({ midpoint }) => midpoint.x);
    const left = furthest(sides, false, ({ midpoint }) => -midpoint.x);
    if (bottom !== undefined && top !== undefined) flipping(bottom, top, { x: 0, y: CLEARANCE_PX + sideSizes[bottom].height / 2 }, sideSizes[bottom]);
    if (right !== undefined && left !== undefined) flipping(right, left, { x: CLEARANCE_PX + sideSizes[right].width / 2, y: 0 }, sideSizes[right]);
  } else {
    const outward = ringTurn(sides) > 0 ? 1 : -1;
    sides.forEach(({ midpoint, edge }, index) => {
      const length = Math.hypot(edge.x, edge.y);
      if (length < MIN_SIDE_PX) return;
      const normal = { x: (outward * edge.y) / length, y: (-outward * edge.x) / length };
      const size = sideSizes[index];
      const distance = CLEARANCE_PX + (Math.abs(normal.x) * size.width + Math.abs(normal.y) * size.height) / 2;
      const offset = { x: normal.x * distance, y: normal.y * distance };
      if (!placed.some((other) => overlap(at(midpoint, offset, size), other))) put(index, offset, size);
    });
  }
  const roomForArea = box.width >= AREA_ROOM.width && box.height >= AREA_ROOM.height && ![...placed, ...controls].some((other) => overlap(area, other));
  return { sides: offsets, area: roomForArea ? { x: 0, y: 0 } : undefined, name: nameOffset };
}
