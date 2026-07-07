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
    // 0|0 fences that normalize would immediately dissolve. "Blank" means
    // no edge nearby AND not inside a fill (a swath wholly inside a big
    // fill overlaps no edge bboxes but is very much an erase).
    var touches = doc.edges.some(function (e) {
      return VB.geom.bboxOverlap(VB.geom.edgeBBox(e), swathBBox);
    });
    if (!touches &&
        VB.geom.fillAt(doc, swath.path[0].x, swath.path[0].y) === 0 &&
        VB.geom.fillAt(doc, swath.path[swath.path.length - 1].x,
          swath.path[swath.path.length - 1].y) === 0) {
      return { removed: 0, boundary: 0 };
    }

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

    // Re-derive every fill claim from face-level consensus: overlapping
    // erases can strand boundary fragments asserting fills that are no
    // longer there (thin slivers defeat any probe-based classification),
    // and one stale claim renders as fill wedges.
    VB.normalizeFills(doc);

    // The consensus vote can still be won by a long stale boundary when
    // channels merge — but any face containing a point of the erase path
    // is empty BY DEFINITION. Enforce that directly. (Called through the
    // namespace so tests can instrument it.)
    VB.zeroErasedFaces(doc, swath.path);

    return { removed: removed, boundary: kept.length };
  }

  // Stamp fill 0 onto every face that contains a sample of the erase path,
  // then dissolve boundaries that became invisible.
  function zeroErasedFaces(doc, path) {
    if (doc.edges.length === 0) return;
    var samples = [];
    var step = Math.max(1, Math.floor(path.length / 6));
    for (var i = 0; i < path.length; i += step) samples.push(path[i]);
    if (samples[samples.length - 1] !== path[path.length - 1]) {
      samples.push(path[path.length - 1]);
    }

    var built = VB.buildFaces(doc);
    var changed = false;
    for (var f = 0; f < built.faces.length; f++) {
      var face = built.faces[f];
      var cycles = [face.outer].concat(face.holes);
      var contains = false;
      for (var s = 0; s < samples.length && !contains; s++) {
        var crossings = 0;
        for (var c = 0; c < cycles.length; c++) {
          for (var h = 0; h < cycles[c].length; h++) {
            crossings += VB.edgeRayCrossings(
              doc.edges[cycles[c][h].edge], samples[s].x, samples[s].y);
          }
        }
        contains = (crossings & 1) === 1;
      }
      if (!contains) continue;
      for (var c2 = 0; c2 < cycles.length; c2++) {
        for (var h2 = 0; h2 < cycles[c2].length; h2++) {
          var he = cycles[c2][h2];
          var e = doc.edges[he.edge];
          if (he.forward) { if (e.fill1 !== 0) { e.fill1 = 0; changed = true; } }
          else { if (e.fill0 !== 0) { e.fill0 = 0; changed = true; } }
        }
      }
    }
    if (changed) {
      doc.edges = doc.edges.filter(function (e) {
        return !(e.fill0 === e.fill1 && e.line === 0);
      });
    }
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
  VB.zeroErasedFaces = zeroErasedFaces; // exposed for diagnostics/tests
})();
