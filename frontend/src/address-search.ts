// The card that finds a home by its address, for a house the map does not show yet.

import { mdiClose, mdiMagnify } from "@mdi/js";
import { LitElement, css, html, nothing } from "lit";
import { type Place, QUERY_MAX, canSearch, placeLines } from "./address";
import { floatingSurface, selectedFill } from "./styles";

/** What the card shows under the field: nothing yet, the places found, or why there are none. */
type Outcome = { places: Place[] } | { failed: true } | undefined;

class SpatialAddressSearch extends LitElement {
  static properties = {
    // Sends one search; the card never searches while typing.
    search: { attribute: false },
    _query: { state: true },
    _busy: { state: true },
    _outcome: { state: true },
  };

  static styles = css`
    :host {
      ${floatingSurface}
      display: flex;
      flex-direction: column;
      gap: var(--ha-space-3);
      box-sizing: border-box;
      width: 400px;
      max-width: 100%;
      padding: var(--ha-space-4);
      border-radius: var(--ha-card-border-radius, 12px);
      color: var(--primary-text-color);
      font-size: var(--ha-font-size-m);
      pointer-events: auto;
    }
    .head {
      display: flex;
      align-items: flex-start;
      gap: var(--ha-space-2);
    }
    .head > div {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    h2 {
      margin: 0;
      font-size: var(--ha-font-size-l);
      font-weight: var(--ha-font-weight-medium, 500);
      line-height: 28px;
    }
    .secondary {
      margin: 0;
      color: var(--secondary-text-color);
    }
    button {
      box-sizing: border-box;
      border: none;
      background: none;
      color: var(--primary-text-color);
      font: inherit;
      cursor: pointer;
    }
    button:focus-visible,
    input:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 1px;
    }
    .close {
      display: flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      margin: -8px -8px 0 0;
      border-radius: 20px;
      color: var(--secondary-text-color);
    }
    .row {
      display: flex;
      gap: var(--ha-space-2);
    }
    .field {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .field ha-svg-icon {
      position: absolute;
      top: 50%;
      left: 10px;
      transform: translateY(-50%);
      color: var(--secondary-text-color);
      --mdc-icon-size: 20px;
      pointer-events: none;
    }
    input {
      box-sizing: border-box;
      width: 100%;
      height: 40px;
      padding: 0 12px 0 38px;
      border: 1px solid var(--divider-color);
      border-radius: var(--ha-border-radius-sm, 4px);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      font: inherit;
    }
    input::placeholder {
      color: var(--secondary-text-color);
    }
    input:focus {
      border-color: var(--primary-color);
    }
    .action {
      flex: none;
      height: 40px;
      padding: 0 var(--ha-space-4);
      border-radius: 20px;
      box-shadow: 0 0 0 1px var(--divider-color);
      font-weight: var(--ha-font-weight-medium, 500);
    }
    /* The one lit button: a tinted fill and a primary ring, so it does not rely on colour alone. */
    .lit {
      background: ${selectedFill};
      box-shadow: 0 0 0 1.5px var(--primary-color);
    }
    .action:disabled {
      opacity: 0.38;
      cursor: default;
    }
    ul {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .place {
      display: flex;
      flex-direction: column;
      justify-content: center;
      width: 100%;
      min-height: 44px;
      padding: 6px var(--ha-space-3);
      border-radius: var(--ha-border-radius-md, 8px);
      text-align: left;
    }
    .place:hover,
    .place:focus-visible {
      background: ${selectedFill};
    }
    .place span {
      overflow: hidden;
      max-width: 100%;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .place .street {
      font-weight: var(--ha-font-weight-medium, 500);
    }
    .place .town {
      color: var(--secondary-text-color);
      font-size: var(--ha-font-size-s);
    }
    .problem {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--ha-space-2);
    }
    .problem p {
      margin: 0;
    }
    .note {
      color: var(--secondary-text-color);
      font-size: var(--ha-font-size-s);
    }
    /* Touch screens get 44 px targets; a mouse keeps the compact 40 px of the other floating controls. */
    @media (pointer: coarse) {
      input,
      .action,
      .close {
        height: 44px;
      }
      .close {
        width: 44px;
        border-radius: 22px;
      }
      .action {
        border-radius: 22px;
      }
    }
  `;

