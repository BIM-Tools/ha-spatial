// The row of pills, the building and then its areas, the user picks the next space to draw from, with in-place rename.

import { mdiCheck, mdiPlus } from "@mdi/js";
import { LitElement, css, html, nothing } from "lit";
import { selectedFill, shapeFill } from "./styles";

export interface AreaEntry {
  area_id: string;
  name: string;
  floor_id: string | null;
}

// Never a registry id.
export const BUILDING = "#building";

const LONG_PRESS_MS = 500;

/** The floor's areas in Home Assistant's own order, which the user sets in the area settings. */
export const stripOrder = (areas: AreaEntry[], floorId: string | null): AreaEntry[] =>
  areas.filter((area) => area.floor_id === floorId);

export const nextActive = (order: AreaEntry[], linkedAreaIds: Set<string>): string | undefined =>
  order.find((area) => !linkedAreaIds.has(area.area_id))?.area_id;

// Same comparison as Home Assistant's normalize_name (homeassistant/helpers/normalized_name_base_registry.py).
const normalize = (name: string) => name.toLowerCase().replace(/\s/g, "");

export const newAreaName = (existingNames: string[]): string => {
  const taken = new Set(existingNames.map(normalize));
  let n = 1;
  while (taken.has(normalize(`Room ${n}`))) n++;
  return `Room ${n}`;
};

