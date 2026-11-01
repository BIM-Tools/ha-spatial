"""State gallery: every panel and card state in both themes and sizes, to review the UI by eye.

Run with `docker compose run --rm gallery; docker compose rm -sf homeassistant-e2e`; the
PNGs, contact sheets and index.md land in ./gallery-out. Add a state by appending a
`State` to STATES with a setup function built from the helpers on `Shot`.

Coupling to watch: the panel offers no public way to reach its map or to tell whether a style
reload is pending, so these private fields of `spatial-panel` are read and break on a rename:
- `_map`, the MapLibre map: camera framing, screen positions and rendered features.
- `_styleKey`, `_pendingStyleKey` and `_wantedStyleKey()`: whether the style the panel asks for
  is on the map.
Everything else goes through the page: element names, roles, labels and visible text.
"""

from __future__ import annotations

import asyncio
import html
import json
import math
import os
import shutil
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from draw_room import (
    BASE_URL,
    PASSWORD,
    USERNAME,
    Websocket,
    add_spatial,
    onboard,
    wait_for_home_assistant,
)
from playwright.sync_api import Browser, Locator, Page, sync_playwright

TOOLS_DIR = Path(os.environ.get("TOOLS_DIR", "/tools"))
sys.path.insert(0, str(TOOLS_DIR))
from import_geojson import import_file, normalize_name  # noqa: E402

OUTPUT_DIR = Path(os.environ.get("GALLERY_OUT", "/out"))
EXAMPLE_HOUSE = TOOLS_DIR / "example_house.geojson"
THEMES = ("light", "dark")
VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}
COLUMNS = [(theme, width) for width in VIEWPORTS for theme in THEMES]
DASHBOARD = "spatial-gallery"
# Rows per contact sheet, so a sheet stays under about 4000 px on its long side.
ROWS_PER_SHEET = 6
SHEET_ROW_HEIGHT = 540
SETTLE_TIMEOUT_MS = 15000
# Per state id, theme and width: the file name, or why there is none.
Results = dict[tuple[str, str, str], str]
Warnings = dict[tuple[str, str, str], list[str]]


class Skip(Exception):
    """A state that cannot be shown with what this build of the panel offers."""


@dataclass
class State:
    id: str
    group: str
    caption: str
    setup: Callable[[Shot], None]
    phone: bool = True


class House:
    """The example house as loaded: floor and area ids by name, room rings by floor."""

    def __init__(self, websocket: Websocket, token: str) -> None:
        self.token = token
        with EXAMPLE_HOUSE.open(encoding="utf-8") as file:
            collection = json.load(file)
        self.floor_ids = {
            normalize_name(entry["name"]): entry["floor_id"]
            for entry in websocket.call("config/floor_registry/list")
        }
        self.area_names = {
            normalize_name(entry["name"]): entry["name"]
            for entry in websocket.call("config/area_registry/list")
        }
        self.rings: dict[str, dict[str, list[list[float]]]] = {}
        for feature in collection["features"]:
            if feature["geometry"] is None:
                continue
            floor = normalize_name(feature["properties"]["floor"])
            area = normalize_name(feature["properties"]["area"])
            self.rings.setdefault(floor, {})[area] = feature["geometry"]["coordinates"][0]

    def floor_id(self, floor: str) -> str:
        return self.floor_ids[normalize_name(floor)]

    def area_name(self, area: str) -> str:
        """The name Home Assistant shows, which onboarding may have spelled differently."""
        return self.area_names[normalize_name(area)]

    def ring(self, area: str) -> list[list[float]]:
        key = normalize_name(area)
        return next(rooms[key] for rooms in self.rings.values() if key in rooms)

    def floor_points(self, floor: str | None) -> list[list[float]]:
        floors = self.rings.values() if floor is None else [self.rings[normalize_name(floor)]]
        return [point for rooms in floors for ring in rooms.values() for point in ring]


