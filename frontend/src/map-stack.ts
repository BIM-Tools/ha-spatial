// Map controls in Home Assistant's look, since MapLibre's own controls do not follow its theme: map toggle, zoom and compass.

import { mdiMap, mdiMinus, mdiNavigation, mdiPlus } from "@mdi/js";
import { LitElement, css, html } from "lit";
import { floatingSurface, selectedFill } from "./styles";

class SpatialMapStack extends LitElement {
  static properties = {
    mapShown: { attribute: false },
    // Align needs the map's buildings, so the map stays on.
    mapForced: { attribute: false },
    bearing: { attribute: false },
    // Whether Align has set a site direction; without one the compass faces north.
    aligned: { attribute: false },
    // A phone pinches to zoom and turn, so it gets only a round map toggle.
    round: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      ${floatingSurface}
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-radius: 12px;
    }
    button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      padding: 0;
      border: none;
      background: none;
      color: var(--primary-text-color);
      cursor: pointer;
    }
    button + button {
      border-top: 1px solid var(--divider-color);
    }
    button[aria-pressed="false"] {
      color: var(--secondary-text-color);
    }
    button[aria-pressed="true"] {
      background: ${selectedFill};
      color: var(--primary-color);
    }
    button:disabled {
      opacity: 0.38;
      cursor: default;
    }
    ha-svg-icon {
      --mdc-icon-size: 20px;
    }
    /* Touch screens get 44 px targets; a mouse keeps the compact 40 px. */
    @media (pointer: coarse) {
      button {
        width: 44px;
        height: 44px;
      }
    }
    :host([round]) {
      border-radius: 22px;
    }
    :host([round]) button {
      width: 44px;
      height: 44px;
    }
    /* Opaque, as it floats straight on the map. */
    :host([round]) button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--primary-color) 14%, var(--card-background-color));
    }
    :host([round]) ha-svg-icon {
      --mdc-icon-size: 22px;
    }
  `;

  declare mapShown: boolean;
  declare mapForced: boolean;
  declare bearing: number;
  declare aligned: boolean;
  declare round: boolean;

  constructor() {
    super();
    this.mapShown = true;
    this.mapForced = false;
    this.bearing = 0;
    this.aligned = false;
    this.round = false;
  }

  render() {
    const toggle = html`
      <button
        aria-label="Show map"
        aria-pressed=${this.mapShown || this.mapForced}
        ?disabled=${this.mapForced}
        @click=${() => this._fire("map-toggle")}
      >
        <ha-svg-icon .path=${mdiMap}></ha-svg-icon>
      </button>
    `;
    if (this.round) return toggle;
    return html`
      ${toggle}
      <button aria-label="Zoom in" @click=${() => this._fire("zoom-in")}>
        <ha-svg-icon .path=${mdiPlus}></ha-svg-icon>
      </button>
      <button aria-label="Zoom out" @click=${() => this._fire("zoom-out")}>
        <ha-svg-icon .path=${mdiMinus}></ha-svg-icon>
      </button>
      <button aria-label=${this.aligned ? "Face the house" : "Face north"} @click=${() => this._fire("compass")}>
        <ha-svg-icon .path=${mdiNavigation} style="transform: rotate(${-this.bearing}deg)"></ha-svg-icon>
      </button>
    `;
  }

  private _fire(type: string) {
    this.dispatchEvent(new CustomEvent(type));
  }
}

customElements.define("spatial-map-stack", SpatialMapStack);
