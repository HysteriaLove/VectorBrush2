# OperationEstimator - deterministic debug framework

`OperationEstimator` is the proposed debug model for answering:

- "How expensive will this edit be before we commit it?"
- "Which stage made this operation heavy?"
- "Did the operation touch more geometry, pixels, memory, or tool logic
  than expected?"
- "Can a replayed journal show the same cost profile on every machine?"

It extends the same rule used by `docs/2DMaterials.md`: estimates are
analytic and deterministic. They are not wall-clock timings. No
`performance.now()`, no GPU timer queries, no device-specific speed
numbers. The estimator describes work implied by the document, operation
params, material params, and viewport.

## Material and Layer Scope

The estimator's `doc` is the active layer/frame cell unless a synthetic
operation explicitly says otherwise. Materials are global within that
cell: `doc.fills[i]` is one layer-local fill-style entry, and every edge
side whose fill index is `i + 1` paints with that same material. Editing a
material changes all regions in that active layer/cell that reference the
style index. It does not automatically change other layers, scenes, or
future frames, because those own their own `VBDocument` style tables.

For project-wide synthetic estimates, aggregate per cell:

```js
project.eachCell(function (cell, sceneIndex, layerIndex) {
  VB.operationEstimate({ doc: cell, project: project }, op, options);
});
```

The profile should keep layer/cell identity in `scope` when an estimate is
aggregated, so a hot material or render cost can be traced back to the
specific layer that owns it.

## Goals

- Give every journal/tool op a cheap preflight estimate.
- Explain cost by stage, not just as one total number.
- Share vocabulary between 2D vector editing, future 3D/GPU paths, brush
  strokes, eraser strokes, bucket fill, shape tools, text, render, save,
  load, and debug views.
- Catch suspicious operations during replay, before they become visual
  mysteries.
- Keep formula outputs stable enough to pin in tests.

## Non-goals

- Do not predict exact milliseconds.
- Do not vary by CPU, GPU, browser, driver, OS, or current machine load.
- Do not mutate the document while estimating.
- Do not make the journal non-deterministic. Debug estimates can be
  exported beside a journal, but live replay must not depend on them.

## Core idea

Every operation produces an `OperationProfile`:

```js
{
  kind: "brush",
  label: "brush stroke",
  version: 1,
  deterministic: true,
  confidence: "preflight", // preflight | postcommit | exact

  scope: {
    edgesBefore: 1204,
    candidateEdges: 318,
    fills: 12,
    lines: 7,
    bboxTw: { xmin: 120, ymin: 180, xmax: 8200, ymax: 4200 },
    bboxMpx: 0.42
  },

  totals: {
    score: 238000,
    cpuUnits: 151000,
    paintPxOps: 87000,
    gpuPasses: 0,
    textureBytes: 0,
    recordBits: 1840,
    allocations: 3
  },

  stages: [
    {
      name: "capture samples",
      unit: "point",
      count: 84,
      weight: 1,
      score: 84
    },
    {
      name: "node boundary into planar map",
      unit: "pair-test",
      count: 19080,
      weight: 4,
      score: 76320,
      metrics: { boundaryEdges: 60, candidateEdges: 318 }
    }
  ],

  warnings: [
    { level: "warn", code: "large-candidate-set",
      text: "candidate edges cover 26% of the document" }
  ]
}
```

`score` is a debug score, not a time estimate. It is useful for sorting,
threshold badges, regression tests, and replay comparisons. Keep the
subtotals visible because a high paint cost and a high noding cost mean
very different bugs.

## Cost dimensions

The estimator keeps separate dimensions and only folds them into
`totals.score` for UI sorting.

| Dimension | Meaning | Typical source |
|-----------|---------|----------------|
| `cpuUnits` | Deterministic scalar work over geometry/data | noding, fitting, face walk, hit tests |
| `paintPxOps` | Per-pixel material work | `VB.materialProfile(style).perPx * paintedPixels` |
| `gpuPasses` | Offscreen/fullscreen/compute passes | matcap, future 3D previews |
| `textureBytes` | Working texture memory | material buffers, 3D targets |
| `recordBits` | Encoded vector stream cost | `VB.debugEdgeRecord`, `VB.vbdStats` |
| `allocations` | Large temporary structures, not object count | pre-op doc copy, face graph, masks |

Suggested score fold:

```js
score =
  cpuUnits +
  paintPxOps +
  gpuPasses * 5000 +
  Math.ceil(textureBytes / 1024) +
  recordBits +
  allocations * 1000
```

The weights are intentionally boring. They are knobs for warning badges,
not claims about hardware.

## Shared symbols

Use the same input symbols across all estimators:

| Symbol | Meaning |
|--------|---------|
| `P` | Pointer samples in the incoming op |
| `G` | Incoming or fitted geometry records |
| `E` | Document edge count before the op |
| `B` | Candidate existing edges whose bbox overlaps the op bbox |
| `X` | Estimated intersection or pair tests |
| `F` | Estimated faces touched by the op |
| `C` | Cycle half-edges stamped or inspected |
| `A` | Painted bbox area in megapixels |
| `M` | Material profile from `VB.materialProfile(style)` |
| `T` | Text glyphs or contours touched |
| `V` | 3D vertices |
| `I` | 3D indices/triangles |

## API sketch

The first implementation can live in `app/js/operation-estimator.js`:

```js
VB.operationEstimate = function operationEstimate(ctx, op, options) {
  // ctx: { doc, project, view? }
  // op: a journal op or synthetic render/save/debug op
  // options: { phase: "preflight" | "postcommit" }
};
```

Helper functions should be exposed for tests:

```js
VB.estimateOpBBox(op);
VB.estimateCandidateEdges(doc, bbox);
VB.estimateMaterialPaint(style, bbox, view);
VB.operationScore(profile);
```

The estimator should accept normal journal ops from `app/js/journal.js`
plus synthetic debug ops:

```js
{ op: "renderFrame" }
{ op: "saveVBD" }
{ op: "saveSWF" }
{ op: "debugOverlay" }
{ op: "materialPreview", style, bboxTw }
{ op: "meshPreview3D", mesh, material, targetPx }
```

## Preflight vs postcommit

Preflight estimates run before the mutation. They must be cheap and
side-effect free. They usually know:

- op params
- current document counts
- affected bbox
- candidate edge count
- material profile
- viewport area

Postcommit estimates can merge in exact return values from the operation:

- pencil: edges added
- bucket: stamped and dissolved counts
- brush: painted and boundary counts
- erase: removed and boundary counts
- shape: boundary records
- save: encoded bytes and record stats

Postcommit should keep the preflight profile and add a comparison block:

```js
comparison: {
  estimatedBoundary: 60,
  actualBoundary: 74,
  estimatedCandidates: 318,
  actualRemoved: 91,
  ratio: 1.23
}
```

Large ratios are often more useful than high raw scores because they point
to hidden geometry growth, bbox mistakes, broken candidate filtering, or
unexpected face graph complexity.

## 2D material integration

`docs/2DMaterials.md` already defines the canonical material profile:

```js
{
  class: "gradient",
  gpu: false,
  passes: [{ name: "affine transform", perPx: 2 }],
  perPx: 3,
  score: 3,
  texBytesPerMpx: 0,
  label: "3x gradient"
}
```

Operation estimates should not duplicate material formulas. They should
call `VB.materialProfile(style)` and multiply by area:

```js
paintPxOps = M.perPx * A * 1000000
textureBytes = M.texBytesPerMpx * A
gpuPasses += M.gpu ? M.passes.length : 0
```

Use bbox area for GPU-class materials because matcap buffers are allocated
over the painted region bbox. For flat/gradient Canvas2D fills, bbox area
is still a good preflight upper bound; postcommit may replace it with
path/fill-chain area if a cheap analytic area is available.

## 2D operation estimators

### Render Frame

Synthetic op: `{ op: "renderFrame" }`

Stages:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| build fill paths | `E` | 3 | `VB.buildFillPaths(doc)` shape traversal |
| build stroke paths | `E` | 2 | `VB.buildStrokePaths(doc)` traversal |
| paint fills | sum material pixel ops | 1 | by fill style and bbox |
| stroke lines | stroked edge count | 2 | includes hairline floor |
| draw text | `T` | 4 | glyph contours and text records |

Warnings:

- `many-render-edges`: `E > 4000`, matching the debug decoration cutoff.
- `large-gpu-material-bbox`: material texture bytes above threshold.
- `expensive-gradient-bounds`: gradient bbox covers most of the stage.

### Fill Style Edit

Journal op: `{ op: "fillStyle", index, style }`

This is a layer-local material edit. `index` addresses
`activeCell().fills[index]`; all fill references to `index + 1` in that
same cell repaint with the new material. Other layers keep their own
style tables and are unaffected.

Stages:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| clone style | 1 | 20 | journal safety copy |
| affected fill references | edge sides using `index + 1` | 1 | scan `E` |
| material profile | 1 | 1 | `VB.materialProfile(style)` |
| repaint upper bound | affected bbox Mpx | material `perPx` | debug only |

This op should report zero geometry mutation. If it estimates changed
edges, the estimator is mixing paint and geometry incorrectly.

### Pencil and Line

Journal ops: `pencil`, `line`

