// Derives the one instruction the floor plan shows from the plan itself, so a first visit is led step by step and a later one resumes where the plan stands, with nothing stored about the steps.

import { BUILDING } from "./area-strip";
import type { Floor } from "./floor-selector";

export interface PlanArea {
  area_id: string;
  name: string;
  shaped: boolean;
}

/** A floor of the floor selector, No floor included, with its areas in the strip's order. */
export interface PlanFloor {
  floor: string | null;
  name: string;
  areas: PlanArea[];
}

/** What the panel and the editor know about the plan, as plain data. */
export interface Plan {
  // Home Assistant has a home location.
  homeKnown: boolean;
  // Whether the map draws a building at the home location; undefined until the map has shown it there.
  buildingAtHome: boolean | undefined;
  // The address search was used or closed in this visit.
  searched: boolean;
  // A building on the map is picked as the home in this visit; never stored.
  picked: boolean;
  // The map is too far out to pick a building.
  zoomedOut: boolean;
  // The site has a direction.
  aligned: boolean;
  outlineStored: boolean;
  // The overall size of the outline the map's building offers, while that question is open.
  outlineOffer: string | undefined;
  // After Use outline or a closed outline, until Looks right.
  checkingLength: boolean;
  // The stored outline is a rectangle along the site axes, whose sides take a typed length.
  outlineIsBox: boolean;
  // In the floor selector's order.
  floors: PlanFloor[];
  floor: Floor;
  tool: "align" | "draw" | "select";
  // The area id of the active pill, or the Building's.
  active: string;
  // The pointer is a finger, so the guide says tap.
  coarse?: boolean;
}

/** A control the guide can light: a tool in the toolbar or a button on the guide line. */
export type Control = "draw" | "pick-again" | "draw-myself" | "use-outline" | "looks-right" | "next-floor";

export interface GuideButton {
  control: Control;
  label: string;
}

export interface Step {
  kind:
    | "find"
    | "pick"
    | "choose-floor"
    | "align"
    | "outline-question"
    | "check-length"
    | "draw-outline"
    | "room"
    | "editing"
    | "floor-done"
    | "done";
  text?: string;
  detail?: string;
  buttons?: GuideButton[];
  // The single control lit as the way on.
  lit?: Control;
  // Where the step happens: the floor to open, or the one Next floor opens.
  floor?: Floor;
}

/**
 * The guide moves that frame the house in the free area: the home pick (pick to align), Align done (align
 * to the outline question, its length check, drawing the outline or the first room), Use outline and Looks
 * right (out of the outline question or the length check), the floor done (room to floor-done) and a floor
 * chosen from All. Picking
 * or editing a room moves the guide too, but the map stays where it is under the pointer.
 */
export const fitsAfter = (last: Step["kind"] | undefined, kind: Step["kind"]) => {
  if (last === "choose-floor") return true;
  if (last === "pick") return kind === "align";
  if (last === "align") return ["outline-question", "check-length", "draw-outline", "room"].includes(kind);
  if (last === "outline-question" || last === "check-length") return ["check-length", "room", "draw-outline", "floor-done"].includes(kind);
  return last === "room" && kind === "floor-done";
};

/**
 * Drawing the floor's last room leaves nothing selected. Only that step: floor-done is also reached by
 * picking a room in Select (for example while the outline is still to draw), and that pick stays.
 */
export const clearsSelection = (last: Step["kind"] | undefined, kind: Step["kind"]) => kind === "floor-done" && last === "room";

const CHOOSE_FLOOR = "Choose a floor to edit its rooms";
const ZOOM_IN = "Zoom in to your house.";

const unshaped = (floor: PlanFloor) => floor.areas.some((area) => !area.shaped);

/** The floor to work on: the first with an area to draw, else the first with areas, else the first, else No floor. */
const workFloor = (floors: PlanFloor[]): string | null =>
  (floors.find(unshaped) ?? floors.find((floor) => floor.areas.length) ?? floors[0])?.floor ?? null;

