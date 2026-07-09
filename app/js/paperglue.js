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
  function buildCapsules(pathPts, radius) {
    var kids = [];
    if (pathPts.length === 1) {
      kids.push(capsule(pathPts[0], pathPts[0], radius));
    }
    for (var i = 0; i + 1 < pathPts.length; i++) {
      kids.push(capsule(pathPts[i], pathPts[i + 1], radius));
    }
    return kids;
  }

  // Slow-but-sturdy union: accumulate one capsule at a time. Each step
  // unites the growing blob with ONE small convex operand that overlaps
  // it fatly (the shared joint disc), which paper's tracer handles far
  // more reliably than blob-vs-blob unions. Used as the fallback when
  // the fast tree union carves (see sweptOutline).
  function sweptRegionLinear(pathPts, radius) {
    var kids = buildCapsules(pathPts, radius);
    var u = kids[0];
    for (var i = 1; i < kids.length; i++) {
      var n = u.unite(kids[i], { insert: false });
      u.remove();
      kids[i].remove();
      u = n;
    }
    return u;
  }

  function sweptRegion(pathPts, radius) {
    var kids = buildCapsules(pathPts, radius);
    var diag = { capsules: kids.length, rounds: [] };
    VB._sweptDiag = diag;
    while (kids.length > 1) {
      var next = [];
      var childCounts = [];
      for (var k = 0; k + 1 < kids.length; k += 2) {
        var u = kids[k].unite(kids[k + 1], { insert: false });
        kids[k].remove();
        kids[k + 1].remove();
        next.push(u);
        childCounts.push(u.children ? u.children.length : 1);
      }
      if (kids.length & 1) next.push(kids[kids.length - 1]);
      diag.rounds.push(childCounts.join(","));
      kids = next;
    }
    return kids[0];
  }

  // Incremental swath union — spreads sweptRegion's capsule tree across
  // the drag so pointerup only pays the final fold. The accumulator is a
  // binary counter of partial unions (sizes are decreasing powers of 2;
  // equal-size neighbors merge eagerly, left operand receiving). That
  // discipline, folded right-associatively at the end, reproduces
  // sweptRegion's level-by-level pairing tree EXACTLY — same operands,
  // same receivers — so live-incremental and replay-batch geometry are
  // identical by construction.
  //
  // Point thinning mirrors buildSwath: acceptance depends only on the
  // last accepted point, EXCEPT that buildSwath may replace the last
  // point with the final raw point at the end. Hence the counter always
  // lags one capsule — the last capsule is only built in finish(), from
  // the authoritative buildSwath path. finish() verifies the shared
  // prefix and the radius; any mismatch discards the partials and
  // returns null, and the caller falls back to the batch union.
  function SwathUnion(radius) {
    this.radius = radius;
    this.minStep = Math.max(8, radius * 0.35);
    this.pts = [];      // accepted (thinned) points so far
    this.partials = []; // [{size, item}] — the binary counter
  }
  SwathUnion.prototype.add = function (p) {
    var last = this.pts[this.pts.length - 1];
    if (last) {
      var dx = p.x - last.x, dy = p.y - last.y;
      if (dx * dx + dy * dy < this.minStep * this.minStep) return;
    }
    this.pts.push({ x: p.x, y: p.y });
    // capsule k is final once pts[k+1] can no longer be replaced,
    // i.e. once it is no longer the last accepted point
    if (this.pts.length >= 3) {
      this._pushCapsule(this.pts[this.pts.length - 3],
                        this.pts[this.pts.length - 2]);
    }
  };
  SwathUnion.prototype._pushCapsule = function (p, q) {
    var P = this.partials;
    P.push({ size: 1, item: capsule(p, q, this.radius) });
    while (P.length >= 2 && P[P.length - 1].size === P[P.length - 2].size) {
      var right = P.pop(), left = P.pop();
      var u = left.item.unite(right.item, { insert: false });
      left.item.remove();
      right.item.remove();
      P.push({ size: left.size * 2, item: u });
    }
  };
  SwathUnion.prototype.finish = function (pathPts, radius) {
    var M = pathPts.length;
    var ok = radius === this.radius && this.pts.length === M && M >= 2;
    if (ok) {
      for (var i = 0; i + 1 < M; i++) { // all but the replaceable last
        if (this.pts[i].x !== pathPts[i].x ||
            this.pts[i].y !== pathPts[i].y) { ok = false; break; }
      }
    }
    if (!ok) { this.dispose(); return null; }
    this._pushCapsule(pathPts[M - 2], pathPts[M - 1]);
    var P = this.partials;
    var acc = P[P.length - 1].item;
    for (var j = P.length - 2; j >= 0; j--) {
      var u = P[j].item.unite(acc, { insert: false });
      P[j].item.remove();
      acc.remove();
      acc = u;
    }
    this.partials = [];
    VB._sweptDiag = { capsules: M - 1, rounds: ["incremental"] };
    return acc;
  };
  SwathUnion.prototype.dispose = function () {
    this.partials.forEach(function (p) { p.item.remove(); });
    this.partials = [];
  };

  // Closed loops of a path item as point lists (integer twips).
  //
  // PRIMARY sampler: by arclength — byte-identical behavior for every
  // healthy loop (fitted straight walls stay integer-exact, which the
  // same-color coincidence handling depends on).
  //
  // FALLBACK sampler: per-curve in parameter space — used ONLY when the
  // arclength ring provably distorted. On boolean output containing
  // degenerate curves, path.getPointAt can walk unreliably and the
  // sampled ring inflates (an outer ring measured 2.5x its true area,
  // swallowing pocket holes). The detector is one-sided and exact: the
  // sampled ring's shoelace area must agree with the paper child's own
  // analytically computed .area, which does not depend on getPointAt.
  function ringAreaPts(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) {
      var q = pts[(i + 1) % pts.length];
      a += pts[i].x * q.y - q.x * pts[i].y;
    }
    return a / 2;
  }
  function sampleArclength(p, step) {
    var n = Math.max(8, Math.ceil(p.length / step));
    var pts = [];
    for (var k = 0; k < n; k++) {
      var pt = p.getPointAt(p.length * k / n);
      if (pt) pts.push({ x: pt.x, y: pt.y });
    }
    return pts;
  }
  function sampleParametric(p, step) {
    var pts = [];
    p.curves.forEach(function (curve) {
      var v = curve.getValues();
      if (isFinite(v[0]) && isFinite(v[1])) pts.push({ x: v[0], y: v[1] });
      var len = curve.length;
      if (!isFinite(len) || len <= 0) return;
      var steps = Math.max(1, Math.min(24, Math.ceil(len / step)));
      for (var k = 1; k < steps; k++) {
        var pt = curve.getPointAtTime(k / steps);
        if (pt && isFinite(pt.x) && isFinite(pt.y)) pts.push({ x: pt.x, y: pt.y });
      }
    });
    return pts;
  }
  function itemLoops(item, step) {
    var paths = item.children ? item.children : [item];
    var loops = [];
    var resampled = 0;
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (!p.length || p.length < 4 * step) {
        if (Math.abs(p.area || 0) < 64) continue; // sub-8tw² sliver
      }
      var pts = sampleArclength(p, step);
      var trueArea = Math.abs(p.area || 0);
      if (pts.length >= 3 && trueArea > 0) {
        var sampledArea = Math.abs(ringAreaPts(pts));
        if (Math.abs(sampledArea - trueArea) > Math.max(30000, trueArea * 0.2)) {
          var pts2 = sampleParametric(p, step);
          if (pts2.length >= 3 &&
              Math.abs(Math.abs(ringAreaPts(pts2)) - trueArea) <
              Math.abs(sampledArea - trueArea)) {
            pts = pts2;
            resampled++;
          }
        }
      }
      if (pts.length >= 3) loops.push(pts);
    }
    VB._loopResamples = resampled;
    return loops;
  }

  /**
   * Swept region of a drag as LEAN closed quad loops (Flash-style fitted
   * outline records, integer twips). Returns an array of edge arrays —
   * one per boundary loop (outer boundaries and pocket holes alike),
   * each loop closed exactly. Fill claims are left 0 for the caller.
   */
  function sweptOutline(pathPts, radius, fitTol, preRegion) {
    // preRegion: a SwathUnion.finish() result — identical to
    // sweptRegion's output by construction, already paid for during the
    // drag. Everything downstream (repair ladder, hole filter, fitting)
    // treats both origins the same.
    var region = preRegion || sweptRegion(pathPts, radius);
    if (!region) return [];
    // A capsule chain is connected by construction, and every pen point
    // is covered by its capsules. If a pen point is NOT contained in the
    // united region, a pairwise unite carved geometry away (a paper.js
    // near-tangent artifact that renders as unpainted/unerased notches
    // ON the drag — heavy strokes have shattered into 5 components with
    // 100 uncovered points). Repair ladder, rare path only:
    //   1. rebuild with the linear accumulator (one convex capsule at a
    //      time — far sturdier than blob-vs-blob tree unions);
    //   2. any straggler joints get a slightly fat bridge capsule
    //      (+2tw, 0.1 px, invisible).
    var s = ensureScope();
    function firstUncovered(reg, from) {
      for (var pi = from || 0; pi < pathPts.length; pi++) {
        if (!reg.contains(new s.Point(pathPts[pi].x, pathPts[pi].y))) return pi;
      }
      return -1;
    }
    // Bridge carved joints LOCALLY first: a bridge is one small convex
    // capsule united over the gap — it cannot swallow a distant pocket.
    // (The previous ladder rebuilt the whole union linearly before
    // bridging; on log11 op#58 that rebuild absorbed a real 1.5M-tw²
    // pocket hole — the union traded carved notches for a flooded
    // pocket. Local repair first, wholesale rebuild only as a last
    // resort.)
    function bridgeGaps(reg, budget) {
      var used = 0;
      var pi = firstUncovered(reg, 0);
      while (pi >= 0 && used < budget) {
        used++;
        var a = pathPts[Math.max(0, pi - 1)];
        var b = pathPts[Math.min(pathPts.length - 1, pi + 1)];
        var bridge = capsule(a, b, radius + 2);
        var u = reg.unite(bridge, { insert: false });
        bridge.remove();
        reg.remove();
        reg = u;
        // resume scanning at the same index: if the bridge worked the
        // scan moves past it, if not we stop burning budget on it
        var again = firstUncovered(reg, pi);
        if (again === pi) break;
        pi = again;
      }
      return { region: reg, used: used, uncovered: firstUncovered(reg, 0) };
    }
    VB._sweptLinear = false;
    VB._sweptBridges = 0;
    if (firstUncovered(region, 0) >= 0) {
      var b1 = bridgeGaps(region, 64);
      region = b1.region;
      VB._sweptBridges = b1.used;
      if (b1.uncovered >= 0) {
        // last resort: wholesale linear rebuild, then bridge again
        VB._sweptLinear = true;
        region.remove();
        region = sweptRegionLinear(pathPts, radius);
        var b2 = bridgeGaps(region, 16);
        region = b2.region;
        VB._sweptBridges += b2.used;
      }
    }
    // Drop ILLEGITIMATE holes. A true pocket lies wholly OUTSIDE the
    // swept distance field (no capsule covers it), so a hole child whose
    // interior point is within the radius is a paper.js boolean artifact
    // (near-tangent overlap resolved as a hole ON the pen path — it
    // renders as an unpainted/unerased notch). The test is exact, no
    // tolerance band: pocket interiors are > radius by definition.
    if (region.children) {
      for (var ci = region.children.length - 1; ci >= 0; ci--) {
        var ch = region.children[ci];
        if (ch.clockwise) continue; // outer boundary, not a hole
        var ip = ch.interiorPoint;
        if (ip && VB.distToPath(pathPts, ip.x, ip.y) <= radius - 1) {
          ch.remove();
        }
      }
    }
    var step = Math.min(40, Math.max(8, radius * 0.3));
    var loops = itemLoops(region, step);
    region.remove();

    function geomsToLoop(geoms) {
      if (geoms.length === 0) return [];
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
      return loop;
    }

    // A fitted loop must be FAITHFUL to its source ring:
    //  - it must not self-cross (the true union contour never does; a
    //    fold has winding 0 inside and leaves a notch ON the drag);
    //  - it must preserve the ring's signed area (a cuspy little pocket
    //    hole fitted to 3-6 quads can collapse — the hole then vanishes
    //    from the winding mask and its whole pocket floods).
    // On violation: refit tighter, then fall back to the raw contour
    // samples. The common, healthy path is untouched.
    function selfCrosses(loop) {
      if (loop.length < 3) return false;
      var temp = new VB.Y2KVectorDocument();
      var pieces = VB.nodeEdges(temp, loop.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
      }));
      return pieces.length !== loop.length;
    }
    function ringArea(pts) {
      var a = 0;
      for (var i = 0; i < pts.length; i++) {
        var q = pts[(i + 1) % pts.length];
        a += pts[i].x * q.y - q.x * pts[i].y;
      }
      return a / 2;
    }
    function loopArea(loop) {
      var a = 0;
      loop.forEach(function (e) {
        var prev = { x: e.ax, y: e.ay };
        for (var t = 0.25; t <= 1.001; t += 0.25) {
          var pt = VB.geom.evalEdge(e, Math.min(1, t));
          a += prev.x * pt.y - pt.x * prev.y;
          prev = pt;
        }
      });
      return a / 2;
    }
    function unfaithful(loop, srcArea) {
      if (loop.length === 0) return true;
      var fa = loopArea(loop);
      var err = Math.abs(fa - srcArea);
      if (err > Math.abs(srcArea) * 0.2 && err > 30000) return true;
      return selfCrosses(loop);
    }

    var out = [];
    var repairs = { loops: 0, refit: 0, raw: 0 };
    VB._outlineRepairs = repairs;
    loops.forEach(function (pts) {
      repairs.loops++;
      var srcArea = ringArea(pts);
      pts.push({ x: pts[0].x, y: pts[0].y }); // close for the fitter
      var loop = geomsToLoop(VB.fitStroke(pts, fitTol || 12));
      if (unfaithful(loop, srcArea)) {
        repairs.refit++;
        var tight = geomsToLoop(VB.fitStroke(pts, 3));
        if (tight.length && !unfaithful(tight, srcArea)) {
          loop = tight;
        } else {
          repairs.raw++;
          // raw contour samples, connected by straight-run quads
          var raw = [];
          for (var i = 0; i + 1 < pts.length; i++) {
            raw.push({
              ax: Math.round(pts[i].x), ay: Math.round(pts[i].y),
              cx: null, cy: null,
              bx: Math.round(pts[i + 1].x), by: Math.round(pts[i + 1].y)
            });
          }
          loop = geomsToLoop(raw);
        }
      }
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
  VB.SwathUnion = SwathUnion;
  VB.sweptOutline = sweptOutline;
  VB.paintUnion = paintUnion;
  VB.fillLoops = fillLoops; // exposed for diagnostics/tests
})();
