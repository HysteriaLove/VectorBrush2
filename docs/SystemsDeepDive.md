# VectorBrush2 — Systems Deep Dive

Audited 2026-07-10 against working tree `9eb24a8`. This document is the
MAP of what the code actually does — file:line referenced — where
[Architecture.md](Architecture.md) is the SPEC of what it should become.
Four systems are covered (streaming/persistence, document object model,
UI implementation, runtime data flows), followed by the consolidated
defect/open-question list (§5) and the concrete native-iPad execution
plan (§6).

---

## 0. Codebase shape

~24,600 lines of plain ES5 across 51 modules in `app/js/` — no build
step, no modules, every file an IIFE hanging off `window.VB` (engine)
or `window.VBApp` (the GUI facade, main.js:3968). Largest files:
main.js 3,970 (all DOM wiring), arrow.js 1,517, text.js 1,120,
audio.js 1,091, transform.js 1,032. `app/index.html` (1,490 lines)
holds ALL CSS in one `<style>`. Vendored: three.js r159 UMD
(`app/vendor/three.min.js`, 656 KB); paper.js v0.12.18 booleans live
*inside* `paperglue.js` (off-DOM scope), pixi v8 inside
`pixi-render.js`'s surface. Reference checkouts at repo root
(untracked): `paper.js/` (upstream), `ruffle/` (Rust SWF), and
`skia-pathops/` — research material for Architecture Appendix A.

Two load-bearing facts frame everything:

1. **The journal IS the project.** Persistence is journal replay, not a
   state blob. `.y2kvector` is a lossy secondary codec (§2.6).
2. **One planar-map cell is the atom.** Every drawing surface anywhere
   (scene layer frame, actor drawing, pitch slide, board panel, library
   symbol, scratchpad) is a `VB.Y2KVectorDocument` (doc.js:58), and all
   tools point at whichever cell `resolveEditCell` says is active.

---

## 1. Streaming & persistence

### 1.1 What persists where

- **IndexedDB `vb-packages`** (packagestore.js:28-40, `DB_VERSION=1`):
  store `projects` (index rows `{id, name, group, created, modified}`)
  and store `units` keyed `[project, path]` holding Blobs. There is no
  migration path beyond store creation — a future `DB_VERSION` bump has
  no upgrade code yet.
- **Unit tree actually written** (shell.js:174-220, audio.js:676-805):
  `manifest.json` (`{format:"y2kproj", version:1, ops, saved}` —
  written but never read back), `journal/seg-NNNNN.json` (256
  ops/segment), `assets/audio/<id>` (stem bytes), and
  `assets/audio/master.wav` (bake). That's it — the rich per-section
  tree in Architecture §3 does not exist yet.
- **Autosave**: `VBApp.onDocChanged` debounces `flushProject` by 600 ms
  (shell.js:222-230); also flushes on `visibilitychange`,
  `beforeunload` (un-awaited best-effort), the Save button, route-away,
  and before Duplicate/Export. Only dirty tail segments rewrite; a
  `load` op resets `firstDirty` to 0 (full rewrite).
- **Load**: `loadSessionFromPackage` (shell.js:240-261) lists
  `journal/`, joins segments, `VB.replayJournal`s the WHOLE journal
  synchronously. No lazy sections, no background indexer.
- **localStorage** (view state, never journaled): `vb-y2kshell` (shell
  chrome), `vbRenderer` (canvas2d override), `vb-cpcam` (export camera
  — see §5.2.9, this one arguably belongs in the journal).

### 1.2 The journal

- Registry: `OPS` Map + `defineOp`/`applyOp` (journal.js:47-55). Live
  path `Session.exec` records THEN applies through the same command
  function replay uses (session.js:81-86) — the anti-divergence design.
- Format: flat JSON objects `{op:"<name>", …params}`, geometry in
  integer twips, ops self-contained (textCreate carries font subsets,
  paste carries a whole mini planar map, audioImport carries only ids +
  a `unit` path — never PCM).
- ~90 ops across 13 families in 12 files (full table in §2.3).
- Replay: `replayJournal(ops, hooks)` (journal.js:310-325) with an
  `onOp` hook the test battery uses to run `integrityReport` after
  every op and pinpoint the first corrupting one.
- Undo: `History` = 64 deep-copy snapshots of the ENTIRE project
  (history.js:97-166) — the single most complete inventory of Project
  fields anywhere. In-memory only; `undo`/`redo` are themselves ops so
  replay reproduces post-undo state.
- Segmentation: `segmentJournal`/`joinJournalSegments`
  (packagestore.js:323-341), pure functions.

### 1.3 The streaming layer — real half, dormant half

