# 📶 Domestic Network Analysis (SCON 2020)

[![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square)](https://www.python.org/)
[![Tests](https://img.shields.io/badge/tests-6%2F6-22C55E?style=flat-square)](tests/)
[![Play](https://img.shields.io/badge/▶%20Play-Interactive%20Web%20Edition-8B5CF6?style=flat-square)](https://alejp1998.github.io/domestic_net_analysis/)

> **▶️ Play it live:** <https://alejp1998.github.io/domestic_net_analysis/> — drag the router around your house plan and watch the predicted signal update live.

A complete analysis of a domestic WiFi network (Alejandro Jarabo-Peñas, SCON
2020): a **beacon scanner**, a **signal-strength study per room**, **band
occupancy** of 2.4/5 GHz, and two simulations — **optimal router placement**
and **WiFi repeater placement** — built on a path-loss model fitted from real
measurements.

## 📡 The pipeline

1. **`wifi_scanner.py`** — scapy-based monitor-mode scanner: hops channels
   1→14→36→60 and records every beacon (BSSID, SSID, zone/subzone, dBm,
   channel, crypto) into `data/scanned_networks.csv`.
2. **`DomesticNetworkAnalysis.ipynb`** — the full analysis:
   - choropleth of the measured 5 GHz signal per room (26 rooms, `house_zones.geojson`)
   - 2.4/5 GHz band occupancy & channel statistics
   - **WiFi placement simulation**: `dBm = dBm_max − (distance_m × 3 dB/m + walls × 7 dB/wall)`
     with a hand-built 10×10 zone wall matrix, scored by zone-weighted linear
     power → **the optimal room is Salon-2**
   - **repeater simulation**: same model with a second source, per-room gain

## 🧪 Model & tests

The model was extracted into **`analysis_model.py`** (reusable + unit-tested)
and ported 1:1 to JavaScript for the web edition (cross-checked: both find
**Salon-2** optimal).

```bash
pip install -e ".[dev]"
pytest -q
ruff check .
```

- `load_rooms` merges the geojson floor plan with the measured means; the
  committed scan CSV is partial (no house-SSID rows), so the canonical
  per-room means from the executed notebook are used automatically.

## 🎮 Interactive web edition

`webgame/` — an interactive floor-plan simulator:

- **📡 Measured** — the real scan heatmap per room
- **🧪 Simulate** — **drag the router** (and a **repeater**) anywhere; every
  room's predicted dBm, the score ranking and the heatmap recompute live;
  tune the model's dB/metre and dB/wall sliders
- **✨ Find optimal room** — runs the notebook's exhaustive search

## 📁 Layout

```
wifi_scanner.py                beacon scanner (monitor mode)
analysis_model.py              extracted signal model + tests
DomesticNetworkAnalysis.ipynb  full analysis (executes end-to-end)
data/                          house_zones.geojson + scanned_networks.csv
webgame/                       interactive simulator + JS model port
tests/                         pytest suite
```
