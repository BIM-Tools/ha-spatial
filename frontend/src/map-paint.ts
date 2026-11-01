// MapLibre paints in WebGL, out of reach of CSS variables, so the rooms' colours are read from Home Assistant's theme here.

import type { Map as MapLibreMap } from "maplibre-gl";

type Rgba = [number, number, number, number];

/*
 * parseColor and computeColor are ported from home-assistant/frontend
 * src/common/map/map-theme-colors.ts, release 20260930.3:
 * https://github.com/home-assistant/frontend/blob/20260930.3/src/common/map/map-theme-colors.ts
 * Copyright Home Assistant contributors, Apache License 2.0.
 */

const HEX = /^#([0-9a-f]{3,8})$/i;
const RGB = /^rgba?\(([^)]+)\)$/i;
// What a browser hands back for a color() or color-mix() in sRGB.
const SRGB = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i;

const parseColor = (value: string): Rgba | undefined => {
  const hex = value.match(HEX);
  if (hex) {
    const d = hex[1];
    const short = d.length === 3 || d.length === 4;
    const part = (i: number) => (short ? parseInt(d[i] + d[i], 16) : parseInt(d.slice(i * 2, i * 2 + 2), 16));
    if (d.length === 3 || d.length === 4 || d.length === 6 || d.length === 8) {
      const alpha = d.length === 4 || d.length === 8 ? part(3) / 255 : 1;
      return [part(0), part(1), part(2), alpha];
    }
    return undefined;
  }
  const rgb = value.match(RGB);
  if (rgb) {
    const parts = rgb[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) {
      return undefined;
    }
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const srgb = value.match(SRGB);
  if (srgb) {
    const to255 = (n: string) => Math.round(Number(n) * 255);
    return [to255(srgb[1]), to255(srgb[2]), to255(srgb[3]), Number(srgb[4] ?? 1)];
  }
  return undefined;
};

// Everything the browser can compute but this module cannot read on its own:
// named colors, hsl(), color-mix(), and a token built out of other properties.
// The sentinel catches a value that is not a color at all, which would
// otherwise quietly inherit the surrounding text color.
const SENTINEL: Rgba = [1, 2, 3, 1];

const computeColor = (element: Element, token: string): Rgba | undefined => {
  const probe = document.createElement("span");
  probe.style.cssText = "display:none;color:rgb(1, 2, 3)";
  const inner = document.createElement("span");
  inner.style.color = `var(${token})`;
  probe.append(inner);
  element.append(probe);
  const parsed = parseColor(getComputedStyle(inner).color);
  probe.remove();
  return parsed && parsed.every((n, i) => n === SENTINEL[i]) ? undefined : parsed;
};

// End of the port.

/** Home Assistant's default theme, for a token the theme does not set. */
const DEFAULTS: Record<string, [light: string, dark: string]> = {
  "--primary-color": ["#03a9f4", "#03a9f4"],
  "--warning-color": ["#ffa600", "#ffa600"],
  "--card-background-color": ["#ffffff", "#1c1c1c"],
  "--primary-text-color": ["#212121", "#e1e1e1"],
  "--secondary-text-color": ["#727272", "#9b9b9b"],
};

/** The map's colours, as rgba() strings MapLibre parses. */
export interface MapPaint {
  primary: string;
  roomFill: string;
  roomEdge: string;
  // Drawn over the room's own fill, so together they make the active fill.
  activeRoomFill: string;
  building: string;
  activeBuildingFill: string;
  draftFill: string;
  apartEdge: string;
  apartFill: string;
  handleFill: string;
}

const rgba = ([r, g, b, a]: Rgba, opacity = 1) => `rgba(${r},${g},${b},${Math.round(a * opacity * 1000) / 1000})`;

const mix = (first: Rgba, second: Rgba, firstShare: number): Rgba =>
  first.map((channel, index) => Math.round(channel * firstShare + second[index] * (1 - firstShare))) as Rgba;

/** Reads the theme as it applies to `element`; `dark` picks the opacities and the defaults. */
export const readMapPaint = (element: Element, dark: boolean): MapPaint => {
  const style = getComputedStyle(element);
  const color = (token: string): Rgba =>
    parseColor(style.getPropertyValue(token).trim()) ??
    computeColor(element, token) ??
    parseColor(DEFAULTS[token][dark ? 1 : 0])!;
  const primary = color("--primary-color");
  const warning = color("--warning-color");
  const roomOpacity = dark ? 0.12 : 0.1;
  const activeOpacity = dark ? 0.3 : 0.24;
  const tintOpacity = dark ? 0.22 : 0.18;
  return {
    primary: rgba(primary),
    roomFill: rgba(primary, roomOpacity),
    roomEdge: rgba(primary, dark ? 0.75 : 0.7),
    activeRoomFill: rgba(primary, 1 - (1 - activeOpacity) / (1 - roomOpacity)),
    // A neutral grey between the two text colours: #5a5a5a on the light default, #bebebe on the dark one.
    building: rgba(mix(color("--primary-text-color"), color("--secondary-text-color"), dark ? 0.5 : 0.3)),
    activeBuildingFill: rgba(primary, tintOpacity),
    draftFill: rgba(primary, tintOpacity),
    apartEdge: rgba(warning),
    apartFill: rgba(warning, 0.16),
    handleFill: rgba(color("--card-background-color")),
  };
};

// A draft feature apart from the active room carries `apart: true`.
const apart = (warning: string, otherwise: string) => ["case", ["==", ["get", "apart"], true], warning, otherwise];

export type LayerColours = Record<string, Record<string, unknown>>;

/** The colour paint of every layer the panel adds, by layer id; widths and dashes stay with each layer. */
export const layerColours = (paint: MapPaint): LayerColours => ({
  "areas-3d": { "fill-extrusion-color": paint.primary },
  "areas-2d": { "fill-color": paint.roomFill },
  "areas-outline": { "line-color": paint.roomEdge },
  "spatial-outline": { "line-color": paint.building },
  "spatial-wall": { "line-color": paint.primary },
  "spatial-active-fill": { "fill-color": paint.activeRoomFill },
  "spatial-active": { "line-color": paint.primary },
  "spatial-active-building-fill": { "fill-color": paint.activeBuildingFill },
  "spatial-active-building": { "line-color": paint.primary },
  "spatial-handles": { "circle-color": paint.handleFill, "circle-stroke-color": paint.primary },
  "spatial-draft-fill": { "fill-color": apart(paint.apartFill, paint.draftFill) },
  "spatial-draft": { "line-color": apart(paint.apartEdge, paint.primary) },
});

type PaintArguments = Parameters<MapLibreMap["setPaintProperty"]>;

/** Repaints the layers already on the map, after a theme change. */
export const repaint = (map: MapLibreMap, paint: MapPaint) => {
  for (const [layerId, properties] of Object.entries(layerColours(paint))) {
    if (!map.getLayer(layerId)) continue;
    for (const [property, value] of Object.entries(properties)) {
      map.setPaintProperty(layerId, property as PaintArguments[1], value as PaintArguments[2]);
    }
  }
};
