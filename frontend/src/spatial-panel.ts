import { LitElement, html } from "lit";

class SpatialPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    panel: { attribute: false },
  };

  // `declare` keeps class fields from shadowing Lit's accessors.
  declare hass: object | undefined;
  declare narrow: boolean;
  declare panel: object | undefined;

  constructor() {
    super();
    this.narrow = false;
  }

  render() {
    return html`<h1>Spatial</h1>`;
  }
}

customElements.define("spatial-panel", SpatialPanel);
