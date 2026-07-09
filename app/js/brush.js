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

  // paint: an RGBA color OR a full 2DMaterial style (anything with a
  // .type) — a selected material IS the drawing color.
  // union: an optional VB.SwathUnion the tool fed during the drag; its
  // finished region is byte-identical to the batch union, so replay
  // (which passes none) commits the same geometry.
  function brushStroke(doc, points, radius, paint, union) {
    var swath = VB.buildSwath(points, radius);
    if (!swath.path || swath.path.length === 0) {
      if (union) union.dispose();
      return { painted: 0, boundary: 0 };
    }

    var fillIdx = doc.addFillStyle(paint && paint.type
      ? JSON.parse(JSON.stringify(paint))
      : { type: "solid",
          color: { r: paint.r, g: paint.g, b: paint.b, a: paint.a } });

    // ---- 1. exact swept region, Flash-lean fitted outline -----------------
    // The union with existing same-color paint happens in the FACE WALK:
    // faces outside the stroke keep their pre-op fill, faces inside get
    // the paint, and fences with paint on both sides dissolve. Existing
    // boundaries are never regenerated, so they keep their exact records.
    // (Feeding the whole old region through paper's booleans instead hit
    // resolveCrossings' documented fragility on pinch-touching compound
    // regions — painted lobes came back carved out.)
    var pre = union ? union.finish(swath.path, radius) : null;
    var loops = VB.sweptOutline(swath.path, radius, FIT_TOL, pre);
    var fitted = [];
    loops.forEach(function (loop) {
      loop.forEach(function (e) { fitted.push(e); });
    });
    if (fitted.length === 0) return { painted: 0, boundary: 0 };

    var windingLoops = fitted.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    var paintOracle = VB.geom.windingOracle(windingLoops);
    function insidePaint(x, y) {
      return paintOracle.at(x, y) !== 0;
    }

    // Ground truth for faces outside the paint: the pre-op document is
    // consistent, so region queries against it are exact.
    var preOp = new VB.VBDocument();
    preOp.width = doc.width; preOp.height = doc.height;
    preOp.fills = doc.fills; preOp.lines = doc.lines;
    preOp.edges = doc.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    });

    // ---- 2. node the lean outline into the map ----------------------------
    // Integer-identical twins are adopted, not noded — intersecting a
    // curve with itself shreds both copies (see eraser.js).
    var adopted = VB.adoptIdenticalEdges(doc, fitted);
    var pieces = VB.nodeEdges(doc, adopted.fresh);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);

    // ---- 3. boolean mask: faces decide everything --------------------------
    var removed = VB.applyRegionMask(doc, preOp, insidePaint, fillIdx,
                                     pieces.concat(adopted.twins));

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
    // unite swept capsules while the hand is still moving — pointerup
    // then only pays the final fold + mask (see paperglue.SwathUnion)
    this.union = new VB.SwathUnion(this.radius());
    this.union.add(pos);
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
      if (this.union) this.union.add(pos);
    }
    this.app.requestRender();
  };

  BrushTool.prototype.onUp = function (pos) {
    if (!this.points) return;
    var pts = this.points;
    var union = this.union;
    this.points = null;
    this.union = null;
    if (pos) {
      pts.push({ x: pos.x, y: pos.y });
      if (union) union.add(pos);
    }

    var op = {
      op: "brush",
      points: pts.map(function (p) { return { x: p.x, y: p.y }; }),
      radius: this.radius(),
      color: {
        r: this.app.fillColor.r, g: this.app.fillColor.g,
        b: this.app.fillColor.b, a: this.app.fillColor.a
      }
    };
    // a selected 2DMaterial paints instead of the flat color; the op
    // carries the full style so replay stays self-contained
    if (this.app.fillMaterial) op.style = VB.materialClone(this.app.fillMaterial);
    this.app.record(op);
    this.app.history.push(this.app.doc);
    var result = brushStroke(this.app.doc, pts, this.radius(),
                             op.style || this.app.fillColor, union);
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
    if (this.union) { this.union.dispose(); this.union = null; }
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
