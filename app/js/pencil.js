/* pencil.js — the pencil tool: capture → fit → merge.
 *
 * Captures the pointer trail in stage twips (throttled to ~2 CSS px so
 * zoom doesn't change stroke character), previews the raw polyline while
 * dragging, and on release fits it to lines+quads (fit.js) and merges it
 * into the planar map (merge.js) with the current stroke style.
 *
 * The core is exposed as pencilCommit(doc, points, style) so tests can
 * drive it without DOM events.
 */
(function () {
  "use strict";

  var MIN_SAMPLE_CSS_PX = 2;

  // Programmatic stroke: returns number of edges added.
  function pencilCommit(doc, points, style, tolerance) {
    var geoms = VB.fitStroke(points, tolerance);
    if (geoms.length === 0) return 0;
    var idx = doc.addLineStyle({
      width: style.width,
      color: { r: style.color.r, g: style.color.g, b: style.color.b, a: style.color.a }
    });
    return VB.mergeStroke(doc, geoms, idx);
  }

  // ---- interactive tool ------------------------------------------------------

  function PencilTool(app) {
    this.app = app;
    this.points = null; // capturing when non-null
  }

  PencilTool.prototype.onDown = function (pos) {
    this.points = [{ x: pos.x, y: pos.y }];
  };

  PencilTool.prototype.onMove = function (pos) {
    if (!this.points) return;
    var minDist = MIN_SAMPLE_CSS_PX * VB.TWIPS / this.app.view.zoom;
    var last = this.points[this.points.length - 1];
    var dx = pos.x - last.x, dy = pos.y - last.y;
    if (dx * dx + dy * dy >= minDist * minDist) {
      this.points.push({ x: pos.x, y: pos.y });
      this.app.requestRender();
    }
  };

  PencilTool.prototype.onUp = function (pos) {
    if (!this.points) return;
    var pts = this.points;
    this.points = null;
    if (pos) pts.push({ x: pos.x, y: pos.y });
    if (pts.length < 2) { this.app.requestRender(); return; }

    this.app.history.push(this.app.doc);
    var added = pencilCommit(this.app.doc, pts, {
      width: this.app.strokeWidth,
      color: this.app.strokeColor
    });
    this.app.docChanged();
    this.app.setMsg(added + " edge" + (added === 1 ? "" : "s") + " added");
  };

  PencilTool.prototype.cancel = function () {
    this.points = null;
    this.app.requestRender();
  };

  // Raw-trail preview, drawn by the main render loop (stage transform set).
  PencilTool.prototype.drawOverlay = function (ctx) {
    if (!this.points || this.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (var i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    var c = this.app.strokeColor;
    ctx.strokeStyle = "rgba(" + c.r + "," + c.g + "," + c.b + ",0.9)";
    ctx.lineWidth = Math.max(this.app.strokeWidth, VB.TWIPS / this.app.view.zoom);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  };

  window.VB = window.VB || {};
  VB.PencilTool = PencilTool;
  VB.pencilCommit = pencilCommit;
})();
