// Gives the panel Home Assistant's subpage header, built here because `hass-subpage` is lazy loaded and undefined on a deep link.

import { mdiArrowLeft, mdiArrowRight, mdiClose, mdiHelpCircleOutline } from "@mdi/js";
import { LitElement, css, html } from "lit";
import manifest from "../../custom_components/spatial/manifest.json";
import { shapeFill } from "./styles";

const KEYS: [key: string, does: string][] = [
  ["Space + drag", "Pan"],
  ["Ctrl Z", "Undo"],
  ["Ctrl Shift Z", "Redo"],
  ["Esc", "Cancel the box"],
  ["Delete", "Remove the active shape"],
];

// The integration's page, whose Configure opens the editor.
const INTEGRATION_PAGE = "/config/integrations/integration/spatial";

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
      padding: var(--ha-space-2) var(--ha-space-3);
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
    /* Home Assistant's dialog is lazy loaded too, so the help is a native dialog in its look. */
    dialog {
      box-sizing: border-box;
      width: min(400px, calc(100vw - 32px));
      max-height: calc(100dvh - 32px);
      padding: var(--ha-space-2) var(--ha-space-6) var(--ha-space-6);
      border: none;
      border-radius: var(--ha-dialog-border-radius, var(--ha-border-radius-3xl, 24px));
      background: var(--card-background-color);
      color: var(--primary-text-color);
      box-shadow: var(--ha-box-shadow-l, 0 8px 24px rgba(0, 0, 0, 0.24));
      font-family: var(--ha-font-family-body, Roboto, sans-serif);
      font-size: var(--ha-font-size-m);
      line-height: var(--ha-line-height-normal);
    }
    dialog::backdrop {
      background: var(--mdc-dialog-scrim-color, rgba(0, 0, 0, 0.32));
    }
    .title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-inline-end: calc(-1 * var(--ha-space-4));
    }
    h2 {
      margin: 0;
      font-size: var(--ha-font-size-xl);
      font-weight: var(--ha-font-weight-normal);
    }
    h3 {
      margin: var(--ha-space-4) 0 var(--ha-space-2);
      color: var(--secondary-text-color);
      font-size: var(--ha-font-size-s);
      font-weight: var(--ha-font-weight-medium, 500);
    }
    ul {
      display: grid;
      gap: var(--ha-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: var(--ha-space-3);
    }
    .symbol {
      display: flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 24px;
    }
    .square {
      width: 12px;
      height: 12px;
      box-sizing: border-box;
      border: 1.5px solid var(--primary-color);
      border-radius: 3px;
      background: ${shapeFill};
    }
    .square.empty {
      border: 1.5px dashed var(--secondary-text-color);
      background: none;
    }
    .handle {
      width: 12px;
      height: 12px;
      box-sizing: border-box;
      border: 2px solid var(--primary-color);
      border-radius: 50%;
      background: var(--card-background-color);
    }
    .given-up {
      width: 20px;
      height: 14px;
      box-sizing: border-box;
      border: 2px dashed var(--warning-color);
      background: color-mix(in srgb, var(--warning-color) 16%, transparent);
    }
    kbd {
      flex: none;
      min-width: 96px;
      font-family: inherit;
      font-size: var(--ha-font-size-s);
    }
    kbd span {
      padding: 2px 6px;
      border: 1px solid var(--divider-color);
      border-radius: 4px;
    }
    .docs {
      display: inline-block;
      margin-top: var(--ha-space-5);
      color: var(--primary-color);
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
          .label=${"Back to Spatial"}
          .href=${INTEGRATION_PAGE}
          @click=${this._back}
        ></ha-icon-button>
        <div class="main-title" role="heading" aria-level="1">Spaces</div>
        <ha-icon-button
          class="help"
          .path=${mdiHelpCircleOutline}
          .label=${"Help"}
          aria-haspopup="dialog"
          @click=${this._openHelp}
        ></ha-icon-button>
      </div>
      <dialog aria-labelledby="help-title" @keydown=${this._helpKey} @close=${this._helpClosed}>
        <div class="title">
          <h2 id="help-title">Help</h2>
          <ha-icon-button class="close" .path=${mdiClose} .label=${"Close"} @click=${this._closeHelp}></ha-icon-button>
        </div>
        <h3>Symbols</h3>
        <ul>
          <li><span class="symbol"><span class="square"></span></span>Has a shape</li>
          <li><span class="symbol"><span class="square empty"></span></span>No shape yet</li>
          <li><span class="symbol"><span class="handle"></span></span>A corner of the active shape</li>
          <li><span class="symbol"><span class="given-up"></span></span>Given up: the box does not touch the shape it would join</li>
        </ul>
        <h3>Keys</h3>
        <ul>
          ${KEYS.map(([key, does]) => html`<li><kbd><span>${key}</span></kbd>${does}</li>`)}
        </ul>
        <a class="docs" href=${manifest.documentation} target="_blank" rel="noreferrer">Documentation</a>
      </dialog>
    `;
  }

  private get _dialog() {
    return this.renderRoot.querySelector("dialog")!;
  }

  private _openHelp() {
    this._dialog.showModal();
  }

  private _closeHelp() {
    this._dialog.close();
  }

  // Closed here rather than by the browser alone, so Escape works the same everywhere. No key
  // reaches the editor behind the sheet, where Delete or Ctrl Z would change the plan unseen.
  private _helpKey(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();
    this._closeHelp();
  }

  private _helpClosed() {
    this.renderRoot.querySelector<HTMLElement>("ha-icon-button.help")?.focus();
  }

  private _back(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState(null, "", INTEGRATION_PAGE);
    // Home Assistant's router listens for this event rather than for pushState.
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }
}

customElements.define("spatial-panel-header", SpatialPanelHeader);
