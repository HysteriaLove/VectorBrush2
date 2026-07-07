/* planarity.js — the planar-map integrity checker.
 *
 * The whole editing model rests on one invariant: edges only meet at
 * shared anchors. Any transversal crossing in the middle of two edges is
 * a missing node — faces leak through it and the bucket floods (the bug
 * this module exists to catch). validatePlanar() finds such crossings;
 * tests run it after every merge, and merge.js uses the same pairwise
 * scan for its re-noding passes.
 */
(function () {
  "use strict";

  // How far (twips) an intersection must sit from every anchor of both
  // edges to count as a violation. Rounding to integer twips means
  // crossings within a twip of a node are legitimate weld jitter.
  var NODE_TOL = 1.5;

  function nearAnchor(e, x, y) {
    function close(ax, ay) {
      var dx = ax - x, dy = ay - y;
      return dx * dx + dy * dy <= NODE_TOL * NODE_TOL;
    }
    return close(e.ax, e.ay) || close(e.bx, e.by);
  }

  /**
   * Scans all edge pairs (bbox-grid pruned) for transversal crossings
   * away from shared anchors. Returns [{i, j, point}] (capped).
   */
  function validatePlanar(doc, cap) {
    cap = cap || 50;
    var edges = doc.edges;
    var violations = [];

    // Coarse uniform grid over edge bboxes to avoid O(E²).
    var CELL = 512; // twips
    var grid = new Map();
    function cellsOf(bb) {
      var cells = [];
      for (var gx = Math.floor(bb.xmin / CELL); gx <= Math.floor(bb.xmax / CELL); gx++) {
        for (var gy = Math.floor(bb.ymin / CELL); gy <= Math.floor(bb.ymax / CELL); gy++) {
          cells.push(gx + "," + gy);
        }
      }
      return cells;
    }
    var bboxes = edges.map(VB.geom.edgeBBox);
    for (var i = 0; i < edges.length; i++) {
      var cells = cellsOf(bboxes[i]);
      for (var c = 0; c < cells.length; c++) {
        var list = grid.get(cells[c]);
        if (!list) { list = []; grid.set(cells[c], list); }
        list.push(i);
      }
    }

    var tested = new Set();
    grid.forEach(function (list) {
      for (var a = 0; a < list.length && violations.length < cap; a++) {
        for (var b = a + 1; b < list.length; b++) {
          var i2 = list[a], j2 = list[b];
          var pairKey = i2 < j2 ? i2 + ":" + j2 : j2 + ":" + i2;
          if (tested.has(pairKey)) continue;
          tested.add(pairKey);
          if (!VB.geom.bboxOverlap(bboxes[i2], bboxes[j2])) continue;
          var hits = VB.geom.edgeIntersections(edges[i2], edges[j2]);
          for (var h = 0; h < hits.length; h++) {
            var p = hits[h].point;
            if (nearAnchor(edges[i2], p.x, p.y) || nearAnchor(edges[j2], p.x, p.y)) continue;
            violations.push({
              i: i2, j: j2,
              t: hits[h].t, u: hits[h].u,
              point: { x: p.x, y: p.y }
            });
            if (violations.length >= cap) return;
          }
        }
      }
    });
    return violations;
  }

  /**
   * Restores the planar invariant by splitting every residual transversal
   * crossing at a shared rounded point. Such crossings slip through the
   * primary noding when two curves merely graze pre-rounding and become
   * real crossings after integer quantization — the fragments here are a
   * twip or two long, invisible, but without a shared node they leak
   * faces. Returns the number of crossings repaired.
   */
  function repairPlanar(doc, maxPasses) {
    var total = 0;
    for (var pass = 0; pass < (maxPasses || 3); pass++) {
      var violations = validatePlanar(doc, 200);
      if (violations.length === 0) break;
      total += violations.length;

      var splits = new Map(); // edge index -> [{t, point}]
      for (var v = 0; v < violations.length; v++) {
        var p = {
          x: Math.round(violations[v].point.x),
          y: Math.round(violations[v].point.y)
        };
        addSplit(splits, violations[v].i, violations[v].t, p);
        addSplit(splits, violations[v].j, violations[v].u, p);
      }

      var rebuilt = [];
      for (var e = 0; e < doc.edges.length; e++) {
        var list = splits.get(e);
        if (!list) { rebuilt.push(doc.edges[e]); continue; }
        list.sort(function (a, b) { return a.t - b.t; });
        var pieces = VB.geom.splitEdge(doc.edges[e], list);
        for (var k = 0; k < pieces.length; k++) rebuilt.push(pieces[k]);
      }
      doc.edges = rebuilt;
    }
    return total;
  }

  function addSplit(map, key, t, point) {
    var arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].point.x === point.x && arr[i].point.y === point.y) return;
      if (Math.abs(arr[i].t - t) < 1e-6) return;
    }
    arr.push({ t: t, point: point });
  }

  window.VB = window.VB || {};
  VB.validatePlanar = validatePlanar;
  VB.repairPlanar = repairPlanar;
})();
