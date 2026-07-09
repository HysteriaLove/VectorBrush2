/* pixi-render.js â€” the Pixi backend (docs/PixiPort.md).
 *
 * FULL document rendering on pixi v8: fills (solid, gradient, matcap),
 * strokes, text â€” the drawing surface is GPU-retained; the Canvas2D
 * overlay above it keeps tool overlays, debug decorations and the rest
 * of the GUI. render.js remains the visual ORACLE: the committed
 * parity page (app/test/pixi-parity.html) compares both backends
 * pixel-for-pixel on the plan's fixtures.
 *
 * Performance contract (iPads are a target):
 *  - NO ticker: rendered from the app's own rAF; idle = zero GPU work.
 *  - Retained + content-hashed: each layer cell caches its display
 *    tree under a hash of its edges/styles/texts, so pan, zoom, tool
 *    overlays and pointer moves re-tessellate NOTHING. Text blocks
 *    live in their own containers â€” live drags are transform-only.
 *  - Hairlines bake into stroke geometry: cells with hairlines rebuild
 *    when zoom moves >2% (the v7-proven policy).
 *
 * Fill-rule bridge: our fills are Flash's EVEN-ODD; pixi triangulates
 * nonzero. assignHoles() nests each style's closed chains by
 * containment (planar-map chains are disjoint or nested) â€” even depth
 * fills, odd-depth children cut() as holes. The same nesting drives
 * glyph counters in text.
 *
 * Gradients render EXACTLY: the paint is rasterized ONCE per style by
 * the same Canvas2D code path the oracle uses (a 256Â² texture over the
 * Â±16384tw SWF gradient square) and sampled on the GPU through the
 * style's SWF matrix â€” parity by construction. Matcap fills upload the
 * CPU pipeline's pixels (matcap.js) as sprites at the region bbox.
 */