class Shot:
    """One page in one theme and size, with the helpers state setups are built from."""

    def __init__(self, page: Page, house: House, theme: str, width: str) -> None:
        self.page = page
        self.house = house
        self.theme = theme
        self.width = width
        self.panel = page.locator("spatial-panel")
        # Things the screenshot shows that the gallery did not ask for; listed in the index.
        self.warnings: set[str] = set()
        # Undoes what a state changed in Home Assistant, so later states see the same house.
        self.cleanups: list[Callable[[], None]] = []

    @property
    def phone(self) -> bool:
        return self.width == "390"

    # Opening

    def open_panel(self) -> None:
        """A fresh panel with the map shown, as a first visit leaves it."""
        self.page.evaluate("localStorage.removeItem('spatial-show-map')")
        self.page.goto(f"{BASE_URL}/spatial")
        self.panel.locator(".maplibregl-canvas").wait_for()
        self.settle()

    def open_card(self, view: str) -> None:
        self.page.goto(f"{BASE_URL}/{DASHBOARD}/{view}")
        self.panel.locator(".maplibregl-canvas").wait_for()
        self.settle()

    # Controls

    def require(self, locator: Locator, what: str) -> Locator:
        if not locator.count():
            raise Skip(f"no {what} on screen")
        return locator.first

    def select_floor(self, floor: str) -> None:
        selector = self.panel.locator("spatial-floor-selector")
        self.require(
            selector.get_by_role("button", name=floor, exact=True), f"floor {floor}"
        ).click()
        self.settle()

    def select_tool(self, tool: str) -> None:
        toolbar = self.panel.locator("spatial-editor-toolbar")
        self.require(toolbar.get_by_role("button", name=tool, exact=True), f"tool {tool}").click()
        self.settle()

    def pill(self, area: str) -> Locator:
        strip = self.panel.locator("spatial-area-strip")
        name = area if area in ("Building", "New area") else self.house.area_name(area)
        return self.require(strip.get_by_role("button", name=name, exact=True), f"pill {name}")

    def activate_pill(self, area: str) -> None:
        self.pill(area).click()
        self.settle()

    def hover_pill(self, area: str) -> None:
        self.pill(area).hover()
        self.settle()

    def start_rename(self, area: str) -> None:
        """Clicking the active pill again turns it into a name field; `release` cancels it."""
        self.activate_pill(area)
        self.activate_pill(area)
        self.panel.get_by_role("textbox", name="Area name").wait_for()

    def new_area(self) -> None:
        """Creates an area with New area, which opens its name field; `release` deletes it again."""
        websocket = Websocket(self.house.token)
        before = {area["area_id"] for area in websocket.call("config/area_registry/list")}

        def delete_new_areas() -> None:
            for area in websocket.call("config/area_registry/list"):
                if area["area_id"] not in before:
                    websocket.call("config/area_registry/delete", area_id=area["area_id"])

        self.cleanups.append(delete_new_areas)
        self.pill("New area").click()
        self.panel.get_by_role("textbox", name="Area name").wait_for()
        self.settle()

    def toggle_map(self) -> None:
        stack = self.panel.locator("spatial-map-stack")
        self.require(stack.get_by_role("button", name="Show map"), "map toggle").click()
        self.settle()

    def open_help(self) -> None:
        header = self.panel.locator("spatial-panel-header")
        help_button = self.require(header.get_by_role("button", name="Help", exact=True), "Help")
        # Its own icon takes the pointer, which Playwright's hit test counts as covering it.
        help_button.click(force=True)
        header.get_by_role("dialog").wait_for()
        self.settle()

    def wait_for_toast(self, message: str) -> None:
        """Home Assistant's toast, shown outside the panel; it fades after a few seconds."""
        # The toast also repeats its message in a live region for screen readers.
        self.page.get_by_text(message, exact=True).first.wait_for()
        # Lets the toast finish sliding in.
        self.page.wait_for_timeout(400)

    # Camera

    def frame(self, floor: str | None, zoom_delta: float = 0.0, pitch: float = 0.0) -> None:
        """Fits the floor's rooms (all rooms for None) in view, keeping the site's bearing."""
        points = self.house.floor_points(floor)
        lons = [point[0] for point in points]
        lats = [point[1] for point in points]
        padding = (
            {"top": 90, "bottom": 150, "left": 24, "right": 24}
            if self.phone
            else {"top": 150, "bottom": 150, "left": 120, "right": 120}
        )
        self.panel.evaluate(
            """(panel, {bounds, padding, zoomDelta, pitch}) => {
                const map = panel._map;
                const bearing = map.getBearing();
                const camera = map.cameraForBounds(bounds, { padding, bearing });
                const zoom = camera.zoom + zoomDelta;
                map.jumpTo({ center: camera.center, zoom, bearing, pitch });
            }""",
            {
                "bounds": [[min(lons), min(lats)], [max(lons), max(lats)]],
                "padding": padding,
                "zoomDelta": zoom_delta,
                "pitch": pitch,
            },
        )
        self.settle()

    def screen_point(self, lon: float, lat: float) -> tuple[float, float]:
        """Page pixels of a map position."""
        x, y = self.panel.evaluate(
            """(panel, at) => {
                const map = panel._map;
                const point = map.project(at);
                const box = map.getContainer().getBoundingClientRect();
                return [box.left + point.x, box.top + point.y];
            }""",
            [lon, lat],
        )
        return x, y

    def room_centre(self, area: str) -> tuple[float, float]:
        ring = self.house.ring(area)[:-1]
        return self.screen_point(
            sum(point[0] for point in ring) / len(ring), sum(point[1] for point in ring) / len(ring)
        )

    def room_corners(self, area: str) -> list[tuple[float, float]]:
        return [self.screen_point(*point) for point in self.house.ring(area)[:-1]]

    def floor_screen_box(self, floor: str) -> tuple[float, float, float, float]:
        corners = [self.screen_point(*point) for point in self.house.floor_points(floor)]
        xs = [x for x, _ in corners]
        ys = [y for _, y in corners]
        return min(xs), min(ys), max(xs), max(ys)

    def building_near(self, x: float, y: float) -> tuple[float, float] | None:
        """Page pixels inside the map tiles' building nearest to a page point, searched outwards.

        The point lies well inside the building, as a point on its drawn edge may fall outside
        the polygon the panel tests.
        """
        found = self.panel.evaluate(
            """(panel, [x, y]) => {
                const map = panel._map;
                const box = map.getContainer().getBoundingClientRect();
                const layers = map.getStyle().layers
                    .filter((layer) => layer["source-layer"] === "buildings")
                    .map((layer) => layer.id);
                if (!layers.length) return null;
                const margin = 12;
                const isBuilding = (px, py) =>
                    map.queryRenderedFeatures([px, py], { layers }).length > 0;
                const wellInside = (px, py) =>
                    [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]].every(
                        ([dx, dy]) => isBuilding(px + dx, py + dy)
                    );
                for (let radius = 0; radius < 400; radius += 10) {
                    const steps = Math.max(1, Math.round(radius / 5));
                    for (let step = 0; step < steps; step++) {
                        const angle = (2 * Math.PI * step) / steps;
                        const px = x - box.left + radius * Math.cos(angle);
                        const py = y - box.top + radius * Math.sin(angle);
                        if (px < margin || py < margin) continue;
                        if (px > box.width - margin || py > box.height - margin) continue;
                        if (wellInside(px, py)) return [box.left + px, box.top + py];
                    }
                }
                return null;
            }""",
            [x, y],
        )
        return None if found is None else (found[0], found[1])

    # Pointer

    def hover(self, x: float, y: float) -> None:
        self.page.mouse.move(x, y, steps=4)
        self.settle()

    def click(self, x: float, y: float) -> None:
        self.page.mouse.click(x, y)
        self.settle()

    def start_drag(self, start: tuple[float, float], end: tuple[float, float]) -> None:
        """Presses at start and moves to end without releasing; `release` cancels it unsaved."""
        self.page.mouse.move(*start)
        self.page.mouse.down()
        self.page.mouse.move(*end, steps=10)
        self.settle()

    def release(self) -> None:
        # Escape cancels the box first: releasing saves nothing, so later states see the same house.
        self.page.keyboard.press("Escape")
        self.page.mouse.up()
        for cleanup in self.cleanups:
            cleanup()

    # Waiting

    def settle(self) -> None:
        """Waits until the map stops moving and has rendered, and fonts and Lit updates are done."""
        # The theme can reach the panel after the map started, which then swaps its style. So wait
        # until the style on the map is the one the panel asks for, with the rooms, and give the
        # panel a while to follow the browser's colour scheme, as Home Assistant's default theme
        # does. Home Assistant names its dark map style with a "-dark" suffix; the plain style
        # without the map has no name.
        theme_followed, idle = self.panel.evaluate(
            """async (panel, timeout) => {
                await document.fonts.ready;
                const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
                const dark = matchMedia("(prefers-color-scheme: dark)").matches;
                const themeFollowed = () => {
                    const name = panel._map.getStyle()?.name;
                    return name === undefined || name.endsWith("-dark") === dark;
                };
                const styleReady = () =>
                    panel._map?.getLayer("areas-2d") &&
                    !panel._pendingStyleKey &&
                    panel._styleKey === panel._wantedStyleKey();
                const themeDeadline = Date.now() + timeout / 3;
                const deadline = Date.now() + timeout;
                while (!styleReady() || (!themeFollowed() && Date.now() < themeDeadline)) {
                    if (Date.now() > deadline) throw new Error("the map style never settled");
                    await pause();
                }
                const map = panel._map;
                const idle = await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(false), timeout);
                    const done = () => { clearTimeout(timer); resolve(true); };
                    if (map.loaded() && !map.isMoving()) done();
                    else map.once("idle", done);
                });
                await panel.updateComplete;
                const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
                await frame();
                await frame();
                return [themeFollowed(), idle];
            }""",
            SETTLE_TIMEOUT_MS,
        )
        # Shown as it is, since that is what a user would see, but flagged in the index.
        if not theme_followed:
            self.warnings.add(f"the map style is not the {self.theme} one")
        if not idle:
            self.warnings.add(f"the map was still loading after {SETTLE_TIMEOUT_MS // 1000} s")
        # Markers and the toolbar re-render on the frame after the map's idle event.
        self.page.wait_for_timeout(250)


