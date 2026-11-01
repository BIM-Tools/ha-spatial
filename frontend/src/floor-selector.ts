// Picks the floor the map shows, styled with Home Assistant's theme because its own toggle groups and chips are lazy loaded.

import { mdiLayers } from "@mdi/js";
import { LitElement, css, html, nothing } from "lit";
import { phoneBar, pillButtons } from "./styles";

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

  static styles = [
    pillButtons,
    css`
      :host {
        box-sizing: border-box;
        flex-wrap: wrap;
      }
      button {
        position: relative;
      }
      button[aria-pressed="true"] {
        font-weight: 500;
      }
      ha-svg-icon {
        --mdc-icon-size: 18px;
      }
      :host([chips]) {
        ${phoneBar}
        flex-wrap: nowrap;
        overflow-x: auto;
        align-items: center;
        gap: 8px;
        height: 52px;
        padding: 0 16px;
        border-bottom: 1px solid var(--divider-color);
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
    `,
  ];

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
