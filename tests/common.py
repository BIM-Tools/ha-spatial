"""Test helpers for Spatial."""

from typing import Any

from custom_components.spatial.geometry import metres_per_degree

ORIGIN_LON = 5.0
ORIGIN_LAT = 52.0
_M_PER_DEG_LON, _M_PER_DEG_LAT = metres_per_degree(ORIGIN_LAT)


def lonlat(x: float, y: float) -> list[float]:
    """Return [lon, lat] for a point x metres east and y metres north of the origin."""
    return [ORIGIN_LON + x / _M_PER_DEG_LON, ORIGIN_LAT + y / _M_PER_DEG_LAT]


def rect(x0: float, y0: float, x1: float, y1: float) -> dict[str, Any]:
    """Return a GeoJSON Polygon for a rectangle given in metres from the origin."""
    ring = [lonlat(x0, y0), lonlat(x1, y0), lonlat(x1, y1), lonlat(x0, y1), lonlat(x0, y0)]
    return {"type": "Polygon", "coordinates": [ring]}
