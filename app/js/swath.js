/* swath.js — capsule-chain outlines: the swept area of a round tool.
 *
 * Given a drag polyline and a radius, builds the closed outline of the
 * swept disc as edge geometry (lines + quadratic arc segments, integer
 * twips): left offsets forward, a round end cap, right offsets backward,
 * a round start cap. Convex corners get round joins; concave corners
 * connect directly, which self-intersects — callers resolve that by
 * noding the loop (merge.nodeEdges) and classifying by signed winding
 * (geom.windingNumber), under which overlapping lobes stay "inside".
 *
 * The eraser subtracts this region; a future brush tool paints it.
 */
(function () {
  "use strict";

  var ARC_STEP = Math.PI / 4; // ≤45° per quadratic arc segment

  // Quadratic approximation of a circular arc from angle a0 to a1
  // (|a1-a0| ≤ ~90°): control point at the tangent intersection.
  function arcQuads(out, cx, cy, r, a0, a1) {
    var sweep = a1 - a0;
    var steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
    for (var i = 0; i < steps; i++) {
      var s0 = a0 + sweep * (i / steps);
      var s1 = a0 + sweep * ((i + 1) / steps);
      var mid = (s0 + s1) / 2;
      var cr = r / Math.cos((s1 - s0) / 2);
      out.push({
        ax: cx + r * Math.cos(s0), ay: cy + r * Math.sin(s0),
        cx: cx + cr * Math.cos(mid), cy: cy + cr * Math.sin(mid),
        bx: cx + r * Math.cos(s1), by: cy + r * Math.sin(s1)
      });
    }
  }

  function norm(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /**
   * Builds the swath outline. points in twips (floats ok), radius twips.
   * Returns closed loop geometry [{ax,ay,cx,cy,bx,by}] rounded to ints,
   * consistently oriented. Single point → a full circle (a "dab").
   */
  function buildSwath(points, radius) {
    // Thin the polyline: sub-radius jitter only bloats the outline.
    var pts = [];
    var minStep = Math.max(8, radius * 0.35);
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var last = pts[pts.length - 1];
      if (last) {
        var dx = p.x - last.x, dy = p.y - last.y;
        if (dx * dx + dy * dy < minStep * minStep) {
          if (i === points.length - 1 && pts.length > 1) pts[pts.length - 1] = p;
          continue;
        }
      }
      pts.push(p);
    }

    var raw = [];
    if (pts.length === 1) {
      // Dab: full circle in two half-arcs.
      arcQuads(raw, pts[0].x, pts[0].y, radius, 0, Math.PI);
      arcQuads(raw, pts[0].x, pts[0].y, radius, Math.PI, 2 * Math.PI);
      return roundLoop(raw);
    }

    // Per-segment direction angles.
    var segs = [];
    for (var s = 0; s + 1 < pts.length; s++) {
      segs.push(Math.atan2(pts[s + 1].y - pts[s].y, pts[s + 1].x - pts[s].x));
    }

    // Left side, forward. The left offset of direction θ sits at θ - 90°.
    // Every vertex gets a round join sweeping by the turn angle: on the
    // convex side that IS the outline; on the concave side the arc lies
    // inside the swept area and the winding cleanup discards it, so no
    // convexity analysis is needed.
    var n = segs.length;
    for (var f = 0; f < n; f++) {
      var aL = segs[f] - Math.PI / 2;
      raw.push({
        ax: pts[f].x + radius * Math.cos(aL), ay: pts[f].y + radius * Math.sin(aL),
        cx: null, cy: null,
        bx: pts[f + 1].x + radius * Math.cos(aL), by: pts[f + 1].y + radius * Math.sin(aL)
      });
      if (f + 1 < n) {
        var turn = norm(segs[f + 1] - segs[f]);
        if (Math.abs(turn) > 1e-3) {
          arcQuads(raw, pts[f + 1].x, pts[f + 1].y, radius, aL, aL + turn);
        }
      }
    }

    // End cap: half circle from the left offset around to the right.
    arcQuads(raw, pts[n].x, pts[n].y, radius,
      segs[n - 1] - Math.PI / 2, segs[n - 1] + Math.PI / 2);

    // Right side, backward. Right offset of direction θ is at θ + 90°.
    for (var b = n - 1; b >= 0; b--) {
      var aR = segs[b] + Math.PI / 2;
      raw.push({
        ax: pts[b + 1].x + radius * Math.cos(aR), ay: pts[b + 1].y + radius * Math.sin(aR),
        cx: null, cy: null,
        bx: pts[b].x + radius * Math.cos(aR), by: pts[b].y + radius * Math.sin(aR)
      });
      if (b > 0) {
        var turn2 = norm(segs[b - 1] - segs[b]);
        if (Math.abs(turn2) > 1e-3) {
          arcQuads(raw, pts[b].x, pts[b].y, radius, aR, aR + turn2);
        }
      }
    }

    // Start cap: half circle from the right offset back to the left.
    arcQuads(raw, pts[0].x, pts[0].y, radius,
      segs[0] + Math.PI / 2, segs[0] + 3 * Math.PI / 2);

    return roundLoop(raw);
  }

  // Round to integer twips and force exact continuity around the loop.
  function roundLoop(raw) {
    var out = [];
    var px = null, py = null;
    var firstX = null, firstY = null;
    for (var i = 0; i < raw.length; i++) {
      var g = raw[i];
      var ax = px === null ? Math.round(g.ax) : px;
      var ay = py === null ? Math.round(g.ay) : py;
      if (firstX === null) { firstX = ax; firstY = ay; }
      var isLast = i === raw.length - 1;
      var bx = isLast ? firstX : Math.round(g.bx);
      var by = isLast ? firstY : Math.round(g.by);
      var e = {
        ax: ax, ay: ay,
        cx: g.cx === null ? null : Math.round(g.cx),
        cy: g.cy === null ? null : Math.round(g.cy),
        bx: bx, by: by
      };
      px = bx; py = by;
      if (e.ax === e.bx && e.ay === e.by &&
          (e.cx === null || (e.cx === e.ax && e.cy === e.ay))) continue;
      out.push(e);
    }
    return out;
  }

  window.VB = window.VB || {};
  VB.buildSwath = buildSwath;
})();
