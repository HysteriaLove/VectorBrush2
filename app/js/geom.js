/* geom.js — exact-ish geometry on planar-map edges (integer twips).
 *
 * Curves are quadratic Béziers: B(t) = (1-t)²A + 2t(1-t)C + t²B.
 * Intersection results are float t-parameters; splitting rounds the new
 * anchors to integer twips (the same quantization Flash applies), with
 * both curves at a crossing forced to share the identical rounded point
 * so the planar map stays exactly welded.
 */
(function () {
  "use strict";

  var T_EPS = 1e-6;      // parameter-space epsilon
  var FLAT_TW = 0.08;    // subdivision flatness threshold (twips) — tight,
                         // because near-tangent crossings missed here become
                         // real crossings after integer rounding

  // ---- evaluation ----------------------------------------------------------

  function evalEdge(e, t) {
    if (e.cx === null) {
      return { x: e.ax + (e.bx - e.ax) * t, y: e.ay + (e.by - e.ay) * t };
    }
    var u = 1 - t;
    return {
      x: u * u * e.ax + 2 * u * t * e.cx + t * t * e.bx,
      y: u * u * e.ay + 2 * u * t * e.cy + t * t * e.by
    };
  }

  function edgeBBox(e) {
    var xmin = Math.min(e.ax, e.bx), xmax = Math.max(e.ax, e.bx);
    var ymin = Math.min(e.ay, e.by), ymax = Math.max(e.ay, e.by);
    if (e.cx !== null) {
      xmin = Math.min(xmin, e.cx); xmax = Math.max(xmax, e.cx);
      ymin = Math.min(ymin, e.cy); ymax = Math.max(ymax, e.cy);
    }
    return { xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax };
  }

  function bboxOverlap(a, b) {
    return a.xmin <= b.xmax && b.xmin <= a.xmax && a.ymin <= b.ymax && b.ymin <= a.ymax;
  }

  // ---- splitting -----------------------------------------------------------

  // Splits an edge at ascending t values. Each split may carry a forced
  // integer point (the shared crossing anchor); otherwise the evaluated
  // point is rounded. Styles are inherited. Degenerate slivers are dropped.
  function splitEdge(e, splits) {
    if (splits.length === 0) return [e];
    var out = [];
    if (e.cx === null) {
      var prev = { x: e.ax, y: e.ay };
      for (var i = 0; i <= splits.length; i++) {
        var end, pt;
        if (i === splits.length) {
          end = { x: e.bx, y: e.by };
        } else {
          pt = splits[i].point || evalEdge(e, splits[i].t);
          end = { x: Math.round(pt.x), y: Math.round(pt.y) };
        }
        out.push(VB.edge(prev.x, prev.y, null, null, end.x, end.y, e.fill0, e.fill1, e.line));
        prev = end;
      }
    } else {
      // Sequential de Casteljau on the remaining right-hand piece,
      // remapping each global t into the local parameter range.
      var cur = { ax: e.ax, ay: e.ay, cx: e.cx, cy: e.cy, bx: e.bx, by: e.by };
      var t0 = 0;
      for (var j = 0; j < splits.length; j++) {
        var tl = (splits[j].t - t0) / (1 - t0);
        var m0x = cur.ax + (cur.cx - cur.ax) * tl, m0y = cur.ay + (cur.cy - cur.ay) * tl;
        var m1x = cur.cx + (cur.bx - cur.cx) * tl, m1y = cur.cy + (cur.by - cur.cy) * tl;
        var px = m0x + (m1x - m0x) * tl, py = m0y + (m1y - m0y) * tl;
        var fp = splits[j].point;
        var jx = Math.round(fp ? fp.x : px), jy = Math.round(fp ? fp.y : py);
        out.push(VB.edge(
          Math.round(cur.ax), Math.round(cur.ay),
          Math.round(m0x), Math.round(m0y),
          jx, jy, e.fill0, e.fill1, e.line));
        cur = { ax: jx, ay: jy, cx: m1x, cy: m1y, bx: cur.bx, by: cur.by };
        t0 = splits[j].t;
      }
      out.push(VB.edge(
        Math.round(cur.ax), Math.round(cur.ay),
        Math.round(cur.cx), Math.round(cur.cy),
        Math.round(cur.bx), Math.round(cur.by),
        e.fill0, e.fill1, e.line));
    }
    return out.filter(function (s) { return !VB.edgeIsDegenerate(s); });
  }

  // ---- intersections -------------------------------------------------------

  // Line segment (p1->p2) vs line segment (p3->p4).
  // Returns null or {t, u} with t on the first segment, u on the second.
  function lineLine(x1, y1, x2, y2, x3, y3, x4, y4) {
    var d1x = x2 - x1, d1y = y2 - y1;
    var d2x = x4 - x3, d2y = y4 - y3;
    var denom = d1x * d2y - d1y * d2x;
    if (denom === 0) return null; // parallel/collinear: no transversal crossing
    var t = ((x3 - x1) * d2y - (y3 - y1) * d2x) / denom;
    var u = ((x3 - x1) * d1y - (y3 - y1) * d1x) / denom;
    if (t < -T_EPS || t > 1 + T_EPS || u < -T_EPS || u > 1 + T_EPS) return null;
    return { t: clamp01(t), u: clamp01(u) };
  }

  // Line segment vs quadratic: substitute the quad into the line's implicit
  // equation, solve the quadratic in s, then recover t by projection.
  function lineQuad(lx1, ly1, lx2, ly2, q) {
    var nx = ly2 - ly1, ny = lx1 - lx2; // line normal
    var c = -(nx * lx1 + ny * ly1);
    function f(x, y) { return nx * x + ny * y + c; }
    var f0 = f(q.ax, q.ay), f1 = f(q.cx, q.cy), f2 = f(q.bx, q.by);
    // f(B(s)) = (f0 - 2f1 + f2)s² + 2(f1 - f0)s + f0
    var A = f0 - 2 * f1 + f2, Bq = 2 * (f1 - f0), Cq = f0;
    var roots = solveQuadratic(A, Bq, Cq);
    var dx = lx2 - lx1, dy = ly2 - ly1;
    var lenSq = dx * dx + dy * dy;
    var hits = [];
    for (var i = 0; i < roots.length; i++) {
      var s = roots[i];
      if (s < -T_EPS || s > 1 + T_EPS) continue;
      s = clamp01(s);
      var p = evalEdge(q, s);
      var t = ((p.x - lx1) * dx + (p.y - ly1) * dy) / lenSq;
      if (t < -T_EPS || t > 1 + T_EPS) continue;
      hits.push({ t: clamp01(t), u: s, point: p });
    }
    return hits;
  }

  function solveQuadratic(a, b, c) {
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) < 1e-12) return [];
      return [-c / b];
    }
    var disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    var sq = Math.sqrt(disc);
    // Citardauq form for numerical stability
    var q = -0.5 * (b + (b >= 0 ? sq : -sq));
    var r = [];
    r.push(q / a);
    if (q !== 0) r.push(c / q);
    else r.push(q / a);
    return r;
  }

  function chordFlatness(q) {
    // distance of control point from the chord midpoint bound
    var mx = (q.ax + q.bx) / 2, my = (q.ay + q.by) / 2;
    return Math.max(Math.abs(q.cx - mx), Math.abs(q.cy - my));
  }

  function subdivideQuad(q) {
    var m0x = (q.ax + q.cx) / 2, m0y = (q.ay + q.cy) / 2;
    var m1x = (q.cx + q.bx) / 2, m1y = (q.cy + q.by) / 2;
    var mx = (m0x + m1x) / 2, my = (m0y + m1y) / 2;
    return [
      { ax: q.ax, ay: q.ay, cx: m0x, cy: m0y, bx: mx, by: my, cxNull: false },
      { ax: mx, ay: my, cx: m1x, cy: m1y, bx: q.bx, by: q.by, cxNull: false }
    ];
  }

  // Quad vs quad by recursive subdivision with bbox pruning.
  // Returns [{t, u, point}] with t on qa, u on qb.
  function quadQuad(qa, qb) {
    var hits = [];
    function bbox(q) {
      return {
        xmin: Math.min(q.ax, q.cx, q.bx), xmax: Math.max(q.ax, q.cx, q.bx),
        ymin: Math.min(q.ay, q.cy, q.by), ymax: Math.max(q.ay, q.cy, q.by)
      };
    }
    function recurse(a, ta0, ta1, b, tb0, tb1, depth) {
      if (!bboxOverlap(bbox(a), bbox(b))) return;
      var flatA = chordFlatness(a) <= FLAT_TW, flatB = chordFlatness(b) <= FLAT_TW;
      if ((flatA && flatB) || depth > 24) {
        var ll = lineLine(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
        if (ll) {
          hits.push({
            t: ta0 + (ta1 - ta0) * ll.t,
            u: tb0 + (tb1 - tb0) * ll.u
          });
        }
        return;
      }
      if (!flatA && (flatB || chordFlatness(a) >= chordFlatness(b))) {
        var sa = subdivideQuad(a), tm = (ta0 + ta1) / 2;
        recurse(sa[0], ta0, tm, b, tb0, tb1, depth + 1);
        recurse(sa[1], tm, ta1, b, tb0, tb1, depth + 1);
      } else {
        var sb = subdivideQuad(b), um = (tb0 + tb1) / 2;
        recurse(a, ta0, ta1, sb[0], tb0, um, depth + 1);
        recurse(a, ta0, ta1, sb[1], um, tb1, depth + 1);
      }
    }
    recurse(
      { ax: qa.ax, ay: qa.ay, cx: qa.cx, cy: qa.cy, bx: qa.bx, by: qa.by }, 0, 1,
      { ax: qb.ax, ay: qb.ay, cx: qb.cx, cy: qb.cy, bx: qb.bx, by: qb.by }, 0, 1, 0);
    // Merge near-duplicate hits from subdivision boundaries.
    hits.sort(function (h1, h2) { return h1.t - h2.t; });
    var merged = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.t - h.t) < 1e-4 && Math.abs(prev.u - h.u) < 1e-4) continue;
      h.point = evalEdge(qa, h.t);
      merged.push(h);
    }
    return merged;
  }

  // All transversal intersections between two edges: [{t, u, point}].
  // preChecked: caller already did a bbox rejection with its own cached
  // boxes — skip re-allocating two boxes per tested pair here.
  function edgeIntersections(ea, eb, preChecked) {
    if (!preChecked && !bboxOverlap(edgeBBox(ea), edgeBBox(eb))) return [];
    var hits;
    if (ea.cx === null && eb.cx === null) {
      var ll = lineLine(ea.ax, ea.ay, ea.bx, ea.by, eb.ax, eb.ay, eb.bx, eb.by);
      hits = ll ? [{ t: ll.t, u: ll.u }] : [];
      hits.forEach(function (h) { h.point = evalEdge(ea, h.t); });
    } else if (ea.cx === null) {
      hits = lineQuad(ea.ax, ea.ay, ea.bx, ea.by, eb).map(function (h) {
        return { t: h.t, u: h.u, point: h.point };
      });
    } else if (eb.cx === null) {
      hits = lineQuad(eb.ax, eb.ay, eb.bx, eb.by, ea).map(function (h) {
        return { t: h.u, u: h.t, point: h.point };
      });
    } else {
      hits = quadQuad(ea, eb);
    }
    return hits;
  }

  // ---- point-in-fill (parity) ----------------------------------------------

  // Parity of +x ray crossings for one fill style over the planar map.
  // Only boundary edges count: edges with the fill on exactly one side.
  // Robust straddle rule: a monotonic piece crosses iff its endpoints'
  // y-values straddle py strictly (shared vertices count once).
  function fillParity(edges, fillIdx, px, py) {
    var crossings = 0;
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var onBoundary = (e.fill0 === fillIdx) !== (e.fill1 === fillIdx);
      if (!onBoundary) continue;
      if (e.cx === null) {
        crossings += lineRay(e.ax, e.ay, e.bx, e.by, px, py);
      } else {
        // conservative reject before any quad math (controls bound the arc)
        if (py < e.ay && py < e.cy && py < e.by) continue;
        if (py > e.ay && py > e.cy && py > e.by) continue;
        if (px > e.ax && px > e.cx && px > e.bx) continue;
        // split into y-monotonic pieces at dy/dt = 0
        var denom = e.ay - 2 * e.cy + e.by;
        var tExt = denom !== 0 ? (e.ay - e.cy) / denom : -1;
        var ts = [0];
        if (tExt > T_EPS && tExt < 1 - T_EPS) ts.push(tExt);
        ts.push(1);
        for (var s = 0; s + 1 < ts.length; s++) {
          crossings += quadRayMonotonic(e, ts[s], ts[s + 1], px, py);
        }
      }
    }
    return crossings & 1;
  }

  function lineRay(x1, y1, x2, y2, px, py) {
    if ((y1 > py) === (y2 > py)) return 0;
    var t = (py - y1) / (y2 - y1);
    return (x1 + (x2 - x1) * t) > px ? 1 : 0;
  }

  function quadRayMonotonic(e, t0, t1, px, py) {
    var p0 = evalEdge(e, t0), p1 = evalEdge(e, t1);
    if ((p0.y > py) === (p1.y > py)) return 0;
    // y(t) = py within [t0, t1]
    var A = e.ay - 2 * e.cy + e.by;
    var B = 2 * (e.cy - e.ay);
    var C = e.ay - py;
    var roots = solveQuadratic(A, B, C);
    for (var i = 0; i < roots.length; i++) {
      var t = roots[i];
      if (t >= t0 - 1e-9 && t <= t1 + 1e-9) {
        return evalEdge(e, Math.min(1, Math.max(0, t))).x > px ? 1 : 0;
      }
    }
    return 0;
  }

  // Signed winding number of a point against a DIRECTED edge list (a
  // closed loop, e.g. an eraser swath outline). Downward crossings
  // (y increasing) count +1, upward -1. Nonzero = inside under the
  // nonzero rule, which is what a self-overlapping capsule chain needs.
  function windingNumber(loopEdges, px, py) {
    var w = 0;
    for (var i = 0; i < loopEdges.length; i++) {
      var e = loopEdges[i];
      if (e.cx === null) {
        if ((e.ay > py) !== (e.by > py)) {
          var t = (py - e.ay) / (e.by - e.ay);
          if (e.ax + (e.bx - e.ax) * t > px) w += (e.by > e.ay) ? 1 : -1;
        }
      } else {
        // conservative reject before any quad math (controls bound the arc)
        if (py < e.ay && py < e.cy && py < e.by) continue;
        if (py > e.ay && py > e.cy && py > e.by) continue;
        if (px > e.ax && px > e.cx && px > e.bx) continue;
        var denom = e.ay - 2 * e.cy + e.by;
        var tExt = denom !== 0 ? (e.ay - e.cy) / denom : -1;
        var ts = [0];
        if (tExt > T_EPS && tExt < 1 - T_EPS) ts.push(tExt);
        ts.push(1);
        for (var s = 0; s + 1 < ts.length; s++) {
          var p0 = evalEdge(e, ts[s]), p1 = evalEdge(e, ts[s + 1]);
          if ((p0.y > py) === (p1.y > py)) continue;
          var roots = solveQuadratic(e.ay - 2 * e.cy + e.by, 2 * (e.cy - e.ay), e.ay - py);
          for (var r2 = 0; r2 < roots.length; r2++) {
            var t2 = roots[r2];
            if (t2 >= ts[s] - 1e-9 && t2 <= ts[s + 1] + 1e-9) {
              if (evalEdge(e, Math.min(1, Math.max(0, t2))).x > px) {
                w += (p1.y > p0.y) ? 1 : -1;
              }
              break;
            }
          }
        }
      }
    }
    return w;
  }

  // Precompiled winding test for a FIXED closed-loop set: the loops'
  // bbox is computed once, and any query outside it is a 4-compare
  // reject (a closed loop's winding is 0 on every side of its bbox).
  // Mask pipelines ask "is this point inside the op?" once per document
  // edge and once per face — most of those points are nowhere near the
  // op, so the reject carries the bulk of the load.
  function windingOracle(loopEdges) {
    var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (var i = 0; i < loopEdges.length; i++) {
      var e = loopEdges[i];
      if (e.ax < xmin) xmin = e.ax; if (e.ax > xmax) xmax = e.ax;
      if (e.bx < xmin) xmin = e.bx; if (e.bx > xmax) xmax = e.bx;
      if (e.ay < ymin) ymin = e.ay; if (e.ay > ymax) ymax = e.ay;
      if (e.by < ymin) ymin = e.by; if (e.by > ymax) ymax = e.by;
      if (e.cx !== null) {
        if (e.cx < xmin) xmin = e.cx; if (e.cx > xmax) xmax = e.cx;
        if (e.cy < ymin) ymin = e.cy; if (e.cy > ymax) ymax = e.cy;
      }
    }
    return {
      bbox: { xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax },
      at: function (x, y) {
        if (x < xmin || x > xmax || y < ymin || y > ymax) return 0;
        return windingNumber(loopEdges, x, y);
      }
    };
  }

  // Which fill contains the point (0 = none). In a consistent planar map at
  // most one fill has odd parity.
  function fillAt(doc, px, py) {
    for (var f = doc.fills.length; f >= 1; f--) {
      if (fillParity(doc.edges, f, px, py)) return f;
    }
    return 0;
  }

  // ---- distance (UI hit-testing) --------------------------------------------

  function distToEdge(e, px, py) {
    if (e.cx === null) {
      return distToSegment(px, py, e.ax, e.ay, e.bx, e.by);
    }
    // coarse sample + local refine — plenty for pointer tolerance
    var best = Infinity, bt = 0;
    for (var i = 0; i <= 16; i++) {
      var t = i / 16;
      var p = evalEdge(e, t);
      var d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
      if (d < best) { best = d; bt = t; }
    }
    var lo = Math.max(0, bt - 1 / 16), hi = Math.min(1, bt + 1 / 16);
    for (var k = 0; k < 20; k++) {
      var m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      var q1 = evalEdge(e, m1), q2 = evalEdge(e, m2);
      var d1 = (q1.x - px) * (q1.x - px) + (q1.y - py) * (q1.y - py);
      var d2 = (q2.x - px) * (q2.x - px) + (q2.y - py) * (q2.y - py);
      if (d1 < d2) hi = m2; else lo = m1;
      best = Math.min(best, d1, d2);
    }
    return Math.sqrt(best);
  }

  // Closest point on an edge to (px,py): {t, x, y, d}.
  // Coarse sampling + ternary refinement — used for endpoint snapping and
  // pointer hit-testing, where sub-twip exactness is not required.
  function nearestOnEdge(e, px, py) {
    if (e.cx === null) {
      var dx = e.bx - e.ax, dy = e.by - e.ay;
      var lenSq = dx * dx + dy * dy;
      var t0 = lenSq === 0 ? 0 : ((px - e.ax) * dx + (py - e.ay) * dy) / lenSq;
      t0 = clamp01(t0);
      var qx = e.ax + dx * t0, qy = e.ay + dy * t0;
      return { t: t0, x: qx, y: qy, d: Math.hypot(qx - px, qy - py) };
    }
    var bt = 0, best = Infinity;
    for (var i = 0; i <= 16; i++) {
      var t = i / 16;
      var p = evalEdge(e, t);
      var d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
      if (d < best) { best = d; bt = t; }
    }
    var lo = Math.max(0, bt - 1 / 16), hi = Math.min(1, bt + 1 / 16);
    for (var k = 0; k < 24; k++) {
      var m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      var p1 = evalEdge(e, m1), p2 = evalEdge(e, m2);
      var d1 = (p1.x - px) * (p1.x - px) + (p1.y - py) * (p1.y - py);
      var d2 = (p2.x - px) * (p2.x - px) + (p2.y - py) * (p2.y - py);
      if (d1 < d2) hi = m2; else lo = m1;
    }
    var tf = (lo + hi) / 2;
    var pf = evalEdge(e, tf);
    return { t: tf, x: pf.x, y: pf.y, d: Math.hypot(pf.x - px, pf.y - py) };
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var lenSq = dx * dx + dy * dy;
    var t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.min(1, Math.max(0, t));
    var qx = x1 + dx * t - px, qy = y1 + dy * t - py;
    return Math.sqrt(qx * qx + qy * qy);
  }

  function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

  window.VB = window.VB || {};
  VB.geom = {
    evalEdge: evalEdge,
    edgeBBox: edgeBBox,
    bboxOverlap: bboxOverlap,
    splitEdge: splitEdge,
    edgeIntersections: edgeIntersections,
    solveQuadratic: solveQuadratic,
    fillParity: fillParity,
    fillAt: fillAt,
    windingNumber: windingNumber,
    windingOracle: windingOracle,
    distToEdge: distToEdge,
    distToSegment: distToSegment,
    nearestOnEdge: nearestOnEdge
  };
})();