Stages:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| capture samples | `P` | 1 | line uses `P = 2` |
| fit stroke | `P` | 6 | `VB.fitStroke` |
| add line style | 1 | 20 | style table growth |
| candidate edge scan | `E` | 1 | bbox overlap pass |
| node/merge stroke | `G * B` | 4 | pair tests before exact splits |
| record bits | estimated new edge bits | 1 | via `VB.debugEdgeRecord` model |

Warnings:

- `overfit-pencil`: fitted `G` close to `P`, usually noisy capture.
- `large-merge-area`: `B / E > 0.35`.
- `snap-wide`: snap tolerance covers an unexpectedly large bbox.

### Brush

Journal op: `brush`

Stages:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| build swath path | `P` | 2 | `VB.buildSwath` |
| capsule union | `P` | 20 | paper.js boolean core |
| fit swept outline | estimated `G` | 12 | Flash-lean quad loops |
| snapshot pre-op doc | `E` | 2 | allocation plus edge copy |
| adopt identical edges | `G + B` | 4 | self-intersection guard |
| node boundary | `G * B` | 4 | dominant geometry cost |
| face mask walk | `F + C` | 10 | `VB.applyRegionMask` |
| dissolve submerged edges | `B` | 3 | same-fill cleanup |
| material paint | `A * M.perPx` | 1 | new fill style preview/repaint |

Default preflight guesses:

```js
G = max(8, ceil(P * 0.75))
B = candidate edges overlapping stroke bbox expanded by radius
X = G * B
F = max(1, ceil(B / 3))
C = max(G, B)
```

Postcommit should replace `G` with `result.boundary` when available.

Warnings:

- `wide-brush`: radius makes the bbox much larger than the pointer path.
- `boolean-heavy`: `P > 256` or estimated capsule union dominates.
- `candidate-explosion`: `G * B > 100000`.
- `mask-heavy`: face walk score larger than noding score.

### Eraser

Journal op: `erase`

Same structure as brush, except:

- material paint is zero because the output material is empty.
- blank-space preflight can short-circuit if bbox touches no edge and
  endpoint fill probes are empty.
- postcommit uses `result.removed` and `result.boundary`.

Warnings:

- `blank-erase`: estimated no-op.
- `large-carve`: removed edges are much larger than candidate edges.
- `suspect-face-merge`: face walk touched remote edges outside the swath
  bbox; this maps directly to comments in `eraser.js`.

### Bucket Fill

Journal op: `bucket`

Stages:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| point face query | `E` or indexed `B` | 4 | `VB.faceAt` |
| stamp outer cycle | `C` | 2 | fill side writes |
| stamp holes | `C` | 2 | included in same total |
| dissolve borders | `E` | 1 | current implementation scans all edges |
| material paint | face bbox `A * M.perPx` | 1 | new style repaint estimate |

Postcommit can replace `C` with `result.stamped` and dissolved count with
`result.dissolved`.

Warnings:

- `outside-fill`: no face found.
- `large-face`: stamped cycle count is above threshold.
- `global-dissolve-scan`: dissolve scanned many edges for a tiny face.

### Rect and Oval

Journal ops: `rect`, `oval`

Initial geometry:

- rect: `G = 4`
- oval: `G = 8`

If filled, estimate like brush with fixed `G`. If stroke-only, estimate
like pencil/line merge.

Warnings:

- `stage-sized-shape`: bbox covers most of the stage.
- `thin-shape`: width or height near zero; likely degenerate/no-op.

### Arrow and Region Tools

Journal ops: `reshape`, `moveNode`, `moveFill`, `deleteFill`,
`deleteEdge`, `transformSel`, `deleteSel`, `regionTransform`,
`regionDelete`, `paste`

Stages should be based on selection size and touched edge count:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| hit/selection lookup | `E` or selected count | 2 | depends on tool |
| transform geometry | selected edges | 3 | matrix application |
| revalidate planarity | touched candidates | 5 | if noding/repair runs |
| claim rewrite | touched edge sides | 2 | fill/line changes |
| record bits delta | changed edges | 1 | debug stream estimate |

Warnings:

- `large-selection`: selected edge count above threshold.
- `remote-claim-change`: changed edge lies outside operation bbox.
- `planarity-repair-heavy`: repair dominates total score.

### Text

Journal ops: `textCreate`, `textEdit`, `textTransform`, `textDelete`,
`textBreak`, `textWrap`, `textSize`, `textBoxH`

Stages:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| glyph lookup | glyph count | 3 | embedded font map |
| contour copy | contours | 5 | outline records |
| layout advances | glyph count | 2 | deterministic metrics |
| bbox update | text records | 2 | hit and render bounds |
| break to shapes | contours | 12 | only `textBreak` |

Warnings:

- `missing-font-fallback`: would change determinism if not embedded.
- `large-text-break`: many contours become planar geometry.
- `wrap-thrash`: text wrap changes many line records.

### Save and Load

Synthetic/journal ops: `load`, `saveVBD`, `saveSWF`

