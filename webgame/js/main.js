/**
 * Domestic Network Analysis — interactive floor-plan WiFi simulator.
 * Model ported 1:1 from analysis_model.py / the SCON 2020 notebook.
 */
(function () {
  "use strict";

  var canvas = document.getElementById("view");
  var ctx = canvas.getContext("2d");
  var $id = function (id) {
    return document.getElementById(id);
  };

  var WALLS_BT = [
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
  ];
  var ZONE_WEIGHTS = { 5: 1.5, 1: 1.25, 2: 1.25, 3: 1.25, 4: 1.25 };
  var UNIT_M = 4.45; // m per geojson unit (casa ~120 m²); 1.0 for the custom flat

  var PAL = {
    dark: {
      bg: "#0b0f19",
      floor: "#101a2c",
      wall: "#334155",
      wallEdge: "#475569",
      zoneDash: "#818cf8",
      text: "#e2e8f0",
      muted: "#94a3b8",
      faint: "#64748b",
      router: "#f59e0b",
      routerEdge: "#b45309",
      rep: "#22d3ee",
      repEdge: "#0e7490",
      optimal: "#fbbf24",
      heat: [
        "#1e40af",
        "#2563eb",
        "#0ea5e9",
        "#06b6d4",
        "#10b981",
        "#84cc16",
        "#eab308",
        "#f97316",
        "#ef4444",
        "#dc2626",
      ],
      panel: "#111c30",
      border: "rgba(255,255,255,0.1)",
    },
    light: {
      bg: "#f1f5f9",
      floor: "#f8fafc",
      wall: "#cbd5e1",
      wallEdge: "#94a3b8",
      zoneDash: "#6366f1",
      text: "#0f172a",
      muted: "#475569",
      faint: "#64748b",
      router: "#f59e0b",
      routerEdge: "#b45309",
      rep: "#0891b2",
      repEdge: "#0e7490",
      optimal: "#d97706",
      heat: [
        "#93c5fd",
        "#7dd3fc",
        "#22d3ee",
        "#2dd4bf",
        "#4ade80",
        "#a3e635",
        "#facc15",
        "#fb923c",
        "#f97316",
        "#ef4444",
      ],
      panel: "#ffffff",
      border: "rgba(15,23,42,0.12)",
    },
  };

  function pal() {
    var t = document.documentElement.getAttribute("data-theme");
    return PAL[t === "dark" ? "dark" : "light"];
  }

  // ---------------------------------------------------------------- state
  var DATA = null;
  var rooms = [];
  var dbmMax = -39.2;
  var mode = "meas"; // meas | sim
  var repeaterOn = false;
  var router = null; // {x, y} geojson coords
  var rep = null;
  var drag = null; // "router" | "rep"
  var optimalName = null;

  function log(msg) {
    var box = $id("log");
    var div = document.createElement("div");
    div.textContent = "› " + msg;
    box.appendChild(div);
    while (box.children.length > 60) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function bounds() {
    var xs = [],
      ys = [];
    rooms.forEach(function (r) {
      r.poly.forEach(function (p) {
        xs.push(p[0]);
        ys.push(p[1]);
      });
    });
    return {
      minX: Math.min.apply(null, xs),
      maxX: Math.max.apply(null, xs),
      minY: Math.min.apply(null, ys),
      maxY: Math.max.apply(null, ys),
    };
  }

  // ---------------------------------------------------------------- model
  function dist(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
  }

  function pointInPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0],
        yi = poly[i][1],
        xj = poly[j][0],
        yj = poly[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  function zoneAt(x, y) {
    for (var i = 0; i < rooms.length; i++) {
      if (pointInPoly(x, y, rooms[i].poly)) return rooms[i].zone;
    }
    var best = rooms[0].zone,
      bestD = Infinity;
    for (var j = 0; j < rooms.length; j++) {
      var d = Math.sqrt((rooms[j].cx - x) ** 2 + (rooms[j].cy - y) ** 2);
      if (d < bestD) {
        bestD = d;
        best = rooms[j].zone;
      }
    }
    return best;
  }

  function predictFrom(src, dbPerM, dbPerWall) {
    return rooms.map(function (r) {
      var rp = rayPath(src.x, src.y, r.cx, r.cy);
      return (
        dbmMax - ((rp.inside + rp.outside) * dbPerM + rp.walls * dbPerWall)
      );
    });
  }

  // --- discrete subdivision model ---
  var cells = []; // {x, y, w, h, roomIdx} in house units
  var cellN = 32;

  function roomAt(x, y) {
    for (var i = 0; i < rooms.length; i++) {
      if (pointInPoly(x, y, rooms[i].poly)) return i;
    }
    return -1;
  }

  var cellMap = {};
  function buildCells() {
    cells = [];
    cellMap = {};
    rooms.forEach(function (r) {
      var xs = r.poly.map(function (p) {
        return p[0];
      });
      var ys = r.poly.map(function (p) {
        return p[1];
      });
      r._b = {
        x0: Math.min.apply(null, xs),
        x1: Math.max.apply(null, xs),
        y0: Math.min.apply(null, ys),
        y1: Math.max.apply(null, ys),
      };
    });
    var b = B;
    if (!b) return;
    var cw = (b.maxX - b.minX) / cellN;
    var ch = (b.maxY - b.minY) / cellN;
    for (var gy = 0; gy < cellN; gy++) {
      for (var gx = 0; gx < cellN; gx++) {
        var cx0 = b.minX + gx * cw;
        var cy0 = b.minY + gy * ch;
        var cx = cx0 + cw / 2;
        var cy = cy0 + ch / 2;
        // CENTER-based membership: a cell belongs to the room that contains
        // its centre (or -1 outside). Deterministic — boundary cells keep one
        // unambiguous owner, so the ray-cast wall count is stable and exact
        // (the fill no longer depends on this: it uses AABB overlap + clip).
        var ri = -1;
        for (var r = 0; r < rooms.length; r++) {
          if (pointInPoly(cx, cy, rooms[r].poly)) {
            ri = r;
            break;
          }
        }
        var c = { x: cx0, y: cy0, w: cw, h: ch, roomIdx: ri };
        if (ri !== -1) {
          var cell = {
            gx: gx,
            gy: gy,
            x: b.minX + gx * cw,
            y: b.minY + gy * ch,
            w: cw,
            h: ch,
            roomIdx: ri,
          };
          cells.push(cell);
          cellMap[gx + "," + gy] = cell;
        }
      }
    }
  }

  // walls actually crossed along the straight line (router -> point): walks
  // the cell grid and counts every room-boundary transition. More accurate
  // than the zone matrix (which gave every cell of a room the same count and
  // produced counterintuitive neighbour-vs-distant comparisons).
  // ray from (x0,y0) to (x1,y1): counts the walls crossed and splits the
  // travelled distance into the in-flat part (inside rooms) and the
  // out-of-flat part (outside the house — through concave notches/corners).
  // BOTH lengths charge the distance degradation (the flat distance drives
  // the term), and every room transition — including into/out of the
  // OUTSIDE — charges a wall (exterior walls degrade too).
  function rayPath(x0, y0, x1, y1) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    var len = Math.hypot(dx, dy);
    if (len < 1e-9) return { inside: 0, outside: 0, walls: 0 };
    var n = Math.ceil(len / 0.02);
    var walls = 0;
    var inside = 0;
    var outside = 0;
    var prev = -2;
    var rw = (B.maxX - B.minX) / cellN;
    var rh = (B.maxY - B.minY) / cellN;
    var step = len / n;
    for (var s = 0; s <= n; s++) {
      var px = x0 + (dx * s) / n;
      var py = y0 + (dy * s) / n;
      var gx = Math.floor((px - B.minX) / rw);
      var gy = Math.floor((py - B.minY) / rh);
      var cell = cellMap[gx + "," + gy];
      var ri = cell ? cell.roomIdx : -1;
      if (s > 0 && prev !== -2 && ri !== prev) walls++;
      if (s > 0) {
        if (prev === -1) outside += step;
        else if (prev !== -2) inside += step;
      }
      prev = ri;
    }
    // report the split lengths in real meters (per-map UNIT_M)
    return { inside: inside * UNIT_M, outside: outside * UNIT_M, walls: walls };
  }

  function cellDbm(c, dbPerM, dbPerWall, roomIdx) {
    var cxc = c.x + c.w / 2;
    var cyc = c.y + c.h / 2;
    var rp = rayPath(router.x, router.y, cxc, cyc);
    var dbm =
      dbmMax - ((rp.inside + rp.outside) * dbPerM + rp.walls * dbPerWall);
    if (repeaterOn && rep) {
      var rpr = rayPath(rep.x, rep.y, cxc, cyc);
      var dbmr =
        dbmMax - ((rpr.inside + rpr.outside) * dbPerM + rpr.walls * dbPerWall);
      dbm = Math.max(dbm, dbmr);
    }
    return dbm;
  }

  function predictedDbm(dbPerM, dbPerWall) {
    var r = predictFrom(router, dbPerM, dbPerWall);
    if (repeaterOn && rep) {
      var rr = predictFrom(rep, dbPerM, dbPerWall);
      r = r.map(function (v, i) {
        return Math.max(v, rr[i]);
      });
    }
    return r;
  }

  function roomScore(dbmValues) {
    // notebook cell-28 semantics: mean over ZONES of the zone-weighted
    // linear power of each zone's mean signal
    var perZone = {};
    for (var i = 0; i < dbmValues.length; i++) {
      var z = rooms[i].zone;
      (perZone[z] = perZone[z] || []).push(dbmValues[i]);
    }
    var scores = [];
    for (var z in perZone) {
      var mean =
        perZone[z].reduce(function (a, b) {
          return a + b;
        }, 0) / perZone[z].length;
      scores.push(Math.pow(10, mean / 10) * (ZONE_WEIGHTS[z] || 1));
    }
    return (
      (1e6 *
        scores.reduce(function (a, b) {
          return a + b;
        }, 0)) /
      scores.length
    );
  }

  function findOptimalRoom() {
    // intuitive objective: the placement that maximizes the MEAN predicted
    // signal across all rooms (the notebook's cell-28 zone-weighted
    // linear-power score rewards the strongest zones, which lets a corner
    // bathroom "win" — nonsensical for coverage)
    var best = null,
      bestScore = -1e9,
      bestMean = 0;
    for (var i = 0; i < rooms.length; i++) {
      var src = { x: rooms[i].cx, y: rooms[i].cy };
      var dbms = rooms.map(function (r) {
        var rp = rayPath(src.x, src.y, r.cx, r.cy);
        return (
          dbmMax -
          ((rp.inside + rp.outside) * dbPerM() + rp.walls * dbPerWall())
        );
      });
      var mean =
        dbms.reduce(function (a, b) {
          return a + b;
        }, 0) / dbms.length;
      if (mean > bestScore) {
        bestScore = mean;
        bestMean = mean;
        best = rooms[i];
      }
    }
    best.optMean = bestMean;
    return best;
  }

  function dbPerM() {
    return Number($id("db-per-m").value);
  }
  function dbPerWall() {
    return Number($id("db-per-w").value);
  }

  // ---------------------------------------------------------------- render
  function sizeCanvas() {
    var panel = $id("stage-panel");
    var w = panel.clientWidth;
    var h = panel.clientHeight;
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  var B = null;
  function toPx(x, y) {
    var pad = 46;
    var sx = (x - B.minX) / (B.maxX - B.minX);
    var sy = (y - B.minY) / (B.maxY - B.minY);
    return [
      pad + sx * (canvas.width / dpr() - pad * 2),
      pad + (1 - sy) * (canvas.height / dpr() - pad * 2),
    ];
  }

  function dpr() {
    return Math.max(1, window.devicePixelRatio || 1);
  }

  var heatMin = -90,
    heatMax = -35;

  function heatColor(v, p) {
    var t = Math.max(0, Math.min(1, (v - heatMin) / (heatMax - heatMin)));
    var i = Math.min(p.heat.length - 1, Math.floor(t * p.heat.length));
    return p.heat[i];
  }

  function render() {
    var p = pal();
    var w = canvas.width / dpr();
    var h = canvas.height / dpr();
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, w, h);
    if (mapId === "custom" && !customAnalyzed) {
      renderEditor();
      return;
    }
    if (!rooms.length) return;

    B = bounds();
    var dbms = null;
    if (mode === "meas")
      dbms = rooms.map(function (r) {
        return r.dBm;
      });
    else dbms = predictedDbm(dbPerM(), dbPerWall());

    var dBmVals = dbms.slice();
    heatMin = Math.min.apply(null, dBmVals) - 2;
    heatMax = Math.max.apply(null, dBmVals) + 2;

    // discrete subdivision model: per-cell heat + grid-aligned walls
    // heatmap: clip each room's cells to its polygon so fills never bleed
    // past the walls (cell rects extend beyond the poly by half a cell)
    rooms.forEach(function (r, ri) {
      ctx.save();
      ctx.beginPath();
      r.poly.forEach(function (pt, k) {
        var px = toPx(pt[0], pt[1]);
        if (k === 0) ctx.moveTo(px[0], px[1]);
        else ctx.lineTo(px[0], px[1]);
      });
      ctx.closePath();
      ctx.clip();
      cells.forEach(function (c) {
        // fill every cell whose rect OVERLAPS this room — the room clip
        // bounds the fill to the poly. (A straddling cell's roomIdx can be
        // the NEIGHBOR — its center may sit past this room's edge — so the
        // roomIdx check would leave an unfilled strip along the wall.)
        var ov =
          c.x + c.w > r._b.x0 &&
          c.x < r._b.x1 &&
          c.y + c.h > r._b.y0 &&
          c.y < r._b.y1;
        if (!ov) return;
        var v =
          mode === "meas"
            ? rooms[ri].dBm
            : cellDbm(c, dbPerM(), dbPerWall(), ri);
        var tl = toPx(c.x, c.y);
        var br = toPx(c.x + c.w, c.y + c.h);
        // normalize the rect: the y-flip makes br[1]-tl[1] NEGATIVE, and a
        // negative height turns the +4px inflation into a SHRINK (2px gap at
        // every row boundary). Use absolute extents so the overlap works.
        var rx = Math.min(tl[0], br[0]);
        var ry = Math.min(tl[1], br[1]);
        var rw = Math.abs(br[0] - tl[0]);
        var rh = Math.abs(br[1] - tl[1]);
        ctx.fillStyle = heatColor(v, p);
        ctx.fillRect(
          Math.round(rx - 2),
          Math.round(ry - 2),
          Math.round(rw + 4),
          Math.round(rh + 4),
        );
      });
      ctx.restore();
    });

    // walls from the room POLYGONS:
    //  - shared edges between DIFFERENT zones: solid thin walls
    //  - shared edges between rooms of the SAME zone (subroom divisions):
    //    DASHED — the group's internal divisions replace the solid line
    //  - outward-facing edges: the thick house outline
    function wallNeighbor(r, e) {
      var poly = r.poly;
      var a = poly[e];
      var b = poly[(e + 1) % poly.length];
      var mx = (a[0] + b[0]) / 2;
      var my = (a[1] + b[1]) / 2;
      var dx = b[0] - a[0];
      var dy = b[1] - a[1];
      var nx = -dy;
      var ny = dx;
      var nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      for (var s = -1; s <= 1; s += 2) {
        for (var i = 0; i < rooms.length; i++) {
          if (rooms[i] === r) continue;
          if (
            pointInPoly(mx + nx * s * 0.03, my + ny * s * 0.03, rooms[i].poly)
          ) {
            return rooms[i];
          }
        }
      }
      return null;
    }
    function edgePts(r, e) {
      var a = r.poly[e];
      var b = r.poly[(e + 1) % r.poly.length];
      return [toPx(a[0], a[1]), toPx(b[0], b[1])];
    }
    // shared walls from room-PAIR segments: every adjacent pair contributes
    // its exact shared segment, drawn once — no midpoint probing, so long
    // edges spanning several neighbors (e.g. the Salon/Pasillo row) get every
    // piece. Solid between different zones, dashed within a zone.
    var EPS = 0.03;
    var bb2 = rooms.map(function (r) {
      var xs = [],
        ys = [];
      r.poly.forEach(function (p) {
        xs.push(p[0]);
        ys.push(p[1]);
      });
      return {
        x0: Math.min.apply(null, xs),
        x1: Math.max.apply(null, xs),
        y0: Math.min.apply(null, ys),
        y1: Math.max.apply(null, ys),
      };
    });
    var solidPath = [];
    var dashPath = [];
    for (var pi = 0; pi < rooms.length; pi++) {
      var A2 = bb2[pi];
      for (var pj = pi + 1; pj < rooms.length; pj++) {
        var B2 = bb2[pj];
        var seg = null;
        if (Math.abs(A2.x1 - B2.x0) <= EPS && A2.y0 < B2.y1 && A2.y1 > B2.y0) {
          seg = [A2.x1, Math.max(A2.y0, B2.y0), A2.x1, Math.min(A2.y1, B2.y1)];
        } else if (
          Math.abs(A2.x0 - B2.x1) <= EPS &&
          A2.y0 < B2.y1 &&
          A2.y1 > B2.y0
        ) {
          seg = [A2.x0, Math.max(A2.y0, B2.y0), A2.x0, Math.min(A2.y1, B2.y1)];
        } else if (
          Math.abs(A2.y1 - B2.y0) <= EPS &&
          A2.x0 < B2.x1 &&
          A2.x1 > B2.x0
        ) {
          seg = [Math.max(A2.x0, B2.x0), A2.y1, Math.min(A2.x1, B2.x1), A2.y1];
        } else if (
          Math.abs(A2.y0 - B2.y1) <= EPS &&
          A2.x0 < B2.x1 &&
          A2.x1 > B2.x0
        ) {
          seg = [Math.max(A2.x0, B2.x0), A2.y0, Math.min(A2.x1, B2.x1), A2.y0];
        }
        if (!seg) continue;
        var ta = toPx(seg[0], seg[1]);
        var tb = toPx(seg[2], seg[3]);
        var sitem = [ta[0], ta[1], tb[0], tb[1]];
        if (rooms[pi].zone === rooms[pj].zone) dashPath.push(sitem);
        else solidPath.push(sitem);
      }
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = p.wallEdge;
    ctx.beginPath();
    solidPath.forEach(function (s) {
      ctx.moveTo(s[0], s[1]);
      ctx.lineTo(s[2], s[3]);
    });
    ctx.stroke();
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    dashPath.forEach(function (s) {
      ctx.moveTo(s[0], s[1]);
      ctx.lineTo(s[2], s[3]);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // thick outline: the runs of each room edge with NO adjacent room
    function hasNeighbor(r, px, py, nx, ny) {
      for (var s = -1; s <= 1; s += 2) {
        for (var i = 0; i < rooms.length; i++) {
          if (
            rooms[i] !== r &&
            pointInPoly(px + nx * s * 0.03, py + ny * s * 0.03, rooms[i].poly)
          ) {
            return true;
          }
        }
      }
      return false;
    }
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = p.text;
    ctx.beginPath();
    rooms.forEach(function (r) {
      for (var e = 0; e < r.poly.length; e++) {
        var a = r.poly[e];
        var b = r.poly[(e + 1) % r.poly.length];
        var dx = b[0] - a[0];
        var dy = b[1] - a[1];
        var len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        var nx = -dy / len;
        var ny = dx / len;
        var nsteps = Math.max(1, Math.ceil(len / 0.02));
        var run = null;
        for (var s = 0; s <= nsteps; s++) {
          var mx = a[0] + (dx * s) / nsteps;
          var my = a[1] + (dy * s) / nsteps;
          var ext = !hasNeighbor(r, mx, my, nx, ny);
          if (ext && !run) run = [mx, my];
          else if (!ext && run) {
            var t1 = toPx(run[0], run[1]);
            var t2 = toPx(mx, my);
            ctx.moveTo(t1[0], t1[1]);
            ctx.lineTo(t2[0], t2[1]);
            run = null;
          }
        }
        if (run) {
          var u1 = toPx(run[0], run[1]);
          var u2 = toPx(b[0], b[1]);
          ctx.moveTo(u1[0], u1[1]);
          ctx.lineTo(u2[0], u2[1]);
        }
      }
    });
    ctx.stroke();
    // room labels + per-room dBm + optimal highlight (on top of the cells)
    rooms.forEach(function (r, i) {
      if (optimalName === r.name) {
        var pts = r.poly.map(function (pp) {
          return toPx(pp[0], pp[1]);
        });
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
        ctx.closePath();
        ctx.strokeStyle = p.optimal;
        ctx.lineWidth = 3.5;
        ctx.stroke();
      }
      var cp = toPx(r.cx, r.cy);
      ctx.fillStyle = p.text;
      ctx.font = "600 11px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        r.name.replace("Habitacion", "Hab.").replace("Pasillo", "Pas."),
        cp[0],
        cp[1] - 5,
      );
      ctx.fillStyle = p.muted;
      ctx.font = "10px system-ui";
      ctx.fillText(Math.round(dbms[i]) + " dBm", cp[0], cp[1] + 9);
    });

    // sources
    if (mode === "sim") {
      drawSource(router, p.router, p.routerEdge, "router");
      if (repeaterOn && rep) drawSource(rep, p.rep, p.repEdge, "repeater");
    }

    // legend
    drawLegend(w, h, p);
    drawScaleBar(w, h, p);

    // mode label
    ctx.fillStyle = p.muted;
    ctx.font = "600 12px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(
      mode === "meas"
        ? "measured 5 GHz mean signal per room (dBm)"
        : "simulated · " + (repeaterOn ? "router + repeater" : "single router"),
      14,
      18,
    );
  }

  function drawSource(src, fill, edge, label) {
    var pt = toPx(src.x, src.y);
    ctx.fillStyle = fill;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pt[0], pt[1], 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = edge;
    ctx.font = "700 10px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(label + " — drag me", pt[0] + 13, pt[1] + 22);
  }

  // horizontal scale bar (bottom-left pad): shows real meters on the X axis
  function drawScaleBar(w, h, p) {
    var pxPerM = (w - 92) / (B.maxX - B.minX) / UNIT_M;
    var lens = [1, 2, 5, 10, 20];
    var len = 2;
    for (var i = 0; i < lens.length; i++) {
      if (lens[i] * pxPerM >= 55 && lens[i] * pxPerM <= 150) {
        len = lens[i];
        break;
      }
    }
    var barLen = len * pxPerM;
    var bx = 24;
    var by = h - 26;
    ctx.strokeStyle = p.text;
    ctx.fillStyle = p.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + barLen, by);
    ctx.moveTo(bx, by - 4);
    ctx.lineTo(bx, by + 4);
    ctx.moveTo(bx + barLen, by - 4);
    ctx.lineTo(bx + barLen, by + 4);
    ctx.stroke();
    ctx.font = "600 11px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(len + " m", bx + barLen + 6, by + 4);
    ctx.textAlign = "left";
  }

  function drawLegend(w, h, p) {
    var lw = Math.min(250, w * 0.32);
    var lx = w - lw - 14;
    var ly = h - 46; // bottom pad — fully below the map outline (map ends at h-46)
    var lh = 46;
    ctx.fillStyle = p.panel + "dd";
    ctx.strokeStyle = p.border;
    ctx.beginPath();
    ctx.roundRect(lx, ly, lw, lh, 8);
    ctx.fill();
    ctx.stroke();
    var barY = ly + 12;
    var barH = 10;
    var grad = ctx.createLinearGradient(lx + 10, 0, lx + lw - 10, 0);
    for (var i = 0; i < p.heat.length; i++)
      grad.addColorStop(i / (p.heat.length - 1), p.heat[i]);
    ctx.fillStyle = grad;
    ctx.fillRect(lx + 10, barY, lw - 20, barH);
    ctx.strokeStyle = p.faint;
    ctx.strokeRect(lx + 10, barY, lw - 20, barH);
    ctx.fillStyle = p.muted;
    ctx.font = "9px system-ui";
    ctx.textAlign = "center";
    for (var k = 0; k < 5; k++) {
      var v = Math.round(heatMin + ((heatMax - heatMin) * k) / 4);
      var tx = lx + 10 + ((lw - 20) * k) / 4;
      ctx.fillText(v, tx, barY + barH + 11);
    }
    ctx.textAlign = "left";
    ctx.fillText("worst", lx + 10, barY - 3);
    ctx.textAlign = "right";
    ctx.fillText("best", lx + lw - 10, barY - 3);
  }

  // ---------------------------------------------------------------- scores
  function renderScores(dbms) {
    var box = $id("scores");
    var items = rooms
      .map(function (r, i) {
        return {
          name: r.name,
          zone: r.zone,
          dbm: dbms[i],
          score: Math.pow(10, dbms[i] / 10) * (ZONE_WEIGHTS[r.zone] || 1),
        };
      })
      .sort(function (a, b) {
        return b.score - a.score;
      });
    var html = "";
    items.slice(0, 8).forEach(function (it, idx) {
      var pct = Math.round((it.score / items[0].score) * 100);
      html +=
        '<div class="score-row' +
        (it.name === optimalName ? " best" : "") +
        '">' +
        '<span class="score-name">' +
        (idx + 1) +
        ". " +
        it.name +
        "</span>" +
        '<span class="score-val">' +
        Math.round(it.dbm) +
        " dBm</span>" +
        '<div class="score-bar"><div style="width:' +
        pct +
        '%"></div></div>' +
        "</div>";
    });
    box.innerHTML = html;
  }

  // ---------------------------------------------------------------- input
  function canvasPos(e) {
    var r = canvas.getBoundingClientRect();
    var px = e.clientX - r.left;
    var py = e.clientY - r.top;
    var sx = (px - 46) / (r.width - 92);
    var sy = (py - 46) / (r.height - 92);
    return {
      x: B.minX + sx * (B.maxX - B.minX),
      y: B.maxY - sy * (B.maxY - B.minY),
    };
  }

  function wireCanvas() {
    canvas.addEventListener("pointerdown", function (e) {
      var pos = canvasPos(e);
      if (mode !== "sim") return;
      var dr = dist(pos, router) * UNIT_M;
      var dRep = repeaterOn && rep ? dist(pos, rep) : Infinity;
      if (repeaterOn && dRep < dr) drag = "rep";
      else drag = "router";
      canvas.setPointerCapture(e.pointerId);
      updateDrag(pos);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) return;
      updateDrag(canvasPos(e));
    });
    canvas.addEventListener("pointerup", function () {
      if (drag) {
        log(
          "📶 Source moved — " +
            (drag === "router" ? "router" : "repeater") +
            " at zone " +
            zoneAt(
              drag === "router" ? router.x : rep.x,
              drag === "router" ? router.y : rep.y,
            ),
        );
        drag = null;
        renderScores(predictedDbm(dbPerM(), dbPerWall()));
      }
    });
  }

  function updateDrag(pos) {
    // keep sources inside the house: the model predicts indoor paths and
    // counts interior walls only — an outdoor source would under-count
    pos.x = Math.max(B.minX, Math.min(B.maxX, pos.x));
    pos.y = Math.max(B.minY, Math.min(B.maxY, pos.y));
    if (drag === "router") router = pos;
    else rep = pos;
    render();
  }

  // ------------------------------------------------------- custom flat
  // a paint-your-own flat: rooms are rectangles on a 1 m² grid; "Analyze"
  // feeds them into the same sim pipeline (walls, ray-cast, optimal search)
  var CUSTOM_W = 18;
  var CUSTOM_H = 12;
  var customRooms = [];
  var customTool = "draw";
  var customDrag = null; // {gx0, gy0} in grid cells (map-y orientation)
  var customPreview = null;
  var customAnalyzed = false;
  var customSel = -1;

  function customRoomAt(gx, gy) {
    for (var i = 0; i < customRooms.length; i++) {
      var r = customRooms[i];
      if (gx >= r.gx0 && gx <= r.gx1 && gy >= r.gy0 && gy <= r.gy1) return i;
    }
    return -1;
  }

  function canvasPx(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function customGridPos(px, py) {
    // raw canvas px -> grid cell; grid rows grow DOWNWARD in canvas space
    var w = canvas.width / dpr();
    var h = canvas.height / dpr();
    var pad = 46;
    var ux = (w - pad * 2) / CUSTOM_W;
    var uy = (h - pad * 2) / CUSTOM_H;
    var gx = Math.floor((px - pad) / ux);
    var gy = Math.floor((py - pad) / uy);
    return {
      gx: Math.max(0, Math.min(CUSTOM_W - 1, gx)),
      gy: Math.max(0, Math.min(CUSTOM_H - 1, gy)),
    };
  }

  function customCellRect(gx, gy, w2, h2) {
    var pad = 46;
    var ux = (w2 - pad * 2) / CUSTOM_W;
    var uy = (h2 - pad * 2) / CUSTOM_H;
    return {
      x0: pad + gx * ux,
      y0: pad + gy * uy,
      x1: pad + (gx + 1) * ux,
      y1: pad + (gy + 1) * uy,
    };
  }

  function drawEditorOn(c2, w2, h2) {
    var p = pal();
    var pad = 46;
    c2.clearRect(0, 0, w2, h2);
    var ux = (w2 - pad * 2) / CUSTOM_W;
    var uy = (h2 - pad * 2) / CUSTOM_H;
    c2.strokeStyle = p.faint;
    c2.lineWidth = 1;
    c2.beginPath();
    for (var gx = 0; gx <= CUSTOM_W; gx++) {
      c2.moveTo(pad + gx * ux, pad);
      c2.lineTo(pad + gx * ux, h2 - pad);
    }
    for (var gy = 0; gy <= CUSTOM_H; gy++) {
      c2.moveTo(pad, pad + gy * uy);
      c2.lineTo(w2 - pad, pad + gy * uy);
    }
    c2.stroke();
    customRooms.forEach(function (r, i) {
      var px = customCellRect(r.gx0, r.gy0, w2, h2);
      var qx = customCellRect(r.gx1, r.gy1, w2, h2);
      c2.fillStyle = p.wallEdge + "55";
      c2.fillRect(px.x0, px.y0, qx.x1 - px.x0, qx.y1 - px.y0);
      c2.strokeStyle = i === customSel ? "#f59e0b" : p.text;
      c2.lineWidth = 2;
      c2.strokeRect(px.x0, px.y0, qx.x1 - px.x0, qx.y1 - px.y0);
      c2.fillStyle = p.text;
      c2.font = "600 11px system-ui";
      c2.textAlign = "left";
      c2.fillText(r.name || "Room " + (i + 1), px.x0 + 4, px.y0 + 14);
    });
    if (customDrag && customPreview) {
      var a = customCellRect(customDrag.gx, customDrag.gy, w2, h2);
      var b = customCellRect(customPreview.gx, customPreview.gy, w2, h2);
      var x0 = Math.min(a.x0, b.x0);
      var y0 = Math.min(a.y0, b.y0);
      c2.strokeStyle = "#22c55e";
      c2.lineWidth = 2;
      c2.setLineDash([6, 4]);
      c2.strokeRect(x0, y0, Math.abs(b.x1 - a.x0), Math.abs(b.y1 - a.y0));
      c2.setLineDash([]);
    }
    c2.fillStyle = p.muted;
    c2.font = "11px system-ui";
    c2.textAlign = "left";
    c2.fillText("Draw rooms, then ▶️ Analyze", pad + 2, h2 - 8);
  }

  function renderEditor() {
    // the LEFT mini-canvas is the editing surface; the main canvas mirrors it
    var w = canvas.width / dpr();
    var h = canvas.height / dpr();
    drawEditorOn(ctx, w, h);
    var ec = $id("edit-canvas");
    if (ec && ec.width)
      drawEditorOn(ec.getContext("2d"), ec.width / dpr(), ec.height / dpr());
  }

  function refreshCustomList() {
    var ul = $id("custom-rooms");
    if (!ul) return;
    ul.innerHTML = "";
    customRooms.forEach(function (r, i) {
      var li = document.createElement("li");
      li.style.cssText = "display:flex;gap:6px;align-items:center;margin:3px 0";
      var name = document.createElement("input");
      name.value = r.name || "Room " + (i + 1);
      name.style.width = "90px";
      name.addEventListener("input", function () {
        r.name = name.value || "Room " + (i + 1);
        render();
      });
      var zone = document.createElement("input");
      zone.value = r.zone || "Z" + (i + 1);
      zone.style.width = "70px";
      zone.title = "zone — rooms sharing a zone get dashed divisions";
      zone.addEventListener("input", function () {
        r.zone = zone.value || "Z" + (i + 1);
        render();
      });
      var del = document.createElement("button");
      del.textContent = "✕";
      del.className = "btn";
      del.style.cssText = "padding:0 8px";
      del.addEventListener("click", function () {
        customRooms.splice(i, 1);
        refreshCustomList();
        render();
      });
      li.appendChild(name);
      li.appendChild(zone);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function analyzeCustom() {
    if (!customRooms.length) {
      log("🧱 Draw at least one room first.");
      return;
    }
    customAnalyzed = true;
    UNIT_M = 1; // the custom grid is 1 m per cell
    rooms = customRooms.map(function (r, i) {
      // grid rows grow DOWN in canvas space; the sim's map-y grows UP
      var yTop = CUSTOM_H - r.gy1; // top row of the room (map-y)
      var yBot = CUSTOM_H - r.gy0; // bottom row
      var x0 = r.gx0;
      var x1 = r.gx1 + 1;
      return {
        name: r.name || "Room " + (i + 1),
        zone: r.zone || "Z" + (i + 1),
        poly: [
          [x0, yTop],
          [x1, yTop],
          [x1, yBot],
          [x0, yBot],
        ],
        cx: (x0 + x1) / 2,
        cy: (yTop + yBot) / 2,
        dBm: -60,
        gx0: r.gx0,
        gy0: r.gy0,
        gx1: r.gx1,
        gy1: r.gy1,
      };
    });
    mapId = "custom";
    dbmMax = -37;
    B = bounds();
    optimalName = null;
    router = { x: rooms[0].cx, y: rooms[0].cy };
    rep = null;
    buildCells();
    sizeCanvas();
    render();
    renderScores(
      rooms.map(function (r) {
        return r.dBm;
      }),
    );
    log(
      "🧱 Custom flat analyzed — drag the router, toggle the repeater, find the optimum.",
    );
    // the custom flat's purpose is the simulation — switch to SIM mode
    $id("mode-sim").click();
  }

  function wireEditor() {
    var ec = $id("edit-canvas");
    if (!ec || ec.dataset.wired) return;
    ec.dataset.wired = "1";
    var ectx = ec.getContext("2d");
    function ePos(e) {
      var r = ec.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function eGrid(px, py) {
      var w = ec.width / dpr();
      var h = ec.height / dpr();
      var pad = 46;
      var ux = (w - pad * 2) / CUSTOM_W;
      var uy = (h - pad * 2) / CUSTOM_H;
      return {
        gx: Math.max(0, Math.min(CUSTOM_W - 1, Math.floor((px - pad) / ux))),
        gy: Math.max(0, Math.min(CUSTOM_H - 1, Math.floor((py - pad) / uy))),
      };
    }
    ec.addEventListener("pointerdown", function (e) {
      if (mapId !== "custom" || customAnalyzed) return;
      var cell = eGrid(ePos(e).x, ePos(e).y);
      if (customTool === "erase") {
        var idx = customRoomAt(cell.gx, cell.gy);
        if (idx !== -1) {
          customRooms.splice(idx, 1);
          customSel = -1;
          refreshCustomList();
          renderEditor();
        }
        return;
      }
      var existing = customRoomAt(cell.gx, cell.gy);
      if (existing !== -1) {
        customSel = existing;
        refreshCustomList();
        renderEditor();
        return;
      }
      customDrag = cell;
      customPreview = cell;
      ec.setPointerCapture(e.pointerId);
      renderEditor();
    });
    ec.addEventListener("pointermove", function (e) {
      if (!customDrag) return;
      customPreview = eGrid(ePos(e).x, ePos(e).y);
      renderEditor();
    });
    ec.addEventListener("pointerup", function () {
      if (customDrag && customPreview) {
        var gx0 = Math.min(customDrag.gx, customPreview.gx);
        var gx1 = Math.max(customDrag.gx, customPreview.gx);
        var gy0 = Math.min(customDrag.gy, customPreview.gy);
        var gy1 = Math.max(customDrag.gy, customPreview.gy);
        if (gx1 > gx0 || gy1 > gy0) {
          var ok = true;
          for (var i = 0; i < customRooms.length; i++) {
            var r = customRooms[i];
            if (gx0 <= r.gx1 && gx1 >= r.gx0 && gy0 <= r.gy1 && gy1 >= r.gy0) {
              ok = false;
              break;
            }
          }
          if (ok) {
            customRooms.push({
              gx0: gx0,
              gy0: gy0,
              gx1: gx1,
              gy1: gy1,
              name: "",
              zone: "",
            });
            refreshCustomList();
          } else {
            log("🧱 Room overlaps an existing room — drag a free area.");
          }
        }
      }
      customDrag = null;
      customPreview = null;
      renderEditor();
    });
    $id("tool-draw").addEventListener("click", function () {
      customTool = "draw";
      $id("tool-draw").classList.add("active");
      $id("tool-erase").classList.remove("active");
    });
    $id("tool-erase").addEventListener("click", function () {
      customTool = "erase";
      $id("tool-erase").classList.add("active");
      $id("tool-draw").classList.remove("active");
    });
    $id("btn-clear").addEventListener("click", function () {
      if (!customRooms.length) return;
      customRooms.length = 0;
      customSel = -1;
      refreshCustomList();
      renderEditor();
      log("🧹 Custom flat cleared.");
    });
    $id("btn-analyze").addEventListener("click", analyzeCustom);
  }

  function sizeEditorCanvas() {
    var ec = $id("edit-canvas");
    if (!ec) return;
    var d = dpr();
    var w = ec.clientWidth || 240;
    var h = Math.round((w * CUSTOM_H) / CUSTOM_W);
    ec.width = Math.round(w * d);
    ec.height = Math.round(h * d);
    ec.style.height = h + "px";
  }

  function enterCustomEditor() {
    customAnalyzed = false;
    UNIT_M = 1;
    mapId = "custom";
    $id("custom-editor").hidden = false;
    sizeEditorCanvas();
    wireEditor();
    refreshCustomList();
    sizeCanvas();
    renderEditor();
  }

  // --------------------------------------------------- router + repeater
  function findBestPair() {
    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < rooms.length; i++) {
      for (var j = 0; j < rooms.length; j++) {
        if (i === j) continue;
        var p1 = { x: rooms[i].cx, y: rooms[i].cy };
        var p2 = { x: rooms[j].cx, y: rooms[j].cy };
        var sum = 0;
        for (var k = 0; k < rooms.length; k++) {
          var t = rooms[k];
          var r1 = rayPath(p1.x, p1.y, t.cx, t.cy);
          var r2 = rayPath(p2.x, p2.y, t.cx, t.cy);
          var d1 =
            dbmMax -
            ((r1.inside + r1.outside) * dbPerM() + r1.walls * dbPerWall());
          var d2 =
            dbmMax -
            ((r2.inside + r2.outside) * dbPerM() + r2.walls * dbPerWall());
          sum += Math.max(d1, d2);
        }
        var score = sum / rooms.length;
        if (score > bestScore) {
          bestScore = score;
          best = { router: rooms[i], repeater: rooms[j] };
        }
      }
    }
    return { router: best.router, repeater: best.repeater, mean: bestScore };
  }

  // ---------------------------------------------------------------- guide
  var guideOpen = false;
  function wireGuide() {
    var guide = $id("guide");
    function open() {
      guideOpen = true;
      guide.classList.remove("hidden");
    }
    function close() {
      guideOpen = false;
      guide.classList.add("hidden");
    }
    $id("btn-guide").addEventListener("click", open);
    guide.querySelectorAll("[data-close-guide]").forEach(function (el) {
      el.addEventListener("click", close);
    });
    document.addEventListener("keydown", function (e) {
      if (e.code === "Escape" && guideOpen) close();
    });
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    document.querySelectorAll(".map-row [data-map]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".map-row [data-map]").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
        if (btn.dataset.map === "custom") {
          enterCustomEditor();
          return;
        }
        $id("custom-editor").hidden = true;
        customAnalyzed = false;
        setMap(btn.dataset.map);
      });
    });
    $id("grid-res").addEventListener("input", function () {
      cellN = Number(this.value);
      $id("grid-res-v").textContent = this.value;
      buildCells();
      render();
    });
    $id("mode-meas").addEventListener("click", function () {
      mode = "meas";
      $id("mode-meas").classList.add("active");
      $id("mode-sim").classList.remove("active");
      $id("sim-options").classList.add("hidden");
      $id("meas-note").classList.remove("hidden");
      optimalName = null;
      render();
      renderScores(
        rooms.map(function (r) {
          return r.dBm;
        }),
      );
    });
    $id("mode-sim").addEventListener("click", function () {
      mode = "sim";
      $id("mode-sim").classList.add("active");
      $id("mode-meas").classList.remove("active");
      $id("sim-options").classList.remove("hidden");
      $id("meas-note").classList.add("hidden");
      if (!router) {
        router = { x: rooms[0].cx, y: rooms[0].cy };
        log(
          "🧪 Simulation — drag the router; toggle the repeater for a 2nd source.",
        );
      }
      render();
      renderScores(predictedDbm(dbPerM(), dbPerWall()));
    });

    $id("rep-toggle").addEventListener("change", function () {
      repeaterOn = this.checked;
      if (repeaterOn && !rep) {
        rep = { x: rooms[rooms.length - 1].cx, y: rooms[rooms.length - 1].cy };
        log(
          "🔁 Repeater added at " +
            rooms[rooms.length - 1].name +
            " — drag it too.",
        );
      }
      render();
      renderScores(predictedDbm(dbPerM(), dbPerWall()));
    });

    ["db-per-m", "db-per-w"].forEach(function (id) {
      $id(id).addEventListener("input", function () {
        $id(id + "-v").textContent =
          id === "db-per-m" ? this.value + " dB" : this.value + " dB";
        render();
        renderScores(predictedDbm(dbPerM(), dbPerWall()));
      });
    });

    $id("btn-optimal").addEventListener("click", function () {
      var best = findOptimalRoom();
      // place the router at the optimal spot and report the true mean
      router.x = best.cx;
      router.y = best.cy;
      optimalName = best.name;
      log(
        "✨ Optimal router location: " +
          best.name +
          " (zone " +
          best.zone +
          ") — mean predicted " +
          Math.round(best.optMean) +
          " dBm across the flat.",
      );
      render();
      renderScores(predictedDbm(dbPerM(), dbPerWall()));
    });
    $id("btn-pair").addEventListener("click", function () {
      if (rooms.length < 2) {
        log("🔎 Draw at least two rooms first.");
        return;
      }
      if (!repeaterOn) {
        $id("rep-toggle").checked = true;
        repeaterOn = true;
      }
      if (!rep) rep = { x: rooms[0].cx + 0.3, y: rooms[0].cy + 0.3 };
      log("🔎 Searching the best router + repeater pair…");
      // let the log paint before the brute-force loop
      setTimeout(function () {
        var best = findBestPair();
        router.x = best.router.cx;
        router.y = best.router.cy;
        rep.x = best.repeater.cx;
        rep.y = best.repeater.cy;
        log(
          "✨ Best router + repeater: router in " +
            best.router.name +
            " + repeater in " +
            best.repeater.name +
            " — mean predicted " +
            Math.round(best.mean) +
            " dBm across the flat.",
        );
        render();
        renderScores(predictedDbm(dbPerM(), dbPerWall()));
      }, 50);
    });

    $id("btn-reset").addEventListener("click", function () {
      router = { x: rooms[0].cx, y: rooms[0].cy };
      rep = repeaterOn
        ? { x: rooms[rooms.length - 1].cx, y: rooms[rooms.length - 1].cy }
        : null;
      optimalName = null;
      log("↻ Reset: router back at " + rooms[0].name + ".");
      render();
      renderScores(predictedDbm(dbPerM(), dbPerWall()));
    });

    $id("btn-theme").addEventListener("click", function () {
      var t =
        document.documentElement.getAttribute("data-theme") === "dark"
          ? "light"
          : "dark";
      document.documentElement.setAttribute("data-theme", t);
      try {
        localStorage.setItem("theme", t);
      } catch (e) {}
      applyTheme();
      render();
    });
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", function (ev) {
        if (localStorage.getItem("theme")) return;
        document.documentElement.setAttribute(
          "data-theme",
          ev.matches ? "dark" : "light",
        );
        applyTheme();
        render();
      });
    window.addEventListener("resize", function () {
      sizeCanvas();
      render();
    });
  }

  function applyTheme() {
    var t = document.documentElement.getAttribute("data-theme");
  }

  // ---------------------------------------------------------------- init
  var MAPS = null;
  var mapId = "casa";

  function setMap(id) {
    var m = MAPS.maps.find(function (x) {
      return x.id === id;
    });
    if (!m) return;
    mapId = id;
    rooms = m.rooms;
    WALLS_BT = m.wallsBT;
    dbmMax = m.dbmMax;
    B = bounds();
    optimalName = null;
    router = { x: rooms[0].cx, y: rooms[0].cy };
    rep = null;
    buildCells();
    sizeCanvas();
    render();
    renderScores(
      rooms.map(function (r) {
        return r.dBm;
      }),
    );
    log("🗺️ Map: " + m.label);
  }

  fetch("data/maps.json")
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      MAPS = d;
      setMap("casa");
      applyTheme();
      wireGuide();
      wire();
      wireCanvas();
      sizeCanvas();
      log("📡 Measured mode — real scan of the house's own 5 GHz network.");
      log("🧪 Switch to Simulate and drag the router to find the best spot!");
      render();
      renderScores(
        rooms.map(function (r) {
          return r.dBm;
        }),
      );
    })
    .catch(function (e) {
      document.body.innerHTML =
        "<p style='padding:20px'>Failed to load data: " + e + "</p>";
    });
})();
