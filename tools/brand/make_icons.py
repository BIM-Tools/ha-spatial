"""Keeps every brand icon variant from drifting by writing them all from one plan geometry."""

import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
BRAND = ROOT / "custom_components" / "spatial" / "brand"
TOOLS = pathlib.Path(__file__).resolve().parent

LIGHT = {"stroke": "#1d1d1d", "rest": "#cdeefd", "active": "#03a9f4", "aop": "1"}
DARK = {"stroke": "#eeeeee", "rest": "#1f3a48", "active": "#03a9f4", "aop": "1"}
TILE_LIGHT = {
    **LIGHT, "ground": "#f2eee5", "road": "#faf8f4", "building": "#e2dacb", "edge": "#e4ddcf",
}  # fmt: skip
TILE_DARK = {
    **DARK, "ground": "#1d1f23", "road": "#26292e", "building": "#2c2f36", "edge": "#2d3036",
}  # fmt: skip

WALLS = [
    (46, 70, 466, 70, (0, 2), (0, -3)),
    (226, 215, 466, 215, (0, -2), (0, 2)),
    (46, 270, 274, 270, (0, 3), (0, -1)),
    (294, 380, 466, 380, (0, -2), (0, 2)),
    (46, 442, 342, 442, (0, -1), (0, 3)),
    (70, 46, 70, 466, (2, 0), (-3, 0)),
    (250, 46, 250, 294, (-2, 0), (2, 0)),
    (318, 191, 318, 466, (3, 0), (-1, 0)),
    (442, 46, 442, 404, (-1, 0), (3, 0)),
]  # fmt: skip

MAP_GROUND = (
    '<rect x="-20" y="150" width="104" height="190" fill="{building}"/>'
    '<rect x="470" y="70" width="80" height="190" fill="{building}"/>'
    '<rect x="70" y="472" width="200" height="80" fill="{building}"/>'
    '<rect x="-6" y="424" width="524" height="30" fill="{road}"/>'
    '<rect x="424" y="-6" width="30" height="524" fill="{road}"/>'
)


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
    out += [
        f'<line x1="{x1 + a[0]}" y1="{y1 + a[1]}" x2="{x2 + b[0]}" y2="{y2 + b[1]}"/>'
        for x1, y1, x2, y2, a, b in WALLS
    ]
    out.append("</g>")
    return "\n".join(out)


def svg(body: str) -> str:
    head = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" '
        'role="img" aria-label="Spatial">'
    )
    return f"{head}\n<title>Spatial</title>\n{body}\n</svg>\n"


def tile(c: dict[str, str]) -> str:
    # Unique clip id per theme so two tiles inlined in one page cannot clash.
    clip = f"tile-{c['ground'][1:]}"
    return svg(
        f'<defs><clipPath id="{clip}"><rect width="512" height="512" rx="96"/></clipPath></defs>\n'
        f'<g clip-path="url(#{clip})">\n'
        f'<rect width="512" height="512" fill="{c["ground"]}"/>\n'
        f"{MAP_GROUND.format(**c)}\n"
        "</g>\n"
        f'<rect width="512" height="512" rx="96" fill="none" stroke="{c["edge"]}" '
        'stroke-width="4"/>\n'
        f'<g transform="translate(87 87) scale(0.66)">\n{plan(c)}\n</g>'
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
