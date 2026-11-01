// @vitest-environment happy-dom
// Checks the area strip's ordering helpers and how a user picks, renames and adds areas with its pills.
import { afterEach, expect, test, vi } from "vitest";
import { BUILDING, nextActive, newAreaName, stripOrder, type AreaEntry } from "../src/area-strip";

const area = (area_id: string, name: string, floor_id: string | null = "f1"): AreaEntry => ({
  area_id,
  name,
  floor_id,
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

test("stripOrder keeps Home Assistant's order of the floor's areas", () => {
  const areas = [area("kitchen", "Kitchen"), area("attic", "Attic"), area("bath", "Bath")];
  expect(stripOrder(areas, "f1").map((a) => a.area_id)).toEqual(["kitchen", "attic", "bath"]);
});

test("stripOrder keeps only the floor's areas, and no-floor areas for null", () => {
  const areas = [area("up", "Up", "f2"), area("loose", "Loose", null), area("down", "Down")];
  expect(stripOrder(areas, "f1").map((a) => a.area_id)).toEqual(["down"]);
  expect(stripOrder(areas, null).map((a) => a.area_id)).toEqual(["loose"]);
});

test("nextActive is the first area without a footprint, and nothing once all have one", () => {
  const order = [area("a", "A"), area("b", "B")];
  expect(nextActive(order, new Set(["a"]))).toBe("b");
  expect(nextActive(order, new Set(["a", "b"]))).toBeUndefined();
});

test("newAreaName takes the smallest free number, ignoring case and spaces", () => {
  expect(newAreaName(["Room 1", "room2"])).toBe("Room 3");
  expect(newAreaName([])).toBe("Room 1");
  expect(newAreaName(["Room 2"])).toBe("Room 1");
});

type Strip = HTMLElement & {
  order: AreaEntry[];
  linked: Set<string>;
  active: string;
  renaming: string;
  hovered: string | undefined;
  allFloors: boolean;
  updateComplete: Promise<boolean>;
};

const mountStrip = async (active: string, setup: Partial<Strip> = {}) => {
  const strip = document.createElement("spatial-area-strip") as Strip;
  strip.order = [area("a", "Kitchen"), area("b", "Bath")];
  strip.linked = new Set(["a"]);
  strip.active = active;
  Object.assign(strip, setup);
  document.body.append(strip);
  await strip.updateComplete;
  return strip;
};

const pills = (strip: HTMLElement) => [...strip.shadowRoot!.querySelectorAll<HTMLButtonElement>("button.pill")];
const pill = (strip: HTMLElement, name: string) => pills(strip).find((button) => button.textContent?.trim() === name)!;

const events = (strip: HTMLElement, ...types: string[]) => {
  const seen: [string, unknown][] = [];
  for (const type of types) strip.addEventListener(type, (event) => seen.push([type, (event as CustomEvent).detail]));
  return seen;
};

test("the strip shows Building, a divider, the areas in order, then New area", async () => {
  const strip = await mountStrip("a");
  const parts = [...strip.shadowRoot!.children].map((element) =>
    element.classList.contains("divider") ? "|" : element.textContent?.trim(),
  );
  expect(parts).toEqual(["Building", "|", "Kitchen", "Bath", "New area"]);
});

test("each pill shows its state: shape or none by data-linked, active by aria-pressed", async () => {
  const strip = await mountStrip("b", { linked: new Set([BUILDING, "a"]) });
  const states = pills(strip).map((button) => [
    button.textContent?.trim(),
    button.getAttribute("data-linked"),
    button.getAttribute("aria-pressed"),
  ]);
  expect(states).toEqual([
    ["Building", "true", "false"],
    ["Kitchen", "true", "false"],
    ["Bath", "false", "true"],
    ["New area", null, null],
  ]);
  expect(pill(strip, "Bath").title).toBe("No shape yet");
  expect(pill(strip, "Kitchen").hasAttribute("title")).toBe(false);
});

test("a tap on another pill selects its area, and New area asks for a new one", async () => {
  const strip = await mountStrip("a");
  const seen = events(strip, "area-select", "area-create", "area-rename-start");
  pill(strip, "Bath").click();
  pill(strip, "Building").click();
  pill(strip, "New area").click();
  expect(seen).toEqual([
    ["area-select", { areaId: "b" }],
    ["area-select", { areaId: BUILDING }],
    ["area-create", {}],
  ]);
});

test("a tap on the active pill asks to rename it, except on Building", async () => {
  const strip = await mountStrip("a");
  const seen = events(strip, "area-select", "area-rename-start");
  pill(strip, "Kitchen").click();
  strip.active = BUILDING;
  await strip.updateComplete;
  pill(strip, "Building").click();
  expect(seen).toEqual([
    ["area-rename-start", { areaId: "a" }],
    ["area-select", { areaId: BUILDING }],
  ]);
});

test("a long press on a phone asks to rename, and the click that ends it does nothing more", async () => {
  vi.useFakeTimers();
  const strip = await mountStrip("a");
  const seen = events(strip, "area-select", "area-rename-start");
  const bath = pill(strip, "Bath");
  bath.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" }));
  vi.advanceTimersByTime(500);
  bath.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" }));
  bath.click();
  expect(seen).toEqual([["area-rename-start", { areaId: "b" }]]);
  bath.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" }));
  vi.advanceTimersByTime(200);
  bath.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" }));
  bath.click();
  expect(seen.at(-1)).toEqual(["area-select", { areaId: "b" }]);
});

const renameInput = (strip: HTMLElement) => strip.shadowRoot!.querySelector("input");

test("the renaming pill is a field with the name selected and a check button", async () => {
  const strip = await mountStrip("a");
  strip.renaming = "a";
  await strip.updateComplete;
  const input = renameInput(strip)!;
  expect(input.value).toBe("Kitchen");
  expect(strip.shadowRoot!.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Kitchen".length]);
  expect(pill(strip, "Kitchen")).toBeUndefined();
  expect(strip.shadowRoot!.querySelector("button.save")?.getAttribute("aria-label")).toBe("Save name");
});

test("Enter or the check button renames, Escape cancels, and an unchanged name only closes the field", async () => {
  const strip = await mountStrip("a", { renaming: "a" });
  const seen = events(strip, "area-rename", "area-rename-cancel");
  const input = renameInput(strip)!;
  input.value = "Scullery ";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  input.value = "Pantry";
  strip.shadowRoot!.querySelector<HTMLButtonElement>("button.save")!.click();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  input.value = "Kitchen";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(seen).toEqual([
    ["area-rename", { areaId: "a", name: "Scullery" }],
    ["area-rename", { areaId: "a", name: "Pantry" }],
    ["area-rename-cancel", {}],
    ["area-rename-cancel", {}],
  ]);
});

test("the arrow keys move the focus between the pills", async () => {
  const strip = await mountStrip("a");
  const focused = () => strip.shadowRoot!.activeElement?.textContent?.trim();
  pill(strip, "Building").focus();
  const press = (key: string) =>
    strip.shadowRoot!.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  press("ArrowRight");
  expect(focused()).toBe("Kitchen");
  press("ArrowRight");
  press("ArrowRight");
  expect(focused()).toBe("New area");
  press("ArrowRight");
  expect(focused()).toBe("New area");
  press("ArrowLeft");
  expect(focused()).toBe("Bath");
});

test("pointing at a pill names its area, leaving it names none, and the hovered pill is marked", async () => {
  const strip = await mountStrip("a");
  const seen = events(strip, "area-hover");
  pill(strip, "Bath").dispatchEvent(new MouseEvent("mouseenter"));
  pill(strip, "Bath").dispatchEvent(new MouseEvent("mouseleave"));
  expect(seen).toEqual([
    ["area-hover", { areaId: "b" }],
    ["area-hover", { areaId: undefined }],
  ]);
  strip.hovered = "a";
  await strip.updateComplete;
  expect(pills(strip).filter((button) => button.hasAttribute("data-hovered")).map((b) => b.textContent?.trim())).toEqual([
    "Kitchen",
  ]);
});

test("a new active area, or a name field, scrolls into view", async () => {
  const strip = await mountStrip("a");
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  strip.active = "b";
  await strip.updateComplete;
  expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  expect((scroll.mock.contexts[0] as Element).textContent?.trim()).toBe("Bath");
  strip.renaming = "b";
  await strip.updateComplete;
  expect((scroll.mock.contexts[1] as Element).classList.contains("rename")).toBe(true);
  scroll.mockRestore();
});

test("on All the strip shows only the Building and a hint to choose a floor", async () => {
  const strip = await mountStrip(BUILDING, { allFloors: true, linked: new Set([BUILDING]) });
  const parts = [...strip.shadowRoot!.children].map((part) => part.textContent?.trim());
  expect(parts).toEqual(["Building", "Choose a floor to edit its rooms"]);
  expect(pills(strip)).toEqual([]);
});