class SpatialAreaStrip extends LitElement {
  static properties = {
    order: { attribute: false },
    linked: { attribute: false },
    active: { attribute: false },
    // The area whose pill is a name field, or "".
    renaming: { attribute: false },
    hovered: { attribute: false },
    // All floors is a view only: the strip shows the building and a hint.
    allFloors: { type: Boolean },
  };

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow-x: auto;
      padding: 8px;
      scrollbar-width: none;
    }
    .pill {
      display: flex;
      flex: none;
      align-items: center;
      gap: 8px;
      height: 36px;
      box-sizing: border-box;
      padding: 0 14px 0 12px;
      border: 1px solid var(--divider-color);
      border-radius: 18px;
      background: none;
      color: var(--secondary-text-color);
      font: inherit;
      font-size: var(--ha-font-size-m);
      white-space: nowrap;
      cursor: pointer;
      -webkit-touch-callout: none;
      user-select: none;
    }
    .pill[data-linked="true"] {
      color: var(--primary-text-color);
    }
    .pill[aria-pressed="true"] {
      border-color: var(--primary-color);
      box-shadow: inset 0 0 0 1px var(--primary-color);
      background: ${selectedFill};
      color: var(--primary-text-color);
      font-weight: var(--ha-font-weight-medium, 500);
    }
    .pill[data-hovered] {
      border-color: var(--primary-color);
    }
    span.pill {
      cursor: default;
    }
    .square {
      flex: none;
      width: 12px;
      height: 12px;
      box-sizing: border-box;
      border: 1.5px dashed var(--secondary-text-color);
      border-radius: 3px;
    }
    [data-linked="true"] > .square {
      border: 1.5px solid var(--primary-color);
      background: ${shapeFill};
    }
    [aria-pressed="true"][data-linked="false"] > .square {
      border-color: var(--primary-color);
    }
    .new {
      gap: 6px;
      padding: 0 14px 0 10px;
      border-style: dashed;
      border-color: var(--secondary-text-color);
      color: var(--primary-text-color);
    }
    .new ha-svg-icon {
      --mdc-icon-size: 18px;
      color: var(--primary-color);
    }
    .divider {
      flex: none;
      width: 1px;
      height: 24px;
      background: var(--divider-color);
    }
    .hint {
      flex: none;
      padding: 0 12px 0 4px;
      color: var(--secondary-text-color);
      font-size: var(--ha-font-size-m);
      white-space: nowrap;
    }
    .rename {
      gap: 8px;
      padding: 0 4px 0 12px;
      border-color: var(--primary-color);
      box-shadow: inset 0 0 0 1px var(--primary-color);
      background: var(--card-background-color);
      cursor: auto;
    }
    .rename input {
      width: 96px;
      padding: 0;
      border: none;
      outline: none;
      background: none;
      color: var(--primary-text-color);
      font: inherit;
      font-weight: var(--ha-font-weight-medium, 500);
    }
    .save {
      position: relative;
      display: flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: ${shapeFill};
      color: var(--primary-text-color);
      cursor: pointer;
    }
    /* A 44 px target around the small round button. */
    .save::after {
      content: "";
      position: absolute;
      inset: -8px;
    }
    .save ha-svg-icon {
      --mdc-icon-size: 18px;
    }
    @media (pointer: coarse) {
      .pill {
        height: 44px;
        border-radius: 22px;
      }
      .rename input {
        width: 84px;
      }
    }
  `;

  declare order: AreaEntry[];
  declare linked: Set<string>;
  declare active: string;
  declare renaming: string;
  declare hovered: string | undefined;
  declare allFloors: boolean;

  private _pressTimer?: ReturnType<typeof setTimeout>;
  // A long press already renamed; the click that ends it must not select or rename again.
  private _pressedLong = false;

  constructor() {
    super();
    this.order = [];
    this.linked = new Set();
    this.active = BUILDING;
    this.renaming = "";
    this.hovered = undefined;
    this.allFloors = false;
  }

  render() {
    if (this.allFloors) {
      return html`<span class="pill" data-linked=${this.linked.has(BUILDING)}
          ><span class="square"></span>Building</span
        ><span class="hint">Choose a floor to edit its rooms</span>`;
    }
    return html`${this._pill(BUILDING, "Building")}<span class="divider"></span>${this.order.map((area) =>
        area.area_id === this.renaming ? this._renameField(area) : this._pill(area.area_id, area.name),
      )}<button class="pill new" @click=${() => this._fire("area-create")} @keydown=${this._arrows}>
        <ha-svg-icon .path=${mdiPlus}></ha-svg-icon>New area
      </button>`;
  }

  updated(changed: Map<string, unknown>) {
    // On a phone the strip scrolls, and the next area to draw, or a new one, may be out of view.
    if (changed.has("active") || changed.has("renaming")) {
      this.shadowRoot!
        .querySelector('[aria-pressed="true"], .rename')
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    if (changed.has("renaming") && this.renaming) {
      const input = this.shadowRoot!.querySelector("input");
      input?.focus();
      input?.select();
    }
  }

  private _pill(areaId: string, name: string) {
    const linked = this.linked.has(areaId);
    return html`<button
      class="pill"
      aria-pressed=${areaId === this.active}
      data-linked=${linked}
      ?data-hovered=${areaId === this.hovered}
      title=${linked ? nothing : "No shape yet"}
      @click=${() => this._tap(areaId)}
      @keydown=${this._arrows}
      @mouseenter=${() => this._fire("area-hover", { areaId })}
      @mouseleave=${() => this._fire("area-hover", { areaId: undefined })}
      @pointerdown=${(event: PointerEvent) => this._pressStart(event, areaId)}
      @pointerup=${this._pressEnd}
      @pointercancel=${this._pressEnd}
      @pointerleave=${this._pressEnd}
      @contextmenu=${(event: Event) => event.preventDefault()}
    >
      <span class="square"></span>${name}
    </button>`;
  }

  private _renameField(area: AreaEntry) {
    const save = () => {
      const name = this.shadowRoot!.querySelector("input")!.value.trim();
      if (name && name !== area.name) this._fire("area-rename", { areaId: area.area_id, name });
      else this._fire("area-rename-cancel");
    };
    return html`<span class="pill rename" data-linked=${this.linked.has(area.area_id)}>
      <span class="square"></span>
      <input
        aria-label="Area name"
        .value=${area.name}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") this._fire("area-rename-cancel");
        }}
      />
      <button class="save" aria-label="Save name" @click=${save}>
        <ha-svg-icon .path=${mdiCheck}></ha-svg-icon>
      </button>
    </span>`;
  }

  private _tap(areaId: string) {
    if (this._pressedLong) {
      this._pressedLong = false;
      return;
    }
    if (areaId === this.active && areaId !== BUILDING) this._fire("area-rename-start", { areaId });
    else this._fire("area-select", { areaId });
  }

  // A long press renames on a touch screen, where clicking the active pill again is easy to miss.
  private _pressStart(event: PointerEvent, areaId: string) {
    this._pressEnd();
    this._pressedLong = false;
    if (event.pointerType !== "touch" || areaId === BUILDING) return;
    this._pressTimer = setTimeout(() => {
      this._pressedLong = true;
      this._fire("area-rename-start", { areaId });
    }, LONG_PRESS_MS);
  }

  private _pressEnd = () => clearTimeout(this._pressTimer);

  private _arrows = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const buttons = [...this.shadowRoot!.querySelectorAll<HTMLButtonElement>("button.pill")];
    const step = (event.key === "ArrowRight") === (getComputedStyle(this).direction !== "rtl") ? 1 : -1;
    const next = buttons[buttons.indexOf(event.currentTarget as HTMLButtonElement) + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  private _fire(type: string, detail: object = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

customElements.define("spatial-area-strip", SpatialAreaStrip);