# State setups. Each starts from a fresh page; keep them small and build them from the helpers.


def floor_plan(shot: Shot) -> None:
    shot.open_panel()
    shot.select_floor("Ground floor")
    shot.frame("Ground floor")


def all_floors(shot: Shot) -> None:
    shot.open_panel()
    shot.frame(None, zoom_delta=-0.3, pitch=50)


def map_off(shot: Shot) -> None:
    floor_plan(shot)
    shot.toggle_map()


def help_open(shot: Shot) -> None:
    floor_plan(shot)
    shot.open_help()


def floor_view(floor: str) -> Callable[[Shot], None]:
    def setup(shot: Shot) -> None:
        shot.open_panel()
        shot.select_floor(floor)
        # No floor has no rooms in the example house; it is framed on the whole house.
        shot.frame(None if floor == "No floor" else floor)

    return setup


def align_active(shot: Shot) -> None:
    floor_plan(shot)
    shot.select_tool("Align")


def align_wall_hover(shot: Shot) -> None:
    align_active(shot)
    # The example house stands where the map tiles have no building, so the pointer goes to
    # the nearest building the tiles do draw.
    building = shot.building_near(*shot.room_centre("Living room"))
    if building is None:
        raise Skip("no OSM building near the house in the map tiles")
    shot.hover(*building)
    # The wall's GeoJSON is parsed in a worker, so it can draw a few frames after the map idled.
    highlighted = shot.panel.evaluate(
        """async (panel) => {
            for (let attempt = 0; attempt < 30; attempt++) {
                if (panel._map.queryRenderedFeatures({ layers: ["spatial-wall"] }).length) {
                    return true;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return false;
        }"""
    )
    if not highlighted:
        raise Skip("the wall under the pointer was not highlighted")
    shot.settle()


