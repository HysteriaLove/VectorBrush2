/* brush.js — the Flash brush: paint a swept-disc region as a fill.
 *
 * The output is dictated by the SWFExamples references:
 *   - a single dab/stroke (Brush001/brush002.swf) is ONE closed loop of
 *     14-26 fitted quadratic curves with the fill on one side and NO
 *     line style — Flash curve-fits the stroke outline;
 *   - same-color strokes overlapping merge into a union, their shared
 *     border dissolving (Brush002 series);
 *   - different colors overlapping split at the crossings and share
 *     two-sided F|G borders, with the NEW color owning the overlap;
 *   - paint-over ERASES what it covers: stroke segments under the paint
 *     are trimmed away ("paint normal" replaces everything beneath).
 *
 * Pipeline (paper.js boolean core + face walk):
 *   1. exact swept region = union of per-segment capsules (paper.js
 *      unite, see paperglue.js), fitted to lean closed quad loops;
 *   2. node the fitted outline into the planar map;
 *   3. reconcile via the boolean mask (mask.js): walk faces, one probe
 *      per face — inside the mask → the paint, outside → pre-op truth —
 *      and regenerate every edge claim from its two faces.
 * Consistency is by construction: no per-edge probing, no stitching.
 */
(function () {
  "use strict";

  var FIT_TOL = 12; // twips: outline curve-fit tolerance (0.6 px)

  function brushStroke(doc, points, radius, color) {
    var swath = VB.buildSwath(points, radius);
    if (!swath.path || swath.path.length === 0) return { painted: 0, boundary: 0 };

    var fillIdx = doc.addFillStyle({
      type: "solid",
      color: { r: color.r, g: color.g, b: color.b, a: color.a }
    });

    // ---- 1. region boolean in paper space ---------------------------------
    // The new fill-f region = swept capsules UNITED with the existing
    // fill-f region. Where the boundary is unchanged, paper reuses the
    // input curves and the exact original integer quads come back — so
    // near-coincident re-fitted duplicates cannot exist, which was the
    // root of every pocket-flood / invisible-stroke bug.
    var pu = VB.paintUnion(doc, swath.path, radius, fillIdx);
    var fitted = [];
    pu.loops.forEach(function (loop) {
      loop.forEach(function (e) { fitted.push(e); });
    });
    if (fitted.length === 0) return { painted: 0, boundary: 0 };

    var unionLoops = fitted.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    function insideUnion(x, y) {
      return VB.geom.windingNumber(unionLoops, x, y) !== 0;
    }
    var strokeEdges = [];
    pu.strokeLoops.forEach(function (loop) {
      loop.forEach(function (e) { strokeEdges.push(e); });
    });
    // Paint-over covering (erasing strokes/other colors) applies only
    // under the STROKE itself, never under pre-existing paint.
    function insideStroke(x, y) {
      return VB.geom.windingNumber(strokeEdges, x, y) !== 0;
    }

    // Ground truth for faces outside the paint: the pre-op document is
    // consistent, so region queries against it are exact.
    var preOp = new VB.VBDocument();
    preOp.width = doc.width; preOp.height = doc.height;
    preOp.fills = doc.fills; preOp.lines = doc.lines;
    preOp.edges = doc.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    });

    // ---- 2. replace the old fill-f boundary wholesale ---------------------
    doc.edges = doc.edges.filter(function (e) { return !pu.replaced.has(e); });

    // ---- 3. node the new boundary into the map -----------------------------
    var pieces = VB.nodeEdges(doc, fitted);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);

    // ---- 4. boolean mask: faces decide everything --------------------------
    var removed = VB.applyRegionMask(doc, preOp, insideUnion, fillIdx, pieces,
                                     insideStroke);

    return { painted: removed, boundary: fitted.length };
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
