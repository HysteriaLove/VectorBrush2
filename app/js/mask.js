/* mask.js — the boolean mask core: reconcile the document against a
 * region by walking faces.
 *
 * After a region outline (brush paint, eraser swath) has been noded into
 * the planar map, every consistency question has one exact answer: walk
 * the faces of the arrangement, decide each face's fill with ONE probe
 * (inside the mask → the mask's fill; outside → whatever the pre-op
 * document had there), and regenerate every edge's fill0/fill1 FROM its
 * two adjacent faces. Claims are consistent by construction — open fill
 * chains and stranded claims cannot exist, so no stitching, no per-edge
 * probing, no invariant repair.
 *
 * Everything the mask covers is replaced: line-carrying edges inside the
 * mask are deleted (Flash's brush paints over strokes; the eraser erases
 * them), and old lineless boundaries inside the mask dissolve on their
 * own — both their faces get the mask fill, so they become F|F and are
 * culled by the Flash output invariant (no lineless fill|fill, no
 * lineless 0|0).
 */
(function () {
  "use strict";

  /**
   * @param doc        document AFTER the mask outline has been noded in
   * @param preOp      snapshot of the document BEFORE the operation
   * @param insideMask function(x, y) -> bool, the region faces resolve to
   *                   maskFill inside of
   * @param maskFill   fill index the region resolves to (0 = eraser)
   * @param fencePieces the mask outline's own noded pieces (protected)
   * @param coverInside optional function(x, y) -> bool: where covered
   *                   edges are deleted (defaults to insideMask). The
   *                   brush passes the STROKE region here — paint-over
   *                   erases only under the stroke, while the stamping
   *                   mask is the whole united fill region.
   * Returns the number of edges removed (covered strokes + dissolved
   * boundaries).
   */
  function applyRegionMask(doc, preOp, insideMask, maskFill, fencePieces, coverInside) {
    var before = doc.edges.length;
    var fence = new Set(fencePieces || []);
    var covered = coverInside || insideMask;
    // maskFill may be a FUNCTION (x, y) -> fill index: multi-fill regions
    // (a moved clip containing several fills) stamp in ONE pass instead
    // of one mask per fill — sequential passes destabilize each other's
    // shared borders (micro-welds shift nodes between passes and the
    // next pass's identical border goes near-coincident and shreds).
    var stampFor = typeof maskFill === "function"
      ? maskFill
      : function () { return maskFill; };

    // Everything the op covers goes: interior fill boundaries dissolve
    // into the region, covered strokes are erased.
    doc.edges = doc.edges.filter(function (e) {
      if (fence.has(e)) return true;
      var m = VB.geom.evalEdge(e, 0.5);
      return !covered(m.x, m.y);
    });

    // A fence piece IDENTICAL to a surviving old edge (integer-exact,
    // either orientation — mutual noding splits coincident walls into
    // matching pieces) is a true no-op: same nodes, same geometry. Keep
    // the old edge, drop the duplicate — two overlapping edges scramble
    // the angular sort in the face walk. Nothing short of integer-exact
    // is touched (near-parallels have their own nodes and faces).
    //
    // SPAN ALIGNMENT first: re-erasing/re-painting the exact same spot
    // regenerates the same fence, but the OLD copy carries extra nodes
    // from historical noding — identical geometry, different spans, so
    // the duplicate rule misses it and the coincident pair survives to
    // scramble the walk (the eraser-click toggle bug). Split each side
    // at the other's endpoints that lie ON it; identical stretches then
    // decompose into integer-identical twins.
    (function alignCoincidentSpans() {
      function splitsFor(target, endpoints) {
        var bb = VB.geom.edgeBBox(target);
        var list = [];
        for (var i = 0; i < endpoints.length; i++) {
          var pt = endpoints[i];
          if (pt.x < bb.xmin - 1 || pt.x > bb.xmax + 1 ||
              pt.y < bb.ymin - 1 || pt.y > bb.ymax + 1) continue;
          if ((pt.x === target.ax && pt.y === target.ay) ||
              (pt.x === target.bx && pt.y === target.by)) continue;
          var q = VB.geom.nearestOnEdge(target, pt.x, pt.y);
          if (q.d <= 0.75 && q.t > 0.02 && q.t < 0.98) {
            list.push({ t: q.t, point: { x: pt.x, y: pt.y } });
          }
        }
        return list;
      }
      var fenceEnds = [], oldEnds = [];
      doc.edges.forEach(function (e) {
        (fence.has(e) ? fenceEnds : oldEnds).push(
          { x: e.ax, y: e.ay }, { x: e.bx, y: e.by });
      });
      var rebuilt = [];
      doc.edges.forEach(function (e) {
        var ends = fence.has(e) ? oldEnds : fenceEnds;
        var list = splitsFor(e, ends);
        if (list.length === 0) { rebuilt.push(e); return; }
        list.sort(function (a, b) { return a.t - b.t; });
        var pieces = VB.geom.splitEdge(e, list);
        var isFence = fence.has(e);
        if (isFence) fence.delete(e);
        pieces.forEach(function (pc) {
          if (VB.edgeIsDegenerate(pc)) return;
          if (isFence) fence.add(pc);
          rebuilt.push(pc);
        });
      });
      doc.edges = rebuilt;
    })();

    function edgeKey(ax, ay, cx, cy, bx, by) {
      return ax + "," + ay + "," + cx + "," + cy + "," + bx + "," + by;
    }
    var survivorKeys = new Set();
    doc.edges.forEach(function (e) {
      if (fence.has(e)) return;
      survivorKeys.add(edgeKey(e.ax, e.ay, e.cx, e.cy, e.bx, e.by));
    });
    doc.edges = doc.edges.filter(function (e) {
      if (!fence.has(e)) return true;
      return !survivorKeys.has(edgeKey(e.ax, e.ay, e.cx, e.cy, e.bx, e.by)) &&
             !survivorKeys.has(edgeKey(e.bx, e.by, e.cx, e.cy, e.ax, e.ay));
    });

    // Rounding can turn grazing contacts into real crossings; the face
    // walk needs a properly noded map.
    VB.repairPlanar(doc);

    // Contract micro-edges. Noding two near-tangent hugging fences (a
    // stroke re-tracing existing paint) shreds them into 1-3tw fragments
    // whose departure angles are integer-quantization noise; the angular
    // sort misroutes at such nodes and the walk turns closed pocket
    // boundaries into bridge trees (the pocket-flood class). Welding a
    // micro-edge's endpoints into one node removes the noise without
    // changing anything visible (<=3tw).
    var MICRO = 5;
    for (var pass = 0; pass < 4; pass++) {
      var weld = new Map(); // "x,y" -> "x,y" (union-find style)
      function resolve(k) {
        var steps = 0;
        while (weld.has(k) && steps++ < 128) k = weld.get(k);
        return k;
      }
      var contracted = 0;
      doc.edges.forEach(function (e) {
        if (Math.hypot(e.bx - e.ax, e.by - e.ay) > MICRO) return;
        // Transitive: a CHAIN of micro-pieces (near-tangent noding
        // leaves 30+ piece stairs) must collapse to ONE node in a
        // single pass — pairwise-only welding left every other piece
        // alive past the pass cap and the stair survived to scramble
        // the face walk.
        var rootA = resolve(e.ax + "," + e.ay);
        var rootB = resolve(e.bx + "," + e.by);
        if (rootA === rootB) return;
        weld.set(rootB, rootA);
        contracted++;
      });
      if (contracted === 0) break;
      doc.edges.forEach(function (e) {
        var ka = resolve(e.ax + "," + e.ay);
        var pa = ka.split(",");
        e.ax = +pa[0]; e.ay = +pa[1];
        var kb = resolve(e.bx + "," + e.by);
        var pb = kb.split(",");
        e.bx = +pb[0]; e.by = +pb[1];
      });
      // Welding collapses chords but leaves controls behind: a quad whose
      // endpoints merged becomes a closed micro-CURL (a==b, control a few
      // twips out). edgeIsDegenerate keeps those, they accumulate op after
      // op, and a caterpillar of curls at one node scrambles the angular
      // walk (the last pocket-flood case). A lineless closed curl within
      // 2*MICRO extent is a sub-half-pixel nothing — delete it.
      doc.edges = doc.edges.filter(function (e) {
        if (VB.edgeIsDegenerate(e)) return false;
        if (e.line !== 0) return true;
        if (e.ax !== e.bx || e.ay !== e.by) return true;
        if (e.cx === null) return false; // zero-length line
        return Math.hypot(e.cx - e.ax, e.cy - e.ay) > MICRO * 2;
      });
      VB.repairPlanar(doc);
    }

    var built = VB.buildFaces(doc);

    // A probe point verified to be INSIDE the face (parity against the
    // face's own boundary). A single 1tw nudge off one edge can leak
    // into the neighboring region when noding disturbed geometry at the
    // twip scale — and one leaked probe misfills (or empties) an entire
    // face. Try the longest edges at several params and nudge widths,
    // and accept only a probe the face itself contains.
    //
    // DEEP nudges first: the probe is verified against THIS map, but
    // outside-mask faces are then classified with fillAt(preOp) — and
    // splitting/welding drifts boundary geometry a few twips from the
    // pre-op original. A probe hugging the post-op boundary at 1-2.5tw
    // can sit on the WRONG side of the pre-op curve and misfill the
    // whole face (the log-23 pocket flood: a white pocket 15px from the
    // stroke stamped with the neighbor's paint). Deep probes clear the
    // drift; slivers still fall through to the fine nudges.
    function faceProbe(f) {
      var cycles = [f.outer].concat(f.holes);
      function contains(x, y) {
        var c = 0;
        for (var ci = 0; ci < cycles.length; ci++) {
          for (var hi = 0; hi < cycles[ci].length; hi++) {
            c += VB.edgeRayCrossings(doc.edges[cycles[ci][hi].edge], x, y);
          }
        }
        return (c & 1) === 1;
      }
      var order = f.outer.slice().sort(function (h1, h2) {
        var e1 = doc.edges[h1.edge], e2 = doc.edges[h2.edge];
        var l1 = (e1.bx - e1.ax) * (e1.bx - e1.ax) + (e1.by - e1.ay) * (e1.by - e1.ay);
        var l2 = (e2.bx - e2.ax) * (e2.bx - e2.ax) + (e2.by - e2.ay) * (e2.by - e2.ay);
        return l2 - l1;
      });
      var params = [0.5, 0.3, 0.7];
      var nudges = [60, 25, 8, 2.5, 1];
      for (var oi = 0; oi < order.length && oi < 5; oi++) {
        var h = order[oi];
        var e = doc.edges[h.edge];
        for (var pi = 0; pi < params.length; pi++) {
          var t = params[pi];
          var p = VB.geom.evalEdge(e, t);
          var p1 = VB.geom.evalEdge(e, Math.min(1, t + 0.04));
          var p0 = VB.geom.evalEdge(e, Math.max(0, t - 0.04));
          var dx = p1.x - p0.x, dy = p1.y - p0.y;
          if (!h.forward) { dx = -dx; dy = -dy; }
          var len = Math.hypot(dx, dy) || 1;
          for (var ni = 0; ni < nudges.length; ni++) {
            var n = nudges[ni];
            var px = p.x - dy / len * n, py = p.y + dx / len * n;
            if (contains(px, py)) return { x: px, y: py };
          }
        }
      }
      return VB.probeForCycle(doc.edges, f.outer); // last resort
    }

    // One decision per face.
    var diag = [];
    VB._maskDiag = diag;
    var stamps = built.faces.map(function (f) {
      var probe = faceProbe(f);
      var inMask = insideMask(probe.x, probe.y);
      var stamp = inMask ? stampFor(probe.x, probe.y)
                         : VB.geom.fillAt(preOp, probe.x, probe.y);
      diag.push({
        probe: { x: Math.round(probe.x), y: Math.round(probe.y) },
        area: Math.round(f.area), inMask: inMask, stamp: stamp,
        cycleLen: f.outer.length, holes: f.holes.length
      });
      return stamp;
    });

    // Optional debug: record the stamp decision for the face containing
    // VB._maskDebugPt (diagnostics only).
    if (VB._maskDebugPt) {
      var dp = VB._maskDebugPt;
      VB._maskDebugFace = null;
      built.faces.forEach(function (f, fi) {
        var crossings = 0;
        var cycles = [f.outer].concat(f.holes);
        cycles.forEach(function (cyc) {
          cyc.forEach(function (h) {
            crossings += VB.edgeRayCrossings(doc.edges[h.edge], dp.x, dp.y);
          });
        });
        if (crossings & 1) VB._maskDebugFace = Object.assign({ face: fi }, diag[fi]);
      });
    }

    // Regenerate all claims from the faces. Half-edges on the infinite
    // face are never stamped, leaving 0 there — exactly right.
    doc.edges.forEach(function (e) { e.fill0 = 0; e.fill1 = 0; });
    built.faces.forEach(function (f, fi) {
      var stamp = stamps[fi];
      var cycles = [f.outer].concat(f.holes);
      cycles.forEach(function (cyc) {
        cyc.forEach(function (h) {
          var e = doc.edges[h.edge];
          if (h.forward) e.fill1 = stamp; else e.fill0 = stamp;
        });
      });
    });

    // Flash output invariants: no lineless 0|0, no lineless fill|fill.
    var dissolved = [];
    doc.edges = doc.edges.filter(function (e) {
      if (!(e.fill0 === e.fill1 && e.line === 0)) return true;
      if (fence.has(e)) {
        var m = VB.geom.evalEdge(e, 0.5);
        dissolved.push({ x: Math.round(m.x), y: Math.round(m.y), f: e.fill0 });
      }
      return false;
    });
    VB._maskFenceDissolved = dissolved;

    return before - doc.edges.length;
  }

  /**
   * Splits a batch of new edges into { fresh, twins }: `fresh` are safe
   * to node; `twins` are existing doc edges integer-identical (either
   * orientation) to a new edge — the new copy is discarded and the old
   * edge becomes the protected carrier. Noding a curve against an
   * identical curve shreds both into sub-twip fragments, which no exact
   * duplicate rule can pair afterwards.
   */
  function adoptIdenticalEdges(doc, newEdges) {
    var byKey = new Map();
    function k(ax, ay, cx, cy, bx, by) {
      return ax + "," + ay + "," + cx + "," + cy + "," + bx + "," + by;
    }
    doc.edges.forEach(function (e) {
      byKey.set(k(e.ax, e.ay, e.cx, e.cy, e.bx, e.by), e);
    });
    var fresh = [], twins = [];
    newEdges.forEach(function (e) {
      var twin = byKey.get(k(e.ax, e.ay, e.cx, e.cy, e.bx, e.by)) ||
                 byKey.get(k(e.bx, e.by, e.cx, e.cy, e.ax, e.ay));
      if (twin) twins.push(twin); else fresh.push(e);
    });
    return { fresh: fresh, twins: twins };
  }

  window.VB = window.VB || {};
  VB.applyRegionMask = applyRegionMask;
  VB.adoptIdenticalEdges = adoptIdenticalEdges;
})();
