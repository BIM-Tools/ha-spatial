// @vitest-environment happy-dom
import { expect, test } from "vitest";
import "../src/spatial-panel";

test("spatial-panel renders a title", async () => {
  const panel = document.createElement("spatial-panel") as HTMLElement & {
    hass: object;
  };
  panel.hass = {};
  document.body.append(panel);
  await (panel as unknown as { updateComplete: Promise<boolean> }).updateComplete;
  expect(panel.shadowRoot?.textContent).toContain("Spatial");
});