`app/js/streaming.js` implements Architecture §5.2 in skeleton. Status:

| Piece | State | Evidence |
| --- | --- | --- |
| `AssetCache` (`VB.assets`, one global LRU, 256 MB placeholder) | **REAL — 5 tenants** | pixi raster sprites (pixi-render.js:665-715), matcap paints (matcap.js:459), thumbnails (thumbs.js:67), decoded audio buffers (audio.js:262), `frameStart()` in-frame exemption |
| `Prefetcher` (`VB.prefetcher`, priority queue, concurrency 2) | **REAL — 1 client** | thumbs.js:75 (the actors thumbnail wall — the only windowed view) |
| `chunkSource` (range reads over `readRange`/`Blob.slice`) | **DORMANT** | defined + exported + one suite check; zero runtime callers — everything whole-loads via `readUnit` |
| Workerized decoders | **ABSENT** | audio decode, inflate, thumb renders all on the main thread |
| Proxy store (persisted peaks/thumbs/blurhash) | **ABSENT** | thumbs and peaks are in-memory Maps, recomputed per session |

So the honest statement is: the CACHING side of §5 is live and
battle-tested (the parity gate even asserts eviction-rebuild pixel
identity); the WINDOWED-I/O side is scaffolding awaiting per-section
package units to read ranges from.

### 1.4 Containers

- **`.y2kproj`** = zip of the unit tree. Hand-rolled zip: STORE-only
  write with a FIXED DOS timestamp for byte-identical exports
  (packagestore.js:208-253); reader also accepts DEFLATE via
  `DecompressionStream` so foreign zips import. Export/import
  materialize every byte in RAM (§5.1.7).
- **`.y2kvector`** (y2kvector.js): magic `Y2KV`, legacy `VBD1` read
  forever; body v1 shape / v2 +text / v3 scenes→layers / v4 +materials;
  shape records are byte-exact SWF DefineShape bit grammar shared with
  the SWF exporter. **Lossy**: only `frames[0]` per layer; no sequence,
  cast, tracks, actors, library, audio, boards, pitch, writing, notes,
  fps (§2.6).
- **`.y2kactor`** (actors.js:390-416): JSON `{format, version:1,
  actor}`; ids regenerate on import.
- **SWF v7 write** (swfwrite.js:150-196): uncompressed FWS, one frame,
  active scene only, solid fills only (throws on gradients/matcaps),
  mirrors MX 2004 reference bytes. Text-in-SWF permanently out of scope.

### 1.5 Spec-vs-code gaps (Architecture §3/§5)

1. Package layout: per-section units don't exist — journal + audio
   assets only (Arch §3 now carries a TODAY note).
2. `manifest.json` is write-only; content is 4 fields, not the promised
   section index.
3. Load replays everything synchronously; "manifest + entered section"
   and the lazy store are unimplemented.
4. Range reads / window subscriptions / placeholder ladders: dormant
   (§1.3).
5. No workers; no persisted proxies; no y2kvector partial-parse header.
6. `load`/`paste`/`textCreate` ops embed payloads (the `load` op keeps
   the whole opened file as base64 in the journal FOREVER) — Arch §5.5
   Q7.
7. `exportZip`/`importZip` materialize whole projects in RAM.
8. No asset-unit GC: `audioRemove` leaves `assets/audio/<id>` orphaned;
   `VB.projectAssets` has no delete (Arch §5.5 Q8).
9. No `navigator.storage.persist()`, no quota handling (Arch §5.5 Q9).
10. Scratch sessions keep assets in an in-memory Map that silently
    vanishes on reload (shell.js:157-166).

---

## 2. Document object model

### 2.1 Project

`Project(width, height)` — project.js:42-91. Fields:

| Field | Shape |
| --- | --- |
| `width, height` | stage twips (default 550×400 px × 20) — SWF frame definition only, canvases are infinite |
| `fps` | 24; `fpsSet` op |
| `background` | `{r,g,b,a}` |
| `scenes` | `[Scene]`; `Scene = {id, name, layers:[Layer], cast:[], tracks:[]}`; `Layer = {name, visible, locked, frames:[cell]}`; **layers[0] is TOP** (JSFL convention) |
| `cur` | `{scene, layer, frame}` — shared edit cursor |
| `sequence` | `[{id, scene, duration, locked}]` — the master timeline |
| `materials` | global 2DMaterial library |
| `actors` | actors library (poses→symbols→drawings) |
| `library` | object library (`{id, kind:"symbol"\|"background", name, cell}`) |
| `notes / writing / pitch / boards` | side documents (items / docs / slides / beats+panels) |
| `audio` | `{assets:[], tracks:[]}` — clips `{id, asset, at, offset, duration, gain}` in integer **ms** (unlike frame-based scene tracks) |
| `editTarget` | null or a descriptor routing all tools at a library/actor/slide/panel/notes cell |

