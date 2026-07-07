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
    var loop = VB.buildSwath(points, radius);
    if (loop.length === 0) return { removed: 0, boundary: 0 };

    // Directed loop for winding queries (kept pristine — noding splits
    // copies, not these).
    var loopEdges = loop.map(function (g) {
      return VB.edge(g.ax, g.ay, g.cx, g.cy, g.bx, g.by, 0, 0, 0);
    }).filter(function (e) { return !VB.edgeIsDegenerate(e); });
    if (loopEdges.length === 0) return { removed: 0, boundary: 0 };

    function winding(x, y) {
      return VB.geom.windingNumber(loopEdges, x, y);
    }

    var swathBBox = loopEdges.reduce(function (bb, e) {
      var b = VB.geom.edgeBBox(e);
      if (!bb) return b;
      return {
        xmin: Math.min(bb.xmin, b.xmin), xmax: Math.max(bb.xmax, b.xmax),
        ymin: Math.min(bb.ymin, b.ymin), ymax: Math.max(bb.ymax, b.ymax)
      };
    }, null);

    // Node the swath boundary into the map (splits existing edges at the
    // swath outline; returns the outline's own pieces, not yet inserted).
    var inserts = loopEdges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    var pieces = VB.nodeEdges(doc, inserts);

    // Classify the swath boundary pieces BEFORE deleting anything: the
    // outside fill query needs the regions intact.
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
      var wRight = winding(mid.x - dy * SIDE_PROBE, mid.y + dx * SIDE_PROBE);
      var wLeft = winding(mid.x + dy * SIDE_PROBE, mid.y - dx * SIDE_PROBE);
      var rightInside = wRight !== 0, leftInside = wLeft !== 0;
      if (rightInside === leftInside) continue; // interior lobe or stray

      var ox = rightInside ? mid.x + dy * SIDE_PROBE : mid.x - dy * SIDE_PROBE;
      var oy = rightInside ? mid.y - dx * SIDE_PROBE : mid.y + dx * SIDE_PROBE;
      var f = VB.geom.fillAt(doc, ox, oy);
      if (f === 0) continue; // nothing outside — no boundary needed

      // fill1 = right face, fill0 = left face; the inside face stays 0.
      e.fill0 = rightInside ? f : 0;
      e.fill1 = rightInside ? 0 : f;
      e.line = 0;
      kept.push(e);
    }

    // Delete existing edges swallowed by the swath.
    var removed = 0;
    var survivors = [];
    for (var j = 0; j < doc.edges.length; j++) {
      var de = doc.edges[j];
      var bb = VB.geom.edgeBBox(de);
      if (VB.geom.bboxOverlap(bb, swathBBox)) {
        var m = VB.geom.evalEdge(de, 0.5);
        if (winding(m.x, m.y) !== 0) { removed++; continue; }
      }
      survivors.push(de);
    }
    doc.edges = survivors;

    for (var k = 0; k < kept.length; k++) doc.edges.push(kept[k]);
    return { removed: removed, boundary: kept.length };
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
