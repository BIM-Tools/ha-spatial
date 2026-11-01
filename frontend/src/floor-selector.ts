// Picks the floor the map shows, styled with Home Assistant's theme because its own toggle groups and chips are lazy loaded.

import { mdiLayers } from "@mdi/js";
import { LitElement, css, html, nothing } from "lit";

// A floor_id, null for areas without a floor, or "all".
export type Floor = string | null | "all";

export interface FloorChoice {
  floor: Floor;
  name: string;
}

class SpatialFloorSelector extends LitElement {
  static properties = {
    choices: { attribute: false },
    selected: { attribute: false },
    // A scrolling chip row under the header on a phone, instead of a floating segmented control.
    chips: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: flex;
      gap: 2px;
      box-sizing: border-box;
      padding: 4px;
      overflow-x: auto;
      scrollbar-width: none;
      background: var(--card-background-color);
      border: var(--spatial-float-border);
      border-radius: 24px;
      box-shadow: var(--spatial-float-shadow);
    }
    button {
      flex: none;
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      padding: 0 14px;
      border: none;
      border-radius: 18px;
      background: none;
      color: var(--secondary-text-color);
      font: inherit;
      font-size: 14px;
      cursor: pointer;
    }
    button[aria-pressed="true"] {
      background: var(--spatial-selected-tint);
      color: var(--primary-text-color);
      font-weight: 500;
    }
    ha-svg-icon {
      --mdc-icon-size: 18px;
    }
    :host([chips]) {
      flex: none;
      align-items: center;
      gap: 8px;
      height: 52px;
      padding: 0 16px;
      border: none;
      border-bottom: 1px solid var(--divider-color);
      border-radius: 0;
      box-shadow: none;
    }
    :host([chips]) button {
      height: 32px;
      padding: 0 12px;
      border: 1px solid var(--divider-color);
      border-radius: 16px;
    }
    :host([chips]) button[aria-pressed="true"] {
      border-color: var(--primary-color);
    }
    /* A 32 px chip still takes a 44 px tap; the row is 52 px high. */
    :host([chips]) button::after {
      content: "";
      position: absolute;
      inset: -7px 0;
    }
    @media (pointer: coarse) {
      :host(:not([chips])) {
        border-radius: 26px;
      }
      :host(:not([chips])) button {
        height: 44px;
        border-radius: 22px;
      }
    }
  `;

  declare choices: FloorChoice[];
  declare selected: Floor;
  declare chips: boolean;

  constructor() {
    super();
    this.choices = [];
    this.selected = "all";
    this.chips = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", "Floor");
  }

  // The selected floor stays enabled, so keyboard focus does not jump away from it.
  render() {
    return this.choices.map(
      ({ floor, name }) => html`
        <button
          aria-pressed=${floor === this.selected}
          @click=${() => this.dispatchEvent(new CustomEvent("floor-select", { detail: { floor } }))}
        >
          ${floor === "all" ? html`<ha-svg-icon .path=${mdiLayers}></ha-svg-icon>` : nothing}${name}
        </button>
      `,
    );
  }
}

customElements.define("spatial-floor-selector", SpatialFloorSelector);