`meta`, `compositing`, `post`, `exports` from Arch §3 are NOT fields —
compositing/grading are views over placement records; exports live in
the shelf concept; meta splits across the package DB row + manifest.

### 2.2 Vector core

- Edge record `{ax,ay,cx,cy,bx,by,fill0,fill1,line}` (doc.js:36-45);
  integer twips; `cx===null` ⟺ straight, else quadratic Bézier; style
  indices 1-based with 0 = none; fill1/fill0 = Flash
  FillStyle1/FillStyle0 forward/reverse sides.
- Invariant owners: `doc.validate()` (integer coords, resolvable
  indices); `planarity.js` (`validatePlanar`, NODE_TOL 1.5tw — edges
  meet only at shared anchors); `faces.js` (half-edge face walk,
  keep-face-on-right, y-down); `mask.js` `applyRegionMask` (one probe
  per face, then **regenerates every edge's fill0/fill1 from its two
  adjacent faces** — stranded fill chains impossible by construction;
  culls lineless 0|0 and F|F for Flash-clean output).
- Booleans: paper.js v0.12.18 in paperglue.js — capsule-per-segment
  swaths, `SwathUnion` incremental binary-counter union during the
  drag, batch union as the authority (§4.1 carries the one divergence
  risk).
- Edge identity for ops: `edgeKey` 9-tuple by VALUE (arrow.js:26-30)
  since indices shift.

### 2.3 Op registry

13 families: lifecycle+layers+frames+draw+text+materials+undo
(journal.js), sequence (sequence.js), cast/step-sequencer (stepseq.js),
actors (actors.js), library (library.js), audio (audio.js), brainstorm
/ pitch / writing / boards (their view files). Id discipline: callers
mint ids at record time (`VB.actorNewId` crypto-random; deterministic
fragment ids like `c.id+":l"+from` when a gesture splits a run —
stepseq.js:104-109) so replay builds identical structures.

⚠ **Defect — op-name collision**: `symbolRename`/`symbolRemove` are
defined by BOTH actors.js (:205/:214, keyed `op.actor`+`op.symbol`) and
library.js (:76/:85, keyed `op.id`). Last-loaded wins — library.js —
and index.html loads actors.js first, so the actor forms are shadowed.
Nothing records the actor form today (the Actors panel has no
rename/remove UI), but any journal that ever contains one replays as a
SILENT NO-OP. Fix before the Actors panel grows those buttons (§5.1.1).

### 2.4 Timeline model

- A layer shorter than the playhead HOLDS its last frame
  (`frameCell` clamps); `frameCount` = longest layer;
  `sceneSpan` = max(drawn, longest sequence instance of the scene) so
  the playhead can park on holds. (Duplicated in stepseq.js:72 —
  §5.1.9.)
- `scene.cast` instance = `{id, ref, kind, x, y, scale, rotation}`;
  `scene.tracks` clip = `{id, lane, target, start, duration, label}`
  with namespaced targets `"vis:"+instId` / `"pose:"+instId`; rows are
  GENERATED from structure, clips are painted timing runs.
- `sequence` boundary ops steal/slide frames between neighbors keeping
  ≥1 (`sceneBoundarySet` menu semantics vs `sceneBoundaryDrag`
  zone-preserving rebalance).

### 2.5 References & editTarget

- `refOf` resolves an instance's prototype by `kind` → actors vs
  library namespace (stepseq.js:53-68). Deleting a prototype does NOT
  prune referencing cast instances — they render nothing (dangling by
  design until the instance-management system lands).
- `editTarget` set only via journaled `editTargetSet/Clear`; when set,
  `project.scene()` returns a synthetic single-layer scene so every
  tool/renderer transparently follows the target cell; frame ops are
  disabled. Fragility: `resolveEditCell` silently returns null when the
  target id no longer resolves — an un-journaled mode fallback
  (§5.1.5).

### 2.6 Serialization surfaces

(a) `.y2kproj` journal — the ONLY faithful save. (b) `.y2kvector` —
lossy (frames[0] only, no side systems). (c) `.y2kactor` — portable,
id-regenerating. The undo snapshotter (history.js:97-166) is the
authoritative "everything in Project" list; keep it in sync when adding
containers (it already bit us once).

---

## 3. UI implementation

### 3.1 y2kshell

Pure engine (y2kshell.js, `VB.Y2KShell`, zero DOM) + DOM wiring
(main.js:1910-2601). State (localStorage `vb-y2kshell`):

