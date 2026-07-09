/* eraser.js — the eraser tool: subtract a swept disc from the planar map.
 *
 * The drag becomes a capsule-chain outline (swath.js). That loop is noded
 * into the map (merge.nodeEdges), then everything is classified against
 * the loop's signed winding (geom.windingNumber, nonzero rule so the
 * loop's self-overlap lobes still count as inside):
 *
 *   - existing edges whose midpoint is inside the swath are deleted —
 *     this is what trims strokes and carves fills;
 *   - swath boundary pieces keep only the side that faces surviving
 *     artwork: the outside face inherits the fill that was there, the
 *     inside face is empty, and pieces with nothing on either side are
 *     dropped (erasing through blank canvas leaves no geometry);
 *   - erased holes have no stroke around them (line = 0), matching the
 *     Eraser*.swf reference snapshots.
 */
(function () {
  "use strict";

  var SIDE_PROBE = 1.5; // twips: probe distance (legacy deriveFills below)
  var FIT_TOL = 12;     // twips: outline curve-fit tolerance (0.6 px)

  function eraseStroke(doc, points, radius) {
    var swath = VB.buildSwath(points, radius);
    if (!swath.path || swath.path.length === 0) return { removed: 0, boundary: 0 };

    var swathBBox = swath.path.reduce(function (bb, p) {
      if (!bb) {
        return { xmin: p.x - radius, xmax: p.x + radius,
                 ymin: p.y - radius, ymax: p.y + radius };
      }
      return {
        xmin: Math.min(bb.xmin, p.x - radius), xmax: Math.max(bb.xmax, p.x + radius),
        ymin: Math.min(bb.ymin, p.y - radius), ymax: Math.max(bb.ymax, p.y + radius)
      };
    }, null);

    // Erasing blank space is a true no-op — don't litter the map with
    // 0|0 fences. "Blank" means no edge nearby AND not inside a fill (a
    // swath wholly inside a big fill overlaps no edge bboxes but is very
    // much an erase).
    var touches = doc.edges.some(function (e) {
      return VB.geom.bboxOverlap(VB.geom.edgeBBox(e), swathBBox);
    });
    if (!touches &&
        VB.geom.fillAt(doc, swath.path[0].x, swath.path[0].y) === 0 &&
        VB.geom.fillAt(doc, swath.path[swath.path.length - 1].x,
          swath.path[swath.path.length - 1].y) === 0) {
      return { removed: 0, boundary: 0 };
    }

    // The eraser shares the brush's boolean core: exact swept region from
    // paper.js capsule union, fitted to Flash-lean quad loops, noded in,
    // then the face-walk mask (mask.js) regenerates all claims — with the
    // region resolving to EMPTINESS instead of a paint fill.
    var loops = VB.sweptOutline(swath.path, radius, FIT_TOL);
    var fitted = [];
    loops.forEach(function (loop) {
      loop.forEach(function (e) { fitted.push(e); });
    });
    if (fitted.length === 0) return { removed: 0, boundary: 0 };

    var windingLoops = fitted.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    var sweptOracle = VB.geom.windingOracle(windingLoops);
    function insideSwept(x, y) {
      return sweptOracle.at(x, y) !== 0;
    }

    // Ground truth for faces outside the swath: the pre-op document is
    // consistent, so region queries against this snapshot are exact.
    var preOp = new VB.VBDocument();
    preOp.width = doc.width; preOp.height = doc.height;
    preOp.fills = doc.fills; preOp.lines = doc.lines;
    preOp.edges = doc.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    });

    // A fence piece integer-identical to an existing edge must NOT be
    // noded against it: intersecting a curve with itself shreds both
    // copies into sub-twip fragments no exact rule can pair (the
    // repeated-eraser-click toggle). Drop the new copy up front and hand
    // its old twin to the mask as a protected carrier instead.
    var adopted = VB.adoptIdenticalEdges(doc, fitted);
    var pieces = VB.nodeEdges(doc, adopted.fresh);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);

    var removed = VB.applyRegionMask(doc, preOp, insideSwept, 0,
                                     pieces.concat(adopted.twins));

    return { removed: removed, boundary: fitted.length };
  }

  function stitchOpenChains(doc) {
    for (var pass = 0; pass < 2; pass++) {
      var perFill = VB.buildFillPaths(doc);
      var chords = [];
      for (var f = 1; f < perFill.length; f++) {
        for (var c = 0; c < perFill[f].length; c++) {
          var ch = perFill[f][c];
          if (ch.closed) continue;
          var last = ch.pts[ch.pts.length - 1];
          if (Math.hypot(last.x - ch.sx, last.y - ch.sy) <= 2) continue;
          // Chains walk with their fill on the right (fill1 side); the
          // closing chord end→start keeps the same handedness.
          chords.push(VB.edge(last.x, last.y, null, null, ch.sx, ch.sy, 0, f, 0));
        }
      }
      if (chords.length === 0) return;
      var pieces = VB.nodeEdges(doc, chords);
      for (var p = 0; p < pieces.length; p++) doc.edges.push(pieces[p]);
      VB.repairPlanar(doc);
    }
  }

  var FENCE_BAND = 4;    // twips: construction wobble of the swath outline
  var SIDE_NUDGE = 2;    // twips: how far off an edge each face is sampled
  var SUSPECT_PAD = 40;  // twips: a "carved channel" face must fit within this

  // Fill re-derivation after the carve. Faces coordinate (so long shared
  // boundaries get ONE consistent answer), but only where they can be
  // trusted; where the face structure is suspect, exact per-edge local
  // queries take over. Learned the hard way on real session logs:
  //   - whole-face votes let stale claims empty entire regions,
  //   - pure per-edge answers disagree along long walls (giant seams),
  //   - the failure mode must always degrade toward "a sliver keeps its
  //     old fill", never "a region vanishes".
  // Rules per face (only faces near the swath are touched at all):
  //   1. contains an erase-path probe and fits within the swept
  //      neighborhood → it IS the carved channel → empty, by definition;
  //   2. contains a probe but extends far beyond the swath → the fence
  //      leaked and this "face" is a merger of channel and innocent
  //      regions → don't trust it as a unit; re-derive its boundary
  //      edges individually from local truth;
  //   3. no probe inside → decide once, exactly, from its own boundary
  //      probe (distance rules near the fence band, pre-op region parity
  //      otherwise) and stamp the whole face with it.
  function deriveFills(doc, preOp, path, radius, insideFill) {
    function sideFill(px, py, baseDist) {
      var d = VB.distToPath(path, px, py);
      if (d <= radius - FENCE_BAND) return insideFill;
      if (d <= radius + FENCE_BAND && d < baseDist) return insideFill;
      return VB.geom.fillAt(preOp, px, py);
    }

    // Re-derives ONE face of an edge — the side of the given half-edge.
    // Touching both sides here would clobber the claim a neighboring
    // healthy face already stamped on its own side of a shared edge.
    function deriveEdgeSide(e, forward) {
      var mid = VB.geom.evalEdge(e, 0.5);
      var baseDist = VB.distToPath(path, mid.x, mid.y);
      if (baseDist > radius + 20) return; // local truth already exact
      var ahead = VB.geom.evalEdge(e, 0.55);
      var dx = ahead.x - mid.x, dy = ahead.y - mid.y;
      var len = Math.hypot(dx, dy);
      if (len === 0) return;
      dx /= len; dy /= len;
      // visual right of travel = (-dy, dx) → fill1; left → fill0
      if (forward) {
        e.fill1 = sideFill(mid.x - dy * SIDE_NUDGE, mid.y + dx * SIDE_NUDGE, baseDist);
      } else {
        e.fill0 = sideFill(mid.x + dy * SIDE_NUDGE, mid.y - dx * SIDE_NUDGE, baseDist);
      }
    }

    var probes = [];
    var step = Math.max(1, Math.floor(path.length / 24));
    for (var ps = 0; ps < path.length; ps += step) probes.push(path[ps]);

    var built = VB.buildFaces(doc);
    for (var fi = 0; fi < built.faces.length; fi++) {
      var face = built.faces[fi];
      var boundary = face.outer.slice();
      for (var h = 0; h < face.holes.length; h++) {
        boundary = boundary.concat(face.holes[h]);
      }

      // Distance extent of the face's boundary from the erase path.
      var minDist = Infinity, maxDist = 0;
      for (var b = 0; b < boundary.length; b++) {
        var em = VB.geom.evalEdge(doc.edges[boundary[b].edge], 0.5);
        var d = VB.distToPath(path, em.x, em.y);
        minDist = Math.min(minDist, d);
        maxDist = Math.max(maxDist, d);
      }
      if (minDist > radius + 20) continue; // face untouched by this erase

      var containsProbe = false;
      for (var s = 0; s < probes.length && !containsProbe; s++) {
        var crossings = 0;
        for (var b2 = 0; b2 < boundary.length; b2++) {
          crossings += VB.edgeRayCrossings(
            doc.edges[boundary[b2].edge], probes[s].x, probes[s].y);
        }
        containsProbe = (crossings & 1) === 1;
      }

      // Stamping is ALWAYS scope-limited: a face's boundary can reach
      // arbitrarily far, and if the face is secretly merged through a
      // fence leak, stamping remote sides silently corrupts regions the
      // eraser never came near (observed: stroke edges 1900tw away left
      // with 0|0 claims). Remote sides keep their exact pre-op claims.
      function inScope(he) {
        var m = VB.geom.evalEdge(doc.edges[he.edge], 0.5);
        return VB.distToPath(path, m.x, m.y) <= radius + 20;
      }

      if (containsProbe && maxDist <= radius + SUSPECT_PAD) {
        // 1. the carved channel itself
        for (var b3 = 0; b3 < boundary.length; b3++) {
          var he = boundary[b3];
          if (!inScope(he)) continue;
          if (he.forward) doc.edges[he.edge].fill1 = insideFill;
          else doc.edges[he.edge].fill0 = insideFill;
        }
      } else if (containsProbe) {
        // 2. suspect merger — fall back to exact local truth, one side
        //    per half-edge (deriveEdgeSide is scope-limited itself)
        for (var b4 = 0; b4 < boundary.length; b4++) {
          deriveEdgeSide(doc.edges[boundary[b4].edge], boundary[b4].forward);
        }
      } else {
        // 3. bystander face clipped by the swath: one exact decision
        var probe = VB.probeForCycle(doc.edges, face.outer);
        var dProbe = VB.distToPath(path, probe.x, probe.y);
        var winner;
        if (dProbe <= radius - FENCE_BAND) {
          winner = insideFill;
        } else if (dProbe <= radius + FENCE_BAND) {
          var dBase = VB.distToPath(path, probe.baseX, probe.baseY);
          winner = dProbe < dBase ? insideFill : VB.geom.fillAt(preOp, probe.x, probe.y);
        } else {
          winner = VB.geom.fillAt(preOp, probe.x, probe.y);
        }
        for (var b5 = 0; b5 < boundary.length; b5++) {
          var he2 = boundary[b5];
          if (!inScope(he2)) continue;
          if (he2.forward) doc.edges[he2.edge].fill1 = winner;
          else doc.edges[he2.edge].fill0 = winner;
        }
      }
    }

    doc.edges = doc.edges.filter(function (e2) {
      return !(e2.fill0 === e2.fill1 && e2.line === 0);
    });
  }

  // ---- interactive tool ------------------------------------------------------

  function EraserTool(app) {
    this.app = app;
    this.points = null;
    this.hoverPos = null;
  }

  EraserTool.prototype.radius = function () {
    return this.app.eraserWidth * VB.TWIPS / 2;
  };

  EraserTool.prototype.onDown = function (pos) {
    this.points = [{ x: pos.x, y: pos.y }];
    this.hoverPos = pos;
  };

  EraserTool.prototype.onMove = function (pos) {
    this.hoverPos = pos;
    if (!this.points) return;
    var minDist = 2 * VB.TWIPS / this.app.view.zoom;
    var last = this.points[this.points.length - 1];
    var dx = pos.x - last.x, dy = pos.y - last.y;
    if (dx * dx + dy * dy >= minDist * minDist) {
      this.points.push({ x: pos.x, y: pos.y });
    }
    this.app.requestRender();
  };

  EraserTool.prototype.onUp = function (pos) {
    if (!this.points) return;
    var pts = this.points;
    this.points = null;
    if (pos) pts.push({ x: pos.x, y: pos.y });

    this.app.record({
      op: "erase",
      points: pts.map(function (p) { return { x: p.x, y: p.y }; }),
      radius: this.radius()
    });
    this.app.history.push(this.app.doc);
    var result = eraseStroke(this.app.doc, pts, this.radius());
    if (result.removed === 0 && result.boundary === 0) {
      this.app.history.undoStack.pop(); // erased nothing; drop the snapshot
      this.app.setMsg("nothing to erase there");
      this.app.requestRender();
      return;
    }
    this.app.docChanged();
    this.app.setMsg("erased " + result.removed + " edge" +
      (result.removed === 1 ? "" : "s") +
      (result.boundary ? " · " + result.boundary + " boundary pieces" : ""));
  };

  EraserTool.prototype.onHover = function (pos) {
    this.hoverPos = pos;
    this.app.requestRender();
  };

  EraserTool.prototype.cancel = function () {
    this.points = null;
    this.app.requestRender();
  };

  EraserTool.prototype.drawOverlay = function (ctx) {
    var r = this.radius();
    if (this.points && this.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.points[0].x, this.points[0].y);
      for (var i = 1; i < this.points.length; i++) {
        ctx.lineTo(this.points[i].x, this.points[i].y);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = r * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    if (this.hoverPos) {
      ctx.beginPath();
      ctx.arc(this.hoverPos.x, this.hoverPos.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = VB.TWIPS / this.app.view.zoom;
      ctx.stroke();
    }
  };

  window.VB = window.VB || {};
  VB.EraserTool = EraserTool;
  VB.eraseStroke = eraseStroke;
  VB.stitchOpenChains = stitchOpenChains; // shared with the brush tool
  VB.deriveSweptFills = deriveFills;     // shared with the brush tool
})();
