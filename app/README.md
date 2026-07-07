# VectorBrush

A Flash-like vector drawing editor: loads Flash MX 2004 `.swf` files 1:1,
edits Flash-style planar-map geometry, and saves to its own compact binary
format (`.vbd`, see [FORMAT.md](FORMAT.md)).

## Running

No build step, no dependencies: open `index.html` in a browser
(Chromium-based required for zlib support via `DecompressionStream`).
Drop a `.swf` or `.vbd` onto the canvas, or use **Open…**.

- Mouse wheel: zoom around the cursor
- Middle-drag or Space+drag: pan
- `V`/`P`/`B`/`E`: tool shortcuts (bucket and eraser land in the next milestones)
- **Pencil** (`P`): draw; stroke color/width in the toolbar; strokes are
  smoothed to lines+quads and merged into the planar map (crossed edges
  split, fills inherited) exactly like Flash
- `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`): undo / redo
- `D` or **Debug**: vector debug view — edge wires (cyan straight, magenta
  quad), anchors, control points, direction chevrons, fill-side ticks;
  hovering an edge shows its indices and coordinates in the status bar
- **Save .vbd**: exports the document in the compact format

## Architecture

Plain JS, classic scripts, one global namespace `VB`. Everything operates on
integer twips (20 per pixel) so geometry is exact and endpoint welding needs
no epsilons.

| file | role |
|---|---|
| `js/bitio.js` | MSB-first bit reader/writer + SWF RECT, minimal-bit-width helpers |
| `js/doc.js` | `VBDocument`: the planar edge map (edges with `fill0`/`fill1`/`line` style indices) + style tables |
| `js/swf.js` | SWF loader: FWS/CWS container, DefineShape 1–4, PlaceObject matrix baking → `VBDocument` |
| `js/trace.js` | Resolves dual-sided edges into closed fill loops (fill1 forward, fill0 reversed, exact endpoint welding) and stroke chains |
| `js/render.js` | Canvas2D renderer: fills first (even-odd), strokes on top (round/round, 1px hairline floor). Uses only `moveTo`/`lineTo`/`quadraticCurveTo`/`fill`/`stroke` so it ports 1:1 to `PIXI.Graphics` |
| `js/vbd.js` | `.vbd` encoder/decoder — pen-continuity edge ordering, delta bit-packing, optional deflate |
| `js/geom.js` | Edge geometry: line/quad/quad-quad intersections, de Casteljau splitting with shared rounded junctions, point-in-fill parity, distance queries |
| `js/fit.js` | Pencil smoothing: corner segmentation + least-squares quad fitting with recursive split (Schneider-style, emits lines+quads) |
| `js/merge.js` | Planar merge: re-nodes new strokes against the map (both sides split at crossings) and inherits region fills onto stroke pieces |
| `js/history.js` | Snapshot undo/redo |
| `js/debug.js` | Vector debug overlay + hover edge inspector |
| `js/pencil.js` | Pencil tool: capture → fit → merge, with raw-trail preview |
| `js/main.js` | GUI shell: viewport, toolbar, tool routing, file I/O |

The document model is deliberately **not** an object/layer scene graph: like
Flash's stage drawing layer, the whole document is one planar map. The pencil,
bucket, and eraser tools will operate by inserting/splitting/re-siding edges
in that map.

## Tests

`test/test.html` runs the full pipeline against 10 embedded reference SWFs
(`test/fixtures.js`, generated from `SWFExamples/` with expected stats from an
independent Python parser): container + shape decoding, stage/background/style
/edge-count equality, fill-loop closure, and lossless `.vbd` round-trips (raw
and deflate). Headless run:

```
msedge --headless --disable-gpu --user-data-dir=%TEMP%\vbtest ^
  --virtual-time-budget=30000 --dump-dom "file:///.../app/test/test.html"
```

The `<title>`/final line reads `VBTEST DONE pass=N fail=M`.
Current status: 163 checks, 0 failures — the SWF/VBD pipeline suite plus
unit tests for intersections, splitting, point-in-fill parity, stroke
fitting, planar merge (crossing, fill inheritance, self-crossing), and
undo/redo. `.vbd` output is ≤ the source SWF size on all 10 reference files.

## Roadmap

1. ~~Canvas milestone: SWF loading, planar-map document, rendering, `.vbd`~~
2. ~~Pencil tool (capture → curve fit → planar merge), undo/redo, vector debug view~~
3. Bucket fill (region tracing in the planar map, edge re-siding, border dissolution)
4. Eraser (boolean subtraction against fills, stroke trimming)
5. Pixi.js rendering backend
