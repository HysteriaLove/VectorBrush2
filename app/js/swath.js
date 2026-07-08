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
   * Returns { loop, path }:
   *   loop — closed outline geometry [{ax,ay,cx,cy,bx,by}], integer twips.
   *   path — the thinned drag polyline. The TRUE swept region is
   *          "within radius of path"; callers must classify against that
   *          distance, not the loop's winding (concave joins give the
   *          loop tiny backward lobes where winding cancels to zero).
   * Single point → a full circle (a "dab").
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
      return { loop: roundLoop(raw), path: pts };
    }

    // Per-segment direction angles.
    var segs = [];
    for (var s = 0; s + 1 < pts.length; s++) {
      segs.push(Math.atan2(pts[s + 1].y - pts[s].y, pts[s + 1].x - pts[s].x));
    }

    // Sides are built join-aware so the loop stays SIMPLE (no bowties):
    //   convex vertex  → round join arc on the true outer contour;
    //   concave vertex → the two offset lines meet at the miter point,
    //     which sits exactly on the swept region's boundary. Emitting
    //     naive per-segment offsets instead crosses them in a bowtie
    //     whose fragments hug the radius contour and defeat any local
    //     inside/outside classification (the open-fill-chain eraser bug);
    //   near-reversals (miter denominator collapses) → direct chord; its
    //     flap dives deep inside the swath where the distance test
    //     rejects it decisively.
    var n = segs.length;

    function offsetPt(v, angle) {
      return { x: pts[v].x + radius * Math.cos(angle), y: pts[v].y + radius * Math.sin(angle) };
    }

    // The miter point — the intersection of the two offset lines — lies
    // EXACTLY on the swept region's contour (distance r from both legs),
    // so it is true boundary at any turn sharpness. What is NOT on the
    // contour is a long straight segment leading to a far miter point:
    // it sags inside and its pieces then classify as interior and drop,
    // leaving boundary gaps that render as fill wedges. Hence sharp
    // concave turns are subdivided into small steps (see buildSide).
    function miterPt(v, a0, a1) {
      var n0x = Math.cos(a0), n0y = Math.sin(a0);
      var n1x = Math.cos(a1), n1y = Math.sin(a1);
      var denom = 1 + n0x * n1x + n0y * n1y;
      if (denom < 0.05) return null; // ~180°: legs fold onto themselves
      var s = radius / denom;
      return { x: pts[v].x + (n0x + n1x) * s, y: pts[v].y + (n0y + n1y) * s };
    }

    // side: +1 = left of travel (walked forward), -1 = right (walked backward)
    function buildSide(side) {
      var offAngle = function (s) { return segs[s] + (side > 0 ? -1 : 1) * Math.PI / 2; };
      var first = side > 0 ? 0 : n - 1;
      var cur = offsetPt(side > 0 ? 0 : n, offAngle(first));
      for (var k = 0; k < n; k++) {
        var s = side > 0 ? k : n - 1 - k;
        var a = offAngle(s);
        var segEnd = offsetPt(side > 0 ? s + 1 : s, a);
        if (k === n - 1) {
          raw.push({ ax: cur.x, ay: cur.y, cx: null, cy: null, bx: segEnd.x, by: segEnd.y });
          break;
        }
        var sNext = side > 0 ? s + 1 : s - 1;
        var aNext = offAngle(sNext);
        var sweep = norm(aNext - a);
        var vertex = side > 0 ? s + 1 : s;
        if (Math.abs(sweep) < 1e-3) {
          raw.push({ ax: cur.x, ay: cur.y, cx: null, cy: null, bx: segEnd.x, by: segEnd.y });
          cur = segEnd;
          continue;
        }
        // With sweep measured along the walk, positive sweep = outer side
        // on BOTH sides (the walk keeps the swath on the same hand).
        var convex = sweep > 0;
        if (convex) {
          raw.push({ ax: cur.x, ay: cur.y, cx: null, cy: null, bx: segEnd.x, by: segEnd.y });
          arcQuads(raw, pts[vertex].x, pts[vertex].y, radius, a, a + sweep);
          cur = offsetPt(vertex, aNext);
        } else {
          // Concave join: a subdivided miter fan, trimmed like a single
          // miter (offsets run straight to the first sub-miter — the
          // overshoot past the crossing is never emitted). Each
          // sub-miter point sits exactly on the contour; ≤20° steps keep
          // the connecting segments' inward sag under ~2tw so every
          // piece stays ON the boundary and survives classification.
          var steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 9)));
          var prevA = a;
          for (var st = 1; st <= steps; st++) {
            var ai = a + sweep * (st / steps);
            var mp = miterPt(vertex, prevA, ai);
            if (mp) {
              raw.push({ ax: cur.x, ay: cur.y, cx: null, cy: null, bx: mp.x, by: mp.y });
              cur = mp;
            }
            prevA = ai;
          }
        }
      }
    }

    buildSide(1); // left, forward

    // End cap: half circle from the left offset around to the right.
    arcQuads(raw, pts[n].x, pts[n].y, radius,
      segs[n - 1] - Math.PI / 2, segs[n - 1] + Math.PI / 2);

    buildSide(-1); // right, backward

    // Start cap: half circle from the right offset back to the left.
    arcQuads(raw, pts[0].x, pts[0].y, radius,
      segs[0] + Math.PI / 2, segs[0] + 3 * Math.PI / 2);

    return { loop: roundLoop(raw), path: pts };
  }

  // Distance from a point to the drag polyline — the exact inside test
  // for the swept region: inside ⇔ distToPath ≤ radius.
  function distToPath(path, px, py) {
    if (path.length === 1) {
      return Math.hypot(path[0].x - px, path[0].y - py);
    }
    var best = Infinity;
    for (var i = 0; i + 1 < path.length; i++) {
      best = Math.min(best, VB.geom.distToSegment(
        px, py, path[i].x, path[i].y, path[i + 1].x, path[i + 1].y));
    }
    return best;
  }

  // Round to integer twips and force exact continuity around the loop.
  // Also cancels out-and-back jitter: joins can round into A→B followed
  // immediately by B→A (a zero-width spur). Such a pair is parity-null
  // but poisons the fill-chain welder — both pieces normalize to the
  // SAME direction, so traversal dead-ends at the spur tip and the
  // boundary fragments (rendered as chord wedges once stitched).
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
      var prev = out[out.length - 1];
      if (prev && prev.ax === e.bx && prev.ay === e.by &&
          prev.bx === e.ax && prev.by === e.ay) {
        out.pop(); // A→B, B→A: cancel the spur; continuity holds at A
        continue;
      }
      out.push(e);
    }
    return out;
  }

  // Cancels micro out-and-back pairs among classified boundary pieces:
  // noding + rounding can leave two tiny pieces spanning the same 1-2tw
  // segment in opposite directions. Such a pair nulls the boundary's
  // parity locally AND dead-ends the fill-chain welder (both normalize
  // to the same direction), fragmenting the boundary into open chains.
  // Removing both restores continuity through their shared base point.
  function cancelMicroSpurs(piecesList) {
    var MAX_SPUR = 6; // twips
    var byKey = new Map();
    var dead = new Set();
    for (var i = 0; i < piecesList.length; i++) {
      var e = piecesList[i];
      if (Math.hypot(e.bx - e.ax, e.by - e.ay) > MAX_SPUR) continue;
      var revKey = e.bx + "," + e.by + "|" + e.ax + "," + e.ay;
      var partner = byKey.get(revKey);
      if (partner !== undefined && !dead.has(partner)) {
        dead.add(partner);
        dead.add(i);
        continue;
      }
      byKey.set(e.ax + "," + e.ay + "|" + e.bx + "," + e.by, i);
    }
    if (dead.size === 0) return piecesList;
    return piecesList.filter(function (_, i) { return !dead.has(i); });
  }

  // Prunes dead-end boundary whiskers among classified pieces. Noding +
  // rounding over retraced outline stretches can leave short knots whose
  // strands point INTO a tip (2-in/0-out when normalized to walk with
  // their fill on the right) — the chain welder dead-ends there and the
  // boundary fragments. Iteratively remove short single-sided pieces
  // whose normalized end no other piece continues.
  function pruneDeadEnds(piecesList, doc) {
    var MAX_WHISKER = 40; // twips
    var alive = piecesList.slice();
    for (var pass = 0; pass < 8; pass++) {
      // fill -> Set of normalized start keys a chain can continue from:
      // the alive pieces AND the existing document (boundary chains hand
      // off onto surviving old edges — those junctions are NOT dead ends).
      var starts = new Map();
      function addStart(f, key) {
        var set = starts.get(f);
        if (!set) { set = new Set(); starts.set(f, set); }
        set.add(key);
      }
      alive.forEach(function (e) {
        if (e.fill1 > 0) addStart(e.fill1, e.ax + "," + e.ay);
        if (e.fill0 > 0) addStart(e.fill0, e.bx + "," + e.by);
      });
      if (doc) {
        doc.edges.forEach(function (e) {
          if (e.fill1 > 0) addStart(e.fill1, e.ax + "," + e.ay);
          if (e.fill0 > 0) addStart(e.fill0, e.bx + "," + e.by);
        });
      }
      var removed = false;
      alive = alive.filter(function (e) {
        var single = (e.fill0 > 0) !== (e.fill1 > 0);
        if (!single) return true;
        if (Math.hypot(e.bx - e.ax, e.by - e.ay) > MAX_WHISKER) return true;
        var f = e.fill1 > 0 ? e.fill1 : e.fill0;
        var endKey = e.fill1 > 0 ? (e.bx + "," + e.by) : (e.ax + "," + e.ay);
        if (starts.get(f) && starts.get(f).has(endKey)) return true;
        removed = true;
        return false;
      });
      if (!removed) break;
    }
    return alive;
  }

  window.VB = window.VB || {};
  VB.buildSwath = buildSwath;
  VB.distToPath = distToPath;
  VB.cancelMicroSpurs = cancelMicroSpurs;
  VB.pruneDeadEnds = pruneDeadEnds;
})();
