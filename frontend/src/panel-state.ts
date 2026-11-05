// Keeps what Spatial tells the panel in one place, so the panel, its map and the editor read it instead of relaying it.

import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { Floor } from "./floor-selector";
import { floorsByLevel } from "./map-view";
import { PlanFrame, type SiteFrameData } from "./site-frame";

/** The `spatial/site` reply. */
export interface Site {
  lon: number;
  lat: number;
  // Null until the first Align.
  bearing_deg: number | null;
  // As stored: null until Align sets it on an empty plan.
  origin: [number, number] | null;
  outline: Polygon | null;
  // The frame the integration reads footprints in, with its defaults filled in.
  frame: SiteFrameData;
}

interface Connection {
  sendMessagePromise<T>(message: { type: string }): Promise<T>;
}

// The editor takes the footprints from the same requests, measured in the frame they arrive with.
interface FootprintReader {
  refresh(feed: Promise<FeatureCollection>, site: Promise<Site>): Promise<void>;
}

export const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const EAST_DEG = 90;

export class PanelState implements ReactiveController {
  areas: FeatureCollection = EMPTY;
  outline: Polygon | FeatureCollection = EMPTY;
  // The floors that have rooms, by level; undefined until the first load.
  floorsWithRooms: (string | null)[] | undefined;
  // Rebuilt on every site load, so a unit system change reaches the next gesture.
  frame: PlanFrame | undefined;
  private _floor: Floor = "all";
  private _bearing: number | null = null;

  constructor(private readonly _host: ReactiveControllerHost) {
    _host.addController(this);
  }

  hostConnected() {}

  /** The floor in view. */
  get floor(): Floor {
    return this._floor;
  }

  set floor(floor: Floor) {
    if (floor === this._floor) return;
    this._floor = floor;
    this._host.requestUpdate();
  }

  /** The stored site direction, which names the compass; set ahead of a save so the view turns at once. */
  get bearing(): number | null {
    return this._bearing;
  }

  set bearing(bearing: number | null) {
    if (bearing === this._bearing) return;
    this._bearing = bearing;
    this._host.requestUpdate();
  }

  /** The site's x-axis, clockwise from north. Before any Align it points east, so the view is north up. */
  get axisDeg(): number {
    return this._bearing ?? EAST_DEG;
  }

  /** The rooms on the floor in view, or every room in All. */
  roomsInView(): Feature<Polygon>[] {
    const rooms = this.areas.features as Feature<Polygon>[];
    return this._floor === "all" ? rooms : rooms.filter((room) => room.properties?.floor_id === this._floor);
  }

  /** Whether the card's fixed floor, or else the whole plan, has no rooms; false before the first load. */
  hasNoRooms(fixedFloor: string | undefined): boolean {
    const floors = this.floorsWithRooms;
    if (!floors) return false;
    return fixedFloor && fixedFloor !== "all" ? !floors.includes(fixedFloor) : floors.length === 0;
  }

  /** Reads the rooms and the site; the frame is set before the editor takes the footprints, so it measures them in it. */
  async load(connection: Connection, editor?: FootprintReader): Promise<Site> {
    const feed = connection.sendMessagePromise<FeatureCollection>({ type: "spatial/geojson" });
    const site = connection.sendMessagePromise<Site>({ type: "spatial/site" }).then((reply) => {
      this.frame = PlanFrame.fromSite(reply.frame);
      return reply;
    });
    await editor?.refresh(feed, site);
    this.areas = await feed;
    this.floorsWithRooms = floorsByLevel(this.areas);
    this.outline = (await site).outline ?? EMPTY;
    this._host.requestUpdate();
    return site;
  }
}
