// Gives the panel Home Assistant's subpage header, built here because `hass-subpage` is lazy loaded and undefined on a deep link.

import { mdiArrowLeft, mdiArrowRight, mdiHelpCircleOutline } from "@mdi/js";
import { LitElement, css, html } from "lit";
import manifest from "../../custom_components/spatial/manifest.json";

// The integration's page, where the panel is opened from.
const BACK_FALLBACK = "/config/integrations/integration/spatial";

/**
 * Port of canGoBack and the fallback branch of goBack and performNavigation in home-assistant/frontend
 * src/common/navigate.ts, release 20260930.3:
 * https://github.com/home-assistant/frontend/blob/20260930.3/src/common/navigate.ts
 * Copyright Home Assistant contributors, Apache License 2.0.
 *
 * Home Assistant's navigate() stamps `from` on every entry it pushes, so an entry without it was
 * not reached inside the app (deep link, login redirect, fresh tab) and back would leave it.
 * Dialog handling and unsaved-changes guards are left out: the panel opens neither.
 */
const goBack = (fallbackPath: string) => {
  if (history.state?.from !== undefined) {
    history.back();
    return;
  }
  // A replaced entry keeps its predecessor, so it keeps `from`.
  const { root, from } = history.state ?? {};
  const data = root ? { root: true } : undefined;
  history.replaceState(from === undefined ? (data ?? null) : { ...data, from }, "", fallbackPath);
  window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: true } }));
};

class SpatialPanelHeader extends LitElement {
  static properties = {
    narrow: { type: Boolean, reflect: true },
  };

  // The toolbar rules of home-assistant/frontend src/layouts/hass-subpage.ts, release 20260930.3,
  // with the icon buttons at 40 px (44 px on a phone or touch screen).
  static styles = css`
    :host {
      display: block;
      flex: none;
      background-color: var(--app-header-background-color);
      padding-top: var(--safe-area-inset-top);
      padding-right: var(--safe-area-inset-right);
      --ha-icon-button-size: 40px;
    }
    :host([narrow]) {
      padding-left: var(--safe-area-inset-left);
    }
    @media (pointer: coarse) {
      :host {
        --ha-icon-button-size: 44px;
      }
    }
    :host([narrow]) {
      --ha-icon-button-size: 44px;
    }
    .toolbar-content {
      display: flex;
      align-items: center;
      font-size: var(--ha-font-size-xl);
      height: var(--header-height);
      font-weight: var(--ha-font-weight-normal);
      color: var(--app-header-text-color, white);
      border-bottom: var(--app-header-border-bottom, none);
      box-sizing: border-box;
      padding: 8px 12px;
    }
    ha-icon-button {
      display: flex;
      align-items: center;
      pointer-events: auto;
      color: var(--sidebar-icon-color);
    }
    .main-title {
      margin-inline-start: var(--ha-space-6);
      line-height: var(--ha-line-height-normal);
      min-width: 0;
      flex-grow: 1;
      overflow-wrap: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    :host([narrow]) .main-title {
      margin-inline-start: var(--ha-space-2);
    }
  `;

  declare narrow: boolean;

  constructor() {
    super();
    this.narrow = false;
  }

  // Back is a link to the integration's page, so a ctrl-click opens it in a new tab, as in Home Assistant.
  render() {
    return html`
      <div class="toolbar-content">
        <ha-icon-button
          .path=${document.dir === "rtl" ? mdiArrowRight : mdiArrowLeft}
          .label=${"Back"}
          .href=${BACK_FALLBACK}
          @click=${this._back}
        ></ha-icon-button>
        <div class="main-title" role="heading" aria-level="1">Spaces</div>
        <ha-icon-button
          .path=${mdiHelpCircleOutline}
          .label=${"Help"}
          .href=${manifest.documentation}
          .target=${"_blank"}
          .rel=${"noreferrer"}
        ></ha-icon-button>
      </div>
    `;
  }

  private _back(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    goBack(BACK_FALLBACK);
  }
}

customElements.define("spatial-panel-header", SpatialPanelHeader);
