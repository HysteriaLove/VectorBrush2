/* lasso.js — the Lasso tool (L): freeform region selection.
 *
 * Drag a freehand outline; on release it closes into a polygon and
 * becomes a REGION selection — exactly like the arrow's marquee, it
 * cuts through geometry (the selected content is the drawing clipped
 * to the region). The region goes straight to the TRANSFORM tool
 * (which lifts it live); clicking away there returns to the lasso.
 */
(function () {
  "use strict";

  var MIN_STEP = 60; // twips between recorded lasso points (3 px)

  function LassoTool(app) {
    return {
      app: app,
      points: null,
      onDown: function (pos) {
        this.points = [{ x: pos.x, y: pos.y }];
      },
      onMove: function (pos) {
        if (!this.points) return;
        var last = this.points[this.points.length - 1];
        if (Math.hypot(pos.x - last.x, pos.y - last.y) >= MIN_STEP) {
          this.points.push({ x: pos.x, y: pos.y });
        }
        app.requestRender();
      },
      onUp: function (pos) {
        var pts = this.points;
        this.points = null;
        if (!pts) return;
        if (pos) pts.push({ x: pos.x, y: pos.y });
        if (pts.length < 3) { app.requestRender(); return; }
        var arrow = app.toolByName && app.toolByName("select");
        if (arrow && arrow.setRegionSelection) {
          arrow.setRegionSelection(pts.map(function (p) {
            return { x: Math.round(p.x), y: Math.round(p.y) };
          }));
          if (app.switchTool) app.switchTool("transform");
          app.setMsg("lasso region lifted — transform it; click away to apply and return to the lasso");
        }
      },
      cancel: function () { this.points = null; app.requestRender(); },
      drawOverlay: function (ctx) {
        if (!this.points || this.points.length < 2) return;
        var hair = VB.TWIPS / app.view.zoom;
        ctx.strokeStyle = "rgba(0,160,255,0.9)";
        ctx.lineWidth = 1.5 * hair;
        ctx.setLineDash([6 * hair, 4 * hair]);
        ctx.beginPath();
        this.points.forEach(function (p, i) {
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };
  }

  window.VB = window.VB || {};
  VB.LassoTool = LassoTool;
})();
