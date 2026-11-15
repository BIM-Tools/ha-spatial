"""Writes all brand icon variants from one plan geometry so they never drift."""

import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
BRAND = ROOT / "custom_components" / "spatial" / "brand"
TOOLS = pathlib.Path(__file__).resolve().parent

LIGHT = {"stroke": "#1d1d1d", "rest": "#cdeefd", "active": "#03a9f4", "aop": "1"}
DARK = {"stroke": "#eeeeee", "rest": "#1f3a48", "active": "#03a9f4", "aop": "1"}
MONO = {"stroke": "currentColor", "rest": "none", "active": "currentColor", "aop": "0.35"}
TILE_LIGHT = {**LIGHT, "ground": "#f3efe6", "road": "#ffffff", "edge": "#e4ddcf"}
TILE_DARK = {**DARK, "ground": "#1e2024", "road": "#34383e", "edge": "#2d3036"}

LINES = [
    (46, 72, 466, 67), (226, 213, 466, 217), (46, 273, 274, 269),
    (294, 378, 466, 382), (46, 441, 342, 445), (72, 46, 67, 466),
    (248, 46, 252, 294), (321, 191, 317, 466), (441, 46, 445, 404),
]  # fmt: skip


def plan(c: dict[str, str]) -> str:
    rects = [(70, 70, 180, 200), (250, 70, 192, 145), (318, 215, 124, 165)]
    out = [
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{c["rest"]}"/>'
        for x, y, w, h in rects
    ]
    out.append(
        f'<polygon points="250,215 318,215 318,442 70,442 70,270 250,270" '
        f'fill="{c["active"]}" fill-opacity="{c["aop"]}"/>'
    )
    out.append(f'<g stroke="{c["stroke"]}" stroke-width="20" stroke-linecap="round" fill="none">')
    out += [f'<line x1="{a}" y1="{b}" x2="{x}" y2="{y}"/>' for a, b, x, y in LINES]
    out.append("</g>")
    return "\n".join(out)


def svg(body: str) -> str:
    head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">'
    return f"{head}\n{body}\n</svg>\n"


def tile(c: dict[str, str]) -> str:
    return svg(
        f'<rect width="512" height="512" rx="96" fill="{c["ground"]}" '
        f'stroke="{c["edge"]}" stroke-width="4"/>\n'
        f'<rect x="34" y="452" width="444" height="34" fill="{c["road"]}"/>\n'
        f'<g transform="translate(61 50) scale(0.76)">\n{plan(c)}\n</g>'
    )


def png(source: str, path: pathlib.Path, size: int) -> None:
    subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(path)],
        input=source.encode(),
        check=True,
    )


for prefix, colours in (("", LIGHT), ("dark_", DARK)):
    for suffix, size in (("", 256), ("@2x", 512)):
        png(svg(plan(colours)), BRAND / f"{prefix}icon{suffix}.png", size)
for prefix, colours in (("", TILE_LIGHT), ("dark_", TILE_DARK)):
    (TOOLS / f"{prefix}tile.svg").write_text(tile(colours))
    png(tile(colours), TOOLS / f"{prefix}tile.png", 512)
(TOOLS / "icon_mono.svg").write_text(svg(plan(MONO)))
