// Shows which editing tool is active and offers undo, redo and removal, floating on the map or as a phone's bottom bar.

import { mdiAngleAcute, mdiCursorDefault, mdiDeleteOutline, mdiRedo, mdiUndo, mdiVectorRectangle } from "@mdi/js";
import { LitElement, css, html } from "lit";
import type { Tool } from "./room-editor";
import { litControl, phoneBar, pillButtons, selectedFill } from "./styles";

const TOOLS: { tool: Tool; label: string; icon: string }[] = [
  { tool: "align", label: "Align", icon: mdiAngleAcute },
  { tool: "draw", label: "Draw", icon: mdiVectorRectangle },
  { tool: "select", label: "Select", icon: mdiCursorDefault },
];

class SpatialEditorToolbar extends LitElement {
  static properties = {
    tool: { attribute: false },
    // All floors is a view only: every button is off.
    disabled: { type: Boolean },
    canUndo: { attribute: false },
    canRedo: { attribute: false },
    canRemove: { attribute: false },
    // Align is offered here until the site has a direction; after that the header menu offers it.
    align: { type: Boolean },
    // The tool the guide names as the next step.
    lit: { attribute: false },
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
      :host(:not([bar])) button.lit,
      :host([bar]) button.lit .pill {
        ${litControl}
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
        margin: 0 var(--ha-space-1);
        background: var(--divider-color);
      }
      :host([bar]) {
        ${phoneBar}
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(0, 1fr);
        gap: 0;
        height: calc(72px + var(--safe-area-inset-bottom, 0px));
        box-sizing: border-box;
        padding: var(--ha-space-2) var(--ha-space-1) calc(10px + var(--safe-area-inset-bottom, 0px));
        border-top: 1px solid var(--divider-color);
      }
      :host([bar]) button {
        flex-direction: column;
        gap: var(--ha-space-1);
        height: auto;
        padding: 0;
        font-size: var(--ha-font-size-s);
        background: none;
      }
      :host([bar]) .pill {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 32px;
        border-radius: var(--ha-border-radius-xl);
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
  declare canRemove: boolean;
  declare align: boolean;
  declare lit: Tool | undefined;
  declare bar: boolean;

  constructor() {
    super();
    this.tool = "select";
    this.disabled = false;
    this.canUndo = false;
    this.canRedo = false;
    this.canRemove = false;
    this.align = false;
    this.bar = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "toolbar");
    this.setAttribute("aria-label", "Tools");
  }

  render() {
    const tools = TOOLS.filter(({ tool }) => this.align || tool !== "align").map(
      ({ tool, label, icon }) => html`
        <button
          class=${!this.disabled && tool === this.lit ? "lit" : ""}
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
    const remove = this._action("remove", "Remove", mdiDeleteOutline, this.canRemove, "Remove shape");
    return this.bar ? [tools, undo, redo, remove] : [tools, html`<span class="divider"></span>`, undo, redo, remove];
  }

  private _icon(path: string) {
    const icon = html`<ha-svg-icon .path=${path}></ha-svg-icon>`;
    return this.bar ? html`<span class="pill">${icon}</span>` : icon;
  }

  // Labelled on the phone bar, icon-only with an aria-label on the floating toolbar.
  private _action(type: "undo" | "redo" | "remove", label: string, icon: string, enabled: boolean, name = label) {
    const disabled = this.disabled || !enabled;
    return this.bar
      ? html`<button class="action" aria-label=${name} ?disabled=${disabled} @click=${() => this._fire(type)}>${this._icon(icon)}${label}</button>`
      : html`<button class="icon" aria-label=${name} ?disabled=${disabled} @click=${() => this._fire(type)}>
          ${this._icon(icon)}
        </button>`;
  }

  private _fire(type: string, detail?: object) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

customElements.define("spatial-editor-toolbar", SpatialEditorToolbar);
