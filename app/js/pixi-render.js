/* pixi-render.js — the experimental Pixi backend (docs/PixiPort.md).
 *
 * STAGE 1 (surface shell): a Pixi canvas stacked UNDER the existing
 * #stage-canvas draws the work-area backdrop and the stage background;
 * every document element, tool overlay and debug decoration still
 * renders on the Canvas2D overlay above (in transparent mode). This
 * validates init, canvas stacking, resize/DPR, pan/zoom math, pointer
 * routing and fallback without touching vector drawing.
 *
 * Canvas2D (render.js) remains the visual ORACLE: the Pixi backend is
 * opt-in (?pixi / #pixi / localStorage.vbRenderer = "pixi") and every
 * later stage must prove pixel parity against it before defaulting.
 *
 * Container tree (stable across stages, per the plan):
 *   root
 *     backdropLayer      screen-space work-area fill
 *     world              twips → screen (zoom/pan transform ONLY)
 *       stageLayer       stage background
 *       documentLayer    (stage 2+) cached layer/frame graphics
 *       textLayer        (stage 6) glyph outline graphics
 *       materialLayer    (stage 5) matcap sprites
 *     overlayLayer       (overlay port) Pixi-native tool overlays
 *     debugLayer         (debug port) wires/decorations
 */
(function () {
  "use strict";

  /** Create the Pixi surface: canvas under overlayCanvas inside host.
   *  Resolves null when Pixi or a GL context is unavailable — callers
   *  fall back to pure Canvas2D. No ticker: we render on demand from
   *  the app's own rAF (idle editor = zero GPU work). */
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
      textLayer: new PIXI.Container(),
      materialLayer: new PIXI.Container(),
      overlayLayer: new PIXI.Container(),
      debugLayer: new PIXI.Container(),
      _backdrop: new PIXI.Graphics()
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

    surface.resize = function () {
      app.resize();
    };
    surface.destroy = function () {
      try {
        app.destroy(true, { children: true, texture: true });
      } catch (e) { /* already gone */ }
      if (cv.parentElement) cv.parentElement.removeChild(cv);
    };
    return surface;
  }

  function rgbToHex(c) {
    return ((c.r & 255) << 16) | ((c.g & 255) << 8) | (c.b & 255);
  }

  /** Stage-1 frame: backdrop (screen space) + stage rect (world
   *  space). Pan/zoom only touch the world transform — the contract
   *  every later caching stage builds on. */
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
    // soft shadow stand-in: an offset dark rect under the stage
    surface.stageLayer
      .rect(120, 160, project.width, project.height)
      .fill({ color: 0x000000, alpha: 0.25 });
    surface.stageLayer
      .rect(0, 0, project.width, project.height)
      .fill(rgbToHex(bg));

    surface.app.render();
  }

  // Later stages fill these in (kept exported now so main.js wiring is
  // stable): tool overlays and debug decorations stay on Canvas2D.
  function renderOverlayPixi(surface, tool, view) { /* stage: overlays */ }
  function renderDebugPixi(surface, doc, view, hoverIdx) { /* stage: debug */ }

  window.VB = window.VB || {};
  VB.createPixiSurface = createPixiSurface;
  VB.renderProjectPixi = renderProjectPixi;
  VB.renderOverlayPixi = renderOverlayPixi;
  VB.renderDebugPixi = renderDebugPixi;
})();
