// One look for every control on the map, from Home Assistant's theme tokens, so custom and dark themes follow.

import { css } from "lit";

/** A light primary tint for what is selected or switched on; text keeps --primary-text-color for contrast. */
export const selectedFill = css`color-mix(in srgb, var(--primary-color) 14%, transparent)`;

/** The fill of a space that has a shape, in its pill's square and in the help sheet. */
export const shapeFill = css`color-mix(in srgb, var(--primary-color) 28%, transparent)`;

/** A card that floats on the map; each control sets its own radius. */
export const floatingSurface = css`
  background: var(--card-background-color);
  border: 1px solid var(--divider-color);
  box-shadow: var(--ha-box-shadow-s, 0 1px 2px 0 rgba(0, 0, 0, 0.08), 0 1px 3px 0 rgba(0, 0, 0, 0.12));
`;

/** A full-width bar on a phone instead of a floating card. */
export const phoneBar = css`
  flex: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: var(--card-background-color);
`;

/**
 * The pill buttons of the floating floor selector and toolbar: compact for a mouse, 44 px on a
 * touch screen. A host with the `chips` or `bar` attribute is the phone layout and sizes its own.
 */
export const pillButtons = css`
  :host {
    ${floatingSurface}
    display: flex;
    gap: 2px;
    padding: var(--ha-space-1);
    border-radius: var(--ha-border-radius-3xl);
  }
  button {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 14px;
    border: none;
    border-radius: 18px;
    background: none;
    color: var(--secondary-text-color);
    font: inherit;
    font-size: var(--ha-font-size-m);
    cursor: pointer;
  }
  button[aria-pressed="true"] {
    background: ${selectedFill};
    color: var(--primary-text-color);
  }
  @media (pointer: coarse) {
    :host(:not([chips]):not([bar])) {
      border-radius: 26px;
    }
    :host(:not([chips]):not([bar])) button {
      height: 44px;
      border-radius: 22px;
    }
    :host(:not([chips]):not([bar])) button.icon {
      width: 44px;
    }
  }
`;
