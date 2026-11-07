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
  // A building on the map was clicked as the home in this visit, since the last search pick.
  homeClicked: boolean;
  // The site has a direction.
  aligned: boolean;
  outlineStored: boolean;
  // The overall size of the outline the map's building offers, while that question is open.
  outlineOffer: string | undefined;
  // After Use outline, until Looks right.
  checkingLength: boolean;
  // In the floor selector's order.
  floors: PlanFloor[];
  floor: Floor;
  tool: "align" | "draw" | "select";
  // The area id of the active pill, or the Building's.
  active: string;
}

/** A control the guide can light: a tool in the toolbar or a button on the guide line. */
export type Control = "align" | "draw" | "draw-myself" | "use-outline" | "looks-right" | "next-floor";

export interface GuideButton {
  control: Control;
  label: string;
}

export interface Step {
  kind:
    | "find"
    | "click-home"
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

const CHOOSE_FLOOR = "Choose a floor to edit its rooms";

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
 * the map draws no building there; click the home's building, until one was clicked in this visit (Align
 * switched on by hand goes ahead); on All, which floor to open; align; check one length after Use
 * outline; the outline, as the map's question or drawn by hand; the active area while it has no shape;
 * the floor done with Next floor; done. An area the user picked to edit, while others wait, says nothing.
 */
export function nextStep(plan: Plan): Step {
  const floor = plan.floor === "all" ? workFloor(plan.floors) : plan.floor;
  if (!plan.aligned && !plan.searched && (!plan.homeKnown || plan.buildingAtHome === false)) return { kind: "find", floor };
  if (!plan.aligned && !plan.homeClicked && plan.tool !== "align") {
    return { kind: "click-home", text: "Click your home", detail: "Point at your house and click it.", floor };
  }
  const done = plan.aligned && plan.outlineStored && !plan.floors.some(unshaped);
  if (plan.floor === "all") return done ? { kind: "done", text: CHOOSE_FLOOR } : { kind: "choose-floor", text: CHOOSE_FLOOR, floor };
  if (!plan.aligned || plan.tool === "align") {
    return {
      kind: "align",
      text: "Click the front wall of your home",
      detail: "The view turns so that wall lies flat.",
      lit: plan.tool === "align" ? undefined : "align",
      floor,
    };
  }
  if (plan.checkingLength) {
    return {
      kind: "check-length",
      text: "Check one length you know",
      detail: "For example the front of the house. Tap it to type the real size.",
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
        detail: plan.outlineOffer,
        buttons: [
          { control: "draw-myself", label: "Draw it myself" },
          { control: "use-outline", label: "Use outline" },
        ],
        lit: "use-outline",
        floor,
      };
    }
    return { kind: "draw-outline", text: "Draw the outline of your home", detail: "Click and drag a box; boxes join.", lit: drawLit, floor };
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
