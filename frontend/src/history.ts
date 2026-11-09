// Session undo and redo of footprint and site changes; the caller sends the returned side to the server.

import type { FeatureCollection, Polygon } from "geojson";

export type FootprintBatch = Record<string, Polygon | null>;

/** The site fields a write sets, as `spatial/site` returns them; all null is a site never aligned. */
export interface SiteFields {
  bearing_deg: number | null;
  origin: [number, number] | null;
  outline: Polygon | null;
}

/** The stored properties of a room, which go with its footprint when that is removed. */
export interface RoomProperties {
  floors_up: number;
  on_facade_override: boolean | null;
}

export interface Change {
  before: FootprintBatch;
  after: FootprintBatch;
  // Set in the same write as the footprints.
  site?: { before: SiteFields; after: SiteFields };
  // Sent with the side that gives these areas a footprint, so taking back a removal restores them too.
  properties?: Record<string, RoomProperties>;
}

const NO_SITE: SiteFields = { bearing_deg: null, origin: null, outline: null };

/** The change that removes every footprint and every site field at once; undefined when there is nothing to remove. */
export const startOverChange = (feed: FeatureCollection, site: SiteFields): Change | undefined => {
  const siteBefore: SiteFields = { bearing_deg: site.bearing_deg, origin: site.origin, outline: site.outline };
  if (!feed.features.length && Object.values(siteBefore).every((field) => field === null)) return undefined;
  const rooms = feed.features.map((feature) => ({ areaId: String(feature.id), feature }));
  return {
    before: Object.fromEntries(rooms.map(({ areaId, feature }) => [areaId, feature.geometry as Polygon])),
    after: Object.fromEntries(rooms.map(({ areaId }) => [areaId, null])),
    site: { before: siteBefore, after: NO_SITE },
    properties: Object.fromEntries(
      rooms.map(({ areaId, feature }) => [
        areaId,
        { floors_up: feature.properties?.floors_up ?? 0, on_facade_override: feature.properties?.on_facade_override ?? null },
      ]),
    ),
  };
};

/** The change that removes the shapes of these areas at once; undefined when none of them has one. */
export const clearChange = (areaIds: readonly string[], footprints: ReadonlyMap<string, Polygon>): Change | undefined => {
  const shaped = areaIds.filter((areaId) => footprints.has(areaId));
  if (!shaped.length) return undefined;
  return {
    before: Object.fromEntries(shaped.map((areaId) => [areaId, footprints.get(areaId)!])),
    after: Object.fromEntries(shaped.map((areaId) => [areaId, null])),
  };
};

export class History {
  private _done: Change[] = [];
  private _undone: Change[] = [];

  record(change: Change) {
    this._done.push(change);
    this._undone = [];
  }

  undo(): Change | undefined {
    const change = this._done.pop();
    if (change) this._undone.push(change);
    return change;
  }

  redo(): Change | undefined {
    const change = this._undone.pop();
    if (change) this._done.push(change);
    return change;
  }

  /** Whether this change is the one the next undo takes back. */
  isLatest(change: Change) {
    return this._done[this._done.length - 1] === change;
  }

  get canUndo() {
    return this._done.length > 0;
  }

  get canRedo() {
    return this._undone.length > 0;
  }
}
