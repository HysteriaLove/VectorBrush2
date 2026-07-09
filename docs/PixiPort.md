# Pixi Port - rendering and drawing acceleration plan

This document is the first pass for moving VectorBrush UI/drawing work
from direct Canvas2D calls toward PixiJS. The goal is speed, but the
constraint is stronger: the existing Canvas2D renderer remains the visual
oracle until the Pixi backend proves parity against SWF/VBD fixtures,
materials, text, and debug overlays.

## Current State

The program is still architecturally friendly to a Pixi port:

- `app/js/main.js` owns one `#stage-canvas`, requestAnimationFrame
  scheduling, pointer routing, zoom/pan, and tool dispatch.
- Main document paint goes through `VB.renderProject(ctx, app.project,
  app.view)` in `app/js/render.js`.
- Tool previews call `tool.drawOverlay(ctx)`.
- Debug view calls `VB.renderDebug(ctx, app.doc, app.view, hover)`.
- The document model is not a scene graph. It is one Flash-style planar
  map per layer/frame: edges with `fill0`, `fill1`, and `line` claims.
- Materials are global within that layer/frame cell. The active cell's
  `doc.fills[]` table is what the Materials panel edits; all regions in
  that layer that reference the same fill index share the material.
  Other layers have their own cells and style tables.
- Exact geometry work is independent from rendering: brush, eraser,
  bucket, arrow, transform, lasso, text, SWF/VBD import/export, and
  journal replay all mutate the planar map first, then render it.

That separation is good. Pixi should become a rendering backend, not a
replacement document model.

## What Pixi Can Speed Up First

### Fast wins

- Pan/zoom should become cheap if the document graphics are cached in a
  Pixi container and only the root transform changes.
- Static document redraws can avoid rebuilding Canvas2D paths every frame.
- Tool overlays like pencil trails, brush previews, eraser previews,
  selection boxes, transform handles, and debug wires can become cached
  `Graphics` objects or small containers.
- Matcap CPU results can be uploaded once as textures and drawn as sprites.
- Debug rendering above thousands of edges can use Pixi's GPU path/stroke
  rasterization instead of redrawing all decorations with Canvas2D.

### Things Pixi will not automatically speed up

- Brush commit cost. The slow part is mostly vector geometry:
  `buildSwath`, paper.js capsule union, curve fitting, `nodeEdges`, and
  `applyRegionMask`. Pixi can make the live preview fast, but final
  vector commit still needs algorithmic or worker changes.
- Eraser commit cost for the same reason.
- Face walks, hit tests, fill lookup, planarity repair, SWF/VBD encoding,
  and journal replay.
- Exact SWF-style even-odd fill parity unless we prove Pixi's path
  triangulation matches our fixtures.

## Pixi Version and API Notes

Latest checked package: `pixi.js@8.19.0`.

Useful official docs:

- Application setup is async in Pixi v8:
  https://pixijs.com/8.x/guides/components/application
- `Application.init()` accepts `canvas`, `resizeTo`, `resolution`,
  `autoDensity`, renderer preference, and related renderer options:
  https://pixijs.com/8.x/guides/components/application
- `Graphics` supports lines, rectangles, circles, ellipses, arcs,
  Bezier/quadratic curves, fills, masks, textures, gradients, and
  reusable `GraphicsContext` objects:
  https://pixijs.com/8.x/guides/components/scene-objects/graphics
- Pixi's docs warn that complex SVG/hole geometries may render
  inaccurately because of performance-oriented triangulation:
  https://pixijs.com/8.x/guides/components/scene-objects/graphics
- `pixelLine` gives true 1-pixel strokes, useful for debug overlays and
  hairline guides, but it is only 1 pixel wide:
  https://pixijs.com/8.x/guides/components/scene-objects/graphics/graphics-pixel-line
- `FillGradient` exists for linear/radial gradients, but SWF gradient
  matrix parity still needs a dedicated test pass:
  https://pixijs.com/8.x/guides/components/scene-objects/graphics/graphics-fill

## Proposed Architecture

### Keep Canvas2D as the oracle

Do not remove `render.js`. Instead add a sibling backend:

```text
app/js/render.js        Canvas2D oracle backend
app/js/pixi-render.js   Pixi experimental backend
```

The Pixi backend should expose a small API:

```js
VB.createPixiSurface = async function (host, overlayCanvas, options) {};
VB.renderProjectPixi = function (surface, project, view, options) {};
VB.renderDebugPixi = function (surface, doc, view, hoverIdx) {};
VB.renderOverlayPixi = function (surface, tool, view) {};
```

Initial integration should be behind a flag:

```text
index.html?pixi
index.html#pixi
localStorage.vbRenderer = "pixi"
```

Default stays Canvas2D until fixtures pass.

### Use two canvases during the migration

Use a Pixi canvas for the document layer and keep the existing
`#stage-canvas` as a transparent pointer/overlay canvas.

