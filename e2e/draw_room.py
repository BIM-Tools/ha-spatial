"""Smoke test: a fresh Home Assistant, the Spatial panel, one room drawn with the mouse."""

import json
import os
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright
from websockets.sync.client import connect

BASE_URL = os.environ.get("HA_URL", "http://homeassistant-e2e:8123")
CLIENT_ID = f"{BASE_URL}/"
# The account of a throwaway instance that lives only for this run.
USERNAME = "e2e"
PASSWORD = "e2e-throwaway-password"
TIMEOUT_S = 180


def post(path, body, token=None, form=False):
    data = urllib.parse.urlencode(body) if form else json.dumps(body)
    headers = {"Content-Type": "application/x-www-form-urlencoded" if form else "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(BASE_URL + path, data.encode(), headers)
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read())


def wait_for_home_assistant():
    deadline = time.monotonic() + TIMEOUT_S
    while True:
        try:
            urllib.request.urlopen(f"{BASE_URL}/api/onboarding", timeout=5)
            return
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(2)


def onboard():
    """Creates the admin user and finishes onboarding; returns an access token."""
    code = post(
        "/api/onboarding/users",
        {
            "client_id": CLIENT_ID,
            "name": "E2E",
            "username": USERNAME,
            "password": PASSWORD,
            "language": "en",
        },
    )["auth_code"]
    token = post(
        "/auth/token",
        {"grant_type": "authorization_code", "code": code, "client_id": CLIENT_ID},
        form=True,
    )["access_token"]
    post("/api/onboarding/core_config", {}, token)
    post("/api/onboarding/analytics", {}, token)
    post(
        "/api/onboarding/integration",
        {"client_id": CLIENT_ID, "redirect_uri": f"{BASE_URL}/?auth_callback=1"},
        token,
    )
    return token


def add_spatial(token):
    flow = post("/api/config/config_entries/flow", {"handler": "spatial"}, token)
    if flow["type"] == "form":
        flow = post(f"/api/config/config_entries/flow/{flow['flow_id']}", {}, token)
    assert flow["type"] == "create_entry", flow


class Websocket:
    def __init__(self, token):
        self._socket = connect(BASE_URL.replace("http", "ws", 1) + "/api/websocket")
        self._socket.recv()
        self._socket.send(json.dumps({"type": "auth", "access_token": token}))
        assert json.loads(self._socket.recv())["type"] == "auth_ok"
        self._id = 0

    def call(self, message_type, **fields):
        self._id += 1
        self._socket.send(json.dumps({"id": self._id, "type": message_type, **fields}))
        while (reply := json.loads(self._socket.recv()))["id"] != self._id:
            pass
        assert reply["success"], reply
        return reply["result"]


def kitchen_features(websocket):
    features = websocket.call("spatial/geojson")["features"]
    return [feature for feature in features if feature["properties"]["name"] == "Kitchen"]


def draw_kitchen(websocket):
    """Drags a box in the panel; returns the Kitchen features once the save has arrived."""
    with sync_playwright() as playwright:
        page = playwright.chromium.launch().new_page(viewport={"width": 1280, "height": 800})
        # Proves the panel draws without map tiles.
        page.route("**/api/map_tiles/**", lambda route: route.abort())
        page.goto(f"{BASE_URL}/spatial")
        page.get_by_role("textbox", name="Username").fill(USERNAME)
        page.get_by_role("textbox", name="Password").fill(PASSWORD)
        page.get_by_role("button", name="Log in").click()
        panel = page.locator("spatial-panel")
        panel.locator(".maplibregl-canvas").wait_for()
        panel.get_by_role("button", name="Ground", exact=True).click()
        panel.get_by_role("button", name="Draw", exact=True).click()
        box = panel.locator("#map").bounding_box()
        x = box["x"] + box["width"] / 2 - 100
        y = box["y"] + box["height"] / 2 - 100
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 200, y + 200, steps=10)
        page.mouse.up()
        deadline = time.monotonic() + 10
        while not (features := kitchen_features(websocket)) and time.monotonic() < deadline:
            time.sleep(0.5)
        return features


def main():
    wait_for_home_assistant()
    token = onboard()
    add_spatial(token)
    websocket = Websocket(token)
    floor = websocket.call("config/floor_registry/create", name="Ground", level=0)
    # Onboarding creates Kitchen.
    kitchen = next(
        area for area in websocket.call("config/area_registry/list") if area["name"] == "Kitchen"
    )
    websocket.call(
        "config/area_registry/update", area_id=kitchen["area_id"], floor_id=floor["floor_id"]
    )
    websocket.call("spatial/site/update", bearing_deg=20)

    features = draw_kitchen(websocket)
    assert len(features) == 1, features
    assert features[0]["properties"]["area_m2"] > 0, features[0]
    print(f"PASS: Kitchen drawn, {features[0]['properties']['area_m2']} m2")


if __name__ == "__main__":
    main()
