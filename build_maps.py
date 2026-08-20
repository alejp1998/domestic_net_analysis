
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
        "poly": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2,
        "dBm": dbm,
    }


def tile_real_house(rooms_in):
    """
    Close the empty gaps between the original room rectangles and make facing
    walls meet, while preserving the original design (no re-rasterisation).

    Every room is a rectangle (bbox of its polygon). Adjacent rooms that face
    each other with a small gap (or tiny overlap) get their facing edges moved
    to the midpoint of the two — so the edges become identical and walls meet
    exactly, with sub-0.04-unit adjustments invisible at render scale.
    """
    rooms = []
    for r in rooms_in:
        xs = [p[0] for p in r["poly"]]
        ys = [p[1] for p in r["poly"]]
        rooms.append({
            "name": r["name"], "zone": r["zone"],
            "x0": min(xs), "y0": min(ys),
            "x1": max(xs), "y1": max(ys),
            "poly": r["poly"], "dBm": r["dBm"],
            "cx": (min(xs) + max(xs)) / 2, "cy": (min(ys) + max(ys)) / 2,
        })

    eps = 0.08  # merge facing edges closer than this

    def x_overlap(a, b):
        return a["y0"] < b["y1"] and a["y1"] > b["y0"]

    def y_overlap(a, b):
        return a["x0"] < b["x1"] and a["x1"] > b["x0"]

    for _ in range(3):  # iterate until stable
        moved = 0
        for i in range(len(rooms)):
            a = rooms[i]
            for j in range(i + 1, len(rooms)):
                b = rooms[j]
                if x_overlap(a, b) and abs(a["x1"] - b["x0"]) <= eps:
                    m = (a["x1"] + b["x0"]) / 2
                    a["x1"], b["x0"] = m, m
                    moved += 1
                if x_overlap(a, b) and abs(a["x0"] - b["x1"]) <= eps:
                    m = (a["x0"] + b["x1"]) / 2
                    a["x0"], b["x1"] = m, m
                    moved += 1
                if y_overlap(a, b) and abs(a["y1"] - b["y0"]) <= eps:
                    m = (a["y1"] + b["y0"]) / 2
                    a["y1"], b["y0"] = m, m
                    moved += 1
                if y_overlap(a, b) and abs(a["y0"] - b["y1"]) <= eps:
                    m = (a["y0"] + b["y1"]) / 2
                    a["y0"], b["y1"] = m, m
                    moved += 1
        if moved == 0:
            break

    out = []
    for r in rooms:
        # final snap to a 0.01 grid: merged midpoints land on the SAME
        # gridline -> facing edges are exactly equal, zero gaps remain
        x0, y0 = snap(r["x0"], 0.01), snap(r["y0"], 0.01)
        x1, y1 = snap(r["x1"], 0.01), snap(r["y1"], 0.01)
        r["x0"], r["y0"], r["x1"], r["y1"] = x0, y0, x1, y1
        out.append({
            "name": r["name"], "zone": r["zone"],
            "poly": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "cx": (x0 + x1) / 2,
            "cy": (y0 + y1) / 2,
            "dBm": r["dBm"],
        })
    # alternate merge + snap passes: reunite split edges, then snap the
    # midpoints back onto the gridline — converges to zero gaps
    for _ in range(4):
        moved = 0
        for i in range(len(out)):
            a = out[i]
            for j in range(i + 1, len(out)):
                b = out[j]
                axs = [p[0] for p in a["poly"]]; ays = [p[1] for p in a["poly"]]
                bxs = [p[0] for p in b["poly"]]; bys = [p[1] for p in b["poly"]]
                ax0, ay0, ax1, ay1 = min(axs), min(ays), max(axs), max(ays)
                bx0, by0, bx1, by1 = min(bxs), min(bys), max(bxs), max(bys)
                if ay0 < by1 and ay1 > by0 and abs(ax1 - bx0) <= 0.015:
                    m = (ax1 + bx0) / 2
                    a["poly"][1][0] = a["poly"][2][0] = m
                    b["poly"][0][0] = b["poly"][3][0] = m
                    moved += 1
                if ay0 < by1 and ay1 > by0 and abs(ax0 - bx1) <= 0.015:
                    m = (ax0 + bx1) / 2
                    a["poly"][0][0] = a["poly"][3][0] = m
                    b["poly"][1][0] = b["poly"][2][0] = m
                    moved += 1
                if ax0 < bx1 and ax1 > bx0 and abs(ay1 - by0) <= 0.015:
                    m = (ay1 + by0) / 2
                    a["poly"][2][1] = a["poly"][3][1] = m
                    b["poly"][0][1] = b["poly"][1][1] = m
                    moved += 1
                if ax0 < bx1 and ax1 > bx0 and abs(ay0 - by1) <= 0.015:
                    m = (ay0 + by1) / 2
                    a["poly"][0][1] = a["poly"][1][1] = m
                    b["poly"][2][1] = b["poly"][3][1] = m
                    moved += 1
        for r in out:
            for p in r["poly"]:
                p[0] = snap(p[0], 0.01)
                p[1] = snap(p[1], 0.01)
        if moved == 0:
            break
    # final relaxation: facing edges of adjacent rooms converge to ONE
    # gridline. Fixes merge-chain drift (e.g. Pasillo-3 -9.18 vs
    # Habitacion1-1 -9.17): repeatedly average each close pair and snap to a
    # 0.02 grid until stable, so every wall truly meets its neighbours.
    def box(r):
        xs = [p[0] for p in r["poly"]]
        ys = [p[1] for p in r["poly"]]
        return min(xs), min(ys), max(xs), max(ys)
    for _ in range(6):
        moved = 0
        for i in range(len(out)):
            a = out[i]
            ax0, ay0, ax1, ay1 = box(a)
            for j in range(i + 1, len(out)):
                b = out[j]
                bx0, by0, bx1, by1 = box(b)
                if ay0 < by1 and ay1 > by0 and abs(ax1 - bx0) <= 0.03:
                    m = snap((ax1 + bx0) / 2, 0.02)
                    a["poly"][1][0] = a["poly"][2][0] = m
                    b["poly"][0][0] = b["poly"][3][0] = m
                    moved += 1
                if ay0 < by1 and ay1 > by0 and abs(ax0 - bx1) <= 0.03:
                    m = snap((ax0 + bx1) / 2, 0.02)
                    a["poly"][0][0] = a["poly"][3][0] = m
                    b["poly"][1][0] = b["poly"][2][0] = m
                    moved += 1
                if ax0 < bx1 and ax1 > bx0 and abs(ay1 - by0) <= 0.03:
                    m = snap((ay1 + by0) / 2, 0.02)
                    a["poly"][2][1] = a["poly"][3][1] = m
                    b["poly"][0][1] = b["poly"][1][1] = m
                    moved += 1
                if ax0 < bx1 and ax1 > bx0 and abs(ay0 - by1) <= 0.03:
                    m = snap((ay0 + by1) / 2, 0.02)
                    a["poly"][0][1] = a["poly"][1][1] = m
                    b["poly"][2][1] = b["poly"][3][1] = m
                    moved += 1
        if moved == 0:
            break
    # block alignment: subrooms of the same zone form a PERFECT rectangle —
    # snap edges that lie on a block side to the block's extreme, so grouped
    # rooms (e.g. the Salon-1..6 block) have straight collinear borders.
    from collections import defaultdict
    by_zone = defaultdict(list)
    for r in out:
        by_zone[r["zone"]].append(r)
    for zone, rs in by_zone.items():
        if len(rs) < 2:
            continue
        xs0 = min(min(p[0] for p in r["poly"]) for r in rs)
        xs1 = max(max(p[0] for p in r["poly"]) for r in rs)
        ys0 = min(min(p[1] for p in r["poly"]) for r in rs)
        ys1 = max(max(p[1] for p in r["poly"]) for r in rs)
        for r in rs:
            poly = r["poly"]
            x0 = min(p[0] for p in poly)
            x1 = max(p[0] for p in poly)
            y0 = min(p[1] for p in poly)
            y1 = max(p[1] for p in poly)
            if abs(x0 - xs0) <= 0.03:
                for p in poly:
                    if abs(p[0] - x0) < 1e-9:
                        p[0] = xs0
            if abs(x1 - xs1) <= 0.03:
                for p in poly:
                    if abs(p[0] - x1) < 1e-9:
                        p[0] = xs1
            if abs(y0 - ys0) <= 0.03:
                for p in poly:
                    if abs(p[1] - y0) < 1e-9:
                        p[1] = ys0
            if abs(y1 - ys1) <= 0.03:
                for p in poly:
                    if abs(p[1] - y1) < 1e-9:
                        p[1] = ys1
    # conform + re-align, iterated: rooms adjacent to a block side snap to
    # the block's extreme too, so shared edges sit ON the block boundary —
    # blocks stay perfect rectangles AND neighbours keep exact shared edges.
    def align():
        for zone, rs in by_zone.items():
            if len(rs) < 2:
                continue
            xs0 = min(min(p[0] for p in r["poly"]) for r in rs)
            xs1 = max(max(p[0] for p in r["poly"]) for r in rs)
            ys0 = min(min(p[1] for p in r["poly"]) for r in rs)
            ys1 = max(max(p[1] for p in r["poly"]) for r in rs)
            for r in rs:
                poly = r["poly"]
                x0 = min(p[0] for p in poly)
                x1 = max(p[0] for p in poly)
                y0 = min(p[1] for p in poly)
                y1 = max(p[1] for p in poly)
                if abs(x0 - xs0) <= 0.03:
                    for p in poly:
                        if abs(p[0] - x0) < 1e-9:
                            p[0] = xs0
                if abs(x1 - xs1) <= 0.03:
                    for p in poly:
                        if abs(p[0] - x1) < 1e-9:
                            p[0] = xs1
                if abs(y0 - ys0) <= 0.03:
                    for p in poly:
                        if abs(p[1] - y0) < 1e-9:
                            p[1] = ys0
                if abs(y1 - ys1) <= 0.03:
                    for p in poly:
                        if abs(p[1] - y1) < 1e-9:
                            p[1] = ys1

    def conform():
        for zone, rs in by_zone.items():
            if len(rs) < 2:
                continue
            xs0 = min(min(p[0] for p in r["poly"]) for r in rs)
            xs1 = max(max(p[0] for p in r["poly"]) for r in rs)
            ys0 = min(min(p[1] for p in r["poly"]) for r in rs)
            ys1 = max(max(p[1] for p in r["poly"]) for r in rs)
            for r in out:
                if r["zone"] == zone:
                    continue
                poly = r["poly"]
                x0 = min(p[0] for p in poly)
                x1 = max(p[0] for p in poly)
                y0 = min(p[1] for p in poly)
                y1 = max(p[1] for p in poly)
                if abs(x1 - xs0) <= 0.04:
                    for p in poly:
                        if abs(p[0] - x1) < 1e-9:
                            p[0] = xs0
                if abs(x0 - xs1) <= 0.04:
                    for p in poly:
                        if abs(p[0] - x0) < 1e-9:
                            p[0] = xs1
                if abs(y1 - ys0) <= 0.04:
                    for p in poly:
                        if abs(p[1] - y1) < 1e-9:
                            p[1] = ys0
                if abs(y0 - ys1) <= 0.04:
                    for p in poly:
                        if abs(p[1] - y0) < 1e-9:
                            p[1] = ys1

    for _ in range(4):
        align()
        conform()
    for r in out:
        for p in r["poly"]:
            p[0] = snap(p[0], 0.02)
            p[1] = snap(p[1], 0.02)
    return out

def walls_matrix(rooms, zones):
    """wallsBT[z1][z2] = number of shared wall segments between zones."""
    def box(r):
        xs = [p[0] for p in r["poly"]]
        ys = [p[1] for p in r["poly"]]
        return min(xs), min(ys), max(xs), max(ys)

    n = len(zones)
    w = [[0] * n for _ in range(n)]
    for a in rooms:
        for b in rooms:
            if a is b or a["zone"] == b["zone"]:
                continue
            ax0, ay0, ax1, ay1 = box(a)
            bx0, by0, bx1, by1 = box(b)
            # shared vertical edge
            if abs(ax1 - bx0) < 1e-9 or abs(bx1 - ax0) < 1e-9:
                over = max(0.0, min(ay1, by1) - max(ay0, by0))
                if over > 1e-6:
                    w[a["zone"]][b["zone"]] += 1
            # shared horizontal edge
            if abs(ay1 - by0) < 1e-9 or abs(by1 - ay0) < 1e-9:
                over = max(0.0, min(ax1, bx1) - max(ax0, bx0))
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
                    "poly": r["poly"],
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
