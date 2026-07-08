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
   * @param insideMask function(x, y) -> bool, the exact region test
   * @param maskFill   fill index the region resolves to (0 = eraser)
   * @param fencePieces the mask outline's own noded pieces (protected)
   * Returns the number of edges removed (covered strokes + dissolved
   * boundaries).
   */
  function applyRegionMask(doc, preOp, insideMask, maskFill, fencePieces) {
    var before = doc.edges.length;
    var fence = new Set(fencePieces || []);

    // Everything the mask covers OR overlaps goes: interior edges, and —
    // crucially — old edges lying exactly ON the mask boundary (two
    // same-color tube walls are collinear-coincident there; duplicate
    // overlapping edges cannot be noded and scramble the face walk).
    // The new fence replaces them. Edges hugging within the 2tw probe
    // get absorbed the same way Flash absorbs sub-twip slivers.
    doc.edges = doc.edges.filter(function (e) {
      if (fence.has(e)) return true;
      var m = VB.geom.evalEdge(e, 0.5);
      if (insideMask(m.x, m.y)) return false;
      var ahead = VB.geom.evalEdge(e, 0.55);
      var tx = ahead.x - m.x, ty = ahead.y - m.y;
      var tl = Math.hypot(tx, ty);
      if (tl === 0) return false;
      tx /= tl; ty /= tl;
      return !insideMask(m.x - ty * 2, m.y + tx * 2) &&
             !insideMask(m.x + ty * 2, m.y - tx * 2);
    });

    // Rounding can turn grazing contacts into real crossings; the face
    // walk needs a properly noded map.
    VB.repairPlanar(doc);

    var built = VB.buildFaces(doc);

    // One decision per face.
    var diag = [];
    VB._maskDiag = diag;
    var stamps = built.faces.map(function (f) {
      var probe = VB.probeForCycle(doc.edges, f.outer);
      var inMask = insideMask(probe.x, probe.y);
      var stamp = inMask ? maskFill : VB.geom.fillAt(preOp, probe.x, probe.y);
      diag.push({
        probe: { x: Math.round(probe.x), y: Math.round(probe.y) },
        area: Math.round(f.area), inMask: inMask, stamp: stamp,
        cycleLen: f.outer.length, holes: f.holes.length
      });
      return stamp;
    });

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
    doc.edges = doc.edges.filter(function (e) {
      return !(e.fill0 === e.fill1 && e.line === 0);
    });

    return before - doc.edges.length;
  }

  window.VB = window.VB || {};
  VB.applyRegionMask = applyRegionMask;
})();
