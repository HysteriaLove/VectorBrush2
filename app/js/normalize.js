/* normalize.js — global fill-claim reconciliation.
 *
 * The planar map's GEOMETRY defines the regions; the fill0/fill1 indices
 * on edges are just claims about them. Editing operations (especially
 * overlapping erases) can strand stale claims: an edge asserting a fill
 * that no longer exists on that side, or thin slivers judged
 * inconsistently by probe-based classification. Any such inconsistency
 * eventually renders as fill wedges (open boundary chains).
 *
 * normalizeFills() re-derives every claim from consensus: walk all faces
 * (pure geometry), let each face's boundary half-edges vote for the
 * face's fill weighted by edge length, stamp the winner back onto every
 * facing side, and default sides on the infinite face to empty. On a
 * consistent document the vote is unanimous and this is a no-op; on a
 * corrupted one the (few, short) stale claims are outvoted and healed.
 * Lineless edges that end up with identical faces are dissolved.
 */
(function () {
  "use strict";

  function edgeWeight(e) {
    return Math.hypot(e.bx - e.ax, e.by - e.ay) + 1;
  }

  function normalizeFills(doc) {
    var edges = doc.edges;
    if (edges.length === 0) return { restamped: 0, dissolved: 0 };
    var built = VB.buildFaces(doc);

    // Default: infinite face on every side.
    var f0 = new Array(edges.length).fill(0);
    var f1 = new Array(edges.length).fill(0);

    for (var fi = 0; fi < built.faces.length; fi++) {
      var face = built.faces[fi];
      var boundary = face.outer.slice();
      for (var h = 0; h < face.holes.length; h++) {
        boundary = boundary.concat(face.holes[h]);
      }

      // Length-weighted vote over the face's current claims.
      var tally = new Map();
      for (var b = 0; b < boundary.length; b++) {
        var he = boundary[b];
        var e = edges[he.edge];
        var claim = he.forward ? e.fill1 : e.fill0;
        tally.set(claim, (tally.get(claim) || 0) + edgeWeight(e));
      }
      var winner = 0, best = -1;
      tally.forEach(function (w, claim) {
        if (w > best || (w === best && claim === 0)) { best = w; winner = claim; }
      });

      for (var b2 = 0; b2 < boundary.length; b2++) {
        var he2 = boundary[b2];
        if (he2.forward) f1[he2.edge] = winner;
        else f0[he2.edge] = winner;
      }
    }

    var restamped = 0;
    for (var i = 0; i < edges.length; i++) {
      if (edges[i].fill0 !== f0[i] || edges[i].fill1 !== f1[i]) restamped++;
      edges[i].fill0 = f0[i];
      edges[i].fill1 = f1[i];
    }

    var before = edges.length;
    doc.edges = edges.filter(function (e) {
      return !(e.fill0 === e.fill1 && e.line === 0);
    });

    return { restamped: restamped, dissolved: before - doc.edges.length };
  }

  window.VB = window.VB || {};
  VB.normalizeFills = normalizeFills;
})();