/** The next floor after `current` with an area to draw, going round to the first. */
const nextFloor = (floors: PlanFloor[], current: Floor): PlanFloor | undefined => {
  const at = floors.findIndex((floor) => floor.floor === current);
  return [...floors.slice(at + 1), ...floors.slice(0, Math.max(at, 0))].find(unshaped);
};

/**
 * Custom. The one step the plan is at, in this order: find the home when Home Assistant has none or
 * the map draws no building there; pick the home's building in any tool but Align; on All, which floor to open; align, with Pick another building
 * before the first Align once a building is picked; check one length after a new outline; the outline, as
 * the map's question or drawn by hand; the active area while it has no shape; the floor done with Next
 * floor; done. An area the user picked to edit, while others wait, says nothing. While the building is
 * still to be picked and the map is too far out, the detail says to zoom in.
 */
export function nextStep(plan: Plan): Step {
  const floor = plan.floor === "all" ? workFloor(plan.floors) : plan.floor;
  if (!plan.aligned && !plan.searched && (!plan.homeKnown || plan.buildingAtHome === false)) return { kind: "find", floor };
  const tap = plan.coarse ? "Tap" : "Click";
  if (!plan.aligned && plan.tool !== "align") {
    const detail = plan.zoomedOut ? ZOOM_IN : plan.coarse ? "Tap its building on the map" : "Point at a building to light it up, then click it.";
    return { kind: "pick", text: `${tap} your home`, detail, floor };
  }
  const done = plan.aligned && plan.outlineStored && !plan.floors.some(unshaped);
  if (plan.floor === "all") return done ? { kind: "done", text: CHOOSE_FLOOR } : { kind: "choose-floor", text: CHOOSE_FLOOR, floor };
  if (plan.tool === "align") {
    return {
      kind: "align",
      text: `${tap} the front wall of your home`,
      detail: "The view turns so that wall lies flat.",
      buttons: !plan.aligned && plan.picked ? [{ control: "pick-again", label: "Pick another building" }] : undefined,
      floor,
    };
  }
  if (plan.checkingLength) {
    return {
      kind: "check-length",
      text: "Check one length you know",
      detail: plan.outlineIsBox ? "For example the front of the house. Tap it to type the real size." : "For example the front of the house.",
      buttons: [{ control: "looks-right", label: "Looks right" }],
      lit: "looks-right",
      floor,
    };
  }
  const drawLit = plan.tool === "draw" ? undefined : "draw";
  if (plan.active === BUILDING && !plan.outlineStored) {
    if (plan.outlineOffer) {
      return {
        kind: "outline-question",
        text: "Use the map's outline?",
        detail: `${plan.outlineOffer}. Or ${tap.toLowerCase()} another building.`,
        buttons: [
          { control: "draw-myself", label: "Draw it myself" },
          { control: "use-outline", label: "Use outline" },
        ],
        lit: "use-outline",
        floor,
      };
    }
    return { kind: "draw-outline", text: "Draw the outline of your home", detail: `${tap} each corner; ${tap.toLowerCase()} the first corner to finish. Or ${tap.toLowerCase()} another building.`, lit: drawLit, floor };
  }
  const here = plan.floors.find((entry) => entry.floor === floor) ?? { floor, name: "", areas: [] };
  const active = here.areas.find((area) => area.area_id === plan.active);
  if (active && !active.shaped) {
    const shaped = here.areas.filter((area) => area.shaped).length;
    const count = `${shaped + 1} of ${here.areas.length}`;
    return {
      kind: "room",
      text: `Draw ${active.name}`,
      detail: floor === null ? count : `${count} on the ${here.name}`,
      lit: drawLit,
      floor,
    };
  }
  if (unshaped(here)) return { kind: "editing", floor };
  if (done) return { kind: "done" };
  const next = nextFloor(plan.floors, floor);
  return {
    kind: "floor-done",
    text: here.areas.length ? `${here.name} done` : `No areas on ${here.name}`,
    buttons: next ? [{ control: "next-floor", label: "Next floor" }] : undefined,
    lit: next ? "next-floor" : undefined,
    floor: next?.floor ?? floor,
  };
}