(function () {
  "use strict";

  // ---- pure helpers (unit-tested without a GPU) ------------------------------

  /** Flatten one chain (render.js chain: {sx, sy, pts:[{x,y,cx,cy}]})
   *  to a polyline for containment tests only (drawing keeps quads). */
  function flattenChain(chain, steps) {
    steps = steps || 6;
    var out = [{ x: chain.sx, y: chain.sy }];
    var px = chain.sx, py = chain.sy;
    chain.pts.forEach(function (p) {
      if (p.cx === null || p.cx === undefined) {
        out.push({ x: p.x, y: p.y });
      } else {
        for (var i = 1; i <= steps; i++) {
          var t = i / steps, u = 1 - t;
          out.push({
            x: u * u * px + 2 * u * t * p.cx + t * t * p.x,
            y: u * u * py + 2 * u * t * p.cy + t * t * p.y
          });
        }
      }
      px = p.x; py = p.y;
    });
    return out;
  }

  function pointInPoly(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > pt.y) !== (yj > pt.y) &&
          pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function polyArea(poly) {
    var a = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    }
    return a / 2;
  }

  /** Nest chains by containment: entries {chain, depth, children} â€”
   *  even depth = filled outline, its odd-depth children are holes. */
  function assignHoles(chains, flatten) {
    var entries = chains.map(function (c) {
      var poly = flatten ? flatten(c) : c;
      return { chain: c, poly: poly, area: Math.abs(polyArea(poly)),
               depth: 0, parent: -1, children: [] };
    });
    // VERIFIED interior probe (the faceProbe discipline): candidates
    // at the midpoints of the longest segments, nudged along both
    // normals at several widths, accepted only when the chain ITSELF
    // contains the point. The old first-segment-toward-the-mean guess
    // sat OUTSIDE concave chains (eraser cuts make C-shapes), flipped
    // the containment tests, and rendered regions inverted/missing.
    entries.forEach(function (e) {
      var poly = e.poly, n = poly.length;
      var segs = [];
      for (var i = 0; i < n; i++) {
        var a = poly[i], b = poly[(i + 1) % n];
        segs.push({ a: a, b: b,
                    len: (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y) });
      }
      segs.sort(function (s1, s2) { return s2.len - s1.len; });
      var probe = null;
      var nudges = [30, 8, 2];
      for (var si = 0; si < segs.length && si < 6 && !probe; si++) {
        var s = segs[si];
        var mx2 = (s.a.x + s.b.x) / 2, my2 = (s.a.y + s.b.y) / 2;
        var dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
        var len = Math.sqrt(s.len) || 1;
        for (var ni = 0; ni < nudges.length && !probe; ni++) {
          var ncand = [
            { x: mx2 - dy / len * nudges[ni], y: my2 + dx / len * nudges[ni] },
            { x: mx2 + dy / len * nudges[ni], y: my2 - dx / len * nudges[ni] }
          ];
          for (var ci = 0; ci < 2 && !probe; ci++) {
            if (pointInPoly(ncand[ci], poly)) probe = ncand[ci];
          }
        }
      }
      e.probe = probe || { x: poly[0].x, y: poly[0].y };
    });
    entries.forEach(function (e, i) {
      var best = -1, bestArea = Infinity;
      entries.forEach(function (o, j) {
        if (i === j || o.area <= e.area) return;
        if (o.area < bestArea && pointInPoly(e.probe, o.poly)) {
          best = j; bestArea = o.area;
        }
      });
      e.parent = best;
    });
    entries.forEach(function (e) {
      var d = 0, p = e.parent;
      var guard = 0;
      while (p >= 0 && guard++ < entries.length) { d++; p = entries[p].parent; }
      e.depth = d;
    });
    entries.forEach(function (e, i) {
      if (e.parent >= 0 && e.depth % 2 === 1) entries[e.parent].children.push(i);
    });
    return entries;
  }

  /** Decompose a chain into SIMPLE loops at revisited anchors. The
   *  planar map guarantees self-contact happens only at shared integer
   *  nodes (never mid-edge), so a chain that pinches through a node
   *  twice â€” eraser slits, figure-eights â€” splits exactly there. The
   *  Canvas2D oracle renders such chains with even-odd (the revisited
   *  pocket cancels); pixi triangulates nonzero and would FILL the
   *  pocket, so each simple loop must nest independently (the log-30
   *  eraser artifact). */
  function splitAtRevisits(chain) {
    var loops = [];
    var pts = chain.pts.slice();
    var guard = 0;
    for (;;) {
      if (guard++ > 64) break; // malformed chain: bail with what we have
      var seen = new Map();
      seen.set(chain.sx + "," + chain.sy, -1);
      var cut = null;
      for (var i = 0; i < pts.length; i++) {
        var key = pts[i].x + "," + pts[i].y;
        if (seen.has(key)) {
          var j = seen.get(key);
          // returning to the START at the very end is just the close;
          // anything else is a genuine pinch
          var pinch = j === -1 ? i < pts.length - 1 : i > j + 1;
          if (pinch) {
            cut = { from: j, to: i };
            break;
          }
        }
        seen.set(key, i);
      }
      if (!cut) break;
      // segments (from+1 .. to) form a closed loop anchored at the
      // revisited node; extract it and continue on the remainder
      var loopPts = pts.slice(cut.from + 1, cut.to + 1);
      var anchor = cut.from === -1
        ? { x: chain.sx, y: chain.sy }
        : { x: pts[cut.from].x, y: pts[cut.from].y };
      if (loopPts.length > 1) {
        loops.push({ sx: anchor.x, sy: anchor.y, pts: loopPts, closed: true });
      }
      pts.splice(cut.from + 1, cut.to - cut.from);
    }
    loops.push({ sx: chain.sx, sy: chain.sy, pts: pts, closed: chain.closed });
    return loops;
  }

  function simplifyChains(chains) {
    var out = [];
    chains.forEach(function (c) {
      splitAtRevisits(c).forEach(function (l) {
        if (l.pts.length > 1) out.push(l);
      });
    });
    return out;
  }

  function rgb(c) { return (c.r << 16) | (c.g << 8) | c.b; }

  /** Hairline floor in twips for a zoom (>= 1 CSS px like render.js). */
  function hairWidth(width, zoom) {
    return Math.max(width, VB.TWIPS / zoom);
  }

  /** Content hash of one cell (edges, styles, texts) â€” freshness is
   *  decided by hashing, never by invalidation call sites, so in-place
   *  mutations (floats, node drags) are always caught. */
  function hashCell(doc) {
    var h = 17;
    function mix(v) { h = (h * 31 + v) | 0; }
    var edges = doc.edges;
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      mix(e.ax); mix(e.ay); mix(e.bx); mix(e.by);
      if (e.cx !== null) { mix(e.cx); mix(e.cy); }
      mix(e.fill0); mix(e.fill1); mix(e.line);
    }
    var s = JSON.stringify(doc.fills) + "|" + JSON.stringify(doc.lines);
    for (var c = 0; c < s.length; c++) mix(s.charCodeAt(c));
    (doc.texts || []).forEach(function (t) {
      // matrix EXCLUDED: live moves are transform-only (synced per
      // frame); records/colors are geometry
      t.records.forEach(function (rec) {
        mix(rec.font); mix(rec.height); mix(rec.x); mix(rec.y);
        mix(rec.color.r); mix(rec.color.g); mix(rec.color.b); mix(rec.color.a);
        rec.glyphs.forEach(function (g) { mix(g.gi); mix(g.adv); });
      });
      mix(t.records.length);
    });
    mix((doc.texts || []).length);
    // async matcap textures flip readiness -> re-render when they land
    doc.fills.forEach(function (f) {
      if (f.type === "matcap" && VB.matcapTexture) {
        mix(VB.matcapTexture(f) ? 1 : 0);
      }
    });
    return h;
  }

  // ---- gradient paint textures ------------------------------------------------
  // One 256Â² texture per style, painted by the SAME Canvas2D gradient
  // code the oracle uses, spanning the SWF gradient square (Â±16384tw).

  var GRAD_TEX = 256;
  var gradTexCache = new Map(); // style JSON -> PIXI.Texture

  function gradientTexture(style) {
    var key = JSON.stringify({ t: style.type, g: style.gradient });
    var hit = gradTexCache.get(key);
    if (hit) return hit;
    var cv = document.createElement("canvas");
    cv.width = GRAD_TEX; cv.height = GRAD_TEX;
    var ctx = cv.getContext("2d");
    var grad = style.type === "linear"
      ? ctx.createLinearGradient(0, 0, GRAD_TEX, 0)
      : ctx.createRadialGradient(GRAD_TEX / 2, GRAD_TEX / 2, 0,
                                 GRAD_TEX / 2, GRAD_TEX / 2, GRAD_TEX / 2);
    style.gradient.stops.forEach(function (s) {
      grad.addColorStop(s.ratio / 255, VB.colorToCSS(s.color));
    });
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, GRAD_TEX, GRAD_TEX);
    var tex = PIXI.Texture.from(cv);
    tex.source.addressMode = "clamp-to-edge";
    gradTexCache.set(key, tex);
    return tex;
  }

  /** Pixi's fill matrix maps LOCAL space -> TEXTURE px: build the
   *  texture->local map (scale the 256Â² texture over the Â±16384tw
   *  gradient square, then the style's SWF matrix) and invert it. */
  function gradientMatrix(style) {
    var m = style.matrix || { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 };
    var half = VB.GRAD_HALF || 16384;
    var s = 2 * half / GRAD_TEX; // texture px -> gradient-square twips
    var texToLocal = new PIXI.Matrix(
      m.sx * s, m.r0 * s, m.r1 * s, m.sy * s,
      -half * m.sx + -half * m.r1 + m.tx,
      -half * m.r0 + -half * m.sy + m.ty
    );
    return texToLocal;
  }

  // ---- surface ----------------------------------------------------------------

  async function createPixiSurface(host, overlayCanvas, options) {
    if (typeof PIXI === "undefined" || !PIXI.Application) return null;
    var app = new PIXI.Application();
    try {
      await app.init({
        resizeTo: host,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        backgroundAlpha: 0,
        antialias: true,
        autoStart: false,
        sharedTicker: false,
        preference: (options && options.preference) || "webgl"
      });
    } catch (err) {
      return null;
    }
    app.ticker.stop();
    var cv = app.canvas;
    cv.id = "pixi-canvas";
    cv.style.position = "absolute";
    cv.style.inset = "0";
    cv.style.pointerEvents = "none"; // #stage-canvas stays the pointer target
    host.insertBefore(cv, overlayCanvas);

    var surface = {
      app: app,
      canvas: cv,
      backdropLayer: new PIXI.Container(),
      world: new PIXI.Container(),
      stageLayer: new PIXI.Graphics(),
      documentLayer: new PIXI.Container(),
      textLayer: new PIXI.Container(),     // reserved (text lives per cell)
      materialLayer: new PIXI.Container(), // reserved
      overlayLayer: new PIXI.Container(),
      debugLayer: new PIXI.Container(),
      _backdrop: new PIXI.Graphics(),
      _cells: new Map(),   // "scene:layer" -> {hash, zoom, hasHairlines, bytes, container}
      _structure: "",
      _id: ++surfaceSeq    // scopes this surface's AssetCache claims
    };
    surface.backdropLayer.addChild(surface._backdrop);
    surface.world.addChild(surface.stageLayer);
    surface.world.addChild(surface.documentLayer);
    surface.world.addChild(surface.textLayer);
    surface.world.addChild(surface.materialLayer);
    app.stage.addChild(surface.backdropLayer);
    app.stage.addChild(surface.world);
    app.stage.addChild(surface.overlayLayer);
    app.stage.addChild(surface.debugLayer);

    surface.resize = function () { app.resize(); };
    surface.destroy = function () {
      if (VB.assets) {
        surface._cells.forEach(function (st, key) {
          VB.assets.release("pixicell:" + surface._id + ":" + key);
        });
      }
      surface._cells.clear();
      try { app.destroy(true, { children: true, texture: true }); }
      catch (e) { /* already gone */ }
      if (cv.parentElement) cv.parentElement.removeChild(cv);
    };
    return surface;
  }

  // ---- cell display trees -------------------------------------------------------

  function drawChainPath(g, chain) {
    g.moveTo(chain.sx, chain.sy);
    chain.pts.forEach(function (p) {
      if (p.cx === null || p.cx === undefined) g.lineTo(p.x, p.y);
      else g.quadraticCurveTo(p.cx, p.cy, p.x, p.y);
    });
    g.closePath();
  }

  function fillNested(g, chains, paint) {
    var nested = assignHoles(simplifyChains(chains), flattenChain);
    nested.forEach(function (e) {
      if (e.depth % 2 !== 0) return; // holes cut inside their parent
      drawChainPath(g, e.chain);
      g.fill(paint);
      e.children.forEach(function (ci) {
        drawChainPath(g, nested[ci].chain);
        g.cut();
      });
    });
  }

  /** Fraction of poly B's boundary midpoints strictly inside poly A â€”
   *  between the thresholds means B runs PARTIALLY through A. */
  function partialThrough(pa, pb) {
    var inside = 0;
    for (var k = 0; k < pb.length; k++) {
      var p1 = pb[k], p2 = pb[(k + 1) % pb.length];
      if (pointInPoly({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, pa)) {
        inside++;
      }
    }
    var frac = inside / pb.length;
    return frac > 0.05 && frac < 0.95;
  }

  /** Do any two chains of one fill OVERLAP without containment? Such
   *  siblings encode even-odd XOR (their intersection is EMPTY space)
   *  â€” inexpressible as fill+cut trees or earcut triangulation. */
  function hasSiblingOverlap(nested) {
    for (var i = 0; i < nested.length; i++) {
      for (var j = i + 1; j < nested.length; j++) {
        var a = nested[i], b = nested[j];
        // ancestry means clean nesting â€” fine
        if (a.parent === j || b.parent === i) continue;
        var pa = a.poly, pb = b.poly;
        // cheap bbox reject
        var ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
        var k;
        for (k = 0; k < pa.length; k++) {
          if (pa[k].x < ax0) ax0 = pa[k].x; if (pa[k].x > ax1) ax1 = pa[k].x;
          if (pa[k].y < ay0) ay0 = pa[k].y; if (pa[k].y > ay1) ay1 = pa[k].y;
        }
        var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (k = 0; k < pb.length; k++) {
          if (pb[k].x < bx0) bx0 = pb[k].x; if (pb[k].x > bx1) bx1 = pb[k].x;
          if (pb[k].y < by0) by0 = pb[k].y; if (pb[k].y > by1) by1 = pb[k].y;
        }
        if (ax0 > bx1 || bx0 > ax1 || ay0 > by1 || by0 > ay1) continue;
        // XOR signature: a sibling's boundary runs PARTIALLY through
        // the other's interior (fully-inside = nesting, fully-outside
        // = disjoint; both are fine). Interior probes miss this â€” each
        // sibling's probe sits in its exclusive area â€” so measure the
        // fraction of boundary midpoints inside the other.
        if (partialThrough(pa, pb) || partialThrough(pb, pa)) {
          var anc = a.parent, guard = 0;
          var related = false;
          while (anc >= 0 && guard++ < nested.length) {
            if (anc === j) { related = true; break; }
            anc = nested[anc].parent;
          }
          anc = b.parent; guard = 0;
          while (!related && anc >= 0 && guard++ < nested.length) {
            if (anc === i) { related = true; break; }
            anc = nested[anc].parent;
          }
          if (!related) return true;
        }
      }
    }
    return false;
  }

  /** Rasterize one fill through the ORACLE's painter (render.js
   *  paintFill) into a sprite at the fill's bbox â€” pixel-exact
   *  composition for even-odd-encoded fills, cached with the cell. */
  var RASTER_MAX = 2048;
  var surfaceSeq = 0; // scopes AssetCache claims per created surface
  function rasterFillSprite(doc, fillIdx, style, chains, zoom) {
    if (!VB.paintFill) return null;
    var bb = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
    chains.forEach(function (c) {
      flattenChain(c, 4).forEach(function (p) {
        if (p.x < bb.xmin) bb.xmin = p.x; if (p.x > bb.xmax) bb.xmax = p.x;
        if (p.y < bb.ymin) bb.ymin = p.y; if (p.y > bb.ymax) bb.ymax = p.y;
      });
    });
    if (bb.xmin > bb.xmax) return null;
    bb.xmin -= 20; bb.ymin -= 20; bb.xmax += 20; bb.ymax += 20;
    var wtw = bb.xmax - bb.xmin, htw = bb.ymax - bb.ymin;
    var scale = Math.min((zoom || 1) / VB.TWIPS,
                         RASTER_MAX / Math.max(wtw, htw));
    var w = Math.max(2, Math.round(wtw * scale));
    var h = Math.max(2, Math.round(htw * scale));
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d");
    ctx.setTransform(w / wtw, 0, 0, h / htw, -bb.xmin * w / wtw, -bb.ymin * h / htw);
    VB.paintFill(ctx, doc, fillIdx, style, chains);
    var sprite = new PIXI.Sprite(PIXI.Texture.from(cv));
    sprite.position.set(bb.xmin, bb.ymin);
    sprite.width = wtw;
    sprite.height = htw;
    sprite.vbBytes = w * h * 4; // texture residency, tallied per cell
    return sprite;
  }

  function styleFillPaint(style) {
    if ((style.type === "linear" || style.type === "radial") &&
        style.gradient && style.gradient.stops.length > 1) {
      return {
        texture: gradientTexture(style),
        matrix: gradientMatrix(style),
        // 'global' = matrix maps texture px straight into local twips;
        // the default 'local' normalizes to shape bounds and would
        // bend the paint per region
        textureSpace: "global"
      };
    }
    var base = style.type === "solid" ? style.color
             : VB.materialBaseColor(style);
    return { color: rgb(base), alpha: base.a / 255 };
  }

  function buildCell(doc, zoom, cellState) {
    var cellC = new PIXI.Container();

    // Fills from the claim-boundary chains â€” the SAME source the
    // oracle paints. Chains that nest cleanly render as vector
    // fill+cut trees; fills whose sibling chains OVERLAP without
    // containment carry even-odd XOR encoding (eraser slits, pockets)
    // that no cut tree â€” and no earcut triangulation â€” can express:
    // those fills rasterize through the ORACLE's own painter into a
    // cached sprite at the fill's bbox (crisp at the built zoom; the
    // zoom-rebuild policy refreshes it, same as hairlines).
    var fillPaths = VB.buildFillPaths(doc);
    for (var f = 1; f < fillPaths.length; f++) {
      var chains = fillPaths[f];
      if (!chains || !chains.length) continue;
      var style = doc.fills[f - 1] || { type: "solid",
        color: { r: 128, g: 128, b: 128, a: 255 } };
      if (style.type === "matcap" && VB.matcapBuffers && VB.matcapTexture) {
        var tex = VB.matcapTexture(style);
        if (tex) {
          var buffers = VB.matcapBuffers(doc, f, style);
          if (buffers) {
            var mcv = document.createElement("canvas");
            mcv.width = buffers.w; mcv.height = buffers.h;
            var mid = mcv.getContext("2d").createImageData(buffers.w, buffers.h);
            mid.data.set(VB.matcapPixels(buffers, tex));
            mcv.getContext("2d").putImageData(mid, 0, 0);
            var sprite = new PIXI.Sprite(PIXI.Texture.from(mcv));
            sprite.position.set(buffers.bbox.xmin, buffers.bbox.ymin);
            sprite.width = buffers.bbox.xmax - buffers.bbox.xmin;
            sprite.height = buffers.bbox.ymax - buffers.bbox.ymin;
            cellState.bytes += buffers.w * buffers.h * 4;
            cellC.addChild(sprite);
            continue;
          }
        }
      }
      // Planar-map fills rasterize through the ORACLE painter into a
      // sprite — unconditionally. The walker's chains encode paint as
      // MULTI-CHAIN EVEN-ODD PARITY (post-erase documents weave the
      // ink ribbon's walls into overlapping chains whose XOR is the
      // picture); no fill+cut tree or earcut triangulation can express
      // that, and every geometric "is this fill simple?" test we tried
      // was defeated by real documents (log 30). The sprite is exact
      // by construction, cached with the cell, crisp at the built zoom
      // (the zoom-rebuild policy refreshes it), and composited on the
      // GPU. True GPU vector fills need stencil even-odd — a future
      // pipeline. Strokes and text remain vector Graphics.
      var rSprite = rasterFillSprite(doc, f, style, chains, zoom);
      if (rSprite) {
        cellState.hasHairlines = true; // zoom-sensitive: reuse the policy
        cellState.bytes += rSprite.vbBytes;
        cellC.addChild(rSprite);
      }
    }

    // strokes on top, round caps/joins, hairline floor
    var strokePaths = VB.buildStrokePaths(doc);
    var strokesG = new PIXI.Graphics();
    for (var l = 1; l < strokePaths.length; l++) {
      var chains2 = strokePaths[l];
      if (!chains2 || !chains2.length) continue;
      var ls = doc.lines[l - 1];
      var w = hairWidth(ls.width, zoom);
      if (w > ls.width) cellState.hasHairlines = true;
      chains2.forEach(function (ch) {
        strokesG.moveTo(ch.sx, ch.sy);
        ch.pts.forEach(function (p) {
          if (p.cx === null || p.cx === undefined) strokesG.lineTo(p.x, p.y);
          else strokesG.quadraticCurveTo(p.cx, p.cy, p.x, p.y);
        });
      });
      strokesG.stroke({ width: w, color: rgb(ls.color),
                        alpha: ls.color.a / 255, cap: "round", join: "round" });
    }
    cellC.addChild(strokesG);

    // text blocks: one container each â€” live matrix moves stay cheap
    (doc.texts || []).forEach(function (block) {
      var tc = new PIXI.Container();
      var tg = new PIXI.Graphics();
      block.records.forEach(function (rec) {
        var font = doc.fonts[rec.font];
        if (!font) return;
        var scale = rec.height / 1024;
        var penX = rec.x;
        var contours = [];
        rec.glyphs.forEach(function (gl) {
          var glyph = font.glyphs[gl.gi];
          if (glyph) {
            glyph.contours.forEach(function (c) {
              contours.push({
                sx: penX + c.mx * scale, sy: rec.y + c.my * scale,
                pts: c.segs.map(function (sgl) {
                  return sgl.cx === undefined
                    ? { x: penX + sgl.x * scale, y: rec.y + sgl.y * scale,
                        cx: null, cy: null }
                    : { cx: penX + sgl.cx * scale, cy: rec.y + sgl.cy * scale,
                        x: penX + sgl.x * scale, y: rec.y + sgl.y * scale };
                })
              });
            });
          }
          penX += gl.adv;
        });
        fillNested(tg, contours, { color: rgb(rec.color),
                                   alpha: rec.color.a / 255 });
      });
      tc.addChild(tg);
      tc.vbBlock = block; // transform refreshed every frame (cheap)
      cellC.addChild(tc);
    });

    return cellC;
  }

  // ---- the frame ----------------------------------------------------------------

  function renderProjectPixi(surface, project, view) {
    var res = surface.app.renderer.resolution || 1;
    var w = surface.app.renderer.width / res;
    var h = surface.app.renderer.height / res;
    surface._backdrop.clear();
    surface._backdrop.rect(0, 0, w, h).fill(0x3a3d42);

    surface.world.scale.set(view.zoom / VB.TWIPS);
    surface.world.position.set(view.panX, view.panY);

    var stage = project.stage ? project.stage() : project;
    var bg = stage.background || { r: 255, g: 255, b: 255 };
    surface.stageLayer.clear();
    surface.stageLayer
      .rect(120, 160, stage.width, stage.height)
      .fill({ color: 0x000000, alpha: 0.25 });
    surface.stageLayer
      .rect(0, 0, stage.width, stage.height)
      .fill(rgb(bg));

    // cells: rebuild only what changed (content hash / hairline zoom).
    // Cell raster textures are AssetCache tenants (streaming.js):
    // budget eviction destroys the cell so the next frame rebuilds it —
    // never wrong pixels, only spent milliseconds. frameStart() exempts
    // everything this pass claims or touches from eviction mid-render.
    if (VB.assets) VB.assets.frameStart();
    function cellAssetKey(key) { return "pixicell:" + surface._id + ":" + key; }
    function dropCell(key, st) {
      if (st.container) st.container.destroy({ children: true });
      surface._cells.delete(key);
      if (VB.assets) VB.assets.release(cellAssetKey(key));
    }
    var layers = project.scene().layers;
    var structure = project.cur.scene + "|" + layers.map(function (l) {
      return l.visible ? 1 : 0;
    }).join("");
    var live = {};
    var order = [];
    for (var i = layers.length - 1; i >= 0; i--) {
      if (!layers[i].visible) continue;
      var key = project.cur.scene + ":" + i;
      live[key] = true;
      var doc = layers[i].frames[0];
      var hash = hashCell(doc);
      var st = surface._cells.get(key);
      var zoomStale = st && st.hasHairlines &&
        Math.abs(view.zoom - st.zoom) / st.zoom > 0.02;
      if (!st || st.hash !== hash || zoomStale) {
        if (st) dropCell(key, st);
        st = { hash: hash, zoom: view.zoom, hasHairlines: false, bytes: 0 };
        st.container = buildCell(doc, view.zoom, st);
        surface._cells.set(key, st);
        if (VB.assets) {
          (function (k) {
            VB.assets.claim(cellAssetKey(k), st.bytes, function () {
              var evicted = surface._cells.get(k);
              if (evicted) {
                if (evicted.container) evicted.container.destroy({ children: true });
                surface._cells.delete(k);
              }
            });
          })(key);
        }
      } else if (VB.assets) {
        VB.assets.touch(cellAssetKey(key));
      }
      order.push(st.container);
    }
    // drop cells for deleted/hidden layers
    surface._cells.forEach(function (st, key) {
      if (!live[key]) dropCell(key, st);
    });
    if (structure !== surface._structure ||
        surface.documentLayer.children.length !== order.length ||
        order.some(function (c, idx) {
          return surface.documentLayer.children[idx] !== c;
        })) {
      surface.documentLayer.removeChildren();
      order.forEach(function (c) { surface.documentLayer.addChild(c); });
      surface._structure = structure;
    }

    // text containers track their block matrices every frame
    surface.documentLayer.children.forEach(function (cellC) {
      cellC.children.forEach(function (tc) {
        if (tc.vbBlock) {
          var m = tc.vbBlock.matrix;
          tc.setFromMatrix(new PIXI.Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
        }
      });
    });

    surface.app.render();
  }

  // Later slices: pixi-native tool overlays and debug decorations
  // (they stay on the Canvas2D overlay above until ported).
  function renderOverlayPixi(surface, tool, view) { /* overlay port slice */ }
  function renderDebugPixi(surface, doc, view, hoverIdx) { /* debug port slice */ }

  window.VB = window.VB || {};
  VB.pixiRenderVersion = "oracle-fills-1";
  VB.createPixiSurface = createPixiSurface;
  VB.renderProjectPixi = renderProjectPixi;
  VB.renderOverlayPixi = renderOverlayPixi;
  VB.renderDebugPixi = renderDebugPixi;
  VB.pixiAssignHoles = assignHoles;     // exported for the (GPU-free) suite
  VB.pixiFlattenChain = flattenChain;
  VB.pixiHairWidth = hairWidth;
  VB.pixiHashCell = hashCell;
  VB.pixiSplitAtRevisits = splitAtRevisits;
  VB.pixiSimplifyChains = simplifyChains;
})();
