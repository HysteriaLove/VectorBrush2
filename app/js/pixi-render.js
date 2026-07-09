/* pixi-render.js — the Pixi backend (docs/PixiPort.md).
 *
 * FULL document rendering on pixi v8: fills (solid, gradient, matcap),
 * strokes, text — the drawing surface is GPU-retained; the Canvas2D
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
 *    live in their own containers — live drags are transform-only.
 *  - Hairlines bake into stroke geometry: cells with hairlines rebuild
 *    when zoom moves >2% (the v7-proven policy).
 *
 * Fill-rule bridge: our fills are Flash's EVEN-ODD; pixi triangulates
 * nonzero. assignHoles() nests each style's closed chains by
 * containment (planar-map chains are disjoint or nested) — even depth
 * fills, odd-depth children cut() as holes. The same nesting drives
 * glyph counters in text.
 *
 * Gradients render EXACTLY: the paint is rasterized ONCE per style by
 * the same Canvas2D code path the oracle uses (a 256² texture over the
 * ±16384tw SWF gradient square) and sampled on the GPU through the
 * style's SWF matrix — parity by construction. Matcap fills upload the
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

  /** Nest chains by containment: entries {chain, depth, children} —
   *  even depth = filled outline, its odd-depth children are holes. */
  function assignHoles(chains, flatten) {
    var entries = chains.map(function (c) {
      var poly = flatten ? flatten(c) : c;
      return { chain: c, poly: poly, area: Math.abs(polyArea(poly)),
               depth: 0, parent: -1, children: [] };
    });
    entries.forEach(function (e) {
      var n = e.poly.length;
      var mx = 0, my = 0;
      for (var i = 0; i < n; i++) { mx += e.poly[i].x; my += e.poly[i].y; }
      mx /= n; my /= n;
      var p0 = e.poly[0], p1 = e.poly[1 % n];
      var ex = (p0.x + p1.x) / 2, ey = (p0.y + p1.y) / 2;
      e.probe = { x: ex + (mx - ex) * 1e-3, y: ey + (my - ey) * 1e-3 };
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

  function rgb(c) { return (c.r << 16) | (c.g << 8) | c.b; }

  /** Hairline floor in twips for a zoom (>= 1 CSS px like render.js). */
  function hairWidth(width, zoom) {
    return Math.max(width, VB.TWIPS / zoom);
  }

  /** Content hash of one cell (edges, styles, texts) — freshness is
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
  // One 256² texture per style, painted by the SAME Canvas2D gradient
  // code the oracle uses, spanning the SWF gradient square (±16384tw).

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
   *  texture->local map (scale the 256² texture over the ±16384tw
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
      _cells: new Map(),   // "scene:layer" -> {hash, zoom, hasHairlines, container}
      _structure: ""
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
    var nested = assignHoles(chains, flattenChain);
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

  function buildCell(doc, zoom, cellState) {
    var cellC = new PIXI.Container();

    // fills in style order — one child per style keeps paint order
    // exact even when matcap sprites interleave with Graphics
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
            cellC.addChild(sprite);
            continue;
          }
        }
        // texture still decoding / empty region: base-color fallback
        var gFb = new PIXI.Graphics();
        fillNested(gFb, chains, {
          color: rgb(VB.materialBaseColor(style)),
          alpha: VB.materialBaseColor(style).a / 255
        });
        cellC.addChild(gFb);
        continue;
      }
      var g = new PIXI.Graphics();
      if ((style.type === "linear" || style.type === "radial") &&
          style.gradient && style.gradient.stops.length > 1) {
        fillNested(g, chains, {
          texture: gradientTexture(style),
          matrix: gradientMatrix(style),
          // 'global' = matrix maps texture px straight into local
          // twips; the default 'local' normalizes to shape bounds and
          // would bend the paint per region
          textureSpace: "global"
        });
      } else {
        var base = style.type === "solid" ? style.color
                 : VB.materialBaseColor(style);
        fillNested(g, chains, { color: rgb(base), alpha: base.a / 255 });
      }
      cellC.addChild(g);
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

    // text blocks: one container each — live matrix moves stay cheap
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

    var bg = project.background || { r: 255, g: 255, b: 255 };
    surface.stageLayer.clear();
    surface.stageLayer
      .rect(120, 160, project.width, project.height)
      .fill({ color: 0x000000, alpha: 0.25 });
    surface.stageLayer
      .rect(0, 0, project.width, project.height)
      .fill(rgb(bg));

    // cells: rebuild only what changed (content hash / hairline zoom)
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
        if (st && st.container) st.container.destroy({ children: true });
        st = { hash: hash, zoom: view.zoom, hasHairlines: false };
        st.container = buildCell(doc, view.zoom, st);
        surface._cells.set(key, st);
      }
      order.push(st.container);
    }
    // drop cells for deleted/hidden layers
    surface._cells.forEach(function (st, key) {
      if (!live[key]) {
        if (st.container) st.container.destroy({ children: true });
        surface._cells.delete(key);
      }
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
  VB.createPixiSurface = createPixiSurface;
  VB.renderProjectPixi = renderProjectPixi;
  VB.renderOverlayPixi = renderOverlayPixi;
  VB.renderDebugPixi = renderDebugPixi;
  VB.pixiAssignHoles = assignHoles;     // exported for the (GPU-free) suite
  VB.pixiFlattenChain = flattenChain;
  VB.pixiHairWidth = hairWidth;
  VB.pixiHashCell = hashCell;
})();