```
{ racks:{left,right:{width,scroll,open,modules[]}},
  cols:{left,right:{open}}, toolbars:{top,bottom},
  drawers:{top:{open,h:220}, bottom:{open,h:130}},
  step:{cellW}, float:{panels:{name:{dock:"top"|"bottom",ord}
                                 | {dock:"free",x,y}}} }
```

- Racks: packed stacking ONLY (`packRack`/`insertionIndexAt`/
  `reorderModule` — "panels always collapse together"); smooth width
  drags with a single 4 px close zone (`SNAP_SHUT`); invisible edge
  reveal zones, no pillars/chevrons (user directives all encoded).
- Drawers: faces pull them — `#tophandle` (scratchpad) and
  `#xbar-bottom` (timeline stack), continuous follow.
- Floating toolpanels: every xPanel is its own island; docks to the
  top/bottom bar bounds (rows wrap, ride drawer pulls, inset past
  racks) or floats free; `FLOAT_SNAP=28` capture band with snap-line
  preview; a MutationObserver forgets unmounted panels while their
  seats persist. `app.xpanel(bar, name)` is THE seam views use (bar
  arg accepted and ignored).

### 3.2 Routing & mount contract

shell.js: `SECTIONS` (10 tabs), `MOUNTS` maps section → `{el, view}`;
Composite and Grading SHARE `#composite-view` (setSection treats
same-el mounts as active together). Contract: `view.mount(host, app)` /
`view.unmount()`; same-host remounts short-circuit; unmount removes
`view.xpanels`. Hash routes (`#home`, `#project/<id>/<sec>`, `#demo`)
serialize through a promise chain, and route-away AWAITS the package
flush.

### 3.3 Editor canvas stack

`#pixi-canvas` (document renderer, pointer-events:none) UNDER
`#stage-canvas` (pointer target + overlays). `requestRender` is
rAF-coalesced: pixi paints the document, Canvas2D paints only overlays
(or everything, as the oracle, when forced/fallback). Infinite canvas:
`setupStage` fills background only, no desk/frame. Zoom 0.02–64
cursor-anchored; pan = middle-button or Space+drag. Tools palette in
floating clusters (`.y2kxcol`) over the canvas.

### 3.4 Timelines

Scene strip (canvas `#seq-strip`: ruler with second-snapped ticks,
alternating-blue instance blocks, boundary drags, wheel zoom, context
menu) + step sequencer (`#step-names` + `#step-grid` canvas: generated
rows — frames head row, then per-instance Visibility + pose rows —
paint/erase drags emit ONE `exposureSet` op) + the fixed playback
toolbar. Both playheads draw from the same master clock (§4.2).

### 3.5 Views

brainstorm/pitch/writing/boards/audio/composite all follow the mount
contract and the xpanel seam (prefixes bb-/pt-/bd-/au-). Composite
(composite.js) is three.js r159: backgrounds z<0, scene layers
flattened to one plane z=0, actor/symbol planes z>0; CanvasTextures
hash-cached; 2D ortho vs 3D orbit; `renderInto` for export;
`camConfig` (fov/aspect) in localStorage `vb-cpcam`.

### 3.6 Input & iPad readiness

The good: pointer events + `setPointerCapture` + `touch-action:none`
everywhere — no mouse-only paths; `clientToTwips` already thinks in
logical units (1 px = 20 tw = 1 Apple pt); main canvas, pixi, and
three.js are all DPR-correct.

The gaps (all fixable at rung 0, no Mac needed — see §6.1):

1. Secondary canvases draw at CSS resolution — scratchpad, seq-strip,
   step-grid, boards stage, audio lanes are blurry on Retina.
2. Pan/zoom bound to middle-button + wheel; no two-finger pan or pinch.
3. `contextmenu` menus have no long-press equivalent.
4. `prompt()/confirm()/alert()` for rename/delete/duplicate.
5. No `env(safe-area-inset-*)` anywhere; drawer/float clamps use raw
   `window.innerWidth/innerHeight`.
6. Rack geometry assumes desktop width (`CENTER_MIN=320` + two 240 px
   racks ≈ 800 px minimum comfortable width; iPad portrait is 768-834
   logical pts).
7. Space/keyboard transport assumes a hardware keyboard (on-screen ▶
   exists, so degraded-not-broken).

### 3.7 Theming

Light is `:root` default; `body.theme-dark` redefines the same ~25
custom properties; canvas renderers read tokens via `getComputedStyle`
at draw time. No toggle is currently wired. Hard-coded colors that
bypass tokens (seq blocks, step clips, audio band, pitch text,
brainstorm notes) need routing through variables before `.theme`
packages can work.

### 3.8 Structure notes

