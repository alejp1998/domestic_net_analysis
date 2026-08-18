"""Unit tests for the WiFi signal model (analysis_model.py)."""

import warnings

import pytest

warnings.filterwarnings("ignore")
import analysis_model as am

DATA = "data"
GEOJSON = f"{DATA}/house_zones.geojson"
CSV = f"{DATA}/scanned_networks.csv"


@pytest.fixture(scope="module")
def rooms():
    return am.load_rooms(GEOJSON, CSV)


def test_load_rooms_uses_notebook_means(rooms):
    # the committed CSV lacks the house SSID -> canonical notebook means are used
    assert len(rooms) == 26
    h11 = rooms[rooms.name == "Habitacion1-1"].iloc[0]
    assert h11.dBm_measured == pytest.approx(-39.2)
    assert rooms.dBm_measured.max() == pytest.approx(-39.2)  # dbm_max


def test_predict_dbm_at_source_room_equals_dbm_max(rooms):
    h11 = rooms[rooms.name == "Habitacion1-1"].iloc[0]
    pred = am.predict_dbm(rooms, h11.centroid_x, h11.centroid_y, source_zone=int(h11.zone))
    assert pred[rooms.name == "Habitacion1-1"].iloc[0] == pytest.approx(-39.2)


def test_predict_dbm_falls_with_distance_and_walls(rooms):
    h11 = rooms[rooms.name == "Habitacion1-1"].iloc[0]
    pred = am.predict_dbm(rooms, h11.centroid_x, h11.centroid_y, source_zone=int(h11.zone))
    assert pred[rooms.name == "Habitacion1-1"].iloc[0] > pred[rooms.name == "Terraza-3"].iloc[0]
    # both components contribute: raising wall loss lowers the prediction
    pred_more_walls = am.predict_dbm(
        rooms, h11.centroid_x, h11.centroid_y, source_zone=int(h11.zone),
        db_per_wall=am.DB_LOSS_PER_W + 10,
    )
    assert pred_more_walls[rooms.name == "Terraza-3"].iloc[0] < pred[rooms.name == "Terraza-3"].iloc[0]


def test_zone_at_resolves_room_and_fallback(rooms):
    h11 = rooms[rooms.name == "Habitacion1-1"].iloc[0]
    assert am.zone_at(rooms, h11.centroid_x, h11.centroid_y) == int(h11.zone)
    # a far-away point falls back to the nearest room's zone
    assert isinstance(am.zone_at(rooms, -999, -999), int)


def test_room_score_is_positive_and_weighted(rooms):
    zones = rooms["zone"]
    s = am.room_score(rooms["dBm_measured"], zones)
    assert s > 0
    # better signals -> higher score
    better = am.room_score(rooms["dBm_measured"] + 10, zones)
    assert better > s


def test_optimal_room_matches_web_edition(rooms):
    opt = am.optimal_room(rooms)
    assert opt.iloc[0]["name"] == "Pasillo-2"  # notebook's canonical result
    assert opt.iloc[0]["score"] == pytest.approx(19.781, abs=0.01)
    assert len(opt) == len(rooms)
    # scores are sorted descending
    assert opt["score"].is_monotonic_decreasing