  declare search: (query: string) => Promise<Place[]>;
  declare _query: string;
  declare _busy: boolean;
  declare _outcome: Outcome;
  // The query of the outcome on screen, which Retry sends again.
  private _searched = "";

  constructor() {
    super();
    this._query = "";
    this._busy = false;
    this._outcome = undefined;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "search");
    this.setAttribute("aria-label", "Find your home");
  }

  firstUpdated() {
    this.renderRoot.querySelector("input")?.focus();
  }

  render() {
    return html`
      <div class="head">
        <div>
          <h2 id="title">Find your home</h2>
          <p class="secondary">Type your address and press Search.</p>
        </div>
        <button class="close" aria-label="Close" @click=${this._close}>
          <ha-svg-icon .path=${mdiClose}></ha-svg-icon>
        </button>
      </div>
      <div class="row">
        <div class="field">
          <ha-svg-icon .path=${mdiMagnify}></ha-svg-icon>
          <input
            type="search"
            aria-label="Address"
            placeholder="Street and house number, town"
            autocomplete="street-address"
            enterkeyhint="search"
            maxlength=${QUERY_MAX}
            .value=${this._query}
            @input=${(event: InputEvent) => (this._query = (event.target as HTMLInputElement).value)}
            @keydown=${this._fieldKey}
          />
        </div>
        <button
          class="action ${this._outcome && "failed" in this._outcome ? "" : "lit"}"
          ?disabled=${this._busy || !canSearch(this._query)}
          @click=${() => this._search(this._query)}
        >
          Search
        </button>
      </div>
      ${this._results()}
      <span class="note">Search by OpenStreetMap</span>
    `;
  }

  private _results() {
    const outcome = this._outcome;
    if (!outcome) return nothing;
    if ("failed" in outcome) {
      return html`<div class="problem" role="alert">
        <p>Address search isn't available right now.</p>
        <button class="action lit" ?disabled=${this._busy} @click=${() => this._search(this._searched)}>Retry</button>
        <p class="secondary">You can also pan the map to your home.</p>
      </div>`;
    }
    if (!outcome.places.length) {
      return html`<p class="problem" role="status">No address found. Check the spelling or add the town.</p>`;
    }
    return html`<ul aria-label="Results" @keydown=${this._listKey}>
      ${outcome.places.map((place) => {
        const { street, town } = placeLines(place.label);
        return html`<li>
          <button class="place" aria-label=${town ? `${street}, ${town}` : street} @click=${() => this._pick(place)}>
            <span class="street">${street}</span>${town ? html`<span class="town">${town}</span>` : nothing}
          </button>
        </li>`;
      })}
    </ul>`;
  }

  // The query stays in this card only: it is never logged or stored.
  private async _search(query: string) {
    if (this._busy || !canSearch(query)) return;
    this._busy = true;
    this._searched = query;
    try {
      this._outcome = { places: await this.search(query.trim()) };
    } catch {
      this._outcome = { failed: true };
    } finally {
      this._busy = false;
    }
  }

  private _fieldKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      this._search(this._query);
    } else if (event.key === "ArrowDown") {
      const first = this.renderRoot.querySelector<HTMLButtonElement>(".place");
      if (!first) return;
      event.preventDefault();
      first.focus();
    } else if (event.key === "Escape") {
      this._close();
    }
  };

  // Arrow keys walk the results; up from the first goes back to the field.
  private _listKey = (event: KeyboardEvent) => {
    const places = [...this.renderRoot.querySelectorAll<HTMLButtonElement>(".place")];
    const at = places.indexOf(event.target as HTMLButtonElement);
    if (event.key === "Escape") {
      this._close();
      return;
    }
    if (at < 0 || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const next = at + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) this.renderRoot.querySelector("input")?.focus();
    else places[Math.min(next, places.length - 1)].focus();
  };

  private _pick(place: Place) {
    this.dispatchEvent(new CustomEvent("place-pick", { detail: { place } }));
  }

  private _close = () => {
    this.dispatchEvent(new CustomEvent("search-close"));
  };
}

customElements.define("spatial-address-search", SpatialAddressSearch);
