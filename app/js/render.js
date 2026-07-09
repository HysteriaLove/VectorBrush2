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
    setupStage(ctx, doc, view);
    drawDocContent(ctx, doc, view);
  }

  // ---- content cache -------------------------------------------------------
  // Tool previews request a render on every pointer move, but the
  // DOCUMENT rarely changed — only the overlay did. Re-tracing every
  // edge per move makes drawing feel sluggish on heavy documents, so
  // the composed content is kept in an offscreen canvas and frames
  // where nothing changed are a single blit. Freshness is decided by
  // HASHING the content (order-dependent 31x accumulate over edge
  // coordinates, claims, styles and text records) — no invalidation
  // call sites to miss, and at ~3000 edges the hash costs ~0.05ms
  // against a multi-ms render. The hash covers in-place mutations
  // (node drags, float lifts) that array identity would not.
  var contentCache = new WeakMap(); // target canvas -> { key, off }

  function hashDocContent(h, doc) {
    var edges = doc.edges;
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      h = (h * 31 + e.ax) | 0; h = (h * 31 + e.ay) | 0;
      h = (h * 31 + e.bx) | 0; h = (h * 31 + e.by) | 0;
      if (e.cx !== null) { h = (h * 31 + e.cx) | 0; h = (h * 31 + e.cy) | 0; }
      h = (h * 31 + e.fill0) | 0; h = (h * 31 + e.fill1) | 0;
      h = (h * 31 + e.line) | 0;
    }
    var fills = doc.fills;
    for (var f = 0; f < fills.length; f++) {
      var fc = fills[f].color || { r: 128, g: 128, b: 128, a: 255 };
      h = (h * 31 + fc.r) | 0; h = (h * 31 + fc.g) | 0;
      h = (h * 31 + fc.b) | 0; h = (h * 31 + fc.a) | 0;
    }
    var lines = doc.lines;
    for (var l = 0; l < lines.length; l++) {
      h = (h * 31 + lines[l].width) | 0;
      h = (h * 31 + lines[l].color.r) | 0; h = (h * 31 + lines[l].color.g) | 0;
      h = (h * 31 + lines[l].color.b) | 0; h = (h * 31 + lines[l].color.a) | 0;
    }
    var texts = doc.texts || [];
    for (var t = 0; t < texts.length; t++) {
      var tx = texts[t];
      for (var m = 0; m < 6; m++) h = (h * 31 + ((tx.matrix[m] * 4096) | 0)) | 0;
      for (var r = 0; r < tx.records.length; r++) {
        var rec = tx.records[r];
        h = (h * 31 + rec.font) | 0; h = (h * 31 + rec.height) | 0;
        h = (h * 31 + rec.x) | 0; h = (h * 31 + rec.y) | 0;
        h = (h * 31 + rec.color.r) | 0; h = (h * 31 + rec.color.g) | 0;
        h = (h * 31 + rec.color.b) | 0; h = (h * 31 + rec.color.a) | 0;
        for (var g = 0; g < rec.glyphs.length; g++) {
          h = (h * 31 + rec.glyphs[g].gi) | 0;
          h = (h * 31 + rec.glyphs[g].adv) | 0;
        }
      }
    }
    return h;
  }

  function projectKey(project, view, canvas) {
    var h = 17;
    h = (h * 31 + canvas.width) | 0; h = (h * 31 + canvas.height) | 0;
    h = (h * 31 + ((view.zoom * 4096) | 0)) | 0;
    h = (h * 31 + ((view.panX * 64) | 0)) | 0;
    h = (h * 31 + ((view.panY * 64) | 0)) | 0;
    h = (h * 31 + ((view.dpr || 1) * 64)) | 0;
    h = (h * 31 + project.cur.scene) | 0;
    h = (h * 31 + project.width) | 0; h = (h * 31 + project.height) | 0;
    var bg = project.background;
    if (bg) {
      h = (h * 31 + bg.r) | 0; h = (h * 31 + bg.g) | 0;
      h = (h * 31 + bg.b) | 0; h = (h * 31 + bg.a) | 0;
    }
    var layers = project.scene().layers;
    h = (h * 31 + layers.length) | 0;
    for (var i = 0; i < layers.length; i++) {
      h = (h * 31 + (layers[i].visible ? 1 : 0)) | 0;
      h = hashDocContent(h, layers[i].frames[0]);
    }
    return h;
  }

  // A whole project: the active scene's layers, bottom to top
  // (layers[0] is the TOP layer, JSFL's convention). Cached: unchanged
  // frames blit the offscreen copy. Either way the ctx is left with the
  // STAGE transform applied, which tool overlays rely on.
  function renderProject(ctx, project, view) {
    var canvas = ctx.canvas;
    var key = projectKey(project, view, canvas);
    var entry = contentCache.get(canvas);
    if (!entry || entry.key !== key) {
      if (!entry) {
        entry = { key: 0, off: document.createElement("canvas") };
        contentCache.set(canvas, entry);
      }
      if (entry.off.width !== canvas.width) entry.off.width = canvas.width;
      if (entry.off.height !== canvas.height) entry.off.height = canvas.height;
      var octx = entry.off.getContext("2d");
      renderProjectContent(octx, project, view);
      entry.key = key;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(entry.off, 0, 0);
    var dpr = view.dpr || 1;
    var s = view.zoom * dpr / VB.TWIPS;
    ctx.setTransform(s, 0, 0, s, view.panX * dpr, view.panY * dpr);
  }

  function renderProjectContent(ctx, project, view) {
    setupStage(ctx, project, view);
    var layers = project.scene().layers;
    for (var i = layers.length - 1; i >= 0; i--) {
      if (!layers[i].visible) continue;
      drawDocContent(ctx, layers[i].frames[0], view);
    }
  }

  function setupStage(ctx, stage, view) {
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
    ctx.fillStyle = VB.colorToCSS(stage.background);
    ctx.fillRect(0, 0, stage.width, stage.height);
    ctx.restore();
  }

  function drawDocContent(ctx, doc, view) {
    var dpr = view.dpr || 1;
    var s = view.zoom * dpr / VB.TWIPS;

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

    // Text blocks float above the ink (Flash: shape at depth 1, text
    // stacked over it), drawn from their embedded glyph outlines so the
    // screen shows exactly what the file stores.
    for (var t = 0; t < (doc.texts || []).length; t++) {
      drawText(ctx, doc, doc.texts[t]);
    }
  }

  function drawText(ctx, doc, text) {
    var m = text.matrix;
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    for (var i = 0; i < text.records.length; i++) {
      var rec = text.records[i];
      var font = doc.fonts[rec.font];
      if (!font) continue;
      var scale = rec.height / 1024; // glyph EM square -> twips
      var penX = rec.x, penY = rec.y;
      ctx.beginPath();
      for (var g = 0; g < rec.glyphs.length; g++) {
        var glyph = font.glyphs[rec.glyphs[g].gi];
        if (glyph) traceGlyph(ctx, glyph.contours, penX, penY, scale);
        penX += rec.glyphs[g].adv;
      }
      ctx.fillStyle = VB.colorToCSS(rec.color);
      ctx.fill("evenodd");
    }
    ctx.restore();
  }

  function traceGlyph(ctx, contours, px, py, s) {
    for (var c = 0; c < contours.length; c++) {
      var ct = contours[c];
      ctx.moveTo(px + ct.mx * s, py + ct.my * s);
      for (var i = 0; i < ct.segs.length; i++) {
        var seg = ct.segs[i];
        if (seg.cx === undefined) ctx.lineTo(px + seg.x * s, py + seg.y * s);
        else {
          ctx.quadraticCurveTo(px + seg.cx * s, py + seg.cy * s,
                               px + seg.x * s, py + seg.y * s);
        }
      }
      ctx.closePath();
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
  VB.renderProject = renderProject;
  VB.drawTextBlock = drawText; // (ctx, doc, textBlock) — used by the text tool's live preview
})();
