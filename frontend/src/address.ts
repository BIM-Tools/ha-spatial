// Turns what the address search sends into what the search card shows, where the map goes and what it asks about the home, without a map or a page.

import distance from "@turf/distance";

/** One place of a `spatial/address/search` reply; `bbox` is `[west, south, east, north]`, or null. */
export interface Place {
  label: string;
  lat: number;
  lon: number;
  bbox: [number, number, number, number] | null;
}

/** The shortest and longest query the integration searches for, after trimming. */
export const QUERY_MIN = 3;
export const QUERY_MAX = 200;

/** The zoom the map flies to for a place without a usable box: one house fills a good part of the view. */
export const BUILDING_ZOOM = 18;

/** Whether a typed query may be sent: 3 to 200 characters once the spaces around it are gone. */
export const canSearch = (query: string): boolean => {
  const length = query.trim().length;
  return length >= QUERY_MIN && length <= QUERY_MAX;
};

/** Whether Home Assistant has no home location: unset, or left at 0, 0, which is in the sea. */
export const homeUnknown = (config: { latitude?: number | null; longitude?: number | null }): boolean =>
  config.latitude == null || config.longitude == null || (config.latitude === 0 && config.longitude === 0);

/** How far a picked place may lie from Home Assistant's home before the panel offers to move the home. */
export const HOME_MOVE_MIN_M = 25;

/** What the panel asks after a picked place: use it as the first home, or move the home that far. */
export type HomeQuestion = { kind: "use" } | { kind: "move"; metres: number };

/**
 * The question for a picked place, or none when the home already lies within 25 m of it.
 * The distance is turf's great circle on a sphere, about 0.3% off the ellipsoid, plenty for a 25 m threshold.
 */
export const homeQuestion = (
  home: { latitude?: number | null; longitude?: number | null },
  place: Pick<Place, "lat" | "lon">,
): HomeQuestion | undefined => {
  if (homeUnknown(home)) return { kind: "use" };
  const metres = distance([home.longitude!, home.latitude!], [place.lon, place.lat], { units: "meters" });
  return metres > HOME_MOVE_MIN_M ? { kind: "move", metres } : undefined;
};

// A first part made of a house number: digits first, then letters, digits, spaces, hyphens or slashes, as in
// "12", "12a", "12-14" or "4 bis".
const HOUSE_NUMBER = /^\d[\p{L}\d\s/-]{0,9}$/u;

/**
 * The two lines of a result: the street part first, the town part second.
 *
 * Custom. The label is OpenStreetMap's comma separated name, which puts the house number in a part of
 * its own before the street. When the first part is a house number, the first line is the second part
 * followed by that number ("Voorbeeldstraat 12"); otherwise the first line is the first part, such as a
 * building name or a street without a number. The second line is every part after that, in order.
 * Limits: the number always follows the street, also where the address is written the other way round;
 * the second line can start with a neighbourhood or district rather than the town, and repeats the
 * postcode and country as the label gives them.
 */
export const placeLines = (label: string): { street: string; town: string } => {
  const parts = label
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const numbered = parts.length > 1 && HOUSE_NUMBER.test(parts[0]);
  const street = numbered ? `${parts[1]} ${parts[0]}` : (parts[0] ?? "");
  return { street, town: parts.slice(numbered ? 2 : 1).join(", ") };
};

/**
 * Where the map goes for a place: its box, zoomed in no further than building zoom, or its point at building
 * zoom when the box is missing, has no size or crosses the antimeridian.
 */
export type Camera =
  | { bounds: [[number, number], [number, number]]; maxZoom: number }
  | { center: [number, number]; zoom: number };

export const cameraFor = (place: Place): Camera => {
  const box = place.bbox;
  if (box && box[2] > box[0] && box[3] > box[1]) {
    return { bounds: [[box[0], box[1]], [box[2], box[3]]], maxZoom: BUILDING_ZOOM };
  }
  return { center: [place.lon, place.lat], zoom: BUILDING_ZOOM };
};
