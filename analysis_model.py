"""
analysis_model.py — the WiFi signal model from DomesticNetworkAnalysis.ipynb,
extracted as reusable functions (SCON 2020, Alejandro Jarabo-Peñas).

Model:  dBm_predicted = dBm_max - (distance_m * DB_LOSS_PER_M + walls * DB_LOSS_PER_W)
with per-zone wall counts (walls_bt) and a zone-weighted power score.
"""

from __future__ import annotations

import math

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point

# ----------------------------------------------------------------------
# Model constants (estimated in the notebook)
# ----------------------------------------------------------------------
DB_LOSS_PER_M = 3  # dB loss per metre
DB_LOSS_PER_W = 7  # dB loss per interior wall
SCALE_M = 2.6  # geojson units -> metres

# Walls between zones (10x10 matrix, notebook cell 26)
WALLS_BT = [
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 2],
    [1, 0, 1, 1, 3, 3, 5, 3, 4, 2],
    [1, 1, 0, 2, 2, 3, 4, 2, 3, 3],
    [1, 1, 2, 0, 1, 2, 5, 3, 4, 1],
    [1, 3, 2, 1, 0, 1, 3, 3, 3, 1],
    [1, 3, 3, 2, 1, 0, 2, 2, 2, 1],
    [1, 5, 4, 5, 3, 2, 0, 2, 1, 2],
    [1, 3, 2, 3, 3, 2, 2, 0, 1, 3],
    [1, 4, 3, 4, 3, 2, 1, 1, 0, 3],
    [2, 2, 3, 1, 1, 1, 2, 3, 3, 0],
]

# Zone weights used by the notebook score (living areas matter more)
ZONE_WEIGHTS = {5: 1.5, 1: 1.25, 2: 1.25, 3: 1.25, 4: 1.25}


def zone_weight(zone: int) -> float:
    return ZONE_WEIGHTS.get(zone, 1.0)


# Measured mean dBm per room from the executed notebook (cell 14) — the
# committed scan CSV is partial and lacks the house SSID rows.
NOTEBOOK_MEASURED = {
    ("Pasillo-1", 0, 1): -67.8, ("Pasillo-2", 0, 2): -57.8, ("Pasillo-3", 0, 3): -53.0,
    ("Habitacion1-1", 1, 1): -39.2, ("Habitacion1-2", 1, 2): -40.6,
    ("Habitacion2-1", 2, 1): -45.0, ("Habitacion2-2", 2, 2): -47.0,
    ("Habitacion3-1", 3, 1): -54.8, ("Habitacion3-2", 3, 2): -52.2,
    ("Habitacion3-3", 3, 3): -53.0, ("Habitacion3-4", 3, 4): -52.0,
    ("Habitacion4-1", 4, 1): -63.0, ("Habitacion4-2", 4, 2): -62.0,
    ("Salon-1", 5, 1): -68.0, ("Salon-2", 5, 2): -74.2, ("Salon-3", 5, 3): -76.0,
    ("Salon-4", 5, 4): -71.0, ("Salon-5", 5, 5): -72.5, ("Salon-6", 5, 6): -70.333,
    ("Cocina-1", 6, 1): -72.0, ("Cocina-2", 6, 2): -86.5,
    ("Lavabo1-1", 7, 1): -74.6, ("Lavabo2-1", 8, 1): -75.0,
    ("Terraza-1", 9, 1): -75.8, ("Terraza-2", 9, 2): -69.0, ("Terraza-3", 9, 3): -72.0,
}