def draw_active(shot: Shot) -> None:
    floor_plan(shot)
    shot.select_tool("Draw")


def draw_box_mid_drag(shot: Shot) -> None:
    draw_active(shot)
    shot.activate_pill("Building")
    left, top, right, bottom = shot.floor_screen_box("Ground floor")
    shot.start_drag((left, top), ((left + right) / 2, (top + bottom) / 2))


def draw_box_apart(shot: Shot) -> None:
    draw_active(shot)
    shot.activate_pill("Kitchen")
    left, top, right, bottom = shot.floor_screen_box("Ground floor")
    width = right - left
    shot.start_drag((left + width * 0.1, bottom + 20), (left + width * 0.4, bottom + 80))


def adjust_room_active(shot: Shot) -> None:
    floor_plan(shot)
    shot.click(*shot.room_centre("Living room"))


def labels_fit(shot: Shot) -> None:
    floor_plan(shot)


def labels_zoomed_out(shot: Shot) -> None:
    floor_plan(shot)
    shot.frame("Ground floor", zoom_delta=-1)


def labels_far(shot: Shot) -> None:
    floor_plan(shot)
    shot.frame("Ground floor", zoom_delta=-2.2)


def labels_pointed(shot: Shot) -> None:
    labels_zoomed_out(shot)
    shot.hover(*shot.room_centre("Toilet"))


