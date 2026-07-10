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

  // The export-frame outline on the infinite canvas. ONE constant
  // shared by the Canvas2D and Pixi backends — the parity gate compares
  // full frames, so both must match. (VB.DESK survives for any host
  // that still letterboxes.)
  VB.DESK = "#cfd3d8";
  VB.FRAME_OUTLINE = "#c6cad0";

  // view: { zoom (screen px per stage px), panX, panY (screen px), dpr }
  function render(ctx, doc, view) {
    setupStage(ctx, doc, view);
    drawDocContent(ctx, doc, view);
  }

  // A whole project: the active scene's layers, bottom to top
  // (layers[0] is the TOP layer, JSFL's convention). opts.transparent
  // skips the backdrop/stage paint — used when the Pixi backend draws
  // those beneath this canvas (docs/PixiPort.md two-canvas stacking).
  function renderProject(ctx, project, view, opts) {
    setupStage(ctx, project.stage ? project.stage() : project, view,
               opts && opts.transparent);
    var scene = project.scene();
    var layers = scene.layers;
    var frame = project.cur ? project.cur.frame || 0 : 0;
    drawCast(ctx, project, scene, view, frame, true); // backgrounds
    for (var i = layers.length - 1; i >= 0; i--) {
      if (!layers[i].visible) continue;
      drawDocContent(ctx, VB.frameCell(layers[i], frame), view);
    }
    drawCast(ctx, project, scene, view, frame, false); // actors, symbols
  }

  /** Placed instances (stepseq.js): each draws its prototype's cell
   *  under its own transform, composed onto the stage transform — the
   *  SAME math the Pixi backend applies, parity-gated. */
  function drawCast(ctx, project, scene, view, frame, backgrounds) {
    if (!VB.stepCellAt || !scene.cast || !scene.cast.length) return;
    scene.cast.forEach(function (inst) {
      if ((inst.kind === "background") !== backgrounds) return;
      var cell = VB.stepCellAt(project, scene, inst, frame);
      if (!cell) return;
      ctx.save();
      ctx.translate(inst.x || 0, inst.y || 0);
      var r = (inst.rotation || 0) * Math.PI / 180;
      if (r) ctx.rotate(r);
      var sc = inst.scale === undefined ? 1 : inst.scale;
      if (sc !== 1) ctx.scale(sc, sc);
      drawDocContent(ctx, cell, view);
      ctx.restore();
    });
  }

  function setupStage(ctx, stage, view, transparent) {
    var canvas = ctx.canvas;
    var dpr = view.dpr || 1;
    var s = view.zoom * dpr / VB.TWIPS; // screen device px per twip

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!transparent) {
      // INFINITE canvas (user decision): the paper runs unbounded in
      // every direction — no desk, no letterbox, no frame. Framing is
      // Composite's job (the camera).
      ctx.fillStyle = VB.colorToCSS(stage.background);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.setTransform(s, 0, 0, s, view.panX * dpr, view.panY * dpr);
  }

  function drawDocContent(ctx, doc, view) {
    var dpr = view.dpr || 1;
    var s = view.zoom * dpr / VB.TWIPS;

    var fillPaths = VB.buildFillPaths(doc);
    var strokePaths = VB.buildStrokePaths(doc);

    for (var f = 1; f < fillPaths.length; f++) {
      var chains = fillPaths[f];
      if (!chains || chains.length === 0) continue;
      paintFill(ctx, doc, f, doc.fills[f - 1], chains);
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

  /** Paint one fill style's chains — the Canvas2D material backends.
   *  Gradients render EXACTLY: the context takes the style's SWF
   *  matrix (gradient-square space), the path is traced through the
   *  matrix INVERSE, and the paint server lives in square coords —
   *  correct for sheared/elliptical gradients where mapping the two
   *  endpoints would not be. gpu-class materials (matcap) render
   *  their declared fallback here; the WebGPU backend replaces that
   *  per-region result when available (stage 2). */
  function paintFill(ctx, doc, fillIdx, style, chains) {
    if (style && style.type === "matcap" && VB.matcapPaint) {
      // CPU-reference matcap pipeline (matcap.js), cached per region;
      // falls through to the base color while an embedded texture is
      // still decoding or when the module is absent (diag harnesses).
      if (VB.matcapPaint(ctx, doc, fillIdx, style, chains, tracePath)) return;
    }
    if (style && (style.type === "linear" || style.type === "radial") &&
        style.gradient && style.gradient.stops.length > 1) {
      var gm = style.matrix || { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 };
      // canvas transform(a,b,c,d,e,f) with SWF MATRIX fields:
      // x' = sx·x + r1·y + tx ; y' = r0·x + sy·y + ty
      var det = gm.sx * gm.sy - gm.r0 * gm.r1;
      if (det && isFinite(det)) {
        var inv = {
          a: gm.sy / det, b: -gm.r0 / det,
          c: -gm.r1 / det, d: gm.sx / det
        };
        ctx.save();
        ctx.transform(gm.sx, gm.r0, gm.r1, gm.sy, gm.tx, gm.ty);
        ctx.beginPath();
        for (var c0 = 0; c0 < chains.length; c0++) {
          traceMapped(ctx, chains[c0], gm, inv);
        }
        var half = VB.GRAD_HALF || 16384;
        var grad = style.type === "linear"
          ? ctx.createLinearGradient(-half, 0, half, 0)
          : ctx.createRadialGradient(0, 0, 0, 0, 0, half);
        var stops = style.gradient.stops;
        for (var si = 0; si < stops.length; si++) {
          grad.addColorStop(stops[si].ratio / 255,
                            VB.colorToCSS(stops[si].color));
        }
        ctx.fillStyle = grad;
        ctx.fill("evenodd");
        ctx.restore();
        return;
      }
    }
    ctx.beginPath();
    for (var c1 = 0; c1 < chains.length; c1++) tracePath(ctx, chains[c1], true);
    ctx.fillStyle = fillToCSS(style);
    ctx.fill("evenodd");
  }

  function traceMapped(ctx, chain, gm, inv) {
    function map(x, y) {
      var dx = x - gm.tx, dy = y - gm.ty;
      return { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy };
    }
    var s0 = map(chain.sx, chain.sy);
    ctx.moveTo(s0.x, s0.y);
    for (var i = 0; i < chain.pts.length; i++) {
      var p = chain.pts[i];
      var e = map(p.x, p.y);
      if (p.cx === null) ctx.lineTo(e.x, e.y);
      else {
        var cc = map(p.cx, p.cy); // quad controls map exactly under affine
        ctx.quadraticCurveTo(cc.x, cc.y, e.x, e.y);
      }
    }
    if (chain.closed) ctx.closePath();
  }

  /** Overlay-canvas frame prep when the Pixi backend draws the
   *  content beneath: clear, then set the stage transform so tool
   *  overlays and debug decorations keep drawing in twips. */
  function applyViewTransform(ctx, view) {
    var canvas = ctx.canvas;
    var dpr = view.dpr || 1;
    var s = view.zoom * dpr / VB.TWIPS;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(s, 0, 0, s, view.panX * dpr, view.panY * dpr);
  }

  function fillToCSS(style) {
    if (style.type === "solid") return VB.colorToCSS(style.color);
    // single-stop gradients, gpu-class fallbacks, legacy bitmap: the
    // material's representative base color
    if (VB.materialBaseColor) return VB.colorToCSS(VB.materialBaseColor(style));
    if (style.gradient && style.gradient.stops.length) {
      return VB.colorToCSS(style.gradient.stops[0].color);
    }
    return "#808080";
  }

  window.VB = window.VB || {};
  VB.render = render;
  VB.renderDocContent = drawDocContent; // transparent pass (onion ghosts)
  VB.renderProject = renderProject;
  VB.applyViewTransform = applyViewTransform;
  VB.paintFill = paintFill; // (ctx, doc, fillIdx, style, chains) — the
  // oracle's fill painter; the Pixi backend rasterizes even-odd-encoded
  // fills through it so both backends share ONE composition truth
  VB.tracePath = tracePath;
  VB.drawTextBlock = drawText; // (ctx, doc, textBlock) — used by the text tool's live preview
})();
