/* matcap.js — the matcap material pipeline (2DMaterials stage 2, CPU
 * reference implementation).
 *
 * A matcap ("material capture") is a sphere-lit texture sampled by
 * surface normal: uv = 0.5 + n.xy * 0.5 in IMAGE space (x right,
 * y down). The pipeline for a painted region:
 *
 *   1. coverage  — region mask from fill parity (exact, no canvas);
 *   2. height    — chamfer 3/4 distance transform, clamped to the
 *                  bump relief width (bumpScale twips) — the BUMP MAP;
 *   3. blur      — separable Gaussian, sigma = blurPx · resolution;
 *   4. normals   — Sobel over the height field — the NORMAL MAP;
 *   5. sample    — bilinear matcap texture lookup per pixel.
 *
 * Everything here is deterministic CPU math over typed arrays: the
 * suite pins stage outputs exactly, and this implementation stays the
 * correctness oracle for the WebGPU backend (stage 2b) the same way
 * Canvas2D is the oracle for GPU rendering. Buffer texel counts match
 * VB.materialProfile's cost model (bbox × resolution²).
 *
 * Matcap textures: procedurally generated builtins (studio, chrome,
 * clay, toon — deterministic, no binary assets, offline) or a
 * user-loaded image embedded as PNG bytes in the style ({b64}) so
 * documents and journals stay self-contained.
 */
