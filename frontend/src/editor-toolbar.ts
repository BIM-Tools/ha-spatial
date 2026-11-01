// Shows which editing tool is active and offers undo and redo, floating on the map or as a phone's bottom bar.

import { mdiAngleAcute, mdiCursorMove, mdiRedo, mdiUndo, mdiVectorRectangle } from "@mdi/js";
import { LitElement, css, html } from "lit";
import type { Tool } from "./room-editor";
import { phoneBar, pillButtons, selectedFill } from "./styles";

const TOOLS: { tool: Tool; label: string; icon: string }[] = [
  { tool: "align", label: "Align", icon: mdiAngleAcute },
  { tool: "draw", label: "Draw", icon: mdiVectorRectangle },
  { tool: "adjust", label: "Adjust", icon: mdiCursorMove },
];

class SpatialEditorToolbar extends LitElement {
  static properties = {
    tool: { attribute: false },
    // All floors is a view only: every button is off.
    disabled: { type: Boolean },
    canUndo: { attribute: false },
    canRedo: { attribute: false },
    bar: { type: Boolean, reflect: true },
  };

  static styles = [
    pillButtons,
    css`
      :host {
        align-items: center;
      }
      button {
        padding: 0 14px 0 10px;
        font-weight: 500;
      }
      button[aria-pressed="true"] ha-svg-icon {
        color: var(--primary-color);
      }
      button:disabled {
        opacity: 0.38;
        cursor: default;
      }
      button.icon {
        justify-content: center;
        width: 36px;
        padding: 0;
        color: var(--primary-text-color);
      }
      ha-svg-icon {
        --mdc-icon-size: 20px;
      }
      .divider {
        width: 1px;
        height: 24px;
        margin: 0 4px;
        background: var(--divider-color);
      }
      :host([bar]) {
        ${phoneBar}
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 0;
        height: calc(72px + var(--safe-area-inset-bottom, 0px));
        box-sizing: border-box;
        padding: 8px 4px calc(10px + var(--safe-area-inset-bottom, 0px));
        border-top: 1px solid var(--divider-color);
      }
      :host([bar]) button {
        flex-direction: column;
        gap: 4px;
        height: auto;
        padding: 0;
        font-size: 12px;
        background: none;
      }
      :host([bar]) .pill {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 32px;
        border-radius: 16px;
      }
      :host([bar]) button[aria-pressed="true"] .pill {
        background: ${selectedFill};
      }
      :host([bar]) button.action ha-svg-icon {
        color: var(--primary-text-color);
      }
      :host([bar]) ha-svg-icon {
        --mdc-icon-size: 22px;
      }
    `,
  ];

  declare tool: Tool;
  declare disabled: boolean;
  declare canUndo: boolean;
  declare canRedo: boolean;
  declare bar: boolean;

  constructor() {
    super();
    this.tool = "adjust";
    this.disabled = false;
    this.canUndo = false;
    this.canRedo = false;
    this.bar = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "toolbar");
    this.setAttribute("aria-label", "Tools");
  }

  render() {
    const tools = TOOLS.map(
      ({ tool, label, icon }) => html`
        <button
          aria-pressed=${!this.disabled && tool === this.tool}
          ?disabled=${this.disabled}
          @click=${() => this._fire("tool-select", { tool })}
        >
          ${this._icon(icon)}${label}
        </button>
      `,
    );
    const undo = this._action("undo", "Undo", mdiUndo, this.canUndo);
    const redo = this._action("redo", "Redo", mdiRedo, this.canRedo);
    return this.bar ? [tools, undo, redo] : [tools, html`<span class="divider"></span>`, undo, redo];
  }

  private _icon(path: string) {
    const icon = html`<ha-svg-icon .path=${path}></ha-svg-icon>`;
    return this.bar ? html`<span class="pill">${icon}</span>` : icon;
  }

  // Labelled on the phone bar, icon-only with an aria-label on the floating toolbar.
  private _action(type: "undo" | "redo", label: string, icon: string, enabled: boolean) {
    const disabled = this.disabled || !enabled;
    return this.bar
      ? html`<button class="action" ?disabled=${disabled} @click=${() => this._fire(type)}>${this._icon(icon)}${label}</button>`
      : html`<button class="icon" aria-label=${label} ?disabled=${disabled} @click=${() => this._fire(type)}>
          ${this._icon(icon)}
        </button>`;
  }

  private _fire(type: string, detail?: object) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

customElements.define("spatial-editor-toolbar", SpatialEditorToolbar);
