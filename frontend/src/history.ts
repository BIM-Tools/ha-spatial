// Session undo and redo of footprint changes; the caller sends the returned side to the server.

import type { Polygon } from "geojson";

export type FootprintBatch = Record<string, Polygon | null>;

export interface Change {
  before: FootprintBatch;
  after: FootprintBatch;
}

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

  get canUndo() {
    return this._done.length > 0;
  }

  get canRedo() {
    return this._undone.length > 0;
  }
}
