// Gives the panel Home Assistant's subpage header, built here because `hass-subpage` is lazy loaded and undefined on a deep link.

import { mdiArrowLeft, mdiHelpCircleOutline } from "@mdi/js";
import { LitElement, css, html } from "lit";
import manifest from "../../custom_components/spatial/manifest.json";

// The integration's page, where the panel is opened from.
const BACK_FALLBACK = "/config/integrations/integration/spatial";

class SpatialPanelHeader extends LitElement {
  static properties = {
    narrow: { type: Boolean, reflect: true },
  };

  // Copies the look of Home Assistant's `hass-subpage` toolbar.
  static styles = css`
    :host {
      display: flex;
      flex: none;
      align-items: center;
      gap: 4px;
      box-sizing: border-box;
      height: calc(56px + var(--safe-area-inset-top, 0px));
      padding: var(--safe-area-inset-top, 0px) calc(8px + var(--safe-area-inset-right, 0px)) 0
        calc(8px + var(--safe-area-inset-left, 0px));
      background-color: var(--app-header-background-color);
      color: var(--app-header-text-color, var(--primary-text-color));
      border-bottom: var(--app-header-border-bottom, none);
      --mdc-icon-button-size: 40px;
    }
    :host([narrow]) {
      padding-left: calc(4px + var(--safe-area-inset-left, 0px));
      padding-right: calc(4px + var(--safe-area-inset-right, 0px));
      --mdc-icon-button-size: 44px;
    }
    /* Touch screens get 44 px targets; a mouse keeps the compact 40 px. */
    @media (pointer: coarse) {
      :host {
        --mdc-icon-button-size: 44px;
      }
    }
    h1 {
      flex: 1;
      margin: 0 0 0 8px;
      font-size: 20px;
      font-weight: 400;
      line-height: 20px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    a {
      color: inherit;
    }
  `;

  declare narrow: boolean;

  constructor() {
    super();
    this.narrow = false;
  }

  render() {
    return html`
      <ha-icon-button .path=${mdiArrowLeft} .label=${"Back"} @click=${this._back}></ha-icon-button>
      <h1>Spaces</h1>
      <a href=${manifest.documentation} target="_blank" rel="noreferrer">
        <ha-icon-button .path=${mdiHelpCircleOutline} .label=${"Help"}></ha-icon-button>
      </a>
    `;
  }

  // Back only returns to a page of this Home Assistant: the document was loaded on another of its
  // pages and the router brought the user here. A deep link, or a link from another site, goes to
  // the integration's page instead. Home Assistant's router follows `location-changed`.
  private _back() {
    const [loaded] = performance.getEntriesByType("navigation");
    if (loaded && new URL(loaded.name).pathname !== location.pathname) {
      history.back();
      return;
    }
    history.replaceState(null, "", BACK_FALLBACK);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: true } }));
  }
}

customElements.define("spatial-panel-header", SpatialPanelHeader);
