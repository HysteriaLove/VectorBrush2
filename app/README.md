# VectorBrush

A Flash-like vector drawing editor: loads Flash MX 2004 `.swf` files 1:1,
edits Flash-style planar-map geometry, and saves to its own compact binary
format (`.vbd`, see [FORMAT.md](FORMAT.md)).

## Running

No build step, no dependencies: open `index.html` in a browser
(Chromium-based required for zlib support via `DecompressionStream`).
Drop a `.swf` or `.vbd` onto the canvas, or use **Open…**.

- **Lasso** (`L`) and the arrow's rubber-band marquee: REGION selections
  that cut through geometry like Flash's — marquee half a shape and drag
  the chunk away. The region clips fills and strokes exactly (boolean
  mask), moves with paint-over, Deletes like a shaped eraser, and hands
  to Free Transform
- **Free Transform** (`Q`): transform box around the selection (adopted
  from the arrow tool, or click to pick): eight scale handles anchored
  at the opposite handle, rotate by grabbing just outside the box, move
  from inside — one affine matrix, applied exactly (affine maps quads to
  quads) and re-merged with paint-over
- **Arrow** (`V`): Flash's selection tool. Drag the middle of an edge to
  reshape it (endpoints pinned, straight records become curves through
  the drag point — semantics extracted from the Arrow001 reference
  series); drag an anchor to move the shared node; click a fill to
  select that face, drag it to lift-and-drop with paint-over, press
  Delete to erase it. Shift+click builds multi-selections; double-click
  a stroke to select ALL attached stroke records (and a fill to select
  it with its outline). Selected strokes move with the selection and
  Delete removes them — interior strokes vanish leaving fills intact,
  and a stroked border between same-color fills dissolves so the fills
  collapse into one (different colors stay separated)
- Mouse wheel: zoom around the cursor
- Middle-drag or Space+drag: pan
- `V`/`P`/`B`/`E`/`N`/`O`/`R`/`K`: tool shortcuts
- **Pencil** (`P`): draw; stroke color/width in the toolbar; strokes are
  smoothed to lines+quads and merged into the planar map (crossed edges
  split, fills inherited) exactly like Flash. Stroke endpoints snap
  (~4 screen px, zoom-aware) onto nearby anchors and edges — nearly-closed
  loops close, ends that stop just short of a line weld onto it as a
  T-junction. Without this, casual drawings are full of invisible twip
  gaps and fills flood through them (Flash snaps for the same reason)
- **Brush** (`B`): paint the swept disc as a fill (size in the toolbar,
  uses the fill color). Matches the Brush*.swf references: a dab is one
  closed all-curves loop with no stroke; same-color strokes union;
  different colors split at crossings with two-sided F|G borders and the
  new color owning the overlap; crossed pencil strokes survive as
  interior edges
- **Line** (`N`) / **Oval** (`O`) / **Rectangle** (`R`): Flash's geometric
  primitives. Filled shapes replace everything beneath their interior
  (planar paint-over, same boolean-mask pipeline as the brush) with the
  stroke stamped on the boundary; stroke-only shapes merge like pencil
  strokes. An oval is 8 quad records, a rectangle 4 — Flash-lean by
  construction
- **Bucket** (`K`): click a region to fill it with the toolbar fill color.
  Finds the planar-map face under the cursor (half-edge walk with hole
  assignment, so islands keep their fill), stamps the facing side of every
  boundary edge, and dissolves lineless borders between same-fill regions
  — Flash's exact behavior in the Fill*.swf reference snapshots
- **Eraser** (`E`): drag to subtract the swept disc from the drawing
  (size in the toolbar, circle cursor preview). Strokes crossing the swath
  are trimmed to stubs, fills are carved with lineless boundaries that
  inherit the surviving fill on the outside — matching the Eraser*.swf
  snapshots. Erased holes can be bucket-refilled, and refilling with the
  same color heals the geometry completely
