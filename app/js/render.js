/* render.js — Canvas2D renderer for the planar map.
 *
 * Deliberately uses only moveTo / lineTo / quadraticCurveTo / fill /
 * stroke so the same draw pass ports 1:1 onto PIXI.Graphics later.
 *
 * Paint order mirrors Flash: all fills first (in style order), then all
 * strokes on top. Fills use the even-odd rule (Flash's classic shape
 * winding); strokes are round cap/round join (Flash MX defaults) and are
 * never drawn thinner than 1 screen pixel (Flash's hairline floor).
 */
(function () {
  "use strict";

  // view: { zoom (screen px per stage px), panX, panY (screen px), dpr }
  function render(ctx, doc, view) {
    var canvas = ctx.canvas;
    var dpr = view.dpr || 1;
    var s = view.zoom * dpr / VB.TWIPS; // screen device px per twip

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Work-area backdrop.
    ctx.fillStyle = "#3a3d42";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(s, 0, 0, s, view.panX * dpr, view.panY * dpr);

    // Stage.
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 18 / s;
    ctx.fillStyle = VB.colorToCSS(doc.background);
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.restore();

    var fillPaths = VB.buildFillPaths(doc);
    var strokePaths = VB.buildStrokePaths(doc);

    for (var f = 1; f < fillPaths.length; f++) {
      var chains = fillPaths[f];
      if (!chains || chains.length === 0) continue;
      ctx.beginPath();
      for (var c = 0; c < chains.length; c++) tracePath(ctx, chains[c], true);
      ctx.fillStyle = fillToCSS(doc.fills[f - 1]);
      ctx.fill("evenodd");
    }

    for (var l = 1; l < strokePaths.length; l++) {
      var chains2 = strokePaths[l];
      if (!chains2 || chains2.length === 0) continue;
      var style = doc.lines[l - 1];
      ctx.beginPath();
      for (var c2 = 0; c2 < chains2.length; c2++) tracePath(ctx, chains2[c2], false);
      ctx.strokeStyle = VB.colorToCSS(style.color);
      // Hairline floor: at least 1 device pixel on screen.
      ctx.lineWidth = Math.max(style.width, 1 / s);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }
  }

  function tracePath(ctx, chain, close) {
    ctx.moveTo(chain.sx, chain.sy);
    for (var i = 0; i < chain.pts.length; i++) {
      var p = chain.pts[i];
      if (p.cx === null) ctx.lineTo(p.x, p.y);
      else ctx.quadraticCurveTo(p.cx, p.cy, p.x, p.y);
    }
    if (close && chain.closed) ctx.closePath();
  }

  function fillToCSS(style) {
    if (style.type === "solid") return VB.colorToCSS(style.color);
    if ((style.type === "linear" || style.type === "radial") && style.gradient.stops.length) {
      return VB.colorToCSS(style.gradient.stops[0].color); // degraded for now
    }
    return "#808080"; // bitmap fills
  }

  window.VB = window.VB || {};
  VB.render = render;
})();