def load_rooms(geojson_path: str, csv_path: str, ssid: str = "WifiAle-5G") -> pd.DataFrame:
    """Rooms (polygons + centroids) merged with measured mean dBm per room.

    The committed scan CSV is partial: when the SSID rows are missing, the
    canonical per-room means from the executed notebook are used instead.
    """
    gdf = gpd.read_file(geojson_path)
    gdf["zone"] = gdf["zone"].astype(int)
    gdf["subzone"] = gdf["subzone"].astype(int)
    gdf["centroid_x"] = gdf.geometry.centroid.x
    gdf["centroid_y"] = gdf.geometry.centroid.y
    scanned = pd.read_csv(csv_path).dropna()
    scanned["zone"] = scanned["zone"].astype(int)
    scanned["subzone"] = scanned["subzone"].astype(int)
    filtered = scanned[scanned.SSID == ssid]
    if len(filtered) == 0:
        measured = pd.DataFrame(
            [
                {"zone": z, "subzone": sz, "dBm_measured": v}
                for (_, z, sz), v in NOTEBOOK_MEASURED.items()
            ]
        )
    else:
        measured = (
            filtered.groupby(["zone", "subzone"], as_index=False)["dBm_Signal"]
            .mean()
            .rename(columns={"dBm_Signal": "dBm_measured"})
        )
    return gdf.merge(measured, on=["zone", "subzone"])


def zone_at(rooms: pd.DataFrame, x: float, y: float) -> int:
    """Zone containing the point, or the nearest room's zone if outside all."""
    point = Point(x, y)
    for _, room in rooms.iterrows():
        if room["geometry"].contains(point):
            return int(room["zone"])
    # fallback: nearest room centroid
    best, best_d = 0, float("inf")
    for _, room in rooms.iterrows():
        d = ((room["centroid_x"] - x) ** 2 + (room["centroid_y"] - y) ** 2) ** 0.5
        if d < best_d:
            best_d, best = d, int(room["zone"])
    return best


def predict_dbm(
    rooms: pd.DataFrame,
    source_x: float,
    source_y: float,
    source_zone: int | None = None,
    db_per_m: float = DB_LOSS_PER_M,
    db_per_wall: float = DB_LOSS_PER_W,
    dbm_max: float | None = None,
) -> pd.Series:
    """Predicted dBm in every room for a router at (source_x, source_y).

    Wall loss uses the walls_bt matrix between the source zone and each
    target room's zone (the notebook's room-to-room model, generalised to
    any router position).
    """
    if dbm_max is None:
        dbm_max = float(rooms["dBm_measured"].max())
    if source_zone is None:
        source_zone = zone_at(rooms, source_x, source_y)
    distances = (
        (rooms["centroid_x"] - source_x) ** 2 + (rooms["centroid_y"] - source_y) ** 2
    ) ** 0.5
    walls = rooms["zone"].apply(lambda z: WALLS_BT[source_zone][z])
    # NOTE: like the notebook's recalc_signal_strength, distances are used raw
    # (the 2.6 m/unit scale only appears in the loss-per-metre estimation).
    return dbm_max - (distances * db_per_m + walls * db_per_wall)


def room_score(dbm_values: pd.Series, zones: pd.Series) -> float:
    """Notebook cell-28 score: mean over ZONES of the zone-weighted linear
    power (10^(dBm/10)) of each zone's mean signal."""
    per_zone: dict[int, list[float]] = {}
    for z, d in zip(zones, dbm_values):
        per_zone.setdefault(int(z), []).append(float(d))
    scores = []
    for z, vals in per_zone.items():
        mw = math.pow(10, float(np.mean(vals)) / 10)
        scores.append(mw * zone_weight(z))
    return 1e6 * sum(scores) / len(scores)


def optimal_room(rooms: pd.DataFrame, dbm_max: float | None = None) -> pd.DataFrame:
    """Score every room as the router location; returns rooms + score, sorted."""
    rows = []
    for _, room in rooms.iterrows():
        pred = predict_dbm(
            rooms, room["centroid_x"], room["centroid_y"], source_zone=int(room["zone"]),
            dbm_max=dbm_max,
        )
        rows.append(
            {
                "name": room["name"],
                "zone": int(room["zone"]),
                "score": room_score(pred, rooms["zone"]),
                "pred_mean_dbm": float(pred.mean()),
            }
        )
    return pd.DataFrame(rows).sort_values("score", ascending=False).reset_index(drop=True)