def strip_pills(shot: Shot) -> None:
    draw_active(shot)
    shot.activate_pill("Kitchen")


def strip_active_unshaped(shot: Shot) -> None:
    floor_plan(shot)
    shot.activate_pill("Utility")


def strip_rename(shot: Shot) -> None:
    floor_plan(shot)
    shot.start_rename("Kitchen")


def strip_new_area(shot: Shot) -> None:
    floor_plan(shot)
    shot.new_area()


def hover_pill(shot: Shot) -> None:
    floor_plan(shot)
    shot.hover_pill("Kitchen")


def hover_room(shot: Shot) -> None:
    floor_plan(shot)
    shot.hover(*shot.room_centre("Kitchen"))


def toast_apart_box(shot: Shot) -> None:
    draw_box_apart(shot)
    shot.page.mouse.up()
    shot.wait_for_toast("A room is one shape: draw against it")


def card(view: str) -> Callable[[Shot], None]:
    def setup(shot: Shot) -> None:
        shot.open_card(view)

    return setup


STATES = [
    State(
        "floor-plan",
        "chrome",
        "Header, floor selector and tools on the ground floor, Adjust active",
        floor_plan,
    ),
    State(
        "all-floors",
        "chrome",
        "All floors stacked in 3D, tools disabled, the strip's hint to choose a floor",
        all_floors,
    ),
    State("map-off", "chrome", "Ground floor with the map hidden", map_off),
    State("help-open", "chrome", "The help sheet open: symbols and keys", help_open),
    State(
        "align-active",
        "tools",
        "Align active: the guide line says what to click and the map is forced on",
        align_active,
    ),
    State(
        "align-wall-hover",
        "tools",
        "Align with the wall under the pointer highlighted, on the nearest OSM building",
        align_wall_hover,
        phone=False,
    ),
    State("draw-active", "tools", "Draw active: the area strip with Building first", draw_active),
    State(
        "adjust-room-active",
        "tools",
        "Adjust with the living room active: corner handles and side lengths",
        adjust_room_active,
    ),
    State(
        "strip-pills",
        "strip",
        "Every pill state: Kitchen active with a shape, Building and Utility dashed without one",
        strip_pills,
    ),
    State(
        "strip-active-unshaped",
        "strip",
        "Utility active without a shape: Draw selected, the guide line says Draw Utility 5 of 5",
        strip_active_unshaped,
    ),
    State(
        "strip-rename",
        "strip",
        "Renaming Kitchen: the pill is a name field with a check button",
        strip_rename,
    ),
    State(
        "strip-new-area",
        "strip",
        "New area just created: Room 1 active, its name field open",
        strip_new_area,
    ),
    State(
        "hover-pill",
        "strip",
        "Pointing at the Kitchen pill outlines the kitchen",
        hover_pill,
        phone=False,
    ),
    State(
        "hover-room",
        "strip",
        "Pointing at the kitchen outlines its pill",
        hover_room,
        phone=False,
    ),
    State(
        "draw-box-mid-drag", "drawing", "Drawing the building outline, mid-drag", draw_box_mid_drag
    ),
    State(
        "draw-box-apart",
        "drawing",
        "A box apart from the active kitchen, in the warning look",
        draw_box_apart,
    ),
    State(
        "toast-apart-box",
        "drawing",
        "Releasing the box apart: Home Assistant's toast says a room is one shape",
        toast_apart_box,
    ),
    State(
        "labels-fit",
        "labels",
        "Labels with the ground floor in view: icon, name and m2 by room size",
        labels_fit,
    ),
    State(
        "labels-zoomed-out",
        "labels",
        "Labels one zoom step out: small rooms drop the m2 or the name",
        labels_zoomed_out,
    ),
    State(
        "labels-far", "labels", "Labels far out: icons only, tiny rooms without a label", labels_far
    ),
    State(
        "labels-pointed",
        "labels",
        "Pointing at the icon-only toilet shows its name",
        labels_pointed,
        phone=False,
    ),
    State(
        "floor-first",
        "floors",
        "First floor, with Study dashed in the strip",
        floor_view("First floor"),
    ),
    State(
        "floor-attic",
        "floors",
        "Attic, one room under the roof and Storage dashed in the strip",
        floor_view("Attic"),
    ),
    State(
        "floor-none",
        "floors",
        "No floor: Garden and Driveway in the strip, nothing drawn",
        floor_view("No floor"),
    ),
    State("card-floor", "card", "Dashboard card fixed to the ground floor", card("floor")),
    State("card-all", "card", "Dashboard card with all floors", card("all")),
]


