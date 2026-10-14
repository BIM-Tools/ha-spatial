// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";

// The card loads the panel bundle at runtime; here there is no bundle to load.
vi.spyOn(console, "error").mockImplementation(() => {});

const { panelUrl } = await import("../src/spatial-card");

type Card = HTMLElement & {
  hass: object;
  layout?: string;
  setConfig(config: object): void;
  getCardSize(): number;
};

const mountCard = () => {
  const card = document.createElement("spatial-map-card") as Card;
  card.setConfig({});
  card.hass = { name: "first" };
  document.body.append(card);
  return card;
};

test("the card is offered in Home Assistant's card picker", () => {
  const windowCards = (window as unknown as { customCards: { type: string }[] }).customCards;
  expect(windowCards).toContainEqual(expect.objectContaining({ type: "spatial-map-card" }));
});

test("the card needs no options", () => {
  const Card = customElements.get("spatial-map-card") as unknown as { getStubConfig(): object };
  expect(Card.getStubConfig()).toEqual({});
  expect(mountCard().getCardSize()).toBeGreaterThan(0);
});

test("the card shows the panel's map view, without the menu button, with every hass", () => {
  const card = mountCard();
  const panel = card.shadowRoot?.querySelector("spatial-panel") as HTMLElement & { hass: object };
  expect(panel.hasAttribute("card")).toBe(true);
  expect(panel.hass).toEqual({ name: "first" });
  card.hass = { name: "second" };
  expect(panel.hass).toEqual({ name: "second" });
});

test("the card fills a panel view", () => {
  const card = mountCard();
  card.layout = "panel";
  expect(card.hasAttribute("panel-layout")).toBe(true);
  card.layout = undefined;
  expect(card.hasAttribute("panel-layout")).toBe(false);
});

test("the panel bundle is loaded from next to the card, with the same version", () => {
  // The same URL as the panel registration, so both share one module.
  expect(panelUrl("http://ha:8123/spatial_static/spatial-card.js?v=0.1.0")).toBe(
    "http://ha:8123/spatial_static/spatial-panel.js?v=0.1.0",
  );
});
