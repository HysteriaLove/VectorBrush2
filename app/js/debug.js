/* debug.js — vector debug view: the planar map as Flash-style records.
 *
 * Overlay (on canvas):
 *   - every edge as a thin wire: cyan = straight, magenta = quadratic
 *   - anchors (yellow squares) — the welded nodes of the planar map
 *   - quad control points (hollow circles) with dashed tangents
 *   - a direction chevron at each edge midpoint
 *   - fill-side ticks at the midpoint: a short stroke of the fill's color
 *     on the side the fill lies (fill1 = right of travel, fill0 = left)
 *   - the hovered/pinned edge highlighted white
 *
 * Inspector (side panel + status bar): every edge is described exactly as
 * the Flash record grammar stores it — integer twips, start anchor, delta
 * coordinates, minimal signed bit width (nbits), and on-wire bit cost —
 * plus both faces (fill0 = left of travel, fill1 = right) with their
 * resolved styles and the line style. This is 1:1 the data that the .vbd
 * encoder (and a SWF DefineShape) writes.
 */
(function () {
  "use strict";

  var DECOR_LIMIT = 4000; // above this many edges, wires + hover only

  // ---- Flash-record analysis -------------------------------------------------

  // Exactly mirrors the encoder's record grammar (vbd.js / SWF DefineShape).
  function edgeRecord(doc, idx) {
    var e = doc.edges[idx];
    var rec = {
      index: idx,
      from: { x: e.ax, y: e.ay },
      to: { x: e.bx, y: e.by },
      fill0: e.fill0, fill1: e.fill1, line: e.line
    };
    if (e.cx === null) {
      var dx = e.bx - e.ax, dy = e.by - e.ay;
      rec.deltas = { dx: dx, dy: dy };
      rec.nbits = Math.max(2, VB.sbitsAll([dx, dy]));
      if (dx !== 0 && dy !== 0) {
        rec.kind = "StraightEdgeRecord (GeneralLine)";
        rec.bits = 2 + 4 + 1 + 2 * rec.nbits;
      } else if (dx === 0) {
        rec.kind = "StraightEdgeRecord (Vertical)";
        rec.bits = 2 + 4 + 1 + 1 + rec.nbits;
      } else {
        rec.kind = "StraightEdgeRecord (Horizontal)";
        rec.bits = 2 + 4 + 1 + 1 + rec.nbits;
      }
    } else {
      var cdx = e.cx - e.ax, cdy = e.cy - e.ay;
      var adx = e.bx - e.cx, ady = e.by - e.cy;
      rec.kind = "CurvedEdgeRecord";
      rec.ctrl = { x: e.cx, y: e.cy };
      rec.deltas = { cdx: cdx, cdy: cdy, adx: adx, ady: ady };
      rec.nbits = Math.max(2, VB.sbitsAll([cdx, cdy, adx, ady]));
      rec.bits = 2 + 4 + 4 * rec.nbits;
    }
    return rec;
  }

  function hex2(v) { return v.toString(16).padStart(2, "0"); }

  function colorHex(c) {
    return "#" + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a !== 255 ? "@" + c.a : "");
  }

  function fillLabel(doc, idx) {
    if (idx === 0) return { text: "0 (empty)", css: null };
    var s = doc.fills[idx - 1];
    if (!s) return { text: idx + " (INVALID)", css: null };
    if (s.type === "solid") {
      return { text: idx + " " + colorHex(s.color), css: "rgb(" + s.color.r + "," + s.color.g + "," + s.color.b + ")" };
    }
    return { text: idx + " (" + s.type + ")", css: "#808080" };
  }

  function lineLabel(doc, idx) {
    if (idx === 0) return { text: "0 (none)", css: null };
    var s = doc.lines[idx - 1];
    if (!s) return { text: idx + " (INVALID)", css: null };
    return {
      text: idx + " " + s.width + "tw (" + (s.width / VB.TWIPS) + "px) " + colorHex(s.color),
      css: "rgb(" + s.color.r + "," + s.color.g + "," + s.color.b + ")"
    };
  }

  function sd(v) { return (v >= 0 ? "+" : "") + v; }

  // Status-bar one-liner, Flash record form.
  function describeEdge(doc, idx) {
    var r = edgeRecord(doc, idx);
    var geo;
    if (r.ctrl) {
      geo = "Δc(" + sd(r.deltas.cdx) + "," + sd(r.deltas.cdy) + ") Δa(" +
        sd(r.deltas.adx) + "," + sd(r.deltas.ady) + ")";
    } else {
      geo = "Δ(" + sd(r.deltas.dx) + "," + sd(r.deltas.dy) + ")";
    }
    return "#" + idx + " " + r.kind + " @(" + r.from.x + "," + r.from.y + ")tw " + geo +
      " nbits=" + r.nbits + " " + r.bits + "b · fill0=" + r.fill0 +
      " fill1=" + r.fill1 + " line=" + r.line;
  }

  // ---- panel HTML builders -----------------------------------------------------

  function sw(css) {
    return css ? '<span class="sw" style="background:' + css + '"></span>' : "";
  }

  function edgePanelHTML(doc, idx) {
    if (idx < 0 || idx >= doc.edges.length) {
      return '<div class="dim">hover an edge · click to pin (select tool)</div>';
    }
    var r = edgeRecord(doc, idx);
    var f0 = fillLabel(doc, r.fill0), f1 = fillLabel(doc, r.fill1), ln = lineLabel(doc, r.line);
    var h = "<h4>edge #" + r.index + "</h4>";
    h += '<div class="rec">' + r.kind + "</div>";
    h += "<table>";
    h += "<tr><td>start</td><td>(" + r.from.x + ", " + r.from.y + ") tw</td></tr>";
    if (r.ctrl) {
      h += "<tr><td>Δctrl</td><td>(" + sd(r.deltas.cdx) + ", " + sd(r.deltas.cdy) + ") tw</td></tr>";
      h += "<tr><td>Δanchor</td><td>(" + sd(r.deltas.adx) + ", " + sd(r.deltas.ady) + ") tw</td></tr>";
      h += '<tr class="dim"><td>ctrl</td><td>(' + r.ctrl.x + ", " + r.ctrl.y + ") tw</td></tr>";
    } else {
      h += "<tr><td>Δ</td><td>(" + sd(r.deltas.dx) + ", " + sd(r.deltas.dy) + ") tw</td></tr>";
    }
    h += '<tr class="dim"><td>end</td><td>(' + r.to.x + ", " + r.to.y + ") tw</td></tr>";
    h += "<tr><td>nbits</td><td>" + r.nbits + " · " + r.bits + " bits on wire</td></tr>";
    h += "</table>";
    h += "<h5>faces</h5><table>";
    h += "<tr><td>fill0 <span class='dim'>(left)</span></td><td>" + sw(f0.css) + f0.text +
      (r.fill0 ? " · filled" : "") + "</td></tr>";
    h += "<tr><td>fill1 <span class='dim'>(right)</span></td><td>" + sw(f1.css) + f1.text +
      (r.fill1 ? " · filled" : "") + "</td></tr>";
    h += "<tr><td>line</td><td>" + sw(ln.css) + ln.text + "</td></tr>";
    h += "</table>";
    return h;
  }

  function stylesPanelHTML(doc) {
    var h = "<h4>fill styles (" + doc.fills.length + ")</h4><table>";
    for (var i = 0; i < doc.fills.length; i++) {
      var f = fillLabel(doc, i + 1);
      h += "<tr><td>" + (i + 1) + "</td><td>" + sw(f.css) + f.text + "</td></tr>";
    }
    h += "</table><h4>line styles (" + doc.lines.length + ")</h4><table>";
    for (var j = 0; j < doc.lines.length; j++) {
      var l = lineLabel(doc, j + 1);
      h += "<tr><td>" + (j + 1) + "</td><td>" + sw(l.css) + l.text + "</td></tr>";
    }
    h += "</table>";
    return h;
  }

  function streamPanelHTML(doc) {
    var s = VB.y2kvectorStats(doc);
    var edges = s.straightEdges + s.curvedEdges;
    var h = "<h4>record stream</h4><table>";
    h += "<tr><td>straight</td><td>" + s.straightEdges + "</td></tr>";
    h += "<tr><td>curved</td><td>" + s.curvedEdges + "</td></tr>";
    h += "<tr><td>style changes</td><td>" + s.styleChanges + "</td></tr>";
    h += "<tr><td>moveTos</td><td>" + s.moveTos + "</td></tr>";
    h += "<tr><td>encoded</td><td>" + s.fileBytes.toLocaleString() + " B raw</td></tr>";
    if (edges > 0) {
      h += '<tr class="dim"><td>density</td><td>' +
        (s.bodyBytes * 8 / edges).toFixed(1) + " bits/edge</td></tr>";
    }
    h += "</table>";
    return h;
  }

  // ---- overlay rendering --------------------------------------------------------

  function renderDebug(ctx, doc, view, hoverIdx) {
    var pxTw = VB.TWIPS / view.zoom; // twips per CSS pixel
    var decorate = doc.edges.length <= DECOR_LIMIT;

    ctx.save();
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";

    strokeEdges(ctx, doc, pxTw, function (e) { return e.cx === null; }, "#26c6da");
    strokeEdges(ctx, doc, pxTw, function (e) { return e.cx !== null; }, "#e24fd8");

    if (decorate) {
      for (var i = 0; i < doc.edges.length; i++) {
        var e = doc.edges[i];
        if (e.cx !== null) drawControl(ctx, e, pxTw);
        drawDirection(ctx, e, pxTw);
        drawFillTicks(ctx, doc, e, pxTw);
      }
      for (var j = 0; j < doc.edges.length; j++) drawAnchors(ctx, doc.edges[j], pxTw);
    }

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

  // Inspector: nearest edge within tolerance (twips), or -1.
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

  window.VB = window.VB || {};
  VB.renderDebug = renderDebug;
  VB.debugPickEdge = pickEdge;
  VB.debugDescribeEdge = describeEdge;
  VB.debugEdgeRecord = edgeRecord;
  VB.debugEdgePanelHTML = edgePanelHTML;
  VB.debugStylesPanelHTML = stylesPanelHTML;
  VB.debugStreamPanelHTML = streamPanelHTML;
})();