def load_house(token: str) -> House:
    add_spatial(token)
    asyncio.run(import_file(str(EXAMPLE_HOUSE), BASE_URL, token))
    websocket = Websocket(token)
    house = House(websocket, token)
    websocket.call(
        "lovelace/dashboards/create",
        url_path=DASHBOARD,
        title="Spatial gallery",
        mode="storage",
        show_in_sidebar=True,
        require_admin=False,
    )
    ground = house.floor_id("Ground floor")
    websocket.call(
        "lovelace/config/save",
        url_path=DASHBOARD,
        config={
            "views": [
                {
                    "path": "floor",
                    "title": "Floor",
                    "type": "panel",
                    "cards": [{"type": "custom:spatial-map-card", "floor": ground}],
                },
                {
                    "path": "all",
                    "title": "All",
                    "type": "panel",
                    "cards": [{"type": "custom:spatial-map-card", "floor": "all"}],
                },
            ]
        },
    )
    return house


def log_in(browser: Browser, theme: str, width: str) -> Page:
    viewport_width, viewport_height = VIEWPORTS[width]
    context = browser.new_context(
        viewport={"width": viewport_width, "height": viewport_height},
        color_scheme=theme,
        reduced_motion="reduce",
        locale="en-US",
        timezone_id="UTC",
    )
    page = context.new_page()
    page.goto(f"{BASE_URL}/spatial")
    page.get_by_role("textbox", name="Username").fill(USERNAME)
    page.get_by_role("textbox", name="Password").fill(PASSWORD)
    page.get_by_role("button", name="Log in").click()
    page.locator("spatial-panel .maplibregl-canvas").wait_for()
    return page


def file_name(state: State, theme: str, width: str) -> str:
    return f"{state.id}-{theme}-{width}.png"


def render_states(browser: Browser, house: House) -> tuple[Results, Warnings]:
    """Shoots every state; returns per state, theme and width the file name or why it is missing."""
    results: Results = {}
    warnings: Warnings = {}
    for theme, width in COLUMNS:
        page = log_in(browser, theme, width)
        for state in STATES:
            key = (state.id, theme, width)
            if width == "390" and not state.phone:
                results[key] = "Not on phone"
                continue
            shot = Shot(page, house, theme, width)
            try:
                state.setup(shot)
                page.screenshot(
                    path=OUTPUT_DIR / file_name(state, theme, width), animations="disabled"
                )
                results[key] = file_name(state, theme, width)
                if shot.warnings:
                    warnings[key] = sorted(shot.warnings)
                    print(f"WARN {state.id} {theme} {width}: {'; '.join(warnings[key])}")
            except Skip as reason:
                results[key] = f"Skipped: {reason}"
                print(f"SKIP {state.id} {theme} {width}: {reason}")
            finally:
                shot.release()
        page.context.close()
    return results, warnings


SHEET_STYLE = f"""
body {{ margin: 0; padding: 24px; width: max-content; }}
body {{ background: #fff; color: #111; font: 18px/1.3 sans-serif; }}
h1 {{ font-size: 30px; margin: 0 0 16px; }}
.grid {{ display: grid; grid-template-columns: repeat(4, auto); gap: 8px 16px; }}
.label {{ font-weight: bold; font-size: 20px; }}
.caption {{ grid-column: 1 / -1; font-size: 22px; margin-top: 14px; }}
.caption code {{ font-size: 18px; color: #555; }}
img, .empty {{ height: {SHEET_ROW_HEIGHT}px; border: 1px solid #bbb; display: block; }}
.empty {{ display: flex; align-items: center; justify-content: center; }}
.empty {{ color: #777; background: #f3f3f3; }}
.warning {{ font-size: 18px; color: #b00020; }}
"""


def column_label(theme: str, width: str) -> str:
    viewport_width, viewport_height = VIEWPORTS[width]
    layout = "desktop" if width == "1440" else "phone"
    return f"{theme.capitalize()} {layout} {viewport_width}x{viewport_height}"


def cell(result: str, width: str) -> str:
    viewport_width, viewport_height = VIEWPORTS[width]
    if result.endswith(".png"):
        return f'<img src="{(OUTPUT_DIR / result).as_uri()}">'
    empty_width = round(SHEET_ROW_HEIGHT * viewport_width / viewport_height)
    return f'<div class="empty" style="width:{empty_width}px">{html.escape(result)}</div>'


