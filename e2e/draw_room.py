"""Smoke test: a fresh Home Assistant, the Spatial panel, rooms drawn and resized with the mouse."""

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
            "name": "Alex",
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


def features_named(websocket, name):
    features = websocket.call("spatial/geojson")["features"]
    return [feature for feature in features if feature["properties"]["name"] == name]


def wait_for_features(websocket, name):
    """The area's features once its save has arrived, or none after 10 s."""
    deadline = time.monotonic() + 10
    while not (features := features_named(websocket, name)) and time.monotonic() < deadline:
        time.sleep(0.5)
    return features


def drag(page, start, end):
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(*end, steps=10)
    page.mouse.up()


def corners_on_screen(panel, ring):
    """Page pixels of the ring's corners, without the closing one."""
    return panel.evaluate(
        """(panel, ring) => {
            const map = panel._map;
            const box = map.getContainer().getBoundingClientRect();
            return ring.map((at) => {
                const point = map.project(at);
                return [box.left + point.x, box.top + point.y];
            });
        }""",
        ring[:-1],
    )


def top_right_on_screen(panel, ring):
    """Page pixels of the ring's corner furthest right and up on the screen."""
    return max(corners_on_screen(panel, ring), key=lambda corner: corner[0] - corner[1])


def wait_for_larger(websocket, name, area_m2):
    """The area's feature once its area_m2 exceeds the given one, or as it is after 10 s."""
    deadline = time.monotonic() + 10
    while True:
        feature = features_named(websocket, name)[0]
        if feature["properties"]["area_m2"] > area_m2 or time.monotonic() > deadline:
            return feature
        time.sleep(0.5)


def resize_kitchen(page, panel, websocket, kitchen):
    """In Select drags Kitchen's left edge 40 px left, then its top left corner 30 px out."""
    panel.get_by_role("button", name="Select", exact=True).click()
    panel.get_by_role("button", name="Kitchen", exact=True).click()
    left_corners = sorted(corners_on_screen(panel, kitchen["geometry"]["coordinates"][0]))[:2]
    x = (left_corners[0][0] + left_corners[1][0]) / 2
    y = (left_corners[0][1] + left_corners[1][1]) / 2
    drag(page, (x, y), (x - 40, y))
    stretched = wait_for_larger(websocket, "Kitchen", kitchen["properties"]["area_m2"])
    # The store can answer before the panel has its save reply, and a press while it saves does
    # nothing; the side chips show again once the save has settled.
    panel.locator("button.side-chip").first.wait_for(state="visible")
    # The top left corner faces free space; Bedroom lies to the right.
    corner_x, corner_y = min(
        corners_on_screen(panel, stretched["geometry"]["coordinates"][0]),
        key=lambda corner: corner[0] + corner[1],
    )
    drag(page, (corner_x, corner_y), (corner_x - 30, corner_y - 30))
    cornered = wait_for_larger(websocket, "Kitchen", stretched["properties"]["area_m2"])
    return stretched, cornered


def draw_rooms(websocket, kitchen_id):
    """Draws Kitchen, then Bedroom from 5 px right of Kitchen's top right corner, then resizes
    Kitchen; returns Kitchen as drawn, Bedroom, Kitchen's neighbours then, and Kitchen after
    each resize."""
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
        # Without an outline the Building pill comes first.
        panel.get_by_role("button", name="Kitchen", exact=True).click()
        box = panel.locator("#map").bounding_box()
        x = box["x"] + box["width"] / 2 - 75
        y = box["y"] + box["height"] / 2 - 75
        drag(page, (x, y), (x + 150, y + 150))
        kitchen = wait_for_features(websocket, "Kitchen")
        assert len(kitchen) == 1, kitchen
        # After a first shape the editor moves on, here to the building's pill; then pick Bedroom.
        panel.get_by_role("button", name="Kitchen", exact=True, pressed=False).wait_for()
        panel.get_by_role("button", name="Bedroom", exact=True).click()
        corner_x, corner_y = top_right_on_screen(panel, kitchen[0]["geometry"]["coordinates"][0])
        drag(page, (corner_x + 5, corner_y), (corner_x + 155, corner_y + 150))
        bedroom = wait_for_features(websocket, "Bedroom")
        # Before the resizes, as the dragged corner leaves Bedroom's wall.
        adjacent = websocket.call("spatial/area/adjacent", area_id=kitchen_id)["area_ids"]
        return kitchen, bedroom, adjacent, resize_kitchen(page, panel, websocket, kitchen[0])


def main():
    wait_for_home_assistant()
    token = onboard()
    add_spatial(token)
    websocket = Websocket(token)
    # A home at sea, so the empty plan opens on it and not on the globe with the address search.
    websocket.call("config/core/update", latitude=1.0, longitude=1.0)
    floor = websocket.call("config/floor_registry/create", name="Ground", level=0)
    # Onboarding creates Kitchen and Bedroom.
    areas = {area["name"]: area for area in websocket.call("config/area_registry/list")}
    for name in ("Kitchen", "Bedroom"):
        websocket.call(
            "config/area_registry/update",
            area_id=areas[name]["area_id"],
            floor_id=floor["floor_id"],
        )
    websocket.call("spatial/site/update", bearing_deg=20)

    kitchen, bedroom, adjacent, (stretched, cornered) = draw_rooms(
        websocket, areas["Kitchen"]["area_id"]
    )
    assert kitchen[0]["properties"]["area_m2"] > 0, kitchen[0]
    print(f"PASS: Kitchen drawn, {kitchen[0]['properties']['area_m2']} m2")
    assert len(bedroom) == 1, bedroom
    assert areas["Bedroom"]["area_id"] in adjacent, adjacent
    print("PASS: Bedroom snapped to Kitchen")
    drawn_m2 = kitchen[0]["properties"]["area_m2"]
    assert stretched["properties"]["area_m2"] > drawn_m2, stretched
    print(f"PASS: Kitchen edge dragged, {stretched['properties']['area_m2']} m2")
    assert cornered["properties"]["area_m2"] > stretched["properties"]["area_m2"], cornered
    print(f"PASS: Kitchen corner dragged, {cornered['properties']['area_m2']} m2")


if __name__ == "__main__":
    main()
