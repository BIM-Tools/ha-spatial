// Session undo and redo of footprint changes; the caller sends the returned side to the server.

import type { Polygon } from "geojson";

export type FootprintBatch = Record<string, Polygon | null>;

export interface Change {
  before: FootprintBatch;
  after: FootprintBatch;
}

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