- `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`): undo / redo
- `D` or **Debug**: vector debug view — edge wires (cyan straight, magenta
  quad), anchors, control points, direction chevrons, fill-side ticks, and
  a side panel showing Flash-accurate record data: the hovered/pinned edge
  as its record grammar (start anchor, delta coordinates, nbits, bits on
  wire), both faces (fill0 = left of travel, fill1 = right) with resolved
  styles, the style tables, and the live record-stream cost (record counts,
  encoded bytes, bits/edge). With the select tool active, click pins an
  edge; Esc unpins. All coordinates are integer twips. Open
  `index.html#demo` for a synthetic document with the panel pre-opened.
- **Save .vbd**: exports the document in the compact format
- **Save .swf**: exports an SWF v7 movie (uncompressed, one DefineShape3
  built from the exact same edge records the editor holds) for validity
  testing in Flash MX 2004 -- File > Import (or open in the standalone
  player) and compare against what the editor shows

## Architecture

Plain JS, classic scripts, one global namespace `VB`. Everything operates on
integer twips (20 per pixel) so geometry is exact and endpoint welding needs
no epsilons.

| file | role |
|---|---|
| `js/bitio.js` | MSB-first bit reader/writer + SWF RECT, minimal-bit-width helpers |
| `js/doc.js` | `Y2KVectorDocument`: the planar edge map (edges with `fill0`/`fill1`/`line` style indices) + style tables |
| `js/swf.js` | SWF loader: FWS/CWS container, DefineShape 1–4, PlaceObject matrix baking → `Y2KVectorDocument` |
| `js/trace.js` | Resolves dual-sided edges into closed fill loops (fill1 forward, fill0 reversed, exact endpoint welding) and stroke chains |
| `js/render.js` | Canvas2D renderer: fills first (even-odd), strokes on top (round/round, 1px hairline floor). Uses only `moveTo`/`lineTo`/`quadraticCurveTo`/`fill`/`stroke` so it ports 1:1 to `PIXI.Graphics` |
| `js/vbd.js` | `.vbd` encoder/decoder — pen-continuity edge ordering, delta bit-packing, optional deflate |
| `js/swfwrite.js` | Minimal SWF v7 exporter (DefineShape3 + PlaceObject2, record stream shared with the `.vbd` encoder) |
| `js/geom.js` | Edge geometry: line/quad/quad-quad intersections, de Casteljau splitting with shared rounded junctions, point-in-fill parity, distance queries |
| `js/fit.js` | Pencil smoothing: corner segmentation + least-squares quad fitting with recursive split (Schneider-style, emits lines+quads) |
| `js/merge.js` | Planar merge: re-nodes new strokes against the map (both sides split at crossings) and inherits region fills onto stroke pieces |
| `js/faces.js` | Face traversal: half-edge cycles via angular ordering at nodes, orientation classification, hole-to-face assignment, point-to-face lookup |
| `js/planarity.js` | Integrity checker: finds transversal crossings without a shared node (the invariant everything else relies on) |
| `js/bucket.js` | Bucket tool: stamp the clicked face's boundary sides, dissolve redundant borders |
| `js/swath.js` | Capsule-chain outlines (drag path + radius → closed loop of lines and quad arcs); interior lobes are cleaned by winding classification |
| `js/eraser.js` | Eraser tool: node the swath into the map, delete edges inside (exact distance-to-path test), re-side the boundary to the surviving fills |
| `js/brush.js` | Brush tool: the eraser's positive twin — paint the swath as a fill, submerge covered boundaries, keep crossed strokes as interior edges |
| `js/journal.js` | Action log: record every tool op, deterministic replay, integrity reporting |
| `js/history.js` | Snapshot undo/redo |
| `js/debug.js` | Vector debug overlay + hover edge inspector |
| `js/pencil.js` | Pencil tool: capture → fit → merge, with raw-trail preview |
| `js/shapes.js` | Line/Oval/Rectangle tools: shape loops through the boolean-mask pipeline (filled) or planar merge (stroke-only) |
| `js/arrow.js` | Arrow tool: edge reshape / node move / face lift-move-delete, all journaled |
| `js/transform.js` | Free Transform tool: scale/rotate/move box over the selection, committed as one affine matrix |
| `js/lasso.js` | Lasso tool: freeform region selection, handed to the arrow/transform |
| `js/main.js` | GUI shell: viewport, toolbar, tool routing, file I/O |