z-index ladder: tool clusters 6 < docks 40 < islands 46 < homescreen
60 < menus 200 < export 250 < drag ghosts 300 (docks below islands is
intentional: floating panels ride over drawer faces; tool clusters
BELOW docks means a pulled drawer covers them). main.js is 3,970 lines
of one IIFE in ~29 `// ----` sections; `app.*` is the only cross-file
surface — the DrawingSurface extraction (Arch §4) is the eventual
answer, not ad-hoc splitting.

---

## 4. Runtime data flows

### 4.1 A stroke's life — and the two commit patterns

pointerdown → tool `onDown` (capture) → live preview: points thinned to
~2 px, fed to the incremental `SwathUnion`, raw stroke drawn as overlay
→ pointerup → `BrushTool.onUp`: build op → `app.record(op)` →
`history.push` → DIRECT `brushStroke(doc, …, union)` → `docChanged()`.
`brushStroke` = swath → swept outline (arclength-sampled, curve-fit to
quads) → node into the planar map → `applyRegionMask` (delete covered,
align spans, weld micro-edges, build faces, one verified probe per
face, regenerate all fill0/fill1, cull). `docChanged` fans out to every
panel + view refresh, the ≤4000-edge integrity sentinel, autosave, and
`requestRender`.

⚠ **The one structural divergence risk in the app**: freehand tools
(brush/pencil/eraser) use record + direct-call — the live call passes
the incremental union, while replay's command (journal.js:149-152)
rebuilds the batch union. Correctness rests on `SwathUnion.finish()`
verifying its region byte-matches the batch path (it disposes and
falls back on any mismatch — paperglue.js:161-170), and the suite's
"incremental swath union" section tests it. Everything else routes
through `app.exec` and is divergence-proof by construction. A runtime
tripwire (compare edge-set hash live-vs-replay on N random strokes) is
the missing belt-and-braces (§5.2.6).

### 4.2 Playback & the master clock

`rig.masterMs` (audio.js:226) is THE playhead; `VB.audioNow/Seek/
IsPlaying` the surface (`audioSeek` is a no-op while playing — callers
must stop first, and do). Two transports guard each other manually:
scene-loop `startPlay` (rAF, modulo frameCount, journals the landing
frame on stop) and sequence `startSeqPlay` (audio drives the clock when
clips exist, rAF+`audioSeek` when silent; repositions scene/frame
directly during playback — view-only — then pins `sceneSelect` +
`frameSelect` ops on stop). `seqMasterFrame = floor(audioNow/frameMs)`;
scrubs in any timeline `audioSeek` the clock. Composite follows because
every playback/scrub path funnels through `refreshTimeline`, whose tail
calls `CompositeView.sync()`; `frameSignature` is identity-based (scene
index + per-layer frames + instance transforms), so content edits rely
on `docChanged → refresh → dirty`. Space = interceptor chain
(`VB.audioSpaceIntercept`, first-true wins: boards animatic, pitch
present, then the sequence transport in every non-stub workspace).

### 4.3 Audio

Import → package unit → `decodeAsset` (whole-unit read,
OfflineAudioContext decode — headless-safe, dedup via `pending`,
AssetCache-claimed with re-decode evict) → peaks pyramid (512-sample
min/max bins). Playback: per-clip BufferSource+gain scheduled at
`ctx.currentTime+0.03`, rAF derives `masterMs`. Export:
`audioExportStream` schedules the same clips into a
MediaStreamDestination. Bake: OfflineAudioContext(2ch, 48kHz) →
16-bit WAV → `assets/audio/master.wav`. Decoded PCM is explicitly
non-deterministic across engines — determinism lives in ops, never in
rendered PCM.

### 4.4 Render backends

Oracle Canvas2D (render.js): Flash paint order (fills by style index,
then strokes, hairline floor, text last), exact SWF gradient matrices;
`VB.paintFill` is the shared composition truth. Pixi v8
(pixi-render.js): no ticker — rendered from the app's rAF; freshness by
CONTENT HASH, never invalidation call sites; fills rasterized through
the oracle painter into cached sprites (post-erase even-odd parity
defeats triangulation), strokes stay vector, text containers get cheap
matrix moves; hairlines rebuild past 2% zoom drift. three.js
(composite.js): planes over placement records (our records stay truth),
CanvasTextures keyed by cell identity + pixi hash, continuous render
loop but rebuild only via sync/dirty. Parity gate: 8 fixtures including
userlog30 mid-erase states and an eviction-rebuild pixel-identity
check; >48-value pixel diffs counted, zero tolerance on topology-probe
presence.

### 4.5 Export