Stages:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| parse/write tags | tag count | 4 | SWF/VBD container |
| parse/write records | edge count | 4 | DefineShape/VBD body |
| font subset | glyph count | 10 | text-heavy files |
| material encode | fill style count | 4 | gradients/matcap persistence |
| compression/base64 | byte count | 0.02 | debug scalar only |

For save estimates, use `VB.vbdStats(doc)` and `VB.debugEdgeRecord` when
available so the estimator agrees with the existing debug panel.

## 3D and GPU estimators

The repo is primarily 2D today, but the estimator should reserve stable
slots for 3D and GPU debug work. This matters for matcap materials,
WebGPU pipelines, source-code experiments, and future shape previews.

Synthetic ops:

```js
{ op: "meshPreview3D", vertices, triangles, material, targetPx }
{ op: "gpuMaterialRender", style, bboxTw, resolution }
{ op: "textureUpload", bytes, format }
```

3D dimensions:

| Symbol | Meaning |
|--------|---------|
| `V` | vertices transformed |
| `I` | indices or triangles |
| `D` | draw calls |
| `P3` | GPU/render passes |
| `W` | compute workgroups |
| `Rpx` | render target pixels |
| `TB` | texture bytes |

Stages:

| Stage | Count | Weight | Notes |
|-------|-------|--------|-------|
| transform vertices | `V` | 4 | CPU or shader-side estimate |
| rasterize triangles | `I` | 8 | coarse triangle cost |
| material shade | `Rpx * M.perPx` | 1 | reuse material profile where possible |
| compute pass | workgroups | 64 | WebGPU-style dispatch |
| texture upload | bytes / 1024 | 1 | memory pressure |
| draw calls | `D` | 500 | command overhead/debug sorting |

Matcap is the bridge between 2D and 3D-ish cost: it paints a 2D region,
but its pipeline has GPU passes and bbox textures. For matcap, the
operation estimator should report both:

- 2D geometry/tool cost from the edited region.
- GPU/material cost from `VB.materialProfile(style)`.

## Debug UI model

The first UI can be small:

- A badge in the status bar after each operation:
  `brush: 238k est, 318 candidates, 60 boundary`
- A detail panel with `totals`, `scope`, and `stages`.
- Warnings as terse labels: `candidate-explosion`, `large-gpu-bbox`.
- Optional overlay layers:
  - op bbox
  - candidate edges
  - generated boundary
  - face probes
  - material painted bbox

The debug panel should avoid prose explanations in the app. The document
explains the framework; the app should show facts.

## Thresholds

Initial thresholds can be crude and adjusted by replaying known logs:

| Level | Score | Meaning |
|-------|-------|---------|
| `ok` | `< 50000` | normal interactive edit |
| `watch` | `50000..250000` | likely visible on large docs |
| `warn` | `250000..1000000` | inspect stage breakdown |
| `hot` | `> 1000000` | likely a bug or known heavy operation |

Specific warning defaults:

| Code | Condition |
|------|-----------|
| `candidate-explosion` | `G * B > 100000` |
| `large-candidate-set` | `B / max(E, 1) > 0.35` |
| `many-render-edges` | `E > 4000` |
| `large-gpu-bbox` | `textureBytes > 64000000` |
| `many-pointer-samples` | `P > 512` |
| `record-stream-growth` | postcommit record bits grew by more than 25% |
| `unexpected-noop` | preflight predicted work, postcommit changed nothing |
| `unexpected-growth` | postcommit score is more than 2x preflight |

## Test strategy

Estimator tests should pin exact values for small fixtures:

- empty document render
- one rect render
- solid, linear, radial, and matcap material paint
- line merge into empty doc
- bucket fill of a simple square
- brush/erase no-op in blank space
- rect and oval fixed geometry counts
- text edit with known glyph count
- save stats matching `VB.vbdStats`

Replay tests should not pin every score at first. Instead:

- every journal op returns a profile
- every profile is deterministic across two runs
- no profile has negative counts
- postcommit comparisons exist for tools that return mutation counts
- warnings are stable for known heavy logs

## Rollout plan

1. Add `app/js/operation-estimator.js` with pure helper functions and no UI.
2. Add tests for synthetic docs and material integration.
3. Call it from `app.exec`/tool commits in debug mode only.
4. Show the last profile in the existing debug/status UI.
5. Export a sidecar estimate trace with replay logs.
6. Use replay traces to tune thresholds, not formulas.

## Invariants

- Same document + same op + same viewport bucket = same estimate.
- Estimation must be cheaper than the operation it estimates.
- Formulas must be named and versioned.
- Unknown ops return a valid low-confidence profile, not `null`.
- Debug estimates never affect document geometry, paint, journal replay,
  undo, redo, save, or export.
