"""Proves the panel and the card are registered and versioned for the browser."""

from pathlib import Path
from typing import Any

import pytest
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockUser
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

import custom_components.spatial
from custom_components.spatial.const import DOMAIN, PANEL_URL_PATH, STATIC_URL

from .common import call, setup_entry


async def panels_for_user(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> dict[str, Any]:
    """Return the panels Home Assistant's frontend gets for the current user."""
    msg = await call(await hass_ws_client(hass), type="get_panels")
    assert msg["success"], msg
    panels: dict[str, Any] = msg["result"]
    return panels


async def test_panel_for_admins_outside_the_sidebar(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator
) -> None:
    """Configure opens the panel, which has no sidebar entry.

    Home Assistant's sidebar lists only panels with a title.
    """
    await setup_entry(hass)

    panel = (await panels_for_user(hass, hass_ws_client))[PANEL_URL_PATH]
    assert panel["require_admin"]
    assert panel["title"] is None
    assert panel["icon"] is None
    assert panel["config_panel_domain"] == DOMAIN


async def test_panel_hidden_from_non_admins(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, hass_admin_user: MockUser
) -> None:
    """A user without admin rights does not get the panel."""
    await setup_entry(hass)
    hass_admin_user.groups = []

    assert PANEL_URL_PATH not in await panels_for_user(hass, hass_ws_client)


async def test_panel_removed_on_unload_and_back_on_setup(hass: HomeAssistant) -> None:
    """Unloading removes the panel and setting up again brings it back."""
    entry = await setup_entry(hass)

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert "spatial" not in hass.data["frontend_panels"]

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert "spatial" in hass.data["frontend_panels"]


async def test_static_path_registered(hass: HomeAssistant) -> None:
    """The bundle folder is served under the static URL, built or not.

    Without the folder Home Assistant registers a single-file route instead, so the
    committed `.gitkeep` keeps it in place until the first build.
    """
    await setup_entry(hass)

    prefixes = {resource.get_info().get("prefix") for resource in hass.http.app.router.resources()}
    assert STATIC_URL in prefixes


async def test_card_module_added_while_set_up(hass: HomeAssistant) -> None:
    """Every frontend page loads the small card module while the entry is set up."""
    entry = await setup_entry(hass)

    def card_urls() -> list[str]:
        return [
            url
            for url in hass.data[DATA_EXTRA_MODULE_URL].urls
            if url.startswith(f"{STATIC_URL}/spatial-card.js?v=")
        ]

    assert len(card_urls()) == 1

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert card_urls() == []


@pytest.fixture
def frontend_folder(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Serve the bundles from an empty folder, so tests never touch a real build."""
    monkeypatch.setattr(custom_components.spatial, "FRONTEND_PATH", tmp_path)
    return tmp_path


def module_urls(hass: HomeAssistant) -> list[str]:
    """Return the frontend's extra module URLs of the integration."""
    return [url for url in hass.data[DATA_EXTRA_MODULE_URL].urls if url.startswith(STATIC_URL)]


async def test_module_url_follows_every_bundle(hass: HomeAssistant, frontend_folder: Path) -> None:
    """Rebuilding the card, the panel or the worker gives a new URL, so no browser keeps it."""
    (frontend_folder / "spatial-card.js").write_text("card")
    (frontend_folder / "spatial-panel.js").write_text("panel")
    (frontend_folder / "maplibre-gl-worker.js").write_text("worker")
    entry = await setup_entry(hass)
    (url,) = module_urls(hass)
    seen = {url}

    for bundle in ("spatial-panel.js", "spatial-card.js", "maplibre-gl-worker.js"):
        assert await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()
        (frontend_folder / bundle).write_text("rebuilt")
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        (url,) = module_urls(hass)
        assert url not in seen
        seen.add(url)


async def test_card_url_removed_after_bundle_rebuilt_while_loaded(
    hass: HomeAssistant, frontend_folder: Path
) -> None:
    """Unloading removes the card URL that setup registered, even after a rebuild."""
    (frontend_folder / "spatial-card.js").write_text("first build")
    entry = await setup_entry(hass)

    (frontend_folder / "spatial-card.js").write_text("second build")
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    assert module_urls(hass) == []