export.js: settings → offscreen canvas `captureStream(0)` + manual
`requestFrame()`; audio track merged into the MediaStream; `setInterval`
at export-fps maps export time → master frame `floor(f/fps ×
projectFps)` (film speed independent of export fps); flat = oracle
letterboxed, composite = `renderInto` via a preserveDrawingBuffer
renderer; playhead saved/restored around the run; never journals; audio
failure exports silent rather than aborting. Wall-clock pacing means a
slow frame drifts timing (frames stay correct) — the deterministic
offline renderer remains the planned second slice.

### 4.6 Test battery

- `test.html`: ~37 sections, 794 checks green — geometry through
  package/session/swath-union; user-log replay with per-op integrity
  and erase coverage-diff ("fills may only vanish within reach of the
  erase path").
- `pixi-parity.html`: 23 checks (needs `--use-angle=swiftshader` +
  fresh profile headless).
- `shell.html`: 23 checks — remount tripwire (stable canvas count,
  AssetCache resident 0 on homescreen), package flush/reopen, reload
  survival, zip round-trip; IDB keepalive tick under virtual time.
- Boot gate: `index.html#demo` status line. Flood gate: the harness
  lived in an expired session scratchpad and needs re-vendoring into
  `app/test/` (§5.1.10).

### 4.7 Async/race inventory

Guarded: pixi create-after-unmount (generation token), audio decode
dedup (`pending` map), in-frame eviction exemption (`frameStart`),
stale-evict guards on pixi cells, route serialization + awaited
route-away flush, prefetcher dedup/cancel. Unguarded/accepted:
`beforeunload` flush un-awaited (last ≤600 ms can be lost on hard
close); composite texCache prunes only at unmount (§5.1.6); global
AssetCache lets audio decodes evict render caches under pressure
(§5.2.5); export pacing drift (§4.5).

---

## 5. Consolidated defects & open questions

### 5.1 Defects — fix these before they bite (ranked)

1. **`symbolRename`/`symbolRemove` op-name collision** (actors.js vs
   library.js — §2.3). Rename the actor family
   (`actorSymbolRename/Remove`) and keep a replay shim that routes the
   old name by payload shape (`op.id` → library, `op.actor` → actors).
   Must land before the Actors panel gains rename/remove UI.
2. **Scene ids are index-derived** (`"scene@"+length`) — delete-then-
   add can alias an id still referenced by sequence/cast. Migrate to
   `actorNewId`-style random ids with legacy acceptance on replay;
   blocking for scene deletion.
3. **Journal payload bloat**: the `load` op embeds whole files as
   base64 forever. Extract to asset units (the audio pattern) or add
   segment compaction.
4. **Asset-unit GC**: `audioRemove` orphans `assets/audio/<id>`;
   `VB.projectAssets` needs delete + a sweep at flush.
5. **`resolveEditCell` silent null**: a deleted edit target drops the
   app back to the scene without a journaled `editTargetClear` —
   record one when detected.
6. **Composite `texCache` leak**: keyed by cell object identity, pruned
   only at unmount; undo/scene churn accumulates textures. Sweep
   against the live cell set on `sync`.
7. **Secondary-canvas DPR blur** (scratch/seq-strip/step-grid/boards/
   audio) — multiply by devicePixelRatio like the main stage.
8. **Durability**: request `navigator.storage.persist()`; surface
   quota errors from the flush chain instead of swallowing.
9. **`sceneSpan` duplicated** (project.js:284 vs stepseq.js:72) —
   collapse to one.
10. **Flood gate harness** is not in the repo (expired scratchpad) —
    recreate as `app/test/flood.html` so the 5-gate battery is fully
    reproducible from a checkout.

### 5.2 Open implementation questions

1. **When to materialize per-section package units** (the §3 tree).
   Everything downstream of streaming waits on this: range reads need
   units worth ranging into. Recommended trigger: land it WITH Roughs
   frame-docs (the first data that hurts), not before.
2. **Undo snapshot scaling**: 64 × whole-project deep copies. Options:
   per-section snapshot scoping (Arch §4 already wants per-section
   undo), or journal-index undo (replay-to-N with periodic keyframes).
   Decide before multi-scene productions get heavy.
3. **`docChanged` fan-out cost**: every op refreshes every mounted
   view. Fine today; needs dirty-scoping (section tags on ops exist in
   spirit — use them) before Roughs playback + big casts.
4. **AssetCache class budgets**: one global LRU means audio can evict
   render caches. Consider per-class sub-budgets under the one global
   number.
5. **Live-union equivalence tripwire** (§4.1): assert edge-set hash
   equality live-vs-replay for freehand ops behind a debug flag; run in
   the battery permanently.
6. **Deterministic offline export**: WebCodecs VideoEncoder + muxer
   (mp4/webm) rendering frame-by-frame off the clock would make exports
   journal-revision reproducible and faster-than-realtime; MediaRecorder
   stays the fallback. This also unlocks the export shelf (test vs
   finished) from Arch §2.
7. **Export camera as document truth**: `vb-cpcam` (fov/aspect) is
   localStorage view state, but framing decides the export — promote to
   journaled per-scene camera ops (already on the Composite roadmap).
8. **Workerization**: audio decode + zip inflate + thumb renders are
   main-thread; workers require the localhost dev flow (already
   supported by launch.bat) — schedule with the streaming activation.
9. **Language layer**: `session.language` from Arch §4 is absent; only
   the Lines id-hook discipline in Writing keeps the door open.
10. **Theme routing**: hard-coded canvas colors (§3.7) must move to
    tokens before `.theme` packages.

### 5.3 Architecture-level opens (tracked in Architecture.md §11)

Language-switched downstream tracks; scene z-model (2D order vs 2.5D
planes); three.js scope (renderer-over-records position is holding —
composite.js never made three.js the model); the four §5.5 streaming
platform questions; Roughs/Audio consolidation; Grading pass-stack
model (CapCut-style lanes over the 2DMaterials effect model — nothing
built yet).

---

## 6. The native iPad plan (rung 1 — concrete)

Position (Architecture Appendix A, standing): **option A** — a native
App Store app whose engine is today's JS running in WKWebView (the only
JIT context Apple grants), with one targeted hybrid: a native Metal
overlay for the LIVE STROKE PREVIEW only, fed by predicted touches.
Committed geometry, journal, and baselines stay bit-exact. Option C
(Rust core, ruffle-adjacent) remains the recorded end-game if the suite
outgrows A; today's app would be its validation oracle.

