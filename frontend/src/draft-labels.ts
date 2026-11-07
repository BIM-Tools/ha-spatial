// Keeps the labels of a draft apart on screen: each side's length outside its side, the area inside only when the draft has room for it.

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

/** Where each label goes, as an offset from its anchor in pixels; undefined when it is hidden. */
export interface DraftLabelPlaces {
  sides: (Pixel | undefined)[];
  area: Pixel | undefined;
}

const CLEARANCE_PX = 8;
const AREA_ROOM: Size = { width: 96, height: 40 };

const overlap = (a: ScreenBox, b: ScreenBox) =>
  Math.abs(a.centre.x - b.centre.x) < (a.size.width + b.size.width) / 2 && Math.abs(a.centre.y - b.centre.y) < (a.size.height + b.size.height) / 2;

// Twice the signed area of the ring the sides run along; on screen, with y down, positive is clockwise.
const ringTurn = (sides: readonly ScreenSide[]) => {
  const corners = sides.map(({ midpoint, edge }) => ({ x: midpoint.x - edge.x / 2, y: midpoint.y - edge.y / 2 }));
  return corners.reduce((sum, { x, y }, index) => {
    const next = corners[(index + 1) % corners.length];
    return sum + x * next.y - next.x * y;
  }, 0);
};

/**
 * Custom: puts each side label `CLEARANCE_PX` outside its edge, centred on it, and the area label at its
 * anchor when the draft's box on screen is at least 96 x 40 px and the label clears the side labels and
 * `controls` (the side controls on a resized draft's edges). A side label that would overlap one placed
 * before it in ring order is hidden; on a rectangle its opposite side shows the same length.
 * Limit: on a concave shape a side label may land on another part of the shape.
 */
export function placeDraftLabels(
  sides: readonly ScreenSide[],
  sideSizes: readonly Size[],
  box: Size,
  area: ScreenBox,
  controls: readonly ScreenBox[] = [],
): DraftLabelPlaces {
  const outward = ringTurn(sides) > 0 ? 1 : -1;
  const placed: ScreenBox[] = [];
  const sideOffsets = sides.map(({ midpoint, edge }, index): Pixel | undefined => {
    const length = Math.hypot(edge.x, edge.y);
    if (!length) return undefined;
    const normal = { x: (outward * edge.y) / length, y: (-outward * edge.x) / length };
    const size = sideSizes[index];
    const distance = CLEARANCE_PX + (Math.abs(normal.x) * size.width + Math.abs(normal.y) * size.height) / 2;
    const offset = { x: normal.x * distance, y: normal.y * distance };
    const label = { centre: { x: midpoint.x + offset.x, y: midpoint.y + offset.y }, size };
    if (placed.some((other) => overlap(label, other))) return undefined;
    placed.push(label);
    return offset;
  });
  const roomForArea =
    box.width >= AREA_ROOM.width && box.height >= AREA_ROOM.height && ![...placed, ...controls].some((other) => overlap(area, other));
  return { sides: sideOffsets, area: roomForArea ? { x: 0, y: 0 } : undefined };
}
