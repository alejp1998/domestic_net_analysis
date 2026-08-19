#!/usr/bin/env python3
"""
build_maps.py — generates webgame/data/maps.json for the interactive floor plan.

Maps:
  1. "Casa"        — the real scanned home, rebuilt as a perfectly tiled
                     rectilinear plan (rooms share edges, no gaps).
  2. "Estudio"     — designed studio flat (design A).
  3. "Piso 2 hab"  — designed two-bedroom flat (design B).
  4. "Loft abierto" — designed open-plan loft (design C).

Every map carries: rooms (name, zone, rect, centroid, measured dBm), a zone
wall matrix derived from shared edges, and dbm_max.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def snap(v, g=0.05):
    return round(v / g) * g


def rect_room(name, zone, x0, y0, x1, y1, dbm):
    """Room as a rect [x0,y0,x1,y1] (x1> x0, y1 > y0) — y grows DOWNWARD."""
    return {
        "name": name,
        "zone": zone,
        "x0": x0, "y0": y0, "x1": x1, "y1": y1,
        "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2,
        "dBm": dbm,
    }


def tile_real_house(rooms_in):
    """Rebuild the real rooms as a gap-free tiling.

    Strategy: snap every room edge to a common grid, then assign every grid
    cell (between consecutive grid lines) to the room whose original polygon
    contains its centre (gaps fall back to the nearest room centre). The
    resulting room polygons are outlines of their cells — adjacent rooms share
    exact edges by construction.
    """
    def contains(poly, x, y):
        inside = False
        j = len(poly) - 1
        for i in range(len(poly)):
            xi, yi = poly[i]
            xj, yj = poly[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        return inside

    rooms = []
    for r in rooms_in:
        xs = [p[0] for p in r["poly"]]
        ys = [p[1] for p in r["poly"]]
        rooms.append({
            "name": r["name"], "zone": r["zone"],
            "x0": snap(min(xs)), "y0": snap(min(ys)),
            "x1": snap(max(xs)), "y1": snap(max(ys)),
            "poly": r["poly"], "dBm": r["dBm"],
            "cx": (min(xs) + max(xs)) / 2, "cy": (min(ys) + max(ys)) / 2,
        })

    xs = sorted({v for r in rooms for v in (r["x0"], r["x1"])})
    ys = sorted({v for r in rooms for v in (r["y0"], r["y1"])})
    gx = [(xs[i], xs[i + 1]) for i in range(len(xs) - 1)]
    gy = [(ys[i], ys[i + 1]) for i in range(len(ys) - 1)]

    # assign every grid cell to a room
    grid = {}
    for j, (y0, y1) in enumerate(gy):
        for i, (x0, x1) in enumerate(gx):
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            hit = None
            for r in rooms:
                if contains(r["poly"], cx, cy):
                    hit = r
                    break
            if hit is None:  # gap cell -> nearest room centre
                hit = min(rooms, key=lambda r: (r["cx"] - cx) ** 2 + (r["cy"] - cy) ** 2)
            grid[(i, j)] = hit

    # rebuild each room as the outline of its cells
    out = []
    for r in rooms:
        cells = [k for k, v in grid.items() if v["name"] == r["name"]]
        if not cells:
            continue
        x0 = min(xs[i] for i, _ in cells)
        x1 = max(xs[i + 1] for i, _ in cells)
        y0 = min(ys[j] for _, j in cells)
        y1 = max(ys[j + 1] for _, j in cells)
        out.append(rect_room(r["name"], r["zone"], x0, y0, x1, y1, r["dBm"]))
    return out


def walls_matrix(rooms, zones):
    """wallsBT[z1][z2] = number of shared wall segments between zones."""
    n = len(zones)
    w = [[0] * n for _ in range(n)]
    for a in rooms:
        for b in rooms:
            if a is b or a["zone"] == b["zone"]:
                continue
            # shared vertical edge
            if abs(a["x1"] - b["x0"]) < 1e-9 or abs(b["x1"] - a["x0"]) < 1e-9:
                over = max(0.0, min(a["y1"], b["y1"]) - max(a["y0"], b["y0"]))
                if over > 1e-6:
                    w[a["zone"]][b["zone"]] += 1
            # shared horizontal edge
            if abs(a["y1"] - b["y0"]) < 1e-9 or abs(b["y1"] - a["y0"]) < 1e-9:
                over = max(0.0, min(a["x1"], b["x1"]) - max(a["x0"], b["x0"]))
                if over > 1e-6:
                    w[a["zone"]][b["zone"]] += 1
    for i in range(n):
        for j in range(n):
            w[i][j] = w[j][i] = max(w[i][j], w[j][i])
    return w


def synthetic_dbm(rooms, router_room, dbm_max=-38.0, walls_per=7.0, db_per_m=3.0):
    """Plausible measured dBm per room, using the same model."""
    out = {}
    rr = next(r for r in rooms if r["name"] == router_room)
    for r in rooms:
        d = math.hypot(r["cx"] - rr["cx"], r["cy"] - rr["cy"])
        wall = 0
        if r["zone"] != rr["zone"]:
            wall = 1
        out[r["name"]] = round(dbm_max - (d * db_per_m + wall * walls_per), 1)
    return out


def build():
    # ---- map 1: the real house ----
    data = json.loads((ROOT / "webgame" / "data" / "rooms.json").read_text())
    real = tile_real_house(data["rooms"])
    zones1 = sorted({r["zone"] for r in real})
    walls1 = walls_matrix(real, zones1)

    # ---- map 2: Estudio (studio flat) ----
    estudio = [
        rect_room("Entrada", 0, 0, 0, 3, 2, -52),
        rect_room("Estudio", 1, 0, 2, 6, 6, -40),
        rect_room("Cocina", 2, 3, 0, 6, 2, -44),
        rect_room("Bano", 3, 6, 0, 8, 3, -58),
        rect_room("Terraza", 4, 0, 6, 6, 8, -70),
    ]
    dbm_e = synthetic_dbm(estudio, "Estudio")
    for r in estudio:
        r["dBm"] = dbm_e[r["name"]]
    zones2 = sorted({r["zone"] for r in estudio})
    walls2 = walls_matrix(estudio, zones2)

    # ---- map 3: Piso 2 hab (two-bedroom flat) ----
    piso = [
        rect_room("Pasillo", 0, 0, 2, 10, 3, -48),
        rect_room("Salon", 1, 0, 3, 6, 8, -42),
        rect_room("Cocina", 2, 6, 3, 10, 5, -45),
        rect_room("Bano", 3, 6, 5, 8, 8, -60),
        rect_room("Dorm. 1", 4, 0, 0, 5, 2, -55),
        rect_room("Dorm. 2", 5, 5, 0, 10, 2, -57),
        rect_room("Balcon", 6, 0, 8, 10, 10, -75),
    ]
    dbm_p = synthetic_dbm(piso, "Salon")
    for r in piso:
        r["dBm"] = dbm_p[r["name"]]
    zones3 = sorted({r["zone"] for r in piso})
    walls3 = walls_matrix(piso, zones3)

    # ---- map 4: Loft abierto (open-plan loft) ----
    loft = [
        rect_room("Living", 0, 0, 0, 9, 5, -41),
        rect_room("Cocina", 1, 0, 5, 4, 8, -46),
        rect_room("Dorm.", 2, 4, 5, 9, 8, -50),
        rect_room("Bano", 3, 9, 0, 12, 3, -62),
        rect_room("Oficina", 4, 9, 3, 12, 8, -56),
    ]
    dbm_l = synthetic_dbm(loft, "Living")
    for r in loft:
        r["dBm"] = dbm_l[r["name"]]
    zones4 = sorted({r["zone"] for r in loft})
    walls4 = walls_matrix(loft, zones4)

    def emit(rooms, zones, walls):
        zidx = {z: i for i, z in enumerate(zones)}
        return {
            "rooms": [
                {
                    "name": r["name"],
                    "zone": zidx[r["zone"]],
                    "poly": [[r["x0"], r["y0"]], [r["x1"], r["y0"]],
                             [r["x1"], r["y1"]], [r["x0"], r["y1"]]],
                    "cx": r["cx"], "cy": r["cy"],
                    "dBm": r["dBm"],
                }
                for r in rooms
            ],
            "wallsBT": walls,
            "dbmMax": max(r["dBm"] for r in rooms),
        }

    out = {
        "maps": [
            {"id": "casa", "label": "🏠 Casa real", **emit(real, zones1, walls1)},
            {"id": "estudio", "label": "🏢 Estudio", **emit(estudio, zones2, walls2)},
            {"id": "piso", "label": "🏡 Piso 2 hab", **emit(piso, zones3, walls3)},
            {"id": "loft", "label": "🏗️ Loft", **emit(loft, zones4, walls4)},
        ]
    }
    (ROOT / "webgame" / "data" / "maps.json").write_text(json.dumps(out))
    for m in out["maps"]:
        nz = len(m["wallsBT"])
        print(f"{m['id']:8s} rooms={len(m['rooms']):2d} zones={nz} "
              f"dbmMax={m['dbmMax']} wallsBT_nz={sum(1 for r in m['wallsBT'] for v in r if v)}")


if __name__ == "__main__":
    build()