### Phase N0 — iPad-readiness at rung 0 (browser, NOW, no Mac)

Everything in §3.6, plus durability — each is battery-gateable today:

1. Two-finger pan + pinch zoom on every canvas (multi-pointer tracking
   on the existing pointer handlers; pen draws, one finger draws or
   pans per a setting, two fingers always navigate).
2. Long-press (~500 ms, <8 px drift) opens every `contextmenu` menu.
3. Replace `prompt/confirm/alert` with in-DOM dialogs (they block the
   event loop and look foreign on iPad).
4. DPR-correct secondary canvases (§5.1.7).
5. `env(safe-area-inset-*)` in dock/statusbar/float clamp math; test
   portrait 768–834 pt widths (racks may need to default closed there).
6. `navigator.storage.persist()` + quota surfacing (§5.1.8).
7. Pencil-ready brush: map `PointerEvent.pressure` to brush radius
   behind a toggle — the op still records final geometry, so
   determinism is untouched; testable now with any pressure device.

Exit gate: the full battery green + a hands-on pass in iPad Safari
(the app already runs there over localhost — Phase N0 is done when it
runs WELL there).

### Phase N1 — prerequisites

- **A Mac with Xcode** (the one hard new toolchain requirement —
  currently Windows + Python 3.13 + Git only). CI builds can run on
  GitHub Actions macOS runners once certificates exist, but
  development and device debugging want one physical Mac + an iPad
  with Pencil.
- Apple Developer Program membership; bundle id; signing certs.
- Repo layout: `ios/` (Xcode project, Swift shell) alongside `app/`
  (the engine, shipped verbatim as a bundle resource folder). One
  repo, one engine — the browser build stays the dev/oracle/CI
  environment forever (Arch §10).

### Phase N2 — shell skeleton ("hello, engine")

- SwiftUI app, one full-screen `WKWebView`. Configuration:
  `allowsInlineMediaPlayback`, empty
  `mediaTypesRequiringUserActionForPlayback` (audio transport),
  `isInspectable` on dev builds (Safari remote debugging).
- **Serve `app/` through a `WKURLSchemeHandler`** (e.g. `y2k://app/…`)
  rather than `loadFileURL`: it gives a stable origin (IndexedDB/
  localStorage survive), and — decisively — the handler can answer
  HTTP **Range** requests, which makes the native side a ChunkSource
  backend for free: the JS `fetch(url, {headers:{Range}})` path IS the
  §5.4 bridge, no message-port copying. (Measure throughput here —
  Arch §5.5 Q2 — before trusting it for audio windows.)
- Lifecycle: `scenePhase` → flush journal on background;
  `isIdleTimerDisabled` during playback/export.
- Exit gate: boot gate + suite + shell gates run green INSIDE the
  WKWebView (they are just HTML pages — add a debug menu that loads
  them and reads the DONE title).

