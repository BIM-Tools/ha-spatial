// @vitest-environment happy-dom
// Checks the area strip's ordering helpers and how a user taps and renames its chips.
import { expect, test, vi } from "vitest";
import { NEW_AREA, nextActive, newAreaName, stripOrder, type AreaEntry } from "../src/area-strip";

const area = (area_id: string, name: string, floor_id: string | null = "f1"): AreaEntry => ({
  area_id,
  name,
  floor_id,
});

test("stripOrder lists areas without a footprint first, each group by name", () => {
  const areas = [area("attic", "Attic"), area("kitchen", "Kitchen"), area("bath", "Bath")];
  const order = stripOrder(areas, new Set(["attic"]), "f1");
  expect(order.map((a) => a.area_id)).toEqual(["bath", "kitchen", "attic"]);
});

test("stripOrder keeps only the floor's areas, and no-floor areas for null", () => {
  const areas = [area("up", "Up", "f2"), area("loose", "Loose", null), area("down", "Down")];
  expect(stripOrder(areas, new Set(), "f1").map((a) => a.area_id)).toEqual(["down"]);
  expect(stripOrder(areas, new Set(), null).map((a) => a.area_id)).toEqual(["loose"]);
});

test("nextActive is the first area without a footprint, else the new-area chip", () => {
  const order = [area("a", "A"), area("b", "B")];
  expect(nextActive(order, new Set(["a"]))).toBe("b");
  expect(nextActive(order, new Set(["a", "b"]))).toBe(NEW_AREA);
});

test("newAreaName takes the smallest free number, ignoring case and spaces", () => {
  expect(newAreaName(["Room 1", "room2"])).toBe("Room 3");
  expect(newAreaName([])).toBe("Room 1");
  expect(newAreaName(["Room 2"])).toBe("Room 1");
});

const mountStrip = (active: string) => {
  const strip = document.createElement("spatial-area-strip") as HTMLElement & {
    order: AreaEntry[];
    linked: Set<string>;
    active: string;
    updateComplete: Promise<boolean>;
  };
  strip.order = [area("a", "Kitchen"), area("b", "Bath")];
  strip.linked = new Set(["b"]);
  strip.active = active;
  document.body.append(strip);
  return strip;
};

const chips = (strip: HTMLElement) => [...strip.shadowRoot!.querySelectorAll("button")];

test("tapping a chip selects its area, and the last chip selects a new one", async () => {
  const strip = mountStrip("a");
  await strip.updateComplete;
  const selected = vi.fn();
  strip.addEventListener("area-select", (e) => selected((e as CustomEvent).detail));
  const all = chips(strip);
  expect(all.map((c) => c.textContent?.trim())).toEqual(["Kitchen", "● Bath", "+ New area"]);
  all[1].click();
  all[2].click();
  expect(selected).toHaveBeenNthCalledWith(1, { areaId: "b" });
  expect(selected).toHaveBeenNthCalledWith(2, { areaId: NEW_AREA });
});

test("tapping the active chip again shows a rename field only on that chip", async () => {
  const strip = mountStrip("a");
  await strip.updateComplete;
  expect(strip.shadowRoot!.querySelector("input")).toBeNull();
  chips(strip)[1].click();
  await strip.updateComplete;
  expect(strip.shadowRoot!.querySelector("input")).toBeNull();
  strip.active = "a";
  await strip.updateComplete;
  chips(strip)[0].click();
  await strip.updateComplete;
  expect(strip.shadowRoot!.querySelectorAll("input")).toHaveLength(1);
});

test("Enter renames the active area and Escape cancels", async () => {
  const strip = mountStrip("a");
  await strip.updateComplete;
  const renamed = vi.fn();
  strip.addEventListener("area-rename", (e) => renamed((e as CustomEvent).detail));
  const open = async () => {
    chips(strip)[0].click();
    await strip.updateComplete;
    return strip.shadowRoot!.querySelector("input")!;
  };
  let input = await open();
  input.value = "Scullery";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await strip.updateComplete;
  expect(renamed).not.toHaveBeenCalled();
  expect(strip.shadowRoot!.querySelector("input")).toBeNull();
  input = await open();
  input.value = "Scullery";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await strip.updateComplete;
  expect(renamed).toHaveBeenCalledWith({ areaId: "a", name: "Scullery" });
  expect(strip.shadowRoot!.querySelector("input")).toBeNull();
});

test("stripOrder sorts numbers in names by value", () => {
  const areas = [area("r10", "Room 10"), area("r2", "Room 2")];
  expect(stripOrder(areas, new Set(), "f1").map((a) => a.area_id)).toEqual(["r2", "r10"]);
});

test("tapping the active chip opens the rename field without selecting", async () => {
  const strip = mountStrip("a");
  await strip.updateComplete;
  const selected = vi.fn();
  strip.addEventListener("area-select", selected);
  chips(strip)[0].click();
  expect(selected).not.toHaveBeenCalled();
});

test("a new active area closes the rename field", async () => {
  const strip = mountStrip("a");
  await strip.updateComplete;
  chips(strip)[0].click();
  await strip.updateComplete;
  strip.active = "b";
  await strip.updateComplete;
  expect(strip.shadowRoot!.querySelector("input")).toBeNull();
});

test("a new active area scrolls its chip into view", async () => {
  const strip = mountStrip("a");
  await strip.updateComplete;
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  strip.active = "b";
  await strip.updateComplete;
  expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  expect((scroll.mock.contexts[0] as Element).textContent?.trim()).toBe("● Bath");
  scroll.mockRestore();
});

test("an area with the id new and the new-area chip are never both active", async () => {
  const strip = mountStrip("new");
  strip.order = [area("new", "New")];
  await strip.updateComplete;
  expect(chips(strip).map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
});
