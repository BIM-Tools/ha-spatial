// Checks the guide's one step for every state of a plan, with the steps a plan's data skips.
import { expect, test } from "vitest";
import { BUILDING } from "../src/area-strip";
import { type Plan, type PlanFloor, nextStep } from "../src/onboarding";

const area = (area_id: string, shaped = false) => ({ area_id, name: area_id[0].toUpperCase() + area_id.slice(1), shaped });
const GROUND: PlanFloor = { floor: "ground", name: "Ground floor", areas: [area("kitchen", true), area("hall"), area("bath")] };
const LOFT: PlanFloor = { floor: "loft", name: "Loft", areas: [area("attic")] };
const NONE: PlanFloor = { floor: null, name: "No floor", areas: [] };
const shapedAll = (floor: PlanFloor): PlanFloor => ({ ...floor, areas: floor.areas.map((entry) => ({ ...entry, shaped: true })) });

// Aligned with an outline, on the ground floor, Hall active and without a shape.
const PLAN: Plan = {
  homeKnown: true,
  buildingAtHome: true,
  searched: false,
  homeClicked: true,
  aligned: true,
  outlineStored: true,
  outlineOffer: undefined,
  checkingLength: false,
  floors: [GROUND, LOFT, NONE],
  floor: "ground",
  tool: "select",
  active: "hall",
};
const DONE = [shapedAll(GROUND), shapedAll(LOFT), NONE];

test.each<[string, Partial<Plan>, object]>([
  ["no home location: find it", { homeKnown: false, aligned: false, floor: "all" }, { kind: "find", floor: "ground" }],
  ["no building at the home: find it", { buildingAtHome: false, aligned: false }, { kind: "find", floor: "ground" }],
  [
    "a home on a building skips the search: click the home",
    { aligned: false, homeClicked: false },
    { kind: "click-home", text: "Click your home", detail: "Point at your house and click it.", lit: undefined, floor: "ground" },
  ],
  ["a home not looked at yet skips the search", { buildingAtHome: undefined, aligned: false, homeClicked: false }, { kind: "click-home" }],
  ["a search used or closed skips it", { homeKnown: false, searched: true, aligned: false, homeClicked: false }, { kind: "click-home" }],
  ["on All the home is clicked on the floor to open", { aligned: false, homeClicked: false, floor: "all" }, { kind: "click-home", floor: "ground" }],
  ["Align switched on by hand goes ahead of the click", { aligned: false, homeClicked: false, tool: "align" }, { kind: "align" }],
  ["an aligned site skips the search and the click", { homeKnown: false, homeClicked: false }, { kind: "room" }],
  [
    "the home clicked: align, with Align lit",
    { aligned: false },
    { kind: "align", text: "Click the front wall of your home", detail: "The view turns so that wall lies flat.", lit: "align", floor: "ground" },
  ],
  ["Align on: nothing lit", { aligned: false, tool: "align" }, { kind: "align", lit: undefined }],
  ["Change alignment says what to click", { tool: "align" }, { kind: "align" }],
  ["All with work left opens the first floor with an area to draw", { floor: "all" }, { kind: "choose-floor", text: "Choose a floor to edit its rooms", floor: "ground" }],
  ["All on a done plan opens nothing", { floor: "all", floors: DONE }, { kind: "done", text: "Choose a floor to edit its rooms", floor: undefined }],
  ["All without areas opens No floor", { floor: "all", floors: [NONE], outlineStored: false }, { kind: "choose-floor", floor: null }],
  [
    "the map's outline question",
    { outlineStored: false, active: BUILDING, outlineOffer: "9.70 × 7.70 m" },
    {
      kind: "outline-question",
      text: "Use the map's outline?",
      detail: "9.70 × 7.70 m",
      buttons: [
        { control: "draw-myself", label: "Draw it myself" },
        { control: "use-outline", label: "Use outline" },
      ],
      lit: "use-outline",
    },
  ],
  [
    "no map building: draw the outline, Draw lit",
    { outlineStored: false, active: BUILDING },
    { kind: "draw-outline", text: "Draw the outline of your home", detail: "Click and drag a box; boxes join.", lit: "draw" },
  ],
  ["drawing the outline: Draw on, nothing lit", { outlineStored: false, active: BUILDING, tool: "draw" }, { kind: "draw-outline", lit: undefined }],
  [
    "after Use outline: check one length",
    { checkingLength: true, active: BUILDING },
    { kind: "check-length", text: "Check one length you know", buttons: [{ control: "looks-right", label: "Looks right" }], lit: "looks-right" },
  ],
  ["a stored outline skips the outline step", { active: "hall" }, { kind: "room" }],
  ["the active area to draw, Draw lit", {}, { kind: "room", text: "Draw Hall", detail: "2 of 3 on the Ground floor", lit: "draw" }],
  ["drawing it: nothing lit", { tool: "draw" }, { kind: "room", lit: undefined }],
  ["No floor names no floor", { floor: null, floors: [GROUND, { ...NONE, areas: [area("garden")] }], active: "garden" }, { kind: "room", detail: "1 of 1" }],
  ["a drawn area picked while others wait says nothing", { active: "kitchen" }, { kind: "editing", text: undefined }],
  [
    "a floor done offers the next floor with an area to draw",
    { floors: [shapedAll(GROUND), LOFT, NONE], active: "kitchen" },
    { kind: "floor-done", text: "Ground floor done", buttons: [{ control: "next-floor", label: "Next floor" }], lit: "next-floor", floor: "loft" },
  ],
  ["Next floor goes round to the first", { floors: [GROUND, shapedAll(LOFT), NONE], floor: "loft", active: "attic" }, { kind: "floor-done", floor: "ground" }],
  ["an empty floor says so", { floor: null, active: BUILDING }, { kind: "floor-done", text: "No areas on No floor", floor: "ground" }],
  ["every area drawn: done, nothing to say", { floors: DONE, active: "kitchen" }, { kind: "done", text: undefined }],
])("%s", (_name, change, expected) => {
  // A step leaves out what it has not, which `undefined` in `expected` then matches.
  expect({ text: undefined, lit: undefined, floor: undefined, ...nextStep({ ...PLAN, ...change }) }).toMatchObject(expected);
});
