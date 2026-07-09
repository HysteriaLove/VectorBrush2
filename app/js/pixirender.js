/* pixirender.js — GPU renderer (pixi.js v7, vendored unminified in
 * app/lib/pixi.js) behind the same contract as render.js.
 *
 * Built for LOW-END DEVICES (iPads are a target):
 *   - NO ticker. We render on demand from the app's own rAF, so an
 *     idle editor costs zero GPU/battery.
 *   - Retained scene: Project -> stage, Layer -> Container, cell shape
 *     -> Graphics, text block -> its own Container (so live matrix
 *     moves are transform-only). Geometry re-tessellates ONLY when the
 *     document changes (invalidate()); pan/zoom/overlay frames just
 *     update the stage transform.
 *   - powerPreference "low-power", antialias on (cheap MSAA on WebGL2).
 *
 * Fill-rule note: our fills are Flash's EVEN-ODD; PIXI.Graphics fills
 * nonzero with earcut. assignHoles() nests each style's closed chains
 * by containment (planar-map chains are disjoint or nested) so holes
 * become beginHole()/endHole() pairs — even depth fills, odd depth
 * cuts. The same nesting drives glyph counters in text blocks.
 */
(function () {
  "use strict";

  // ---- pure helpers (unit-tested without a GPU) ------------------------------

  // Flatten one chain (render.js chain: {sx, sy, pts:[{x,y,cx,cy}]}) to
  // a polyline for containment tests only (drawing keeps the quads).
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

  /** Nest chains by containment: returns entries {chain, poly, depth,
   *  children:[indices]} where even depth = filled outline and its
   *  odd-depth children are holes. probe = a point safely interior
   *  (midpoint of the first segment nudged toward the polygon mean). */
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

  // ---- the view --------------------------------------------------------------

  function PixiView() {
    var self = {
      renderer: null,
      stage: null,
      canvas: null,
      dirty: true,
      builtZoom: 0,
      hasHairlines: false
    };

    self.init = function (container) {
      if (!window.PIXI) return false;
      try {
        self.canvas = document.createElement("canvas");
        self.canvas.id = "pixi-canvas";
        self.canvas.style.cssText =
          "position:absolute; inset:0; width:100%; height:100%; display:block;";
        container.insertBefore(self.canvas, container.firstChild);
        self.renderer = new PIXI.Renderer({
          view: self.canvas,
          width: Math.max(1, container.clientWidth),
          height: Math.max(1, container.clientHeight),
          antialias: true,
          autoDensity: true,
          resolution: window.devicePixelRatio || 1,
          backgroundColor: 0x3a3d42, // the work-area backdrop
          powerPreference: "low-power"
        });
        self.stage = new PIXI.Container();
        return true;
      } catch (err) {
        // no WebGL: the caller falls back to the 2D renderer
        if (self.canvas && self.canvas.parentNode) self.canvas.remove();
        self.renderer = null;
        return false;
      }
    };

    self.resize = function (w, h) {
      if (!self.renderer) return;
      self.renderer.resolution = window.devicePixelRatio || 1;
      self.renderer.resize(Math.max(1, w), Math.max(1, h));
      self.dirty = true; // hairlines depend on nothing here, but cheap
    };

    self.invalidate = function () { self.dirty = true; };

    function drawChainPath(g, chain) {
      g.moveTo(chain.sx, chain.sy);
      chain.pts.forEach(function (p) {
        if (p.cx === null || p.cx === undefined) g.lineTo(p.x, p.y);
        else g.quadraticCurveTo(p.cx, p.cy, p.x, p.y);
      });
      g.closePath();
    }

    function drawContourPath(g, c) {
      g.moveTo(c.mx, c.my);
      c.segs.forEach(function (s) {
        if (s.cx === undefined) g.lineTo(s.x, s.y);
        else g.quadraticCurveTo(s.cx, s.cy, s.x, s.y);
      });
      g.closePath();
    }

    function buildCell(doc, zoom) {
      var cellC = new PIXI.Container();

      // fills: per style, nested chains -> outline + holes
      var fillPaths = VB.buildFillPaths(doc);
      var fillsG = new PIXI.Graphics();
      for (var f = 1; f < fillPaths.length; f++) {
        var chains = fillPaths[f];
        if (!chains || !chains.length) continue;
        var style = doc.fills[f - 1];
        if (!style || style.type !== "solid") continue;
        var nested = assignHoles(chains, flattenChain);
        nested.forEach(function (e) {
          if (e.depth % 2 !== 0) return; // holes draw inside their parent
          fillsG.beginFill(rgb(style.color), style.color.a / 255);
          drawChainPath(fillsG, e.chain);
          e.children.forEach(function (ci) {
            fillsG.beginHole();
            drawChainPath(fillsG, nested[ci].chain);
            fillsG.endHole();
          });
          fillsG.endFill();
        });
      }
      cellC.addChild(fillsG);

      // strokes on top, round caps/joins, hairline floor
      var strokePaths = VB.buildStrokePaths(doc);
      var strokesG = new PIXI.Graphics();
      for (var l = 1; l < strokePaths.length; l++) {
        var chains2 = strokePaths[l];
        if (!chains2 || !chains2.length) continue;
        var ls = doc.lines[l - 1];
        var w = hairWidth(ls.width, zoom);
        if (w > ls.width) self.hasHairlines = true;
        strokesG.lineStyle({
          width: w, color: rgb(ls.color), alpha: ls.color.a / 255,
          cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND
        });
        chains2.forEach(function (ch) {
          strokesG.moveTo(ch.sx, ch.sy);
          ch.pts.forEach(function (p) {
            if (p.cx === null || p.cx === undefined) strokesG.lineTo(p.x, p.y);
            else strokesG.quadraticCurveTo(p.cx, p.cy, p.x, p.y);
          });
        });
        strokesG.lineStyle();
      }
      cellC.addChild(strokesG);

      // text blocks: one Container each so live matrix moves stay cheap
      (doc.texts || []).forEach(function (block) {
        var tc = new PIXI.Container();
        var g = new PIXI.Graphics();
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
                // instantiate in block-local twips
                var inst = {
                  mx: penX + c.mx * scale, my: rec.y + c.my * scale,
                  segs: c.segs.map(function (s) {
                    return s.cx === undefined
                      ? { x: penX + s.x * scale, y: rec.y + s.y * scale }
                      : { cx: penX + s.cx * scale, cy: rec.y + s.cy * scale,
                          x: penX + s.x * scale, y: rec.y + s.y * scale };
                  })
                };
                contours.push(inst);
              });
            }
            penX += gl.adv;
          });
          var nested = assignHoles(contours, function (c) {
            return flattenChain({ sx: c.mx, sy: c.my, pts: c.segs }, 4);
          });
          nested.forEach(function (e) {
            if (e.depth % 2 !== 0) return;
            g.beginFill(rgb(rec.color), rec.color.a / 255);
            drawContourPath(g, e.chain);
            e.children.forEach(function (ci) {
              g.beginHole();
              drawContourPath(g, nested[ci].chain);
              g.endHole();
            });
            g.endFill();
          });
        });
        tc.addChild(g);
        tc.vbBlock = block; // transform refreshed every frame (cheap)
        cellC.addChild(tc);
      });

      return cellC;
    }

    function rebuild(project, view) {
      self.stage.removeChildren().forEach(function (c) {
        c.destroy({ children: true });
      });
      self.hasHairlines = false;
      self.builtZoom = view.zoom;

      var stageG = new PIXI.Graphics();
      stageG.beginFill(rgb(project.background), project.background.a / 255);
      stageG.drawRect(0, 0, project.width, project.height);
      stageG.endFill();
      stageG.lineStyle({ width: VB.TWIPS / view.zoom, color: 0x000000, alpha: 0.25 });
      stageG.drawRect(0, 0, project.width, project.height);
      self.stage.addChild(stageG);

      var layers = project.scene().layers;
      for (var i = layers.length - 1; i >= 0; i--) {
        if (!layers[i].visible) continue;
        self.stage.addChild(buildCell(layers[i].frames[0], view.zoom));
      }
      self.dirty = false;
    }

    /** Called from the app's own rAF — never from a ticker. */
    self.render = function (project, view) {
      if (!self.renderer) return;
      // hairline widths bake into geometry: re-tessellate when the
      // zoom moved enough to matter (only if hairlines exist)
      if (!self.dirty && self.hasHairlines &&
          Math.abs(view.zoom - self.builtZoom) / self.builtZoom > 0.02) {
        self.dirty = true;
      }
      if (self.dirty) rebuild(project, view);
      // text containers track their block matrices every frame (live
      // drags update matrices without touching geometry)
      self.stage.children.forEach(function (child) {
        if (!child.children) return;
        child.children.forEach(function (tc) {
          if (tc.vbBlock) {
            var m = tc.vbBlock.matrix;
            tc.transform.setFromMatrix(
              new PIXI.Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
          }
        });
      });
      var s = view.zoom / VB.TWIPS; // twips -> CSS px
      self.stage.scale.set(s, s);
      self.stage.position.set(view.panX, view.panY);
      self.renderer.render(self.stage);
    };

    return self;
  }

  window.VB = window.VB || {};
  VB.PixiView = PixiView;
  VB.pixiAssignHoles = assignHoles;   // exported for the (GPU-free) suite
  VB.pixiFlattenChain = flattenChain;
  VB.pixiHairWidth = hairWidth;
})();
