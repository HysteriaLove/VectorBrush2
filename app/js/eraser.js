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

  var SIDE_PROBE = 1.5; // twips: how far off a boundary piece to sample

  function eraseStroke(doc, points, radius) {
    var swath = VB.buildSwath(points, radius);
    var loop = swath.loop;
    if (loop.length === 0) return { removed: 0, boundary: 0 };

    var loopEdges = loop.map(function (g) {
      return VB.edge(g.ax, g.ay, g.cx, g.cy, g.bx, g.by, 0, 0, 0);
    }).filter(function (e) { return !VB.edgeIsDegenerate(e); });
    if (loopEdges.length === 0) return { removed: 0, boundary: 0 };

    // The exact swept region: within `radius` of the drag path. This must
    // NOT be a winding test on the outline loop — concave joins give the
    // loop tiny backward lobes where the nonzero winding cancels to zero,
    // which once misclassified flap fragments as boundary (open fill
    // chains rendered as wedges).
    function inside(x, y, slack) {
      return VB.distToPath(swath.path, x, y) <= radius + (slack || 0);
    }

    var swathBBox = loopEdges.reduce(function (bb, e) {
      var b = VB.geom.edgeBBox(e);
      if (!bb) return b;
      return {
        xmin: Math.min(bb.xmin, b.xmin), xmax: Math.max(bb.xmax, b.xmax),
        ymin: Math.min(bb.ymin, b.ymin), ymax: Math.max(bb.ymax, b.ymax)
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

    // Ground truth for the re-derivation at the end: the pre-op document
    // is consistent (claims agree with faces — verified after every op),
    // so region queries against this snapshot are exact.
    var preOp = new VB.VBDocument();
    preOp.width = doc.width; preOp.height = doc.height;
    preOp.fills = doc.fills; preOp.lines = doc.lines;
    preOp.edges = doc.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    });

    // Node the swath boundary into the map (splits existing edges at the
    // swath outline; returns the outline's own pieces, not yet inserted).
    var inserts = loopEdges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    var pieces = VB.nodeEdges(doc, inserts);

    // Classify the swath boundary pieces BEFORE deleting anything: the
    // outside fill query needs the regions intact. Boundary pieces sit at
    // distance ≈ radius from the path (± rounding and arc-approximation
    // error, ~1-2tw), so the side probes escalate until the two sides of
    // a piece actually disagree; flap fragments from concave joins are
    // fully inside the swept region and never decide — dropped.
    var probeLadder = [SIDE_PROBE, 4, 10];
    var kept = [];
    for (var i = 0; i < pieces.length; i++) {
      var e = pieces[i];
      var mid = VB.geom.evalEdge(e, 0.5);
      var ahead = VB.geom.evalEdge(e, 0.55);
      var dx = ahead.x - mid.x, dy = ahead.y - mid.y;
      var len = Math.hypot(dx, dy);
      if (len === 0) continue;
      dx /= len; dy /= len;
      // visual right of travel = (-dy, dx); left = (dy, -dx)
      var rightInside = false, leftInside = false, decided = false, probe = 0;
      for (var pl = 0; pl < probeLadder.length && !decided; pl++) {
        probe = Math.min(probeLadder[pl], radius * 0.4);
        rightInside = inside(mid.x - dy * probe, mid.y + dx * probe);
        leftInside = inside(mid.x + dy * probe, mid.y - dx * probe);
        decided = rightInside !== leftInside;
      }
      if (!decided) continue; // flap lobe or stray — inside on both sides

      var ox = rightInside ? mid.x + dy * probe : mid.x - dy * probe;
      var oy = rightInside ? mid.y - dx * probe : mid.y + dx * probe;
      var f = VB.geom.fillAt(doc, ox, oy);

      // Keep the piece even when the outside is empty (f === 0): a fence
      // between the erased inside and an adjacent empty region still
      // defines the face structure. Dropping it once let an erased
      // channel merge through a thin strip into the whole drawing, and
      // the fill-consensus pass then dissolved the channel's REAL
      // boundary (total document wipe-out). Redundant 0|0 fences are
      // dissolved by normalizeFills AFTER the face vote, when they have
      // already done their job.
      e.fill0 = rightInside ? f : 0;
      e.fill1 = rightInside ? 0 : f;
      e.line = 0;
      kept.push(e);
    }

    // Delete existing edges swallowed by the swath. Old edges were split
    // exactly at the constructed outline, which wobbles ~2tw around the
    // true radius — the small negative slack keeps sliver pieces in that
    // band alive rather than eating geometry just outside the eraser.
    var removed = 0;
    var survivors = [];
    for (var j = 0; j < doc.edges.length; j++) {
      var de = doc.edges[j];
      var bb = VB.geom.edgeBBox(de);
      if (VB.geom.bboxOverlap(bb, swathBBox)) {
        var m = VB.geom.evalEdge(de, 0.5);
        if (inside(m.x, m.y, -2)) { removed++; continue; }
      }
      survivors.push(de);
    }
    doc.edges = survivors;

    for (var k = 0; k < kept.length; k++) doc.edges.push(kept[k]);

    // Grazing crossings that only became real after rounding leave edges
    // crossing without a shared node — split them now or faces leak.
    VB.repairPlanar(doc);

    deriveFills(doc, preOp, swath.path, radius);

    // Terminal self-heal: old-fence × new-fence grazings can leave a fill
    // boundary topologically open at twip precision even when everything
    // above did its job. The renderer closes open chains with a straight
    // chord anyway — so make that chord REAL geometry (lineless, fill on
    // the chain's fill side, noded into the map). No visual change, but
    // the closed-boundary invariant holds for the bucket and later ops.
    stitchOpenChains(doc);

    return { removed: removed, boundary: kept.length };
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
  function deriveFills(doc, preOp, path, radius) {
    function sideFill(px, py, baseDist) {
      var d = VB.distToPath(path, px, py);
      if (d <= radius - FENCE_BAND) return 0;
      if (d <= radius + FENCE_BAND && d < baseDist) return 0;
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
          if (he.forward) doc.edges[he.edge].fill1 = 0;
          else doc.edges[he.edge].fill0 = 0;
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
          winner = 0;
        } else if (dProbe <= radius + FENCE_BAND) {
          var dBase = VB.distToPath(path, probe.baseX, probe.baseY);
          winner = dProbe < dBase ? 0 : VB.geom.fillAt(preOp, probe.x, probe.y);
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
})();
