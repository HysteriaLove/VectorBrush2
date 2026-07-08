/* paperglue.js — paper.js (vendored, v0.12.18) as the boolean geometry
 * engine.
 *
 * The swept region of a brush/eraser drag is the union of one capsule
 * per pen-path segment. paper.js computes that union exactly (circular
 * arcs, winding-rule crossing resolution — see paper.js
 * src/path/PathItem.Boolean.js), replacing the hand-rolled outline
 * classification that kept fragmenting on self-crossing strokes.
 *
 * The united boundary comes back as many small cubic fragments (slivers
 * of each capsule's arcs), so each loop is arclength-sampled and
 * curve-fit to quadratics — the Brush*.swf references show Flash stores
 * stroke outlines exactly like that: a whole stroke is 14-26 fitted
 * quads. Everything stays in integer twips.
 */
(function () {
  "use strict";

  var scope = null;
  function ensureScope() {
    if (scope) return scope;
    scope = new paper.PaperScope();
    // Off-DOM canvas: we only use the geometry classes, never the view.
    var cv = document.createElement("canvas");
    cv.width = 8; cv.height = 8;
    scope.setup(cv);
    return scope;
  }

  // One capsule (stadium) covering the segment p→q with the given radius,
  // as a closed clockwise paper path. Zero-length segments get a circle.
  function capsule(p, q, radius) {
    var s = ensureScope();
    var dx = q.x - p.x, dy = q.y - p.y;
    var len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      return new s.Path.Circle({ center: [p.x, p.y], radius: radius, insert: false });
    }
    dx /= len; dy /= len;
    var nx = -dy, ny = dx;
    var path = new s.Path({ insert: false });
    path.moveTo([p.x + nx * radius, p.y + ny * radius]);
    path.lineTo([q.x + nx * radius, q.y + ny * radius]);
    // cap around q: through q + r*dir
    path.arcTo([q.x + dx * radius, q.y + dy * radius],
               [q.x - nx * radius, q.y - ny * radius]);
    path.lineTo([p.x - nx * radius, p.y - ny * radius]);
    // cap around p: through p - r*dir
    path.arcTo([p.x - dx * radius, p.y - dy * radius],
               [p.x + nx * radius, p.y + ny * radius]);
    path.closePath();
    return path;
  }

  /**
   * The exact swept region of a drag: union of the per-segment capsules.
   * Returns a paper.PathItem (Path or CompoundPath), not inserted.
   *
   * Built with PAIRWISE unite() in a divide-and-conquer tree — the
   * documented, example-proven boolean path. (Feeding all capsules to one
   * CompoundPath and resolving crossings misorients enclosed pockets:
   * they come back clockwise like outers, i.e. filled, and the stroke's
   * loop interior floods.)
   */
  function sweptRegion(pathPts, radius) {
    var kids = [];
    if (pathPts.length === 1) {
      kids.push(capsule(pathPts[0], pathPts[0], radius));
    }
    for (var i = 0; i + 1 < pathPts.length; i++) {
      kids.push(capsule(pathPts[i], pathPts[i + 1], radius));
    }
    while (kids.length > 1) {
      var next = [];
      for (var k = 0; k + 1 < kids.length; k += 2) {
        var u = kids[k].unite(kids[k + 1], { insert: false });
        kids[k].remove();
        kids[k + 1].remove();
        next.push(u);
      }
      if (kids.length & 1) next.push(kids[kids.length - 1]);
      kids = next;
    }
    return kids[0];
  }

  // Closed loops of a path item as point lists (integer twips), sampled
  // by arclength. Degenerate slivers are dropped.
  function itemLoops(item, step) {
    var paths = item.children ? item.children : [item];
    var loops = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (!p.length || p.length < 4 * step) {
        if (Math.abs(p.area || 0) < 64) continue; // sub-8tw² sliver
      }
      var n = Math.max(8, Math.ceil(p.length / step));
      var pts = [];
      for (var k = 0; k < n; k++) {
        var pt = p.getPointAt(p.length * k / n);
        if (pt) pts.push({ x: pt.x, y: pt.y });
      }
      if (pts.length >= 3) loops.push(pts);
    }
    return loops;
  }

  /**
   * Swept region of a drag as LEAN closed quad loops (Flash-style fitted
   * outline records, integer twips). Returns an array of edge arrays —
   * one per boundary loop (outer boundaries and pocket holes alike),
   * each loop closed exactly. Fill claims are left 0 for the caller.
   */
  function sweptOutline(pathPts, radius, fitTol) {
    var region = sweptRegion(pathPts, radius);
    if (!region) return [];
    var step = Math.min(40, Math.max(8, radius * 0.3));
    var loops = itemLoops(region, step);
    region.remove();
    var out = [];
    loops.forEach(function (pts) {
      pts.push({ x: pts[0].x, y: pts[0].y }); // close for the fitter
      var geoms = VB.fitStroke(pts, fitTol || 12);
      if (geoms.length === 0) return;
      geoms[geoms.length - 1].bx = geoms[0].ax; // exact closure
      geoms[geoms.length - 1].by = geoms[0].ay;
      var loop = [];
      geoms.forEach(function (g) {
        // All-quad records, like the references: straight runs become
        // quads with the control at the midpoint (straightness stays
        // reserved for the phantom-chord tripwire).
        var cx = g.cx, cy = g.cy;
        if (cx === null) {
          cx = Math.round((g.ax + g.bx) / 2);
          cy = Math.round((g.ay + g.by) / 2);
        }
        var fe = VB.edge(g.ax, g.ay, cx, cy, g.bx, g.by, 0, 0, 0);
        if (!VB.edgeIsDegenerate(fe)) loop.push(fe);
      });
      if (loop.length) out.push(loop);
    });
    return out;
  }

  // ---- region-level boolean support -------------------------------------
  // The killer of every local coincidence rule: a re-traced contour fits
  // to a DIFFERENT near-coincident curve each time. So for same-color
  // painting the union is computed against the EXISTING region geometry
  // in paper space — where the boundary is unchanged, paper's boolean
  // reuses the input curves and the output converts back to the exact
  // original integer quads. No near-coincident duplicates can exist.

  // Directed boundary loops of a fill: edges carrying `fillIdx` on
  // exactly one side, oriented fill-on-right, welded into the fill's
  // FACE-BOUNDARY cycles. Continuation at a shared node must follow the
  // angular face-walk rule (rotational predecessor of the arrival
  // direction — same convention as faces.js): naive "first unused"
  // pairing builds self-crossing loops whose winding cancels, painted
  // fingers drop out of the union, and their area floods as fake holes.
  // Returns { loops: [[edge]], edges: Set } — open chains are dropped
  // (their edges stay untouched in the document).
  function fillLoops(doc, fillIdx) {
    var directed = [];
    doc.edges.forEach(function (e) {
      var f0 = e.fill0 === fillIdx, f1 = e.fill1 === fillIdx;
      if (f0 === f1) return; // not a boundary of this fill
      directed.push({
        src: e,
        ax: f1 ? e.ax : e.bx, ay: f1 ? e.ay : e.by,
        cx: e.cx, cy: e.cy,
        bx: f1 ? e.bx : e.ax, by: f1 ? e.by : e.ay
      });
    });
    function departAngle(x0, y0, cx, cy, x1, y1) {
      var tx = (cx !== null && (cx !== x0 || cy !== y0)) ? cx : x1;
      var ty = (cx !== null && (cx !== x0 || cy !== y0)) ? cy : y1;
      return Math.atan2(ty - y0, tx - x0);
    }
    var byStart = new Map();
    directed.forEach(function (d, i) {
      var k = d.ax + "," + d.ay;
      var arr = byStart.get(k);
      if (!arr) { arr = []; byStart.set(k, arr); }
      arr.push({ i: i, angle: departAngle(d.ax, d.ay, d.cx, d.cy, d.bx, d.by) });
    });
    byStart.forEach(function (arr) {
      arr.sort(function (a, b) { return a.angle - b.angle; });
    });
    var used = new Array(directed.length).fill(false);
    var loops = [], edges = new Set();
    for (var i = 0; i < directed.length; i++) {
      if (used[i]) continue;
      var chain = [directed[i]];
      used[i] = true;
      for (;;) {
        var tail = chain[chain.length - 1];
        if (tail.bx === chain[0].ax && tail.by === chain[0].ay) break;
        var cands = byStart.get(tail.bx + "," + tail.by);
        var next = -1;
        if (cands && cands.length) {
          // angle pointing BACK along the arriving edge, from its end
          var back = departAngle(tail.bx, tail.by, tail.cx, tail.cy, tail.ax, tail.ay);
          // rotational predecessor of `back`: largest angle < back (wrap)
          var best = -1, bestAngle = -Infinity, wrap = -1, wrapAngle = -Infinity;
          for (var c = 0; c < cands.length; c++) {
            if (used[cands[c].i]) continue;
            var a = cands[c].angle;
            if (a < back && a > bestAngle) { bestAngle = a; best = cands[c].i; }
            if (a > wrapAngle) { wrapAngle = a; wrap = cands[c].i; }
          }
          next = best >= 0 ? best : wrap;
        }
        if (next < 0) break;
        used[next] = true;
        chain.push(directed[next]);
      }
      var closed = chain.length &&
        chain[chain.length - 1].bx === chain[0].ax &&
        chain[chain.length - 1].by === chain[0].ay;
      if (closed) {
        loops.push(chain);
        chain.forEach(function (d) { edges.add(d.src); });
      }
    }
    return { loops: loops, edges: edges };
  }

  // Exact quad -> cubic elevation of a directed loop into a paper.Path.
  function loopToPath(loop) {
    var s = ensureScope();
    var segs = [];
    var n = loop.length;
    for (var i = 0; i < n; i++) {
      var cur = loop[i], prev = loop[(i + n - 1) % n];
      var hin = { x: 0, y: 0 }, hout = { x: 0, y: 0 };
      if (prev.cx !== null) {
        hin = { x: (prev.cx - cur.ax) * 2 / 3, y: (prev.cy - cur.ay) * 2 / 3 };
      }
      if (cur.cx !== null) {
        hout = { x: (cur.cx - cur.ax) * 2 / 3, y: (cur.cy - cur.ay) * 2 / 3 };
      }
      segs.push(new s.Segment(new s.Point(cur.ax, cur.ay),
                              new s.Point(hin.x, hin.y),
                              new s.Point(hout.x, hout.y)));
    }
    return new s.Path({ segments: segs, closed: true, insert: false });
  }

  function quadSig(ax, ay, cx, cy, bx, by) {
    return ax + "," + ay + "," + cx + "," + cy + "," + bx + "," + by;
  }

  // paper item -> integer-twip quad edges, Flash-lean:
  //  - a boolean output curve that IS one of the input quads (paper
  //    reuses non-intersected curves, so degree-elevation recovers the
  //    original integer quad bit-exactly — matched against `exactSigs`)
  //    passes through EXACTLY. This is the anti-coincidence guarantee:
  //    unchanged boundary keeps its unchanged records.
  //  - everything else (capsule arc slivers, split remainders) is
  //    arclength-sampled per contiguous run and curve-fit to lean quads,
  //    pinned at the run's endpoints.
  function itemToQuads(item, exactSigs) {
    var sigs = exactSigs || new Set();
    var paths = item.children ? item.children : [item];
    var out = [];
    // Cubic -> quads by recovery, splitting until the reduction converges.
    function emitCubic(x0, y0, x1, y1, x2, y2, x3, y3, depth, sink) {
      var qax = (3 * x1 - x0) / 2, qay = (3 * y1 - y0) / 2;
      var qbx = (3 * x2 - x3) / 2, qby = (3 * y2 - y3) / 2;
      if (depth >= 4 || Math.hypot(qax - qbx, qay - qby) <= 3) {
        sink.push({ ax: x0, ay: y0, cx: (qax + qbx) / 2, cy: (qay + qby) / 2,
                    bx: x3, by: y3 });
        return;
      }
      var mx01 = (x0 + x1) / 2, my01 = (y0 + y1) / 2;
      var mx12 = (x1 + x2) / 2, my12 = (y1 + y2) / 2;
      var mx23 = (x2 + x3) / 2, my23 = (y2 + y3) / 2;
      var mxa = (mx01 + mx12) / 2, mya = (my01 + my12) / 2;
      var mxb = (mx12 + mx23) / 2, myb = (my12 + my23) / 2;
      var mx = (mxa + mxb) / 2, my = (mya + myb) / 2;
      emitCubic(x0, y0, mx01, my01, mxa, mya, mx, my, depth + 1, sink);
      emitCubic(mx, my, mxb, myb, mx23, my23, x3, y3, depth + 1, sink);
    }
    paths.forEach(function (p) {
      if (!p.curves || p.curves.length === 0) return;
      // Tiny loops (small pockets) must survive EXACTLY — run-fitting a
      // sub-600tw hole distorts or degenerates it, and a lost hole loop
      // floods its pocket. Convert per-curve instead.
      var tiny = p.length < 600;
      var raw = []; // {exact} quads in float twips, in loop order
      var run = []; // sample points of the pending NEW run
      function flushRun() {
        if (run.length < 2) { run = []; return; }
        var geoms = VB.fitStroke(run, 12);
        geoms.forEach(function (g) {
          var cx = g.cx === null ? (g.ax + g.bx) / 2 : g.cx;
          var cy = g.cy === null ? (g.ay + g.by) / 2 : g.cy;
          raw.push({ ax: g.ax, ay: g.ay, cx: cx, cy: cy, bx: g.bx, by: g.by });
        });
        run = [];
      }
      p.curves.forEach(function (curve) {
        var v = curve.getValues();
        // quad recovery via degree reduction
        var qax = (3 * v[2] - v[0]) / 2, qay = (3 * v[3] - v[1]) / 2;
        var qbx = (3 * v[4] - v[6]) / 2, qby = (3 * v[5] - v[7]) / 2;
        var rq = {
          ax: Math.round(v[0]), ay: Math.round(v[1]),
          cx: Math.round((qax + qbx) / 2), cy: Math.round((qay + qby) / 2),
          bx: Math.round(v[6]), by: Math.round(v[7])
        };
        if (Math.hypot(qax - qbx, qay - qby) <= 1.5 &&
            sigs.has(quadSig(rq.ax, rq.ay, rq.cx, rq.cy, rq.bx, rq.by))) {
          flushRun();
          raw.push({ ax: rq.ax, ay: rq.ay, cx: rq.cx, cy: rq.cy, bx: rq.bx, by: rq.by });
          return;
        }
        if (tiny) {
          emitCubic(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], 0, raw);
          return;
        }
        // NEW geometry: sample into the pending run
        if (run.length === 0) run.push({ x: v[0], y: v[1] });
        var len = curve.length || 0;
        var steps = Math.max(1, Math.min(8, Math.ceil(len / 25)));
        for (var s = 1; s <= steps; s++) {
          var pt = curve.getPointAtTime(s / steps);
          if (pt) run.push({ x: pt.x, y: pt.y });
        }
      });
      flushRun();
      // round to integer twips with forced continuity and exact closure
      var loop = [];
      var px = null, py = null;
      raw.forEach(function (g) {
        var ax = px === null ? Math.round(g.ax) : px;
        var ay = py === null ? Math.round(g.ay) : py;
        var bx = Math.round(g.bx), by = Math.round(g.by);
        px = bx; py = by;
        var fe = VB.edge(ax, ay, Math.round(g.cx), Math.round(g.cy), bx, by, 0, 0, 0);
        if (!VB.edgeIsDegenerate(fe)) loop.push(fe);
      });
      if (loop.length > 1) {
        loop[loop.length - 1].bx = loop[0].ax;
        loop[loop.length - 1].by = loop[0].ay;
        if (VB.edgeIsDegenerate(loop[loop.length - 1])) loop.pop();
      }
      if (loop.length > 1) out.push(loop);
    });
    return out;
  }

  /**
   * Union of a drag's swept region with a fill's existing region.
   * Returns { loops: [[edge]], replaced: Set(originalEdges) } — the new
   * boundary of fill `fillIdx` after painting, with unchanged stretches
   * preserved as the exact original integer quads.
   */
  function paintUnion(doc, pathPts, radius, fillIdx) {
    var region = sweptRegion(pathPts, radius);
    var strokeLoops = itemToQuads(region, null);
    var old = fillLoops(doc, fillIdx);
    // Exact signatures of every input quad (both traversal directions —
    // the boolean may reverse a loop): output curves matching one pass
    // through unchanged.
    var sigs = new Set();
    old.loops.forEach(function (loop) {
      loop.forEach(function (d) {
        var cx = d.cx === null ? Math.round((d.ax + d.bx) / 2) : d.cx;
        var cy = d.cy === null ? Math.round((d.ay + d.by) / 2) : d.cy;
        sigs.add(quadSig(d.ax, d.ay, cx, cy, d.bx, d.by));
        sigs.add(quadSig(d.bx, d.by, cx, cy, d.ax, d.ay));
      });
    });
    // ONE compound operand: outer loops and their holes together. Fill-
    // on-right orientation makes outers clockwise and holes counter-
    // clockwise, so the compound's nonzero interior IS the region with
    // its pockets. (Uniting loops one at a time treats each outer as a
    // solid disc and swallows every hole — consecutive strokes then
    // collapse the pockets.)
    var united = region;
    if (old.loops.length) {
      var s = ensureScope();
      var compound = new s.CompoundPath({
        children: old.loops.map(loopToPath),
        fillRule: "nonzero",
        insert: false
      });
      united = region.unite(compound, { insert: false });
      region.remove();
      compound.remove();
    }
    var loops = itemToQuads(united, sigs);
    united.remove();
    return { loops: loops, strokeLoops: strokeLoops, replaced: old.edges };
  }

  window.VB = window.VB || {};
  VB.paperScope = ensureScope;
  VB.sweptRegion = sweptRegion;
  VB.sweptOutline = sweptOutline;
  VB.paintUnion = paintUnion;
  VB.fillLoops = fillLoops; // exposed for diagnostics/tests
})();
