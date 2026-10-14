// The row of area chips the user picks the next room to draw from, with in-place rename.

import { LitElement, css, html, nothing } from "lit";

export interface AreaEntry {
  area_id: string;
  name: string;
  floor_id: string | null;
}

export const NEW_AREA = "new";

export const stripOrder = (
  areas: AreaEntry[],
  linkedAreaIds: Set<string>,
  floorId: string | null,
): AreaEntry[] =>
  areas
    .filter((area) => area.floor_id === floorId)
    .sort(
      (a, b) =>
        Number(linkedAreaIds.has(a.area_id)) - Number(linkedAreaIds.has(b.area_id)) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );

export const nextActive = (order: AreaEntry[], linkedAreaIds: Set<string>): string =>
  order.find((area) => !linkedAreaIds.has(area.area_id))?.area_id ?? NEW_AREA;

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
    _renaming: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 8px;
    }
    button,
    input {
      flex: none;
      padding: 6px 12px;
      border: 1px solid var(--primary-color);
      border-radius: 16px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
      font: inherit;
    }
    button[aria-pressed="true"] {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
    }
  `;

  declare order: AreaEntry[];
  declare linked: Set<string>;
  declare active: string;
  declare _renaming: boolean;

  constructor() {
    super();
    this.order = [];
    this.linked = new Set();
    this.active = NEW_AREA;
    this._renaming = false;
  }

  render() {
    return html`${this.order.map((area) =>
        this._renaming && area.area_id === this.active
          ? html`<input
              .value=${area.name}
              @keydown=${(e: KeyboardEvent) => this._key(e, area.area_id)}
            />`
          : html`<button
              aria-pressed=${area.area_id === this.active}
              @click=${() => this._tap(area.area_id)}
            >
              ${this.linked.has(area.area_id) ? "● " : nothing}${area.name}
            </button>`,
      )}
      <button
        aria-pressed=${this.active === NEW_AREA}
        @click=${() => this._tap(NEW_AREA)}
      >
        + New area
      </button>`;
  }

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has("active")) this._renaming = false;
  }

  updated(changed: Map<string, unknown>) {
    // On a phone the strip scrolls, and the next area to draw may be out of view.
    if (changed.has("active")) {
      this.shadowRoot!
        .querySelector('[aria-pressed="true"]')
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    if (changed.has("_renaming") && this._renaming) {
      this.shadowRoot!.querySelector("input")?.focus();
    }
  }

  private _tap(areaId: string) {
    if (areaId === this.active && areaId !== NEW_AREA) {
      this._renaming = true;
      return;
    }
    this._renaming = false;
    this.dispatchEvent(new CustomEvent("area-select", { detail: { areaId } }));
  }

  private _key(event: KeyboardEvent, areaId: string) {
    if (event.key === "Escape") this._renaming = false;
    if (event.key !== "Enter") return;
    const name = (event.target as HTMLInputElement).value.trim();
    this._renaming = false;
    if (name) this.dispatchEvent(new CustomEvent("area-rename", { detail: { areaId, name } }));
  }
}

customElements.define("spatial-area-strip", SpatialAreaStrip);
