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
- `V`/`P`/`B`/`E`: tool shortcuts (pencil, bucket, eraser land in the next milestones)
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
| `js/main.js` | GUI shell: viewport, toolbar, file I/O |

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
Current status: 130 checks, 0 failures; `.vbd` output is ≤ the source SWF
size on all 10 reference files.

## Roadmap

1. ~~Canvas milestone: SWF loading, planar-map document, rendering, `.vbd`~~
2. Pencil tool (point capture → curve fit → edge insertion with intersection splitting)
3. Bucket fill (region tracing in the planar map, edge re-siding, border dissolution)
4. Eraser (boolean subtraction against fills, stroke trimming)
5. Pixi.js rendering backend
