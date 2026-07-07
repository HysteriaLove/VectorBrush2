/* merge.js — inserts new geometry into the planar map, Flash-style.
 *
 * Flash's stage drawing is a single planar subdivision: when a new stroke
 * crosses existing artwork, BOTH the stroke and the crossed edges are
 * split at the crossing so the map stays planar (the SWF examples show
 * this — crossing pencil files have far more style-change records than
 * pen moves). A stroke drawn across a filled region also inherits that
 * region's fill on both of its sides, which is what later lets the bucket
 * fill "half of a circle".
 *
 * All junction points are rounded to integer twips and shared exactly by
 * every edge meeting there, so downstream welding (rendering, bucket
 * tracing) needs no epsilons.
 */
(function () {
  "use strict";

  // Skip splits that land on an edge's own anchors — already a node there.
  function pointIsAnchor(e, x, y) {
    return (e.ax === x && e.ay === y) || (e.bx === x && e.by === y);
  }

  function addSplit(map, key, t, point) {
    var arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    // dedupe: same rounded junction registered twice on one edge
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].point.x === point.x && arr[i].point.y === point.y) return;
      if (Math.abs(arr[i].t - t) < 1e-6) return;
    }
    arr.push({ t: t, point: point });
  }

  function applySplits(edge, splits) {
    if (!splits || splits.length === 0) return [edge];
    splits.sort(function (a, b) { return a.t - b.t; });
    return VB.geom.splitEdge(edge, splits);
  }

  /**
   * Merge a stroke into the document.
   *  geoms:        [{ax,ay,cx,cy,bx,by}] from fitStroke (integer twips)
   *  lineStyleIdx: 1-based line style for the new edges
   * Returns the number of edges the stroke contributed after splitting.
   */
  function mergeStroke(doc, geoms, lineStyleIdx) {
    var newEdges = geoms.map(function (g) {
      return VB.edge(g.ax, g.ay, g.cx, g.cy, g.bx, g.by, 0, 0, lineStyleIdx);
    }).filter(function (e) { return !VB.edgeIsDegenerate(e); });
    if (newEdges.length === 0) return 0;

    var oldSplits = new Map(); // index into doc.edges -> splits
    var newSplits = new Map(); // index into newEdges  -> splits

    // New vs existing.
    for (var i = 0; i < newEdges.length; i++) {
      var ne = newEdges[i];
      var nb = VB.geom.edgeBBox(ne);
      for (var j = 0; j < doc.edges.length; j++) {
        var oe = doc.edges[j];
        if (!VB.geom.bboxOverlap(nb, VB.geom.edgeBBox(oe))) continue;
        var hits = VB.geom.edgeIntersections(ne, oe);
        for (var h = 0; h < hits.length; h++) {
          var p = { x: Math.round(hits[h].point.x), y: Math.round(hits[h].point.y) };
          if (!pointIsAnchor(ne, p.x, p.y)) addSplit(newSplits, i, hits[h].t, p);
          if (!pointIsAnchor(oe, p.x, p.y)) addSplit(oldSplits, j, hits[h].u, p);
        }
      }
    }

    // New vs new (self-crossing strokes). Adjacent pieces meet at shared
    // anchors, which pointIsAnchor filters out.
    for (var a = 0; a < newEdges.length; a++) {
      for (var b = a + 1; b < newEdges.length; b++) {
        var ea = newEdges[a], eb = newEdges[b];
        if (!VB.geom.bboxOverlap(VB.geom.edgeBBox(ea), VB.geom.edgeBBox(eb))) continue;
        var hits2 = VB.geom.edgeIntersections(ea, eb);
        for (var h2 = 0; h2 < hits2.length; h2++) {
          var p2 = { x: Math.round(hits2[h2].point.x), y: Math.round(hits2[h2].point.y) };
          if (!pointIsAnchor(ea, p2.x, p2.y)) addSplit(newSplits, a, hits2[h2].t, p2);
          if (!pointIsAnchor(eb, p2.x, p2.y)) addSplit(newSplits, b, hits2[h2].u, p2);
        }
      }
    }

    // Split existing edges in place (styles inherited by the pieces).
    if (oldSplits.size > 0) {
      var rebuilt = [];
      for (var k = 0; k < doc.edges.length; k++) {
        var pieces = applySplits(doc.edges[k], oldSplits.get(k));
        for (var p3 = 0; p3 < pieces.length; p3++) rebuilt.push(pieces[p3]);
      }
      doc.edges = rebuilt;
    }

    // Split the stroke's own edges.
    var finalNew = [];
    for (var m = 0; m < newEdges.length; m++) {
      var pieces2 = applySplits(newEdges[m], newSplits.get(m));
      for (var p4 = 0; p4 < pieces2.length; p4++) finalNew.push(pieces2[p4]);
    }

    // Fill inheritance: a stroke piece inside a filled region carries that
    // fill on both sides. Query BEFORE inserting the new edges (splitting
    // above didn't change any region).
    for (var q = 0; q < finalNew.length; q++) {
      var mid = VB.geom.evalEdge(finalNew[q], 0.5);
      var f = VB.geom.fillAt(doc, mid.x, mid.y);
      finalNew[q].fill0 = f;
      finalNew[q].fill1 = f;
    }

    for (var r = 0; r < finalNew.length; r++) doc.edges.push(finalNew[r]);
    return finalNew.length;
  }

  window.VB = window.VB || {};
  VB.mergeStroke = mergeStroke;
})();
