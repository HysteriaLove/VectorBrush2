/* brush.js — the Flash brush: paint a swept-disc region as a fill.
 *
 * The positive twin of the eraser, and its output is dictated by the
 * SWFExamples references:
 *   - a single dab (Brush001/brush002.swf) is ONE closed loop of
 *     quadratic curves with the fill on one side and NO line style;
 *   - same-color strokes overlapping merge into a union (their shared
 *     border dissolves — Brush002 series);
 *   - different colors overlapping split at the crossings and share
 *     two-sided F|G borders, with the NEW color owning the overlap
 *     (Brush002/Brush003.swf — "paint normal" covers what's beneath);
 *   - strokes crossed by the brush survive: their pieces inside the
 *     paint become interior edges (fill|fill with a line style), the
 *     same structure a pencil line drawn across a fill has.
 *
 * Mechanically it mirrors eraseStroke with the inside fill being the
 * paint instead of emptiness: node the swath outline into the map, keep
 * its true boundary pieces (paint inward, pre-op fill outward), delete
 * submerged lineless fill boundaries, re-claim submerged strokes as
 * interior, then repair, dissolve redundancy, and stitch — upholding the
 * Flash output invariants (no lineless 0|0, no lineless F|F).
 */
(function () {
  "use strict";

  var SIDE_PROBE = 1.5; // twips: how far off a boundary piece to sample

  function brushStroke(doc, points, radius, color) {
    var swath = VB.buildSwath(points, radius);
    var loop = swath.loop;
    if (loop.length === 0) return { painted: 0, boundary: 0 };

    var loopEdges = loop.map(function (g) {
      return VB.edge(g.ax, g.ay, g.cx, g.cy, g.bx, g.by, 0, 0, 0);
    }).filter(function (e) { return !VB.edgeIsDegenerate(e); });
    if (loopEdges.length === 0) return { painted: 0, boundary: 0 };

    var fillIdx = doc.addFillStyle({
      type: "solid",
      color: { r: color.r, g: color.g, b: color.b, a: color.a }
    });

    // The exact swept region: within `radius` of the drag path (see the
    // eraser for why this must not be a winding test on the outline).
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

    // Node the paint outline into the map.
    var inserts = loopEdges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    var pieces = VB.nodeEdges(doc, inserts);

    // Classify outline pieces BEFORE mutating anything (the outward fill
    // query needs the old regions intact). Same escalating side probes as
    // the eraser; interior flap fragments never decide and are dropped.
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
      if (!decided) continue;

      var ox = rightInside ? mid.x + dy * probe : mid.x - dy * probe;
      var oy = rightInside ? mid.y - dx * probe : mid.y + dx * probe;
      var f = VB.geom.fillAt(doc, ox, oy);

      // Paint inward, whatever was there outward. Same-color contact
      // (f === fillIdx) yields fill|fill pieces that dissolve at the end
      // — that is exactly Flash's stroke-union behavior.
      e.fill0 = rightInside ? f : fillIdx;
      e.fill1 = rightInside ? fillIdx : f;
      e.line = 0;
      kept.push(e);
    }

    // Submerge what the paint covers: lineless fill boundaries inside the
    // swath disappear (the paint replaces those fills there); strokes
    // survive as interior edges of the paint, exactly like a pencil line
    // inside a bucket fill. Band slivers ([r-2, r]) keep their claims.
    var painted = 0;
    var survivors = [];
    for (var j = 0; j < doc.edges.length; j++) {
      var de = doc.edges[j];
      var bb = VB.geom.edgeBBox(de);
      if (VB.geom.bboxOverlap(bb, swathBBox)) {
        var m = VB.geom.evalEdge(de, 0.5);
        if (inside(m.x, m.y, -2)) {
          if (de.line === 0) { painted++; continue; } // submerged boundary
          de.fill0 = fillIdx;                          // interior stroke
          de.fill1 = fillIdx;
          painted++;
        }
      }
      survivors.push(de);
    }
    doc.edges = survivors;

    for (var k = 0; k < kept.length; k++) doc.edges.push(kept[k]);

    // Grazing crossings that became real after rounding must be noded.
    VB.repairPlanar(doc);

    // Flash output invariants: no lineless 0|0, no lineless fill|fill.
    doc.edges = doc.edges.filter(function (e2) {
      return !(e2.fill0 === e2.fill1 && e2.line === 0);
    });

    // Terminal invariant-keeper, shared with the eraser.
    VB.stitchOpenChains(doc);

    return { painted: painted, boundary: kept.length };
  }

  // ---- interactive tool ------------------------------------------------------

  function BrushTool(app) {
    this.app = app;
    this.points = null;
    this.hoverPos = null;
  }

  BrushTool.prototype.radius = function () {
    return this.app.brushWidth * VB.TWIPS / 2;
  };

  BrushTool.prototype.onDown = function (pos) {
    this.points = [{ x: pos.x, y: pos.y }];
    this.hoverPos = pos;
  };

  BrushTool.prototype.onMove = function (pos) {
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

  BrushTool.prototype.onUp = function (pos) {
    if (!this.points) return;
    var pts = this.points;
    this.points = null;
    if (pos) pts.push({ x: pos.x, y: pos.y });

    this.app.record({
      op: "brush",
      points: pts.map(function (p) { return { x: p.x, y: p.y }; }),
      radius: this.radius(),
      color: {
        r: this.app.fillColor.r, g: this.app.fillColor.g,
        b: this.app.fillColor.b, a: this.app.fillColor.a
      }
    });
    this.app.history.push(this.app.doc);
    var result = brushStroke(this.app.doc, pts, this.radius(), this.app.fillColor);
    this.app.docChanged();
    this.app.setMsg("painted: " + result.boundary + " boundary pieces" +
      (result.painted ? " · " + result.painted + " edges submerged" : ""));
  };

  BrushTool.prototype.onHover = function (pos) {
    this.hoverPos = pos;
    this.app.requestRender();
  };

  BrushTool.prototype.cancel = function () {
    this.points = null;
    this.app.requestRender();
  };

  BrushTool.prototype.drawOverlay = function (ctx) {
    var r = this.radius();
    var c = this.app.fillColor;
    if (this.points && this.points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(this.points[0].x, this.points[0].y);
      for (var i = 1; i < this.points.length; i++) {
        ctx.lineTo(this.points[i].x, this.points[i].y);
      }
      ctx.strokeStyle = "rgba(" + c.r + "," + c.g + "," + c.b + ",0.85)";
      ctx.lineWidth = r * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      if (this.points.length === 1) {
        ctx.beginPath();
        ctx.arc(this.points[0].x, this.points[0].y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(" + c.r + "," + c.g + "," + c.b + ",0.85)";
        ctx.fill();
      }
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
  VB.BrushTool = BrushTool;
  VB.brushStroke = brushStroke;
})();
