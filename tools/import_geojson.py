"""Imports room footprints from a GeoJSON file, for houses drawn outside Home Assistant.

The file format is in tools/README.md.
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
import json
from typing import Any

import aiohttp


def normalize_name(name: str) -> str:
    """Normalize a name by removing whitespace and case folding.

    Literal copy of homeassistant.helpers.normalized_name_base_registry.normalize_name,
    so names match the way Home Assistant's area and floor registries match them.
    """
    return name.casefold().replace(" ", "")


class Client:
    """Minimal Home Assistant websocket client."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        """Wrap an authenticated websocket."""
        self._ws = ws
        self._ids = itertools.count(1)

    async def call(self, type_: str, **data: Any) -> Any:
        """Send a command and return its result, raising on error."""
        await self._ws.send_json({"id": next(self._ids), "type": type_, **data})
        msg = await self._ws.receive_json()
        if not msg["success"]:
            raise RuntimeError(f"{type_}: {msg['error']['message']}")
        return msg["result"]


async def import_file(path: str, url: str, token: str) -> None:
    """Import a GeoJSON file into Home Assistant."""
    with open(path, encoding="utf-8") as file:
        collection = json.load(file)

    async with (
        aiohttp.ClientSession() as session,
        session.ws_connect(f"{url.rstrip('/')}/api/websocket") as ws,
    ):
        await ws.receive_json()  # auth_required
        await ws.send_json({"type": "auth", "access_token": token})
        if (await ws.receive_json())["type"] != "auth_ok":
            raise RuntimeError("Authentication failed")
        client = Client(ws)

        floors = {
            normalize_name(entry["name"]): entry["floor_id"]
            for entry in await client.call("config/floor_registry/list")
        }
        areas = {
            normalize_name(entry["name"]): entry["area_id"]
            for entry in await client.call("config/area_registry/list")
        }

        for floor in collection.get("floors", []):
            key = normalize_name(floor["name"])
            if key not in floors:
                created = await client.call(
                    "config/floor_registry/create", name=floor["name"], level=floor.get("level")
                )
                floors[key] = created["floor_id"]
            spatial = {
                field: floor[field] for field in ("elevation_m", "height_m") if field in floor
            }
            await client.call("spatial/floor/update", floor_id=floors[key], **spatial)

        footprints: dict[str, Any] = {}
        names: dict[str, str] = {}
        for feature in collection["features"]:
            name = feature["properties"]["area"]
            key = normalize_name(name)
            floor_id = floors.get(normalize_name(feature["properties"].get("floor", "")))
            icon = (
                {"icon": feature["properties"]["icon"]} if "icon" in feature["properties"] else {}
            )
            if key not in areas:
                created = await client.call(
                    "config/area_registry/create", name=name, floor_id=floor_id, **icon
                )
                areas[key] = created["area_id"]
            else:
                # Existing areas (e.g. created during onboarding) move to the given floor.
                await client.call(
                    "config/area_registry/update", area_id=areas[key], floor_id=floor_id, **icon
                )
            footprints[areas[key]] = feature["geometry"]
            names[areas[key]] = name

        # A file may only set floors or the site; the batch command needs at least one area.
        if footprints:
            result = await client.call("spatial/area/update_geometries", areas=footprints)
            for area_id, area_m2 in result["area_m2"].items():
                print(f"{names[area_id]}: {area_m2} m²")

        # Older files also carry lon and lat; the centre is derived now.
        site = {
            field: value
            for field, value in (collection.get("site") or {}).items()
            if field in ("bearing_deg", "outline")
        }
        if site:
            await client.call("spatial/site/update", **site)


def main() -> None:
    """Parse arguments and run the import."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("path")
    parser.add_argument("--url", default="http://localhost:8123")
    parser.add_argument("--token", required=True, help="Long-lived access token (admin)")
    args = parser.parse_args()
    asyncio.run(import_file(args.path, args.url, args.token))


if __name__ == "__main__":
    main()
