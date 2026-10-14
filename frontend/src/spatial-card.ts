// Puts the rooms map on dashboards. Home Assistant loads this on every page, so it stays
// small: the panel bundle, with MapLibre, loads only when a card is created.

/** The panel bundle next to the card, with the same `?v=` as its registration, so both share one module. */
export const panelUrl = (cardUrl: string): string => {
  const url = new URL("spatial-panel.js", cardUrl);
  url.search = new URL(cardUrl).search;
  return url.href;
};

class SpatialMapCard extends HTMLElement {
  private _panel = document.createElement("spatial-panel") as HTMLElement & {
    hass?: unknown;
    floor?: string;
  };

  static getStubConfig() {
    return {};
  }

  constructor() {
    super();
    this._panel.setAttribute("card", "");
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; height: 400px; }
        :host([panel-layout]) { height: 100%; }
        ha-card { height: 100%; overflow: hidden; }
      </style>
      <ha-card></ha-card>
    `;
    root.querySelector("ha-card")!.append(this._panel);
    import(/* @vite-ignore */ panelUrl(import.meta.url)).catch(console.error);
  }

  setConfig(config: { floor?: unknown }) {
    if (config.floor !== undefined && typeof config.floor !== "string") {
      throw new Error("floor must be a string: all or a floor_id");
    }
    this._panel.floor = config.floor;
  }

  getCardSize() {
    return 8;
  }

  set hass(hass: unknown) {
    this._panel.hass = hass;
  }

  // Home Assistant sets "panel" in a panel view.
  set layout(layout: string | undefined) {
    this.toggleAttribute("panel-layout", layout === "panel");
  }
}

customElements.define("spatial-map-card", SpatialMapCard);

declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string }[];
  }
}

window.customCards ??= [];
window.customCards.push({
  type: "spatial-map-card",
  name: "Spatial map",
  description: "The rooms on Home Assistant's map, per floor or stacked in 3D.",
});
