"""Tests for the frontend version sync script."""

from tools.sync_frontend_versions import frontend_release, ha_version, sync


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