```text
#canvaswrap
  pixi canvas          document layer, pointer-events:none
  #stage-canvas        existing Canvas2D overlay and pointer target
  #ctxmenu
  #toast
```

This avoids the WebGL/Canvas2D context conflict on a single canvas and
lets us port one rendering layer at a time. In Pixi mode:

- Pixi draws the work area, stage, layers, fills, strokes, text, and
  eventually debug content.
- The existing canvas is cleared each frame and still draws any overlay
  that has not been ported yet.
- Pointer routing remains unchanged because events still land on
  `#stage-canvas`.

### Coordinate model

Keep document geometry in twips.

Pixi world container transform:

```js
world.scale.set(view.zoom / VB.TWIPS);
world.position.set(view.panX, view.panY);
```

Pixi application resolution:

```js
await pixi.init({
  resizeTo: canvaswrap,
  resolution: window.devicePixelRatio || 1,
  autoDensity: true,
  backgroundAlpha: 0,
  antialias: true
});
```

The overlay canvas keeps the current DPR sizing logic.

## Backend Layers

The Pixi surface should be split into stable containers:

```text
root
  backdropLayer        screen-space work-area fill
  world
    stageLayer         stage background
    documentLayer      cached layer/frame graphics
    textLayer          glyph outline graphics
    materialLayer      matcap sprites / generated textures
  overlayLayer         Pixi-native tool overlays
  debugLayer           Pixi-native debug wires/decorations
```

Pan and zoom only change `world`. Document geometry should not be rebuilt
for pan/zoom.

## Document Rendering Plan

### Stage 1: Pixi surface shell

Add the Pixi app, canvas stacking, resize handling, and a flag to switch
between Canvas2D and Pixi document rendering. Render only:

- work-area backdrop
- stage background rectangle
- no document content yet
- existing Canvas2D overlay/debug still active

This validates app initialization, resizing, DPR, pointer routing, and
fallback behavior without touching vector drawing.

### Stage 2: Solid fills and strokes

Port the core `render.js` loop:

- Call `VB.buildFillPaths(doc)` and `VB.buildStrokePaths(doc)`.
- Trace chains into `PIXI.Graphics` with `moveTo`, `lineTo`,
  `quadraticCurveTo`, and `closePath`.
- Fill solid materials with `Graphics.fill({ color, alpha })`.
- Stroke line styles with `Graphics.stroke({ color, alpha, width,
  cap:"round", join:"round" })`.
- Preserve paint order: all fills first, all strokes second, text above.
- Preserve layer order: active scene layers bottom to top.

Hairline policy:

```js
var localHairline = VB.TWIPS / (view.zoom * view.dpr);
var widthTwips = Math.max(style.width, localHairline);
```

For debug-only 1-pixel wires, prefer Pixi `pixelLine:true` where it
matches the desired width.

### Stage 3: Cache by document/layer/style

The first real speedup comes from caching, not just from replacing the
canvas API.

Cache:

- fill path graphics per document cell and fill index
- stroke path graphics per document cell and line index
- text graphics per text block
- matcap texture sprites per `(style, geometry hash, resolution)`
- debug graphics per document edge version

Invalidation sources:

- `docChanged()` clears or bumps the active cell render version.
- layer visibility changes only toggle containers.
- pan/zoom only updates `world` transform.
- material edit invalidates only affected fill graphics in the active
  layer/cell, because the material table is layer-local.
- text edit invalidates only affected text block graphics.

Do not cache Pixi material assets as project-global by fill index alone.
The key must include the cell/layer identity plus fill index or a stable
style hash:

```text
sceneIndex/layerIndex/frameIndex/fillIndex/styleHash
```

A fill index of `1` in Layer 1 and fill index `1` in Layer 2 are unrelated
unless their material definitions are deliberately deduped by a higher
level cache.

This should make wheel zoom and pan dramatically cheaper because the
renderer does not rebuild all paths every frame.

### Stage 4: Gradients

SWF gradients are not ordinary object-bbox gradients. Current Canvas2D
rendering maps paths through the inverse SWF gradient matrix and paints in
the canonical `+/-16384tw` gradient square.

Pixi options:

1. Approximate with `FillGradient`.
2. Generate a small gradient texture and fill with a matrix.
3. Use a custom shader/fill pipeline.

Recommendation:

- Start with solid/base-color fallback in experimental mode.
- Add visual tests for linear and radial gradients from `test.html`.
- Only enable Pixi gradients by default when SWF matrix parity is close.

### Stage 5: Matcap materials

Current `matcap.js` is a deterministic CPU oracle.

First Pixi step:

- Reuse `VB.matcapBuffers()` and `VB.matcapPixels()`.
- Upload the resulting canvas/ImageData as a Pixi texture.
- Draw it as a sprite at the fill bbox.
- Let alpha in `matcapPixels()` provide masking.

Later Pixi/WebGPU step:

- Move coverage, height, blur, normal, and matcap sample into GPU passes.
- Keep CPU output as the test oracle.
- Compare buffer outputs or rendered pixels in debug mode.

### Stage 6: Text

Text is stored as embedded glyph outlines, not browser fonts.

Pixi should render these as vector graphics first:

- Transform glyph contours by text matrix.
- Trace contours with `moveTo`, `lineTo`, `quadraticCurveTo`.
- Fill with the text record color.

Do not switch to Pixi `Text` for document text because that would break
the embedded-font determinism model.

## Tool Overlay Porting

Port overlays separately from document rendering. They are lower risk and
give immediate interaction wins.

Priority order:

1. Brush live preview: thick polyline plus dab circle.
2. Eraser live preview: thick white polyline plus cursor circle.
3. Pencil raw trail.
4. Shape previews: line, rect, oval.
5. Lasso polygon.
6. Arrow selections, floating fill/stroke preview, hatches.
7. Free Transform handles, pending selection preview.
8. Text edit handles and flow box.
9. Debug overlay.

Keep each tool API compatible during the migration:

```js
tool.drawOverlay(ctx);       // old Canvas2D path
tool.drawPixiOverlay(layer); // new Pixi path
```

If `drawPixiOverlay` is absent, the overlay canvas draws the old path.

## Brush Performance Plan

Pixi will improve brush preview and redraw, but brush commit is still
vector geometry work.

Immediate changes:

- Draw live brush preview in Pixi while dragging.
- Do not rebuild document graphics while dragging unless the document
  actually changes.
- On pointerup, show a committing state if the vector brush operation is
  slow.
- After commit, invalidate only affected document containers.

Next changes outside Pixi:

- Move paper.js capsule union and mask reconciliation to a Web Worker.
- Add a coarse candidate edge index for `nodeEdges` and `applyRegionMask`.
- Use `OperationEstimator` to warn before huge brush commits.
- Cache the swept outline during drag so pointerup does less work.
- Consider a raster preview layer for large brush strokes, committed to
  exact vector geometry after release.

## Debug and Testing

### Visual parity tests

Add a test page that renders the same document through Canvas2D and Pixi,
then compares pixels:

```text
app/test/pixi-parity.html
```

Test fixtures:

- simple solid rectangle
- stroked line and hairline at multiple zooms
- oval with fill and stroke
- fill with hole/island
- brush blob from SWFExamples
- bucket-filled region
- text outline block
- linear gradient
- radial gradient
- matcap fill
- debug overlay at several zoom levels

Use Canvas2D as the expected image. Early tests can allow a small pixel
tolerance for antialiasing, but topology errors should fail hard:

- holes filled incorrectly
- missing interior strokes
- wrong fill order
- wrong layer order
- text missing
- matcap bbox/mask mismatch

### Performance instrumentation

Extend `OperationEstimator` with synthetic render phases:

```js
{ op: "renderFrame", backend: "canvas2d" }
{ op: "renderFrame", backend: "pixi" }
{ op: "overlayFrame", backend: "pixi", tool: "brush" }
```

Keep estimator values deterministic. Wall-clock timing can be a separate
debug-only profiler, but should not feed replay or tests.

## Known Risks

- Pixi `Graphics` triangulation may not match Canvas2D even-odd behavior
  for complex holes or self-intersections.
- Gradients need SWF matrix parity, not just object-bbox gradients.
- Rebuilding Pixi graphics every frame can be as slow as Canvas2D. Caching
  is required for meaningful speedups.
- Matcap CPU buffers are still CPU-heavy until the GPU pipeline exists.
- A single-canvas migration would break because WebGL/Pixi and Canvas2D
  cannot safely share the same canvas context.
- Tool commits remain slow until geometry algorithms or worker scheduling
  change.

## First Implementation Slice

When we are ready to change code, do this first:

1. Vendor `pixi.js@8.19.0` into `app/lib/pixi.min.js`.
2. Load it before `main.js` in `index.html`.
3. Add `app/js/pixi-render.js`.
4. Add `?pixi`/`#pixi` backend flag.
5. Insert a Pixi canvas beneath `#stage-canvas` in `#canvaswrap`.
6. Render only backdrop and stage background with Pixi.
7. Keep all document content and overlays on Canvas2D.
8. Verify resize, DPR, pan/zoom math, pointer routing, and fallback.
9. Then port solid fills/strokes.

That slice gives a safe foundation without changing document semantics.

## Decision

Begin with Pixi as an optional, side-by-side backend. Do not replace the
Canvas2D renderer yet. The fastest path to useful performance is:

1. Pixi surface and cached document containers.
2. Pixi tool overlays, especially brush/eraser previews.
3. Solid fill/stroke document rendering.
4. Matcap texture upload.
5. Debug overlay.
6. Gradients and exact parity work.
7. Worker/indexing work for brush and eraser commits.
