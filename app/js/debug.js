/* debug.js — vector debug overlay: shows the planar map itself.
 *
 * On top of the normal render it draws:
 *   - every edge as a thin wire: cyan = straight, magenta = quadratic
 *   - anchors (yellow squares) — the welded nodes of the planar map
 *   - quad control points (hollow circles) with dashed tangents
 *   - a direction chevron at each edge midpoint
 *   - fill-side ticks at the midpoint: a short stroke of the fill's color
 *     on the side the fill lies (fill1 = right of travel, fill0 = left)
 *   - the hovered edge highlighted white (inspector text in status bar)
 *
 * Decorations auto-thin out on huge documents; wires always draw.
 */
(function () {
  "use strict";

  var DECOR_LIMIT = 4000; // above this many edges, wires + hover only

  function renderDebug(ctx, doc, view, hoverIdx) {
    var pxTw = VB.TWIPS / view.zoom; // twips per CSS pixel
    var decorate = doc.edges.length <= DECOR_LIMIT;

    ctx.save();
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";

    // Pass 1: wires.
    strokeEdges(ctx, doc, pxTw, function (e) { return e.cx === null; }, "#26c6da");
    strokeEdges(ctx, doc, pxTw, function (e) { return e.cx !== null; }, "#e24fd8");

    // Pass 2: decorations.
    if (decorate) {
      for (var i = 0; i < doc.edges.length; i++) {
        var e = doc.edges[i];
        if (e.cx !== null) drawControl(ctx, e, pxTw);
        drawDirection(ctx, e, pxTw);
        drawFillTicks(ctx, doc, e, pxTw);
      }
      for (var j = 0; j < doc.edges.length; j++) drawAnchors(ctx, doc.edges[j], pxTw);
    }

    // Pass 3: hover highlight.
    if (hoverIdx >= 0 && hoverIdx < doc.edges.length) {
      var he = doc.edges[hoverIdx];
      ctx.beginPath();
      pathEdge(ctx, he);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3 * pxTw;
      ctx.stroke();
      if (!decorate) {
        if (he.cx !== null) drawControl(ctx, he, pxTw);
        drawDirection(ctx, he, pxTw);
        drawFillTicks(ctx, doc, he, pxTw);
        drawAnchors(ctx, he, pxTw);
      }
    }

    ctx.restore();
  }

  function pathEdge(ctx, e) {
    ctx.moveTo(e.ax, e.ay);
    if (e.cx === null) ctx.lineTo(e.bx, e.by);
    else ctx.quadraticCurveTo(e.cx, e.cy, e.bx, e.by);
  }

  function strokeEdges(ctx, doc, pxTw, pred, color) {
    ctx.beginPath();
    for (var i = 0; i < doc.edges.length; i++) {
      if (pred(doc.edges[i])) pathEdge(ctx, doc.edges[i]);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 * pxTw;
    ctx.stroke();
  }

  function drawAnchors(ctx, e, pxTw) {
    var r = 2 * pxTw;
    ctx.fillStyle = "#ffd54f";
    ctx.fillRect(e.ax - r, e.ay - r, 2 * r, 2 * r);
    ctx.fillRect(e.bx - r, e.by - r, 2 * r, 2 * r);
  }

  function drawControl(ctx, e, pxTw) {
    ctx.beginPath();
    ctx.moveTo(e.ax, e.ay);
    ctx.lineTo(e.cx, e.cy);
    ctx.lineTo(e.bx, e.by);
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 0.75 * pxTw;
    ctx.setLineDash([3 * pxTw, 3 * pxTw]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(e.cx, e.cy, 2.2 * pxTw, 0, Math.PI * 2);
    ctx.strokeStyle = "#e24fd8";
    ctx.lineWidth = 1 * pxTw;
    ctx.stroke();
  }

  // Chevron at the midpoint pointing along the direction of travel.
  function drawDirection(ctx, e, pxTw) {
    var mid = VB.geom.evalEdge(e, 0.5);
    var ahead = VB.geom.evalEdge(e, 0.55);
    var dx = ahead.x - mid.x, dy = ahead.y - mid.y;
    var len = Math.hypot(dx, dy);
    if (len === 0) return;
    dx /= len; dy /= len;
    var s = 4 * pxTw;
    ctx.beginPath();
    ctx.moveTo(mid.x - dy * s * 0.6 - dx * s, mid.y + dx * s * 0.6 - dy * s);
    ctx.lineTo(mid.x + dx * s * 0.4, mid.y + dy * s * 0.4);
    ctx.lineTo(mid.x + dy * s * 0.6 - dx * s, mid.y - dx * s * 0.6 - dy * s);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1 * pxTw;
    ctx.stroke();
  }

  // Fill-side ticks. With y-down screen coordinates, the visual right of
  // travel direction (dx,dy) is (-dy,dx); fill1 sits there, fill0 opposite.
  function drawFillTicks(ctx, doc, e, pxTw) {
    if (e.fill0 === 0 && e.fill1 === 0) return;
    var mid = VB.geom.evalEdge(e, 0.45);
    var ahead = VB.geom.evalEdge(e, 0.5);
    var dx = ahead.x - mid.x, dy = ahead.y - mid.y;
    var len = Math.hypot(dx, dy);
    if (len === 0) return;
    dx /= len; dy /= len;
    var rx = -dy, ry = dx; // visual right
    tick(ctx, doc, mid, rx, ry, e.fill1, pxTw);
    tick(ctx, doc, mid, -rx, -ry, e.fill0, pxTw);
  }

  function tick(ctx, doc, mid, nx, ny, fillIdx, pxTw) {
    if (fillIdx === 0) return;
    var style = doc.fills[fillIdx - 1];
    var color = style && style.type === "solid" ? style.color : { r: 128, g: 128, b: 128, a: 255 };
    ctx.beginPath();
    ctx.moveTo(mid.x + nx * 2 * pxTw, mid.y + ny * 2 * pxTw);
    ctx.lineTo(mid.x + nx * 8 * pxTw, mid.y + ny * 8 * pxTw);
    ctx.strokeStyle = "rgb(" + color.r + "," + color.g + "," + color.b + ")";
    ctx.lineWidth = 2.5 * pxTw;
    ctx.stroke();
  }

  // Inspector: nearest edge within tolerance (CSS px), or -1.
  function pickEdge(doc, x, y, tolTwips) {
    var best = -1, bestDist = tolTwips;
    for (var i = 0; i < doc.edges.length; i++) {
      var bb = VB.geom.edgeBBox(doc.edges[i]);
      if (x < bb.xmin - tolTwips || x > bb.xmax + tolTwips ||
          y < bb.ymin - tolTwips || y > bb.ymax + tolTwips) continue;
      var d = VB.geom.distToEdge(doc.edges[i], x, y);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  function describeEdge(doc, idx) {
    var e = doc.edges[idx];
    var kind = e.cx === null ? "line" : "quad";
    return "edge #" + idx + " " + kind +
      " (" + e.ax + "," + e.ay + ")→(" + e.bx + "," + e.by + ")" +
      (e.cx !== null ? " ctrl(" + e.cx + "," + e.cy + ")" : "") +
      " · fill0=" + e.fill0 + " fill1=" + e.fill1 + " line=" + e.line;
  }

  window.VB = window.VB || {};
  VB.renderDebug = renderDebug;
  VB.debugPickEdge = pickEdge;
  VB.debugDescribeEdge = describeEdge;
})();
