/* materials.js — the 2DMaterial model and its deterministic profiler.
 *
 * A 2DMaterial IS a fill-style table entry (doc.fills[i]) — the same
 * slot SWF fills live in, extended beyond SWF's native types:
 *   { type:"solid",  color }                                (SWF-native)
 *   { type:"linear", matrix, gradient:{spread,interpolation,
 *                    stops:[{ratio 0..255, color}]} }       (SWF-native)
 *   { type:"radial", matrix, gradient, focal? }             (SWF-native)
 *   { type:"matcap", color, bumpScale, blurPx, resolution } (vbd-only,
 *                    WebGPU class; renders its base color without GPU)
 *
 * The PROFILE of a material is an analytic function of its definition —
 * never a wall-clock measurement — so identical params give identical
 * numbers on every machine: artists see exactly how heavy a material is
 * before it ever renders. Costs are in per-pixel ops (solid = 1),
 * passes, and working-texture bytes per megapixel of painted bbox.
 * Formulas are documented in docs/2DMaterials.md and pinned by tests.
 */
(function () {
  "use strict";

  // The canonical SWF gradient square: ±16384tw mapped by the style
  // matrix. Gradients are defined across it; renderers map through it.
  var GRAD_HALF = 16384;

  var TYPES = {
    solid: {
      swfNative: true,
      defaults: function () {
        return { type: "solid", color: { r: 102, g: 204, b: 255, a: 255 } };
      },
      profile: function () {
        return mkProfile("flat", false, [{ name: "direct fill", perPx: 1 }], 0);
      }
    },
    linear: {
      swfNative: true,
      defaults: function () {
        return {
          type: "linear",
          matrix: { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 },
          gradient: { spread: 0, interpolation: 0, stops: [
            { ratio: 0, color: { r: 255, g: 255, b: 255, a: 255 } },
            { ratio: 255, color: { r: 102, g: 204, b: 255, a: 255 } }
          ] }
        };
      },
      profile: function () {
        return mkProfile("gradient", false,
          [{ name: "affine transform", perPx: 2 },
           { name: "stop lerp", perPx: 1 }], 0);
      }
    },
    radial: {
      swfNative: true,
      defaults: function () {
        var d = TYPES.linear.defaults();
        d.type = "radial";
        return d;
      },
      profile: function () {
        return mkProfile("gradient", false,
          [{ name: "affine transform", perPx: 2 },
           { name: "radius (mul+sqrt)", perPx: 2 },
           { name: "stop lerp", perPx: 1 }], 0);
      }
    },
    matcap: {
      swfNative: false,
      defaults: function () {
        return { type: "matcap",
                 color: { r: 160, g: 168, b: 180, a: 255 }, // no-GPU fallback
                 matcap: "studio", // builtin texture id or {b64: png}
                 bumpScale: 60,    // twips of simulated relief
                 blurPx: 3,        // height-field smoothing sigma, px
                 resolution: 1 };  // working-buffer scale (0.5 / 1 / 2)
      },
      profile: function (style) {
        var s = style.resolution || 1;
        var taps = 2 * Math.ceil((style.blurPx || 0) * s) + 1;
        var passes = [
          { name: "height rasterize", perPx: 1 },
          { name: "blur H+V (" + taps + " taps/axis)", perPx: 2 * taps },
          { name: "normal derive (Sobel)", perPx: 10 },
          { name: "matcap sample", perPx: 3 }
        ];
        // height + blur + normal working buffers, 4 bytes each, at
        // resolution² texels per bbox pixel
        var texBytesPerMpx = Math.round(3 * 4 * s * s * 1e6);
        return mkProfile("gpu", true, passes, texBytesPerMpx);
      }
    }
  };

  function mkProfile(cls, gpu, passes, texBytesPerMpx) {
    var perPx = 0;
    for (var i = 0; i < passes.length; i++) perPx += passes[i].perPx;
    var score = perPx; // solid's perPx is 1 by construction
    var label = score + "× " + cls +
      (texBytesPerMpx ? " · " + Math.round(texBytesPerMpx / 1e6 * 10) / 10 + "MB/Mpx" : "");
    return { class: cls, gpu: gpu, passes: passes, perPx: perPx,
             score: score, texBytesPerMpx: texBytesPerMpx, label: label };
  }

  /** Deterministic cost profile of a fill style / 2DMaterial. Unknown
   *  or legacy types (bitmap) profile as flat. */
  function materialProfile(style) {
    var t = TYPES[style && style.type];
    if (!t) return mkProfile("flat", false, [{ name: "direct fill", perPx: 1 }], 0);
    return t.profile(style);
  }

  /** A fresh style of the given type with sensible defaults. */
  function materialDefaults(type) {
    if (!TYPES[type]) throw new Error("unknown material type: " + type);
    return TYPES[type].defaults();
  }

  /** Normalized deep copy of a style (journal ops carry these; replay
   *  must not share references with the live panel). */
  function materialClone(style) {
    return JSON.parse(JSON.stringify(style));
  }

  function materialTypes() { return Object.keys(TYPES); }

  function gpuMaterialsAvailable() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
  }

  /** The material's representative color — the SWF-export bake color
   *  and the no-GPU fallback: solid/matcap base color, gradients their
   *  first stop. */
  function materialBaseColor(style) {
    if (style.color) return style.color;
    if (style.gradient && style.gradient.stops.length) {
      return style.gradient.stops[0].color;
    }
    return { r: 128, g: 128, b: 128, a: 255 };
  }

  window.VB = window.VB || {};
  VB.materialProfile = materialProfile;
  VB.materialDefaults = materialDefaults;
  VB.materialClone = materialClone;
  VB.materialTypes = materialTypes;
  VB.materialBaseColor = materialBaseColor;
  VB.gpuMaterialsAvailable = gpuMaterialsAvailable;
  VB.GRAD_HALF = GRAD_HALF;
})();