(function () {
  "use strict";

  var MAX_SIDE = 1024; // hard cap on working-buffer long side, texels
  var TEX = 256;       // builtin matcap texture size

  // ---- builtin matcap textures ----------------------------------------------

  function shadePoint(name, nx, ny, nz) {
    // light in image space: upper-left key
    function dot3(ax, ay, az, bx, by, bz) { return ax * bx + ay * by + az * bz; }
    var kl = { x: -0.45, y: -0.55, z: 0.7 };
    var kn = Math.hypot(kl.x, kl.y, kl.z);
    var l = Math.max(0, dot3(nx, ny, nz, kl.x / kn, kl.y / kn, kl.z / kn));
    var rim = Math.pow(Math.max(0, 1 - nz), 2);
    var spec = Math.pow(l, 24);
    var r, g, b;
    if (name === "chrome") {
      // env-band look: vertical gradient split by a soft horizon
      var band = 0.5 - ny * 0.5;
      var sky = 150 + 90 * band;
      var ground = 40 + 50 * band;
      var horizon = 1 / (1 + Math.exp(-(ny + 0.08) * 18));
      var v = sky * (1 - horizon) + ground * horizon;
      v = v + rim * 60 + spec * 90;
      r = v * 0.92; g = v * 0.97; b = v * 1.05;
    } else if (name === "clay") {
      var base = 60 + 150 * l;
      r = base * 1.05; g = base * 0.82; b = base * 0.68;
    } else if (name === "toon") {
      var q = l > 0.75 ? 1 : l > 0.35 ? 0.62 : 0.28;
      r = 90 * q + 30; g = 150 * q + 30; b = 210 * q + 30;
    } else { // "studio"
      var base2 = 34 + 165 * l + rim * 25;
      r = base2 + spec * 200; g = base2 + spec * 200; b = base2 + spec * 210;
    }
    return [Math.max(0, Math.min(255, Math.round(r))),
            Math.max(0, Math.min(255, Math.round(g))),
            Math.max(0, Math.min(255, Math.round(b)))];
  }

  var builtinCache = {};
  /** A builtin matcap as {w, h, data(Uint8ClampedArray RGBA)} —
   *  procedural and deterministic. */
  function builtinMatcap(name) {
    if (builtinCache[name]) return builtinCache[name];
    var data = new Uint8ClampedArray(TEX * TEX * 4);
    for (var y = 0; y < TEX; y++) {
      for (var x = 0; x < TEX; x++) {
        var nx = (x + 0.5) / TEX * 2 - 1;
        var ny = (y + 0.5) / TEX * 2 - 1;
        var rr = nx * nx + ny * ny;
        if (rr > 1) { // outside the sphere: clamp to the rim direction
          var rl = Math.sqrt(rr);
          nx /= rl; ny /= rl; rr = 1;
        }
        var nz = Math.sqrt(Math.max(0, 1 - rr));
        var c = shadePoint(name, nx, ny, nz);
        var o = (y * TEX + x) * 4;
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
      }
    }
    builtinCache[name] = { w: TEX, h: TEX, data: data };
    return builtinCache[name];
  }

  var BUILTINS = ["studio", "chrome", "clay", "toon"];

  // ---- embedded (user-loaded) matcap textures --------------------------------

  var embeddedCache = new Map(); // b64 -> {w,h,data} | "loading"

  /** Resolve a style's matcap texture. Builtins are synchronous;
   *  embedded images decode async — returns null while loading and
   *  calls VB.onMatcapReady() when the pixels arrive. */
  function matcapTexture(style) {
    var src = style.matcap || "studio";
    if (typeof src === "string") return builtinMatcap(src);
    if (!src.b64) return builtinMatcap("studio");
    var hit = embeddedCache.get(src.b64);
    if (hit && hit !== "loading") return hit;
    if (hit === "loading") return null;
    embeddedCache.set(src.b64, "loading");
    var img = new Image();
    img.onload = function () {
      var cv = document.createElement("canvas");
      cv.width = TEX; cv.height = TEX;
      var cx = cv.getContext("2d");
      cx.drawImage(img, 0, 0, TEX, TEX);
      var id = cx.getImageData(0, 0, TEX, TEX);
      embeddedCache.set(src.b64, { w: TEX, h: TEX, data: id.data });
      if (VB.onMatcapReady) VB.onMatcapReady();
    };
    img.onerror = function () {
      embeddedCache.set(src.b64, builtinMatcap("studio"));
      if (VB.onMatcapReady) VB.onMatcapReady();
    };
    img.src = "data:image/png;base64," + src.b64;
    return null;
  }

  // ---- pipeline stages (pure, typed arrays) ----------------------------------

  /** Region coverage mask over an integer pixel grid: 1 inside the
   *  fill (parity at pixel centers — exact, same crossing rule as
   *  geom.fillParity), 0 outside.
   *
   *  SCANLINE parity: each row computes its boundary crossings once
   *  and fills the spans between them — O(rows × boundary edges), not
   *  O(pixels × edges). Per-pixel ray casting made every matcap
   *  recompute take seconds on real regions. */
  function coverageMask(doc, fillIdx, bb, w, h) {
    var mask = new Uint8Array(w * h);
    var sx = (bb.xmax - bb.xmin) / w, sy = (bb.ymax - bb.ymin) / h;
    var boundary = [];
    for (var bi = 0; bi < doc.edges.length; bi++) {
      var be = doc.edges[bi];
      if ((be.fill0 === fillIdx) !== (be.fill1 === fillIdx)) boundary.push(be);
    }
    var T_EPS = 1e-9;
    // crossing x-coordinates of one edge with the horizontal line py —
    // mirrors fillParity's straddle rules so pixel-center classification
    // is IDENTICAL to the per-pixel reference
    function rowCrossings(e, py, out) {
      if (e.cx === null) {
        if ((e.ay > py) !== (e.by > py)) {
          out.push(e.ax + (e.bx - e.ax) * (py - e.ay) / (e.by - e.ay));
        }
        return;
      }
      var denom = e.ay - 2 * e.cy + e.by;
      var tExt = denom !== 0 ? (e.ay - e.cy) / denom : -1;
      var ts = [0];
      if (tExt > T_EPS && tExt < 1 - T_EPS) ts.push(tExt);
      ts.push(1);
      for (var s = 0; s + 1 < ts.length; s++) {
        var p0 = VB.geom.evalEdge(e, ts[s]), p1 = VB.geom.evalEdge(e, ts[s + 1]);
        if ((p0.y > py) === (p1.y > py)) continue;
        var roots = VB.geom.solveQuadratic(denom, 2 * (e.cy - e.ay), e.ay - py);
        for (var r2 = 0; r2 < roots.length; r2++) {
          var t = roots[r2];
          if (t >= ts[s] - 1e-9 && t <= ts[s + 1] + 1e-9) {
            out.push(VB.geom.evalEdge(e, Math.min(1, Math.max(0, t))).x);
            break;
          }
        }
      }
    }
    var xs = [];
    for (var y = 0; y < h; y++) {
      var py = bb.ymin + (y + 0.5) * sy;
      xs.length = 0;
      for (var b2 = 0; b2 < boundary.length; b2++) rowCrossings(boundary[b2], py, xs);
      if (!xs.length) continue;
      xs.sort(function (a, b) { return a - b; });
      for (var k = 0; k + 1 < xs.length; k += 2) {
        // pixels whose CENTER lies inside the span (x0, x1]
        var x0 = Math.ceil((xs[k] - bb.xmin) / sx - 0.5);
        var x1 = Math.floor((xs[k + 1] - bb.xmin) / sx - 0.5 - 1e-9);
        if (x0 < 0) x0 = 0;
        if (x1 > w - 1) x1 = w - 1;
        for (var x = x0; x <= x1; x++) mask[y * w + x] = 1;
      }
    }
    return mask;
  }

  /** Chamfer 3/4 distance transform (two passes) of the mask interior,
   *  clamped and normalized by the relief width: the BUMP MAP in
   *  [0..1]. reliefTexels is the bump ramp width in texels. */
  function heightField(mask, w, h, reliefTexels) {
    var INF = 1 << 28;
    var dt = new Int32Array(w * h);
    var i, x, y;
    for (i = 0; i < w * h; i++) dt[i] = mask[i] ? INF : 0;
    // forward pass
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (dt[i] === 0) continue;
        var d = dt[i];
        if (x > 0 && dt[i - 1] + 3 < d) d = dt[i - 1] + 3;
        if (y > 0) {
          if (dt[i - w] + 3 < d) d = dt[i - w] + 3;
          if (x > 0 && dt[i - w - 1] + 4 < d) d = dt[i - w - 1] + 4;
          if (x < w - 1 && dt[i - w + 1] + 4 < d) d = dt[i - w + 1] + 4;
        }
        // boundary of the grid counts as outside (edge of the buffer)
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) d = Math.min(d, 3);
        dt[i] = d;
      }
    }
    // backward pass
    for (y = h - 1; y >= 0; y--) {
      for (x = w - 1; x >= 0; x--) {
        i = y * w + x;
        if (dt[i] === 0) continue;
        var d2 = dt[i];
        if (x < w - 1 && dt[i + 1] + 3 < d2) d2 = dt[i + 1] + 3;
        if (y < h - 1) {
          if (dt[i + w] + 3 < d2) d2 = dt[i + w] + 3;
          if (x < w - 1 && dt[i + w + 1] + 4 < d2) d2 = dt[i + w + 1] + 4;
          if (x > 0 && dt[i + w - 1] + 4 < d2) d2 = dt[i + w - 1] + 4;
        }
        dt[i] = d2;
      }
    }
    var height = new Float32Array(w * h);
    var cap = Math.max(1, reliefTexels) * 3; // chamfer orthogonal weight
    for (i = 0; i < w * h; i++) {
      height[i] = Math.min(dt[i], cap) / cap;
    }
    return height;
  }

  /** Separable Gaussian blur, taps = 2·ceil(sigma)+1 per axis — the
   *  same tap count VB.materialProfile charges for. */
  function gaussianBlur(src, w, h, sigma) {
    if (sigma <= 0) return src;
    var half = Math.ceil(sigma);
    var kernel = new Float32Array(2 * half + 1);
    var sum = 0;
    for (var k = -half; k <= half; k++) {
      var v = Math.exp(-(k * k) / (2 * sigma * sigma));
      kernel[k + half] = v; sum += v;
    }
    for (var n = 0; n < kernel.length; n++) kernel[n] /= sum;
    var tmp = new Float32Array(w * h);
    var out = new Float32Array(w * h);
    var x, y, a, kk;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        a = 0;
        for (kk = -half; kk <= half; kk++) {
          var xx = Math.min(w - 1, Math.max(0, x + kk));
          a += src[y * w + xx] * kernel[kk + half];
        }
        tmp[y * w + x] = a;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        a = 0;
        for (kk = -half; kk <= half; kk++) {
          var yy = Math.min(h - 1, Math.max(0, y + kk));
          a += tmp[yy * w + x] * kernel[kk + half];
        }
        out[y * w + x] = a;
      }
    }
    return out;
  }

  /** Sobel-derived NORMAL MAP in image space (x right, y down),
   *  Float32Array of [nx,ny,nz] triples, unit length. */
  function normalMap(height, w, h, amp) {
    var normals = new Float32Array(w * h * 3);
    function H(x, y) {
      if (x < 0) x = 0; if (x >= w) x = w - 1;
      if (y < 0) y = 0; if (y >= h) y = h - 1;
      return height[y * w + x];
    }
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1) -
                  H(x - 1, y - 1) - 2 * H(x - 1, y) - H(x - 1, y + 1)) / 8;
        var dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1) -
                  H(x - 1, y - 1) - 2 * H(x, y - 1) - H(x + 1, y - 1)) / 8;
        var nx = -dx * amp, ny = -dy * amp, nz = 1;
        var len = Math.sqrt(nx * nx + ny * ny + 1);
        var o = (y * w + x) * 3;
        normals[o] = nx / len; normals[o + 1] = ny / len; normals[o + 2] = nz / len;
      }
    }
    return normals;
  }

  function sampleBilinear(tex, u, v) {
    var x = Math.min(tex.w - 1.001, Math.max(0, u * tex.w - 0.5));
    var y = Math.min(tex.h - 1.001, Math.max(0, v * tex.h - 0.5));
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    var out = [0, 0, 0];
    for (var c = 0; c < 3; c++) {
      var a = tex.data[(y0 * tex.w + x0) * 4 + c];
      var b = tex.data[(y0 * tex.w + x0 + 1) * 4 + c];
      var d = tex.data[((y0 + 1) * tex.w + x0) * 4 + c];
      var e = tex.data[((y0 + 1) * tex.w + x0 + 1) * 4 + c];
      out[c] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) +
               d * (1 - fx) * fy + e * fx * fy;
    }
    return out;
  }

  // ---- the whole pipeline -----------------------------------------------------

  /** All intermediate buffers for a matcap-painted fill:
   *  {w, h, bbox, mask, height (bump map), normals}. Pure and
   *  deterministic — the debug views and the compositor both read
   *  from here. */
  function matcapBuffers(doc, fillIdx, style, maxSide) {
    var bb = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
    var any = false;
    for (var i = 0; i < doc.edges.length; i++) {
      var e = doc.edges[i];
      if (e.fill0 !== fillIdx && e.fill1 !== fillIdx) continue;
      any = true;
      if (Math.min(e.ax, e.bx) < bb.xmin) bb.xmin = Math.min(e.ax, e.bx);
      if (Math.max(e.ax, e.bx) > bb.xmax) bb.xmax = Math.max(e.ax, e.bx);
      if (Math.min(e.ay, e.by) < bb.ymin) bb.ymin = Math.min(e.ay, e.by);
      if (Math.max(e.ay, e.by) > bb.ymax) bb.ymax = Math.max(e.ay, e.by);
      if (e.cx !== null) {
        bb.xmin = Math.min(bb.xmin, e.cx); bb.xmax = Math.max(bb.xmax, e.cx);
        bb.ymin = Math.min(bb.ymin, e.cy); bb.ymax = Math.max(bb.ymax, e.cy);
      }
    }
    if (!any) return null;
    var res = style.resolution || 1;
    var wpx = Math.max(1, (bb.xmax - bb.xmin) / VB.TWIPS);
    var hpx = Math.max(1, (bb.ymax - bb.ymin) / VB.TWIPS);
    var cap = maxSide || MAX_SIDE;
    var scale = Math.min(res, cap / Math.max(wpx, hpx));
    var w = Math.max(2, Math.round(wpx * scale));
    var h = Math.max(2, Math.round(hpx * scale));
    var mask = coverageMask(doc, fillIdx, bb, w, h);
    var reliefTexels = Math.max(1, (style.bumpScale || 60) / VB.TWIPS * scale);
    var height = heightField(mask, w, h, reliefTexels);
    var blurred = gaussianBlur(height, w, h, (style.blurPx || 0) * scale);
    var normals = normalMap(blurred, w, h, 2.0);
    return { w: w, h: h, bbox: bb, scale: scale, mask: mask,
             height: blurred, rawHeight: height, normals: normals };
  }

  /** Composite the matcap-shaded region into RGBA pixels (masked). */
  function matcapPixels(buffers, tex) {
    var w = buffers.w, h = buffers.h;
    var out = new Uint8ClampedArray(w * h * 4);
    for (var i = 0; i < w * h; i++) {
      if (!buffers.mask[i]) continue;
      var o3 = i * 3;
      var u = 0.5 + buffers.normals[o3] * 0.5;
      var v = 0.5 + buffers.normals[o3 + 1] * 0.5;
      var c = sampleBilinear(tex, u, v);
      var o4 = i * 4;
      out[o4] = c[0]; out[o4 + 1] = c[1]; out[o4 + 2] = c[2]; out[o4 + 3] = 255;
    }
    return out;
  }

  // ---- debug views ------------------------------------------------------------

  /** A canvas visualizing one pipeline buffer: "bump" (height field,
   *  grayscale), "normal" (RGB-encoded normal map) or "result"
   *  (matcap-shaded). Masked texels render transparent. */
  function matcapDebugCanvas(buffers, which, style) {
    var w = buffers.w, h = buffers.h;
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var id = cv.getContext("2d").createImageData(w, h);
    var i, o;
    if (which === "result") {
      var tex = matcapTexture(style || {}) || builtinMatcap("studio");
      id.data.set(matcapPixels(buffers, tex));
    } else if (which === "normal") {
      for (i = 0; i < w * h; i++) {
        if (!buffers.mask[i]) continue;
        o = i * 3;
        id.data[i * 4] = Math.round((buffers.normals[o] * 0.5 + 0.5) * 255);
        id.data[i * 4 + 1] = Math.round((buffers.normals[o + 1] * 0.5 + 0.5) * 255);
        id.data[i * 4 + 2] = Math.round((buffers.normals[o + 2] * 0.5 + 0.5) * 255);
        id.data[i * 4 + 3] = 255;
      }
    } else { // "bump"
      for (i = 0; i < w * h; i++) {
        if (!buffers.mask[i]) continue;
        var v = Math.round(buffers.height[i] * 255);
        id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v;
        id.data[i * 4 + 3] = 255;
      }
    }
    cv.getContext("2d").putImageData(id, 0, 0);
    return cv;
  }

  // ---- renderer integration ----------------------------------------------------
  // Per-fill result cache keyed by a content hash of (style, boundary
  // geometry): pan/zoom/overlay frames reuse the composite; it only
  // recomputes when the region or the material actually changes.

  var paintCache = new Map(); // fillIdx -> { key, canvas, bbox }

  function styleGeoKey(doc, fillIdx, style) {
    var hsh = 17;
    function mix(v) { hsh = (hsh * 31 + v) | 0; }
    var s = JSON.stringify({ b: style.bumpScale, bl: style.blurPx,
                             r: style.resolution,
                             m: typeof style.matcap === "string"
                               ? style.matcap
                               : (style.matcap && style.matcap.b64
                                  ? style.matcap.b64.length : 0) });
    for (var c = 0; c < s.length; c++) mix(s.charCodeAt(c));
    for (var i = 0; i < doc.edges.length; i++) {
      var e = doc.edges[i];
      if (e.fill0 !== fillIdx && e.fill1 !== fillIdx) continue;
      mix(e.ax); mix(e.ay); mix(e.bx); mix(e.by);
      if (e.cx !== null) { mix(e.cx); mix(e.cy); }
      mix(e.fill0); mix(e.fill1);
    }
    return hsh;
  }

  /** Paint a matcap fill into the document render. Returns false when
   *  the caller should fall back to the base color (texture still
   *  decoding). ctx is in TWIPS space; chains clip the exact region. */
  function matcapPaint(ctx, doc, fillIdx, style, chains, tracePath) {
    var tex = matcapTexture(style);
    if (!tex) return false; // embedded image still decoding
    if (!VB.assets && paintCache.size > 64) paintCache.clear(); // legacy backstop
    var key = styleGeoKey(doc, fillIdx, style);
    var hit = paintCache.get(fillIdx);
    if (!hit || hit.key !== key) {
      var buffers = matcapBuffers(doc, fillIdx, style);
      if (!buffers) return false;
      var cv = document.createElement("canvas");
      cv.width = buffers.w; cv.height = buffers.h;
      var id = cv.getContext("2d").createImageData(buffers.w, buffers.h);
      id.data.set(matcapPixels(buffers, tex));
      cv.getContext("2d").putImageData(id, 0, 0);
      hit = { key: key, canvas: cv, bbox: buffers.bbox };
      paintCache.set(fillIdx, hit);
      // paints are AssetCache tenants (streaming.js): eviction drops the
      // composite and the next paint recomputes it — never wrong pixels,
      // only spent milliseconds
      if (VB.assets) {
        VB.assets.claim("matcap:" + fillIdx, buffers.w * buffers.h * 4,
          function () { paintCache.delete(fillIdx); });
      }
    } else if (VB.assets) {
      VB.assets.touch("matcap:" + fillIdx);
    }
    ctx.save();
    ctx.beginPath();
    for (var c = 0; c < chains.length; c++) tracePath(ctx, chains[c], true);
    ctx.clip("evenodd");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(hit.canvas, hit.bbox.xmin, hit.bbox.ymin,
                  hit.bbox.xmax - hit.bbox.xmin,
                  hit.bbox.ymax - hit.bbox.ymin);
    ctx.restore();
    return true;
  }

  window.VB = window.VB || {};
  VB.matcapBuiltins = BUILTINS;
  VB.builtinMatcap = builtinMatcap;
  VB.matcapTexture = matcapTexture;
  VB.matcapBuffers = matcapBuffers;
  VB.matcapPixels = matcapPixels;
  VB.matcapDebugCanvas = matcapDebugCanvas;
  VB.matcapPaint = matcapPaint;
  VB.matcapHeightField = heightField;   // exposed for tests
  VB.matcapNormalMap = normalMap;       // exposed for tests
  VB.matcapGaussianBlur = gaussianBlur; // exposed for tests
})();
