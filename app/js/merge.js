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

  var VERTEX_SNAP = 2; // twips: crossings this close to an anchor weld onto it

  // Endpoint snapping — the reason Flash drawings are fillable at all.
  // A stroke's terminal anchors magnetize (within snapTol twips) onto:
  //   1. the stroke's own other end (auto-closing almost-closed loops),
  //   2. an existing anchor (weld to the node),
  //   3. the nearest point on an existing edge (T-junction: the edge is
  //      split there so the endpoint becomes a real node).
  // Mutates the terminal edges in place; returns forced splits for case 3.
  function snapEndpoints(doc, newEdges, snapTol) {
    var pendingOldSplits = [];
    if (snapTol <= 0 || newEdges.length === 0) return pendingOldSplits;

    var first = newEdges[0], last = newEdges[newEdges.length - 1];

    // 1. auto-close the stroke onto itself
    var gx = last.bx - first.ax, gy = last.by - first.ay;
    var closed = gx === 0 && gy === 0;
    if (!closed && gx * gx + gy * gy <= snapTol * snapTol && newEdges.length > 1) {
      last.bx = first.ax; last.by = first.ay;
      closed = true;
    }

    var ends = [];
    ends.push({ edge: first, end: "a" });
    if (!closed) ends.push({ edge: last, end: "b" });

    for (var k = 0; k < ends.length; k++) {
      var ex = ends[k].end === "a" ? ends[k].edge.ax : ends[k].edge.bx;
      var ey = ends[k].end === "a" ? ends[k].edge.ay : ends[k].edge.by;

      // 2. nearest existing anchor
      var bestD = snapTol, bx = null, by = null;
      for (var i = 0; i < doc.edges.length; i++) {
        var e = doc.edges[i];
        var d1 = Math.hypot(e.ax - ex, e.ay - ey);
        if (d1 < bestD) { bestD = d1; bx = e.ax; by = e.ay; }
        var d2 = Math.hypot(e.bx - ex, e.by - ey);
        if (d2 < bestD) { bestD = d2; bx = e.bx; by = e.by; }
      }

      // 3. else nearest point on an existing edge (forces a split there)
      var splitIdx = -1, splitT = 0;
      if (bx === null) {
        for (var j = 0; j < doc.edges.length; j++) {
          var bb = VB.geom.edgeBBox(doc.edges[j]);
          if (ex < bb.xmin - snapTol || ex > bb.xmax + snapTol ||
              ey < bb.ymin - snapTol || ey > bb.ymax + snapTol) continue;
          var near = VB.geom.nearestOnEdge(doc.edges[j], ex, ey);
          if (near.d < bestD) {
            bestD = near.d;
            bx = Math.round(near.x); by = Math.round(near.y);
            splitIdx = j; splitT = near.t;
          }
        }
        if (splitIdx >= 0 && !pointIsAnchor(doc.edges[splitIdx], bx, by)) {
          pendingOldSplits.push({ index: splitIdx, t: splitT, point: { x: bx, y: by } });
        }
      }

      if (bx !== null && (bx !== ex || by !== ey)) {
        if (ends[k].end === "a") { ends[k].edge.ax = bx; ends[k].edge.ay = by; }
        else { ends[k].edge.bx = bx; ends[k].edge.by = by; }
      }
    }
    return pendingOldSplits;
  }

  // Snap a crossing point onto a nearby anchor of either edge so the
  // junction reuses the existing node instead of minting a sliver.
  function vertexSnap(p, ea, eb) {
    var candidates = [
      [ea.ax, ea.ay], [ea.bx, ea.by], [eb.ax, eb.ay], [eb.bx, eb.by]
    ];
    for (var i = 0; i < candidates.length; i++) {
      var dx = candidates[i][0] - p.x, dy = candidates[i][1] - p.y;
      if (dx * dx + dy * dy <= VERTEX_SNAP * VERTEX_SNAP) {
        return { x: candidates[i][0], y: candidates[i][1] };
      }
    }
    return p;
  }

  /**
   * Node a batch of new edges into the planar map: split existing edges
   * and the new edges at every mutual and self crossing (shared, exactly
   * rounded junction points). Mutates doc.edges (splits in place, styles
   * preserved) but does NOT insert the new edges — returns their split
   * pieces so the caller can classify/style them first.
   *  extraOldSplits: optional [{index, t, point}] forced splits on
   *  existing edges (e.g. from endpoint snapping).
   */
  function nodeEdges(doc, newEdges, extraOldSplits) {
    var oldSplits = new Map(); // index into doc.edges -> splits
    var newSplits = new Map(); // index into newEdges  -> splits
    if (extraOldSplits) {
      for (var sp = 0; sp < extraOldSplits.length; sp++) {
        addSplit(oldSplits, extraOldSplits[sp].index, extraOldSplits[sp].t, extraOldSplits[sp].point);
      }
    }

    // New vs existing.
    for (var i = 0; i < newEdges.length; i++) {
      var ne = newEdges[i];
      var nb = VB.geom.edgeBBox(ne);
      for (var j = 0; j < doc.edges.length; j++) {
        var oe = doc.edges[j];
        if (!VB.geom.bboxOverlap(nb, VB.geom.edgeBBox(oe))) continue;
        var hits = VB.geom.edgeIntersections(ne, oe);
        for (var h = 0; h < hits.length; h++) {
          var p = vertexSnap(
            { x: Math.round(hits[h].point.x), y: Math.round(hits[h].point.y) }, oe, ne);
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
          var p2 = vertexSnap(
            { x: Math.round(hits2[h2].point.x), y: Math.round(hits2[h2].point.y) }, ea, eb);
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

    // Split the new edges themselves.
    var finalNew = [];
    for (var m = 0; m < newEdges.length; m++) {
      var pieces2 = applySplits(newEdges[m], newSplits.get(m));
      for (var p4 = 0; p4 < pieces2.length; p4++) finalNew.push(pieces2[p4]);
    }
    return finalNew;
  }

  /**
   * Merge a stroke into the document.
   *  geoms:        [{ax,ay,cx,cy,bx,by}] from fitStroke (integer twips)
   *  lineStyleIdx: 1-based line style for the new edges
   *  snapTol:      endpoint snap distance in twips (default 80 = 4px)
   * Returns the number of edges the stroke contributed after splitting.
   */
  function mergeStroke(doc, geoms, lineStyleIdx, snapTol) {
    if (snapTol === undefined) snapTol = 80;
    var newEdges = geoms.map(function (g) {
      return VB.edge(g.ax, g.ay, g.cx, g.cy, g.bx, g.by, 0, 0, lineStyleIdx);
    }).filter(function (e) { return !VB.edgeIsDegenerate(e); });
    if (newEdges.length === 0) return 0;

    // Magnetize stroke endpoints before any crossing detection.
    var snapSplits = snapEndpoints(doc, newEdges, snapTol);
    newEdges = newEdges.filter(function (e) { return !VB.edgeIsDegenerate(e); });
    if (newEdges.length === 0) return 0;

    var finalNew = nodeEdges(doc, newEdges, snapSplits);

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
  VB.nodeEdges = nodeEdges;
})();
