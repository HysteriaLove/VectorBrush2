/* faces.js — planar-map face traversal (the geometry behind the bucket).
 *
 * The document's edges form a planar subdivision. This module walks its
 * faces the classic half-edge way: every edge yields two half-edges
 * (forward a→b and backward b→a); at each node the outgoing half-edges
 * are sorted by departure angle; walking "keep the face on your right"
 * (y-down screen coordinates) links half-edges into boundary cycles.
 *
 * Cycle orientation tells what a cycle bounds: with this convention a
 * cycle with positive shoelace area is the OUTER boundary of a bounded
 * region; negative-area cycles are inner boundaries (holes, or the
 * infinite face). Each hole cycle is assigned to the smallest containing
 * outer cycle, giving faces = outer cycle + holes.
 *
 * Because a face lies on the right of each of its half-edges, stamping a
 * fill onto a face is exact: forward half-edge → the stored edge's fill1
 * side, backward half-edge → fill0. (Same convention as rendering.)
 */
(function () {
  "use strict";

  function key(x, y) { return x + "," + y; }

  // Departure angle of a half-edge at its origin (y-down atan2), plus a
  // secondary angle toward the far end. Short split pieces have heavily
  // quantized control points, so ties on the primary angle are broken by
  // where the edge ultimately goes.
  function departureAngles(e, forward) {
    var ox, oy, tx, ty, fx, fy;
    if (forward) {
      ox = e.ax; oy = e.ay; fx = e.bx; fy = e.by;
      tx = (e.cx !== null && (e.cx !== e.ax || e.cy !== e.ay)) ? e.cx : e.bx;
      ty = (e.cx !== null && (e.cx !== e.ax || e.cy !== e.ay)) ? e.cy : e.by;
    } else {
      ox = e.bx; oy = e.by; fx = e.ax; fy = e.ay;
      tx = (e.cx !== null && (e.cx !== e.bx || e.cy !== e.by)) ? e.cx : e.ax;
      ty = (e.cx !== null && (e.cx !== e.bx || e.cy !== e.by)) ? e.cy : e.ay;
    }
    return {
      angle: Math.atan2(ty - oy, tx - ox),
      angle2: Math.atan2(fy - oy, fx - ox)
    };
  }

  // Flattened polyline of a half-edge (for cycle areas / hole probes).
  function flatten(e, forward, out) {
    if (e.cx === null) {
      out.push(forward ? { x: e.bx, y: e.by } : { x: e.ax, y: e.ay });
      return;
    }
    var ts = forward ? [0.25, 0.5, 0.75, 1] : [0.75, 0.5, 0.25, 0];
    for (var i = 0; i < ts.length; i++) out.push(VB.geom.evalEdge(e, ts[i]));
  }

  /**
   * Traces every walk cycle of the planar map — pure geometry, no
   * orientation classification, no hole grouping. Returns
   * [{ cycle: [halfEdge], area, pts }] covering every half-edge exactly
   * once. This is the trustworthy core; everything layered on top of it
   * (hole assignment in particular) is heuristic.
   */
  function traceCycles(doc) {
    var edges = doc.edges;

    // Outgoing half-edges per node, angle-sorted.
    var nodes = new Map();
    function addOutgoing(i, forward) {
      var e = edges[i];
      var k = forward ? key(e.ax, e.ay) : key(e.bx, e.by);
      var list = nodes.get(k);
      if (!list) { list = []; nodes.set(k, list); }
      var ang = departureAngles(e, forward);
      list.push({ edge: i, forward: forward, angle: ang.angle, angle2: ang.angle2 });
    }
    for (var i = 0; i < edges.length; i++) {
      if (VB.edgeIsDegenerate(edges[i])) continue;
      addOutgoing(i, true);
      addOutgoing(i, false);
    }
    nodes.forEach(function (list) {
      list.sort(function (a, b) { return (a.angle - b.angle) || (a.angle2 - b.angle2); });
    });

    // next(h): at h's target node, take the reverse half-edge's rotational
    // predecessor (clockwise in atan2 order) — keeps the face on the right.
    function next(h) {
      var e = edges[h.edge];
      var k = h.forward ? key(e.bx, e.by) : key(e.ax, e.ay);
      var list = nodes.get(k);
      var revIdx = -1;
      for (var n = 0; n < list.length; n++) {
        if (list[n].edge === h.edge && list[n].forward === !h.forward) { revIdx = n; break; }
      }
      return list[(revIdx - 1 + list.length) % list.length];
    }

    // Trace all cycles.
    var visited = new Set(); // "edgeIdx/1|0"
    var cycles = [];
    for (var s = 0; s < edges.length; s++) {
      if (VB.edgeIsDegenerate(edges[s])) continue;
      for (var d = 0; d < 2; d++) {
        var start = { edge: s, forward: d === 0 };
        var startKey = start.edge + "/" + (start.forward ? 1 : 0);
        if (visited.has(startKey)) continue;
        var cyc = [];
        var h = start;
        var guard = edges.length * 2 + 4;
        do {
          visited.add(h.edge + "/" + (h.forward ? 1 : 0));
          cyc.push({ edge: h.edge, forward: h.forward });
          h = next(h);
        } while ((h.edge !== start.edge || h.forward !== start.forward) && --guard > 0);
        cycles.push(cyc);
      }
    }

    // Signed area + a probe point for each cycle.
    var cycleInfo = cycles.map(function (cyc) {
      var pts = [];
      var e0 = edges[cyc[0].edge];
      pts.push(cyc[0].forward ? { x: e0.ax, y: e0.ay } : { x: e0.bx, y: e0.by });
      for (var c = 0; c < cyc.length; c++) {
        flatten(edges[cyc[c].edge], cyc[c].forward, pts);
      }
      var area = 0;
      for (var p = 0; p + 1 < pts.length; p++) {
        area += pts[p].x * pts[p + 1].y - pts[p + 1].x * pts[p].y;
      }
      area /= 2;
      return { cycle: cyc, area: area, pts: pts };
    });
    return cycleInfo;
  }

  /**
   * Builds all faces of the planar map.
   * Returns { faces } where each face is:
   *   { outer: [halfEdge], holes: [[halfEdge]], area }
   * and each halfEdge is { edge: index, forward: bool }.
   * The infinite face is not returned (its cycles bound no region).
   */
  function buildFaces(doc) {
    var edges = doc.edges;
    var cycleInfo = traceCycles(doc);

    // Positive cycles bound regions; negative ones are holes/infinite.
    var outers = cycleInfo.filter(function (c) { return c.area > 0; });
    var inners = cycleInfo.filter(function (c) { return c.area <= 0; });
    outers.sort(function (a, b) { return a.area - b.area; }); // smallest first

    var faces = outers.map(function (o) {
      return { outer: o.cycle, holes: [], area: o.area, _info: o };
    });

    // Assign each hole to the smallest containing outer cycle.
    for (var hIdx = 0; hIdx < inners.length; hIdx++) {
      var probe = probeForCycle(edges, inners[hIdx].cycle);
      for (var f = 0; f < faces.length; f++) {
        if (cycleContains(edges, faces[f].outer, probe.x, probe.y)) {
          faces[f].holes.push(inners[hIdx].cycle);
          break; // faces are sorted smallest-first: first hit = tightest
        }
      }
      // No container → boundary of the infinite face; dropped.
    }

    faces.forEach(function (f) { delete f._info; });
    return { faces: faces };
  }

  // Containment probe for a hole cycle: a point exactly ON the true curve
  // (longest half-edge, evaluated at t=0.5) nudged one twip to the RIGHT
  // of travel — the side the cycle's face lies on. Must NOT be derived
  // from flattened chords: a chord midpoint sags into the curve's belly
  // by far more than any nudge, landing the probe in the wrong region
  // (that was the "every island fills" bug).
  function probeForCycle(edges, cycle) {
    var best = cycle[0], bestLen = -1;
    for (var i = 0; i < cycle.length; i++) {
      var ee = edges[cycle[i].edge];
      var l = (ee.bx - ee.ax) * (ee.bx - ee.ax) + (ee.by - ee.ay) * (ee.by - ee.ay);
      if (l > bestLen) { bestLen = l; best = cycle[i]; }
    }
    var e = edges[best.edge];
    var p = VB.geom.evalEdge(e, 0.5);
    // At t=0.5 a quad's tangent is parallel to its chord, so the chord
    // direction is the exact travel direction for lines and quads alike.
    var dx = e.bx - e.ax, dy = e.by - e.ay;
    if (!best.forward) { dx = -dx; dy = -dy; }
    var len = Math.hypot(dx, dy) || 1;
    // baseX/baseY: the exact on-curve point the probe was nudged from —
    // callers use it to tell which side of a boundary the face lies on.
    return { x: p.x - dy / len, y: p.y + dx / len, baseX: p.x, baseY: p.y };
  }

  // Parity of a point against one cycle's underlying edges. Each
  // half-edge occurrence counts once, so an edge traversed twice by the
  // cycle (dangling stub) contributes twice and cancels — correct.
  function cycleContains(edges, cycle, px, py) {
    var crossings = 0;
    for (var i = 0; i < cycle.length; i++) {
      crossings += edgeRayCrossings(edges[cycle[i].edge], px, py);
    }
    return (crossings & 1) === 1;
  }

  function edgeRayCrossings(e, px, py) {
    if (e.cx === null) {
      return lineRay(e.ax, e.ay, e.bx, e.by, px, py);
    }
    var denom = e.ay - 2 * e.cy + e.by;
    var tExt = denom !== 0 ? (e.ay - e.cy) / denom : -1;
    var ts = [0];
    if (tExt > 1e-9 && tExt < 1 - 1e-9) ts.push(tExt);
    ts.push(1);
    var n = 0;
    for (var s = 0; s + 1 < ts.length; s++) {
      n += quadRayMonotonic(e, ts[s], ts[s + 1], px, py);
    }
    return n;
  }

  function lineRay(x1, y1, x2, y2, px, py) {
    if ((y1 > py) === (y2 > py)) return 0;
    var t = (py - y1) / (y2 - y1);
    return (x1 + (x2 - x1) * t) > px ? 1 : 0;
  }

  function quadRayMonotonic(e, t0, t1, px, py) {
    var p0 = VB.geom.evalEdge(e, t0), p1 = VB.geom.evalEdge(e, t1);
    if ((p0.y > py) === (p1.y > py)) return 0;
    var A = e.ay - 2 * e.cy + e.by;
    var B = 2 * (e.cy - e.ay);
    var C = e.ay - py;
    var roots = VB.geom.solveQuadratic(A, B, C);
    for (var i = 0; i < roots.length; i++) {
      var t = roots[i];
      if (t >= t0 - 1e-9 && t <= t1 + 1e-9) {
        return VB.geom.evalEdge(e, Math.min(1, Math.max(0, t))).x > px ? 1 : 0;
      }
    }
    return 0;
  }

  // The face containing (x,y), or null (infinite face). Uses the face's
  // full boundary (outer + holes) so islands are excluded correctly.
  function faceAt(doc, x, y) {
    var built = buildFaces(doc);
    for (var f = 0; f < built.faces.length; f++) {
      var face = built.faces[f];
      var crossings = 0;
      for (var i = 0; i < face.outer.length; i++) {
        crossings += edgeRayCrossings(doc.edges[face.outer[i].edge], x, y);
      }
      for (var h = 0; h < face.holes.length; h++) {
        for (var j = 0; j < face.holes[h].length; j++) {
          crossings += edgeRayCrossings(doc.edges[face.holes[h][j].edge], x, y);
        }
      }
      if (crossings & 1) return face;
    }
    return null;
  }

  window.VB = window.VB || {};
  VB.buildFaces = buildFaces;
  VB.traceCycles = traceCycles;
  VB.probeForCycle = probeForCycle;
  VB.faceAt = faceAt;
  VB.edgeRayCrossings = edgeRayCrossings; // exposed for diagnostics/tests
})();