def sheet_row(state: State, results: Results, warnings: Warnings) -> str:
    """The caption and four cells; a state with no screenshot at all gets one line, not a row."""
    row = [results[(state.id, theme, width)] for theme, width in COLUMNS]
    caption = f"{html.escape(state.caption)} <code>{state.id}</code>"
    if not any(result.endswith(".png") for result in row):
        reasons = "; ".join(dict.fromkeys(row))
        return f'<div class="caption">{caption}: <em>{html.escape(reasons)}</em></div>'
    notes = "".join(
        f'<div class="warning">{column_label(theme, width)}: {html.escape(warning)}</div>'
        for theme, width in COLUMNS
        for warning in warnings.get((state.id, theme, width), [])
    )
    cells = "".join(cell(result, width) for result, (_, width) in zip(row, COLUMNS, strict=True))
    return f'<div class="caption">{caption}{notes}</div>{cells}'


def render_sheets(browser: Browser, results: Results, warnings: Warnings) -> list[tuple[str, str]]:
    """One or more labelled contact sheets per group; returns their file names and titles."""
    sheets = []
    page = browser.new_page(viewport={"width": 800, "height": 600})
    groups = list(dict.fromkeys(state.group for state in STATES))
    with tempfile.TemporaryDirectory() as scratch:
        for group in groups:
            states = [state for state in STATES if state.group == group]
            parts = math.ceil(len(states) / ROWS_PER_SHEET)
            for part in range(parts):
                rows = states[part * ROWS_PER_SHEET : (part + 1) * ROWS_PER_SHEET]
                suffix = f"-{part + 1}" if parts > 1 else ""
                title = f"{group.capitalize()}{f' ({part + 1} of {parts})' if parts > 1 else ''}"
                labels = "".join(
                    f'<div class="label">{column_label(theme, width)}</div>'
                    for theme, width in COLUMNS
                )
                body = "".join(sheet_row(state, results, warnings) for state in rows)
                heading = f"<h1>State gallery: {html.escape(title)}</h1>"
                sheet_html = Path(scratch) / f"sheet-{group}{suffix}.html"
                sheet_html.write_text(
                    f"<!doctype html><meta charset='utf-8'><style>{SHEET_STYLE}</style>"
                    f"{heading}<div class='grid'>{labels}{body}</div>",
                    encoding="utf-8",
                )
                page.goto(sheet_html.as_uri())
                page.wait_for_load_state("load")
                name = f"sheet-{group}{suffix}.png"
                page.screenshot(path=OUTPUT_DIR / name, full_page=True)
                sheets.append((name, title))
    page.close()
    return sheets


def write_index(results: Results, warnings: Warnings, sheets: list[tuple[str, str]]) -> None:
    lines = ["# State gallery", "", "## Contact sheets", ""]
    lines += [f"- `{name}`: {title}" for name, title in sheets]
    for group in dict.fromkeys(state.group for state in STATES):
        lines += ["", f"## {group.capitalize()}", ""]
        for state in (state for state in STATES if state.group == group):
            lines.append(f"- `{state.id}`: {state.caption}")
            for theme, width in COLUMNS:
                result = results[(state.id, theme, width)]
                shown = f"`{result}`" if result.endswith(".png") else f"{theme} {width}: {result}"
                lines.append(f"  - {shown}")
                lines += [
                    f"    - warning: {warning}"
                    for warning in warnings.get((state.id, theme, width), [])
                ]
    (OUTPUT_DIR / "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    for old in OUTPUT_DIR.glob("*"):
        if old.is_file():
            old.unlink()
        else:
            shutil.rmtree(old)
    wait_for_home_assistant()
    house = load_house(onboard())
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        results, warnings = render_states(browser, house)
        sheets = render_sheets(browser, results, warnings)
        browser.close()
    write_index(results, warnings, sheets)
    shots = sum(result.endswith(".png") for result in results.values())
    skipped = sorted(
        {state for (state, _, _), result in results.items() if result.startswith("Skipped")}
    )
    print(f"DONE: {shots} screenshots and {len(sheets)} contact sheets in {OUTPUT_DIR}")
    print(f"Skipped states: {', '.join(skipped) or 'none'}")


if __name__ == "__main__":
    main()