### Phase N3 — the bridge (defined once, in the repo)

`app/js/bridge.js`: feature-detected facade over
`window.webkit.messageHandlers` with a browser fallback, exposing:

| Surface | Native side |
| --- | --- |
| `bridge.files` — package list/create/delete, unit read/write, range read | app Documents dir; the PackageStore gets a third backend (bridge-native) beside IndexedDB |
| `bridge.share(blob, name)` | UIActivityViewController (`.y2kproj`, videos, `.y2kactor`) |
| `bridge.import(types)` | UIDocumentPickerViewController |
| `bridge.memory` — pressure events, device budget | `didReceiveMemoryWarning` → shrink `VB.assets` budget + flush; device-class budget replaces the 256 MB placeholder (Arch §5.5 Q4) |
| `bridge.haptics` (optional) | UIFeedbackGenerator on snaps |

**Storage moves to native files** — this is the point of rung 1:
IndexedDB inside WKWebView is evictable and invisible to the user;
`.y2kproj` becomes a real document package in Documents (visible in
the Files app via `UISupportsDocumentBrowser` /
`LSSupportsOpeningDocumentsInPlace`, iCloud Drive syncable). IndexedDB
backend remains for the browser rung. This forces §5.1.3/§5.2.1
(journal bloat, per-section units) to be resolved first or alongside —
small addressable units are what makes Files/iCloud sync cheap.

### Phase N4 — input

- Pencil: WKWebView already delivers pointer events with `pressure`,
  `tiltX/Y`, `pointerType:"pen"` — the N0 pressure work lights up
  as-is. Add palm rejection (ignore `touch` pointers while a `pen`
  pointer is active) and pen-draws/fingers-navigate mode.
- Pencil hover (M2+) → cursor preview; double-tap tool switch via
  `UIPencilInteraction` in the shell, bridged to `selectTool`.
- Keyboard: iPad hardware keyboards work today; add `UIKeyCommand`
  passthrough only if WKWebView swallows anything (Space, Ctrl/Cmd-Z).

### Phase N5 — the Metal live-stroke overlay (the pen-feel hybrid)

- A transparent `CAMetalLayer` view OVER the webview, activated only
  while a drawing tool is armed (the bridge tells native which tool is
  active). It consumes touches during a stroke: renders the preview
  ribbon from **coalesced + predicted touches** (the ~1–2 frame win
  WKWebView cannot give), and forwards the coalesced points to JS.
- On pen-up, JS commits the journaled op from the forwarded points
  exactly as today; native clears when JS confirms the committed
  render. The uncommitted-overlay/journaled-commit seam already exists
  in the tool code — this swaps who draws the overlay.
- **Gate**: a stroke parity test — same recorded gesture through the
  pointer-event path and the forwarded-native path must produce the
  identical op point list (byte-equal journal), or the overlay ships
  disabled. This phase is OPTIONAL for launch; A-without-it is already
  correct, just ~a frame laggier than Procreate.

### Phase N6 — hardening + App Store passage

- Memory: adaptive `VB.assets` budget by device; respond to pressure
  events; Instruments passes over playback + export; watch the
  WKWebView content-process jetsam ceiling with production-scale
  projects.
- Files: exported UTI for `.y2kproj`/`.y2kvector`/`.y2kactor`; share
  sheet registration; document icons.
- Review readiness: extensibility is already data-only (NoteObject
  packs, themes, actors — Arch §10 chose this partly for review
  safety); privacy manifest (no tracking, local files only); export
  compliance (none — no proprietary crypto).
- TestFlight loop with the on-device gate menu (Phase N2) as the
  acceptance bar per build; the browser battery remains CI.

### Sequencing & effort shape

N0 interleaves with feature work now (it is ordinary battery-gated
rung-0 work). N1+N2 is the first milestone ("the engine boots native,
gates green on device"). N3+N4 is the real product milestone
(native files + Pencil — TestFlight-able). N5 is a quality option
behind a parity gate. N6 is continuous from N3 onward. The single
biggest technical risk to retire EARLY is scheme-handler range-read
throughput (N2 exit measurement) — it decides whether audio/frame
streaming rides fetch-Range or needs an OPFS mirror fallback (Arch
§5.5 Q2).

### The end-game contingency (recorded, not scheduled)

If pen latency or memory ceilings ever force option C: the Rust core
(ruffle-adjacent SWF machinery, wgpu renderer, Skia-PathOps or ported
paper.js booleans) is validated AGAINST this app — every user log, the
flood baselines, and the parity fixtures become its acceptance suite.
The `skia-pathops/` and `ruffle/` checkouts at repo root are the
research trail for that decision. Nothing in rung 1 forecloses it.
