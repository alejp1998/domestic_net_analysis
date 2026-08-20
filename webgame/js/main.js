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
  var SCALE_M = 2.6;

  var PAL = {
    dark: {
      bg: "#0b0f19",
      floor: "#101a2c",
      wall: "#334155",
      wallEdge: "#475569",
      text: "#e2e8f0",
      muted: "#94a3b8",
      faint: "#64748b",
      router: "#f59e0b",
      routerEdge: "#b45309",
      rep: "#22d3ee",
      repEdge: "#0e7490",
      optimal: "#fbbf24",
      heat: [
        "#1e3a8a",
        "#0c4a6e",
        "#0e7490",
        "#06b6d4",
        "#34d399",
        "#fbbf24",
        "#f97316",
      ],
      panel: "#111c30",
      border: "rgba(255,255,255,0.1)",
    },
    light: {
      bg: "#f1f5f9",
      floor: "#f8fafc",
      wall: "#cbd5e1",
      wallEdge: "#94a3b8",
      text: "#0f172a",
      muted: "#475569",
      faint: "#64748b",
      router: "#f59e0b",
      routerEdge: "#b45309",
      rep: "#0891b2",
      repEdge: "#0e7490",
      optimal: "#d97706",
      heat: [
        "#dbeafe",
        "#e0f2fe",
        "#7dd3fc",
        "#22d3ee",
        "#34d399",
        "#fbbf24",
        "#f97316",
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
    var z = zoneAt(src.x, src.y);
    return rooms.map(function (r) {
      var d = dist(src, { x: r.cx, y: r.cy });
      var walls = WALLS_BT[z][r.zone];
      return dbmMax - (d * dbPerM + walls * dbPerWall);
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
      var xs = r.poly.map(function (p) { return p[0]; });
      var ys = r.poly.map(function (p) { return p[1]; });
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
        // corner-aware membership: a cell belongs to the room that contains
        // its center or most corners — avoids white slivers along room edges
        // where no cell CENTER lands inside the polygon
        var ri = -1;
        var best = 0;
        for (var r = 0; r < rooms.length; r++) {
          var cnt = 0;
          if (pointInPoly(cx, cy, rooms[r].poly)) cnt += 2;
          if (pointInPoly(cx0, cy0, rooms[r].poly)) cnt++;
          if (pointInPoly(cx0 + cw, cy0, rooms[r].poly)) cnt++;
          if (pointInPoly(cx0, cy0 + ch, rooms[r].poly)) cnt++;
          if (pointInPoly(cx0 + cw, cy0 + ch, rooms[r].poly)) cnt++;
          if (cnt > best) {
            best = cnt;
            ri = r;
          }
        }
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

  function cellDbm(c, dbPerM, dbPerWall, roomIdx) {
    var cxc = c.x + c.w / 2;
    var cyc = c.y + c.h / 2;
    var z = zoneAt(router.x, router.y);
    var d = Math.hypot(router.x - cxc, router.y - cyc);
    var dbm =
      dbmMax - (d * dbPerM + WALLS_BT[z][rooms[roomIdx].zone] * dbPerWall);
    if (repeaterOn && rep) {
      var zr = zoneAt(rep.x, rep.y);
      var dr = Math.hypot(rep.x - cxc, rep.y - cyc);
      var dbmr =
        dbmMax -
        (dr * dbPerM + WALLS_BT[zr][rooms[roomIdx].zone] * dbPerWall);
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
    var best = null,
      bestScore = -1;
    for (var i = 0; i < rooms.length; i++) {
      var src = { x: rooms[i].cx, y: rooms[i].cy };
      var z = rooms[i].zone;
      var dbms = rooms.map(function (r) {
        var d = dist(src, { x: r.cx, y: r.cy });
        return dbmMax - (d * dbPerM() + WALLS_BT[z][r.zone] * dbPerWall());
      });
      var s = roomScore(dbms);
      if (s > bestScore) {
        bestScore = s;
        best = rooms[i];
      }
    }
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

    // walls from the room POLYGONS: shared edges are thin interior walls,
    // outward-facing edges are the thick house outline (cells only fill)
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = p.wallEdge;
    ctx.beginPath();
    rooms.forEach(function (r) {
      var poly = r.poly;
      for (var e = 0; e < poly.length; e++) {
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
        var in1 = rooms.some(function (rr) {
          return pointInPoly(mx + nx * 0.03, my + ny * 0.03, rr.poly);
        });
        var in2 = rooms.some(function (rr) {
          return pointInPoly(mx - nx * 0.03, my - ny * 0.03, rr.poly);
        });
        var p1 = toPx(a[0], a[1]);
        var p2 = toPx(b[0], b[1]);
        if (in1 && in2) {
          ctx.moveTo(p1[0], p1[1]);
          ctx.lineTo(p2[0], p2[1]);
        }
      }
    });
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = p.text;
    ctx.beginPath();
    rooms.forEach(function (r) {
      var poly = r.poly;
      for (var e = 0; e < poly.length; e++) {
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
        var in1 = rooms.some(function (rr) {
          return pointInPoly(mx + nx * 0.03, my + ny * 0.03, rr.poly);
        });
        var in2 = rooms.some(function (rr) {
          return pointInPoly(mx - nx * 0.03, my - ny * 0.03, rr.poly);
        });
        if (in1 !== in2) {
          var p1 = toPx(a[0], a[1]);
          var p2 = toPx(b[0], b[1]);
          ctx.moveTo(p1[0], p1[1]);
          ctx.lineTo(p2[0], p2[1]);
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
    drawLegend(w, p);

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

  function drawLegend(w, p) {
    var lw = Math.min(230, w * 0.3);
    var lx = w - lw - 14;
    var ly = 14;
    ctx.fillStyle = p.panel + "dd";
    ctx.strokeStyle = p.border;
    ctx.beginPath();
    ctx.roundRect(lx, ly, lw, 46, 8);
    ctx.fill();
    ctx.stroke();
    var grad = ctx.createLinearGradient(lx + 10, 0, lx + lw - 10, 0);
    for (var i = 0; i < p.heat.length; i++)
      grad.addColorStop(i / (p.heat.length - 1), p.heat[i]);
    ctx.fillStyle = grad;
    ctx.fillRect(lx + 10, ly + 12, lw - 20, 10);
    ctx.fillStyle = p.muted;
    ctx.font = "10px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(Math.round(heatMax) + " dBm (best)", lx + 10, ly + 34);
    ctx.textAlign = "right";
    ctx.fillText(Math.round(heatMin) + " dBm", lx + lw - 10, ly + 34);
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
      if (mode !== "sim") return;
      var pos = canvasPos(e);
      var dr = dist(pos, router) * SCALE_M;
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
      optimalName = best.name;
      log(
        "✨ Optimal router location: " +
          best.name +
          " (zone " +
          best.zone +
          ") — mean predicted " +
          Math.round(predictedDbm(dbPerM(), dbPerWall())[rooms.indexOf(best)]) +
          " dBm in it.",
      );
      render();
      renderScores(predictedDbm(dbPerM(), dbPerWall()));
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
