"""Sync frontend package versions with the ones Home Assistant's frontend ships.

Usage:
    python tools/sync_frontend_versions.py [--check]

Reads the Home Assistant version from requirements_test.txt, finds the frontend
release in that core version's manifest, and copies the exact versions of shared
packages from that release's package.json into frontend/package.json, plus its
.nvmrc, and sets the home-assistant-frontend pin in requirements_test.txt to the
release. With --check nothing is written; differences are listed and the exit
code is 1. Standard library only.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CORE = "https://raw.githubusercontent.com/home-assistant/core/{}/homeassistant/components/frontend/manifest.json"
FRONTEND = "https://raw.githubusercontent.com/home-assistant/frontend/{}/{}"
SECTIONS = ("dependencies", "devDependencies")


def ha_version(requirements_test: str) -> str:
    """Return X from the 'homeassistant==X' comment on the pytest-homeassistant line."""
    match = re.search(r"#\s*homeassistant==(\S+)", requirements_test)
    if match is None:
        raise ValueError("no 'homeassistant==X' comment in requirements_test.txt")
    return match.group(1)


def frontend_release(core_manifest: dict[str, Any]) -> str:
    """Return X from the 'home-assistant-frontend==X' requirement."""
    for requirement in core_manifest["requirements"]:
        if requirement.startswith("home-assistant-frontend=="):
            return str(requirement.split("==", 1)[1])
    raise ValueError("no home-assistant-frontend requirement in the manifest")


def set_frontend_pin(requirements_test: str, release: str) -> str:
    """Return the text with the home-assistant-frontend== version set to release."""
    return re.sub(
        r"^(home-assistant-frontend==)\S+", rf"\g<1>{release}", requirements_test, flags=re.M
    )


def sync(ours: dict[str, Any], theirs: dict[str, Any]) -> dict[str, Any]:
    """Return ours with shared packages set to their exact version (range prefix stripped)."""
    result: dict[str, Any] = copy.deepcopy(ours)
    shipped = {**theirs.get("dependencies", {}), **theirs.get("devDependencies", {})}
    for section in SECTIONS:
        for name in result.get(section, {}):
            version = shipped.get(name)
            if version is not None:
                result[section][name] = version.lstrip("^~=v")
    return result


def _fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=30) as response:
        return str(response.read().decode())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--check", action="store_true", help="list differences, exit 1")
    check = parser.parse_args().check

    requirements_path = ROOT / "requirements_test.txt"
    requirements = requirements_path.read_text()
    ha = ha_version(requirements)
    release = frontend_release(json.loads(_fetch(CORE.format(ha))))
    theirs = json.loads(_fetch(FRONTEND.format(release, "package.json")))
    nvmrc = _fetch(FRONTEND.format(release, ".nvmrc")).strip() + "\n"

    package_path = ROOT / "frontend" / "package.json"
    if not package_path.exists():
        print(f"{package_path} does not exist", file=sys.stderr)
        return 1
    ours = json.loads(package_path.read_text())
    wanted = sync(ours, theirs)
    nvmrc_path = package_path.with_name(".nvmrc")
    current_nvmrc = nvmrc_path.read_text() if nvmrc_path.exists() else ""

    differences = [
        f"{name}: {ours[section][name]} -> {version}"
        for section in SECTIONS
        for name, version in wanted.get(section, {}).items()
        if ours[section][name] != version
    ]
    wanted_requirements = set_frontend_pin(requirements, release)
    if wanted_requirements != requirements:
        differences.append("requirements_test.txt: home-assistant-frontend pin -> " + release)
    if current_nvmrc != nvmrc:
        differences.append(f".nvmrc: {current_nvmrc.strip() or '(missing)'} -> {nvmrc.strip()}")

    print(f"Home Assistant {ha}, frontend {release}")
    for line in differences:
        print(line)
    if check:
        return 1 if differences else 0
    package_path.write_text(json.dumps(wanted, indent=2) + "\n")
    nvmrc_path.write_text(nvmrc)
    requirements_path.write_text(wanted_requirements)
    return 0


if __name__ == "__main__":
    sys.exit(main())
