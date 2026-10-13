"""Import room footprints from a GeoJSON file into Home Assistant.

Usage:
    python tools/import_geojson.py house.geojson --url http://localhost:8123 --token TOKEN

The file is a FeatureCollection of Polygons. Each feature names its area and
floor in its properties ({"area": "Kitchen", "floor": "Ground floor"}).
Optional foreign members set floors and the site anchor:
    "floors": [{"name": "Ground floor", "level": 0, "elevation_m": 0, "height_m": 2.8}]
    "site": {"lon": 5.12, "lat": 52.09, "bearing_deg": 20}
Missing floors and areas are created with Home Assistant's own registry
commands. Only the public websocket API is used.
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
            normalize_name(f["name"]): f["floor_id"]
            for f in await client.call("config/floor_registry/list")
        }
        areas = {
            normalize_name(a["name"]): a["area_id"]
            for a in await client.call("config/area_registry/list")
        }

        for floor in collection.get("floors", []):
            key = normalize_name(floor["name"])
            if key not in floors:
                created = await client.call(
                    "config/floor_registry/create", name=floor["name"], level=floor.get("level")
                )
                floors[key] = created["floor_id"]
            spatial = {k: floor[k] for k in ("elevation_m", "height_m") if k in floor}
            await client.call("spatial/floor/update_spatial", floor_id=floors[key], **spatial)

        for feature in collection["features"]:
            name = feature["properties"]["area"]
            key = normalize_name(name)
            floor_id = floors.get(normalize_name(feature["properties"].get("floor", "")))
            if key not in areas:
                created = await client.call(
                    "config/area_registry/create", name=name, floor_id=floor_id
                )
                areas[key] = created["area_id"]
            else:
                # Existing areas (e.g. created during onboarding) move to the given floor.
                await client.call(
                    "config/area_registry/update", area_id=areas[key], floor_id=floor_id
                )
            result = await client.call(
                "spatial/area/update_geometry", area_id=areas[key], polygon=feature["geometry"]
            )
            print(f"{name}: {result['area_m2']} m²")

        if site := collection.get("site"):
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