The document model is deliberately **not** an object/layer scene graph: like
Flash's stage drawing layer, the whole document is one planar map. The pencil,
bucket, and eraser tools will operate by inserting/splitting/re-siding edges
in that map.

## Deterministic bug reports: the action log

Every document-mutating action (pencil strokes with their exact pointer
trails, bucket clicks, erases, undo/redo, file loads) is recorded in an
in-memory journal. **Save log** in the toolbar exports it as JSON; opening
`test/replay.html` and dropping the file replays the session through the
real tool code, runs integrity checks (twips invariant, planarity, fill
chain closure) after every op, and names the **first op that corrupts the
document**. The status bar also warns live (⚠) the moment an edit breaks
integrity, so a repro can be exported right when it happens.

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
`test/repro.html` is a stress page: dense random scribbles with Euler-count
verification (bounded faces must equal E − V + C), wavy-grid bucket
containment, and the casual-drawing gap scenarios.

Current status: 370 checks, 0 failures — the SWF/VBD pipeline suite plus
the journal-replay regression (pencil square → bucket fill → erase across
it, the case that exposed the concave-join bowtie bug) and
eraser unit tests (band erase splitting a fill, dab holes with
bucket-refill healing back to the original geometry, stroke trimming,
blank no-op, corner clipping) and
bucket-fill unit tests (outline fill, outside no-op, split-region fills,
border dissolution, island/annulus hole assignment, style dedup) and
unit tests for intersections, splitting, point-in-fill parity, stroke
fitting, planar merge (crossing, fill inheritance, self-crossing),
undo/redo, and the Flash-parity invariant (`doc.validate()`: integer twips
everywhere, valid style indices) checked on every loaded file and after
every merge. `.vbd` output is ≤ the source SWF size on all 10 reference
files.

## Roadmap

1. ~~Canvas milestone: SWF loading, planar-map document, rendering, `.vbd`~~
2. ~~Pencil tool (capture → curve fit → planar merge), undo/redo, vector debug view~~
3. ~~Bucket fill (face tracing, edge re-siding, border dissolution)~~
4. ~~Eraser (swath subtraction, stroke trimming, boundary re-siding)~~
5. ~~Brush tool (paint the swath as a fill)~~
6. ~~Boolean-mask erase/brush core~~ — done, shared by both tools and
   powered by paper.js (vendored checkout; prebuilt v0.12.18 in
   `lib/paper-core.min.js`). The swept region is the paper.js union of
   per-segment capsules (`js/paperglue.js`), curve-fit to Flash-lean
   closed quad loops (a single stroke is ~14-30 records, matching the
   Brush*.swf references), noded into the map, and reconciled by the
   face walk in `js/mask.js`: one VALIDATED probe per face (a probe must
   lie inside its own face) — inside the region -> the mask fill (paint,
   or emptiness for the eraser), outside -> the pre-op snapshot — and
   every edge claim is regenerated from its two faces. Union with
   existing same-color paint falls out of the stamping, so untouched
   boundaries keep their exact records. All captured user-session logs
   replay with zero phantom chords and zero integrity problems.
   (A stronger per-fill region boolean was tried — `paintUnion` in
   `js/paperglue.js`, kept for reference — but paper's resolveCrossings
   mis-resolves pinch-touching compound regions, carving painted lobes;
   the face-walk formulation is equivalent and robust.)
7. Residual polish: the same-contour re-trace case (a stroke drawn
   exactly along an existing fitted fence can scramble the face walk —
   log 7 op#8), and the two partial-underpaint ops in logs 8/9/11
8. Use paper.js `getIntersections`/`divide` for planar noding in
   `merge.js` (replacing the hand-rolled quad-quad intersector)
9. Pixi.js rendering backend
