"""Tests for the frontend version sync script."""

import pytest

from tools.sync_frontend_versions import frontend_release, ha_version, set_frontend_pin, sync


def test_ha_version_from_requirements() -> None:
    line = "pytest-homeassistant-custom-component==0.13.372  # homeassistant==2026.10.1"
    assert ha_version(line) == "2026.10.1"


def test_frontend_release_from_manifest() -> None:
    manifest = {"requirements": ["home-assistant-frontend==20260930.3"]}
    assert frontend_release(manifest) == "20260930.3"


def test_sync_takes_shared_versions_only() -> None:
    ours = {
        "dependencies": {"lit": "3.0.0", "polygon-clipping": "0.15.7"},
        "devDependencies": {"esbuild": "0.25.0", "vitest": "1.0.0"},
    }
    theirs = {
        "dependencies": {"lit": "3.3.3"},
        "devDependencies": {"vitest": "5.0.2", "typescript": "6.0.0"},
    }
    result = sync(ours, theirs)
    assert result["dependencies"] == {"lit": "3.3.3", "polygon-clipping": "0.15.7"}
    assert result["devDependencies"] == {"esbuild": "0.25.0", "vitest": "5.0.2"}


def test_sync_strips_range_prefixes() -> None:
    ours = {"dependencies": {"lit": "3.0.0"}}
    theirs = {"dependencies": {"lit": "^3.3.3"}}
    assert sync(ours, theirs)["dependencies"] == {"lit": "3.3.3"}


def test_set_frontend_pin_changes_only_that_line() -> None:
    text = "ruff\nhome-assistant-frontend==20260930.3  # note\nmypy\n"
    expected = "ruff\nhome-assistant-frontend==20261001.0  # note\nmypy\n"
    assert set_frontend_pin(text, "20261001.0") == expected


@pytest.mark.parametrize(
    "text",
    ["ruff\nmypy\n", "home-assistant-frontend==1\nhome-assistant-frontend==2\n"],
    ids=["missing", "duplicated"],
)
def test_set_frontend_pin_needs_exactly_one_pin(text: str) -> None:
    with pytest.raises(ValueError, match="exactly one"):
        set_frontend_pin(text, "20261001.0")
