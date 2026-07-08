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
      var weld = new Map(); // "x,y" -> {x, y} replacement
      var contracted = 0;
      doc.edges.forEach(function (e) {
        if (Math.hypot(e.bx - e.ax, e.by - e.ay) > MICRO) return;
        var fromK = e.bx + "," + e.by;
        var toK = e.ax + "," + e.ay;
        if (fromK === toK || weld.has(toK) || weld.has(fromK)) return;
        weld.set(fromK, { x: e.ax, y: e.ay });
        contracted++;
      });
      if (contracted === 0) break;
      doc.edges.forEach(function (e) {
        var wa = weld.get(e.ax + "," + e.ay);
        if (wa) { e.ax = wa.x; e.ay = wa.y; }
        var wb = weld.get(e.bx + "," + e.by);
        if (wb) { e.bx = wb.x; e.by = wb.y; }
      });
      doc.edges = doc.edges.filter(function (e) { return !VB.edgeIsDegenerate(e); });
      VB.repairPlanar(doc);
    }

    var built = VB.buildFaces(doc);

    // A probe point verified to be INSIDE the face (parity against the
    // face's own boundary). A single 1tw nudge off one edge can leak
    // into the neighboring region when noding disturbed geometry at the
    // twip scale — and one leaked probe misfills (or empties) an entire
    // face. Try the longest edges at several params and nudge widths,
    // and accept only a probe the face itself contains.
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
      var nudges = [1, 2.5];
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
      var stamp = inMask ? maskFill : VB.geom.fillAt(preOp, probe.x, probe.y);
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

  window.VB = window.VB || {};
  VB.applyRegionMask = applyRegionMask;
})();
