# 2DMaterials — vector material model with deterministic cost profiling

A **2DMaterial** is what a region (or stroke) is painted with. It is the
fill-style table entry itself — `doc.fills[i]` — extended beyond SWF's
native types. Artists design materials; the profiler tells them exactly
how heavy each one is *before* anything renders, deterministically:
identical params produce identical numbers on every machine, because
the profile is an analytic function of the material definition, never a
wall-clock measurement.

## Material classes

| class      | types                    | backend               | relative fill cost |
|------------|--------------------------|-----------------------|--------------------|
| `flat`     | `solid`                  | Canvas2D direct       | 1× (baseline)      |
| `gradient` | `linear`, `radial`       | Canvas2D paint server | 3× / 5×            |
| `gpu`      | `matcap` (first of many) | WebGPU pipeline       | computed per params|

- `solid`, `linear`, `radial` are **SWF-native** — they round-trip with
  MX 2004 documents (gradients: matrix over the ±16384tw gradient
  square, up to 8 ratio/color stops).
- `gpu`-class types are **vbd-only**. SWF export bakes them to their
  base color (same policy as other beyond-SWF features).
- Every `gpu` material must declare a **Canvas2D fallback** (matcap:
  flat base color) so documents open everywhere, WebGPU or not.

## The deterministic cost model (`VB.materialProfile`)

Costs are counted in **per-pixel ops** — an abstract unit where a solid
fill costs 1 — plus **passes** and **texture bytes**. Texture bytes are
reported per megapixel of the painted region's bounding box, because
gpu materials allocate working buffers over the bbox, not the exact
region. The profile of a material is:

```
{ class, gpu,               // needs WebGPU?
  passes: [{name, perPx}],  // ordered pipeline stages
  perPx,                    // total ops per painted pixel
  score,                    // perPx / solid's perPx (the "N× solid" badge)
  texBytesPerMpx,           // working-buffer footprint
  label }                   // human string for the UI badge
```

Formulas (all integer/exact — unit-tested against literal values):

- `solid`  : 1 op (write). 0 bytes.
- `linear` : 3 ops (2 affine transform + 1 lerp). 0 bytes.
- `radial` : 5 ops (2 transform + 2 mul/sqrt + 1 lerp). 0 bytes.
- `matcap` : passes over the region bbox at `resolution` scale `s`:
  1. height rasterize      — 1 op
  2. separable blur H + V  — `2 · (2·ceil(blurPx·s)+1)` taps
  3. normal derive (Sobel) — 10 ops
  4. matcap sample         — 3 ops (normal → matcap UV → texture read)
  Working buffers: height + blur + normal = `3 · 4 bytes · s²` per
  bbox pixel → `12 s² MB` per megapixel.

The materials panel shows each fill style with its score badge
(`1× solid`, `3× gradient`, `47× gpu · 12MB` …) so cost is visible at
authoring time, not discovered on an iPad later.

## WebGPU backend (stage 2 — gated)

Pipeline per matcap-painted region, all offscreen:

1. rasterize region coverage/height field (distance-to-boundary bump,
   scaled by `bumpScale`) into an `r16float` texture at bbox×`resolution`;
2. separable Gaussian blur (compute, `blurPx` sigma);
3. derive a normal map (Sobel over the height field);
4. sample a matcap texture by view-space normal, composite the result
   under the region's even-odd mask into the frame.

Determinism: WGSL float ops are deterministic per device but not across
devices; document GEOMETRY stays untouched — gpu materials affect
pixels only, never the planar map, so journals/replays are unaffected.
`VB.gpuMaterialsAvailable()` reports `navigator.gpu` presence; without
it every gpu material renders its declared fallback.

Rollout: stage 1 (this commit) ships the model, profiler, real gradient
rendering, the panel, persistence and journal op. Stage 2 ships the
WebGPU matcap pipeline behind the availability check, off the render
hot path (results cached per (style, geometry-hash, zoom bucket)).

## Persistence and journaling

- vbd body v4: fills are tagged — `0 solid | 1 linear | 2 radial |
  3 matcap` (gradient: f32 matrix ×6 + stop count + ratio/RGBA stops;
  matcap: base RGBA + f32 bumpScale, blurPx, resolution). Older bodies
  decode unchanged.
- Journal: `{op:"fillStyle", index, style}` — a registered command
  (one undo step) that replaces a fill-style entry; the materials panel
  edits styles exclusively through it.
- SWF: import keeps gradients verbatim (now rendered properly); export
  policy unchanged this stage (gradients/gpu bake to base color with a
  warning — native gradient export is a candidate follow-up since SWF
  supports it).
