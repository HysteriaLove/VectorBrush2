# VectorBrush2 — Application Architecture

Status: PLANNING. This document fixes the shape of the full application —
an iPad-first, team-capable animation suite that takes a production from
brainstorm to finished export. It records what is DECIDED, what is
PROPOSED (recommendation, changeable), and what is OPEN (needs a call
before the section is built). The drawing engine that exists today (planar
map, paper.js booleans, face-walk mask, pixi renderer, 2DMaterials,
command journal) is the foundation everything below reuses — nothing here
replaces it.

Workflow reference: `D:\DriveDProjects\Animation Program V2` (PyQt
prototype). Its concepts — master timeline as a sequence of scene
instances, scenes as sub-timelines, actor = poses → symbols → drawings,
portable `.actor` interchange, Blender compositing bridge — are adopted
here and cited per section.

---

## 1. Principles (carried over from the editor, now app-wide)

1. **One command journal per project.** Every mutation in every section is
   a named op through the registry (`VB.defineOp`/`applyOp`). Live dispatch
   and replay share one code path, so live/replay divergence is impossible
   by construction. This is already true for the drawing editor; the
   project shell extends the same registry with section-scoped ops
   (`writing.*`, `board.*`, `audio.*`, …). Undo/redo, crash recovery
   (journal tail replay), bug reports (exported journals), and — later —
   collaboration (op streams merge better than state blobs) all fall out
   of this one decision.
2. **Sections are views, not silos — in two tiers.** There is exactly ONE
   project model, and no section keeps a private copy of shared state.
   But not everything rides the clock (user clarification, 2026-07-09):
   - **Upstream producer sections** — Brainstorm, Writing, Storyboards,
     Audio — are not clock-synced editors. They produce artifacts and
     data the pipeline consumes: Audio's job is to bake THE master audio
     track; Writing produces Lines; Storyboards produce timed panels.
   - **The clock-synced pipeline** — Roughs, Actors (as placed),
     Compositing, Post, Export — shares the master clock and a strict
     dependency chain: Roughs establish the scene sequencing everything
     downstream addresses; Compositing depends on Actors (the assets)
     AND on their sequencing data; Post depends on Compositing's
     decisions; Export consumes the lot plus the baked master audio.
   The dependency DAG, not a global sync, is the contract: each section
   declares what upstream slices it reads, and edits upstream invalidate
   downstream views by id — never by copying data down the chain.
3. **The drawing engine is a component.** The current editor (canvas +
   pencil/brush/bucket/eraser/arrow/text + materials + pixi surface)
   becomes an embeddable `DrawingSurface` that Brainstorm, Storyboards,
   Roughs, and Actors instantiate against different backing documents.
   One geometry core, one renderer, one battery of tests.
4. **Deterministic and gated.** The oracle discipline (Canvas2D truth,
   pixi validated against it) and the battery-gate rhythm stay. New
   sections ship one at a time behind the same kind of gates.
5. **Multiplatform model, iPad-first target.** The App/Document object
   model and every section view are built platform-neutral; nothing in
   the model layer may assume a platform. The ladder is DECIDED: the
   suite is prototyped in the app's CURRENT browser form first, then
   ships as a native iPad App Store app, then Windows, macOS, Linux
   (native or Electron-class shells, chosen per platform). iPad's
   constraints (touch + Pencil input, memory ceilings, sandboxed files)
   set the floor every platform benefits from (see §10).
6. **Streaming, not loading.** The suite is data-heavy in every view —
   audio stems, bitmaps, onion-skin frame runs, scene renders, exports.
   Views subscribe to windows of data and the streaming layer feeds them
   incrementally; whole-resource loads are the exception that must be
   justified, not the default (see §5 — Streaming architecture).

---

## 2. Application shell (DECIDED, layout details PROPOSED)

```
App
├─ Homescreen
│  ├─ Projects list  — groupable (by project / series), group artwork
│  ├─ Test Exports   — scratch renders, auto-pruned shelf
│  └─ Finished Exports — curated deliverables
└─ Project workspace (one open project)
   ├─ Sketchbook │ Pitch │ Story │ Boards │ Audio
   ├─ Roughs │ Actors │ Composite │ Grading
   └─ Export
```

- The homescreen owns a **project index** (id, title, group/series id,
  cover graphic, last-opened, export shelf entries). Groups are folders
  with artwork — a series is a group whose children sort by episode.
- **Test vs Finished Exports** are the same artifact type with a
  different shelf and retention policy: test exports are cheap, listed
  newest-first, and prunable; finished exports are explicit promotions
  with a name and a lock. Both record WHICH journal revision they were
  rendered from, so any export can be reproduced or diffed later.
- Section navigation inside a project is a persistent rail (the ten
  sections in production order — tab names: Sketchbook, Pitch, Story,
  Boards, Audio, Roughs, Actors, Composite, Grading, Export; decided
  2026-07-10). Sections lazy-load: opening a project
  loads the manifest + the section you enter, nothing else (§5).
- **`.theme` reskinning (DECIDED, future).** The whole UI — homescreen
  and every section view — is reskinnable via `.theme` packages, built
  mostly on slice-9 skinning, with a skin repository for distribution.
  Architectural consequence NOW: views never hard-code chrome; layout +
  appearance resolve through a theme lookup (default theme built in), and
  slice-9 assets are just images, so themes are data-only packages like
  NoteObject packs. Theme format details deferred until the shell exists.

---

## 3. Project data model — the spine (PROPOSED)

The reference prototype validates the shape (Managment.py `Project`):

```
Project
├─ meta            — title, fps, language list, cover, ids
├─ notes           — Sketchbook canvas (infinite, NoteObjects)
├─ pitch           — sequential pitch slides (y2kvector cells)
├─ writing         — documents → dialogue Lines (line-id, per-language text)
├─ boards          — storyboard panels, grouped by beat, timed
├─ audio           — stems, edits, baked master(s)
├─ sequence        — MASTER TIMELINE: ordered SceneInstances
│    └─ Scene      — a sub-timeline: rough passes, actor placements,
│                    camera/comp clips, per-scene tracks
├─ actors          — Actor = poses → symbol groups → drawings (y2kvector docs)
├─ compositing     — per-scene: placement/camera/background arrangement
├─ post            — per-scene + global: effect graphs (2DMaterials-based)
└─ exports         — recorded renders (revision, settings, artifact ref)
```

- **The master timeline is a sequence of scene instances** (reference:
  `Project.scene_sequence` / `scene_sequence_clips`). A `Scene` is
  established in Roughs and is itself a timeline; instancing a scene into
  the sequence gives it a start and duration on the master clock. Roughs,
  Actors (as placed), Compositing, and Post all address time as
  `(sceneInstance, localFrame)`; the master clock derives from the
  sequence. Audio's baked master aligns to the master clock. (Exact
  Sequence/Roughs UX to be studied when the section is built — DECIDED
  only that Roughs determine scenes.)
- **Everything has a stable id** (`scene_xxxx`, `actor_xxxx`, `line_xxxx`
  — reference convention). Cross-section references are by id, never by
  index or text, so renames and reorders never break links.
  **Prototype/instance model (DECIDED):** ids follow the Flash symbol
  discipline — a definition (prototype) has a uuid, every placement is an
  INSTANCE with its own uuid pointing at the prototype. Interaction
  controls (future) attach to instances; edits to the prototype flow to
  all instances. Scene instances already work this way; actors, symbols,
  NoteObjects, and boards adopt the same two-level id shape from day one.
- **The object library (DECIDED 2026-07-10):** scenes and actors are data
  containers (the reference model), and SYMBOLS are the third container
  type: any marquee/lasso selection can be right-clicked → "Convert to
  Symbol", which materializes its self-contained clip into a library cell.
  BACKGROUNDS are the fourth kind — stage-sized backdrop containers.
  Actors, symbols, and backgrounds live together in the Library panel;
  entries can be deleted (a management system for instances — including
  delete-all-instances — comes later, with instantiation). Library cells
  are ordinary y2kvector docs edited through the journaled editTarget, so
  the whole tool suite and byte-exact replay apply for free.
- **Boards are INFINITE canvases (DECIDED 2026-07-10):** no drawing
  surface is a fixed-frame canvas — every board (Sketchbook, Roughs,
  Actors, scene cells) is unbounded, with NO frame drawn (the export
  frame was judged redundant there); FRAMING is the Composite camera's
  job. Composite and Grading are three.js scenes hosting actors,
  symbols, and backgrounds (three.js r159 vendored at
  app/vendor/three.min.js — UMD, MIT). Grading IS the compositing view
  for now; the pass stack grows inside it. Pitch, Story, Boards, and
  Audio keep their own surface shapes. (Open: Roughs may consolidate
  with Audio.) The stage width/height persists in the model as the
  SWF-export frame definition only.
- **All vector art is a y2kvector document** (the planar map engine we
  already have — the in-code `VBDocument` class and the current `.vbd`
  codec are renamed to y2kvector, extension `.y2kvector`, when the shell
  lands; a codec version bump covers the magic change). Symbol drawings,
  rough frames, storyboard panels, brainstorm sketches are all y2kvector
  files, so the materials library and the whole tool suite apply
  everywhere for free. Bitmap support INSIDE y2kvector (embedded bitmap
  fills/objects, Flash-style) is planned for later; the format reserves
  tag space for it now.
- **Data formats are y2k-branded (PROPOSED palette):** project package
  `.y2kproj`, vector document `.y2kvector`, portable actor `.y2kactor`,
  note pack `.y2knotes`, UI skin `.theme` (user-named). Names are cheap
  until formats freeze; the extension registry lives in the manifest so
  renames stay one-line.

### On-disk format: a package folder, not a monolith

Reference validated this too (`project.json` + mirrored folders). One
JSON blob does not survive a 40-scene production on an iPad: partial
load, autosave granularity, and team sync all want per-unit files.

```
MyShow.y2kproj/
  manifest.json        — meta, section index, format versions
  journal/             — op log, segmented (crash recovery, bug export)
  notes/board.json     + notes/assets/…
  writing/doc-*.json
  boards/board-*.json  + boards/art/*.y2kvector
  audio/stems/…        + audio/master-*.m4a + audio/edits.json
  sequence.json        — scene instances, master tracks
  scenes/scene-*/      — scene.json + roughs/*.y2kvector
  actors/actor-*/      — actor.json + drawings/*.y2kvector
  compositing/scene-*.json
  post/…
  exports/index.json   + artifacts…
```

- Load = manifest + entered section; a background indexer warms the rest.
- Save = journaled ops flush to the touched files only (autosave-friendly,
  Files-app/iCloud sync writes small deltas).
- The package layout is deliberately **streaming-shaped**: many small
  addressable units instead of few big ones, so the streaming layer (§5)
  can pull exactly what a view's window needs.
- Interchange formats stay separate from the package: `.y2kvector`
  (drawing), `.y2kactor` (portable actor, reference format v3 — ids
  regenerate on import), and later `.y2knotes` (NoteObjects, §6.1).

---

## 4. Runtime architecture (PROPOSED)

```
Shell (homescreen, project rail, section router)
└─ ProjectSession
   ├─ store      — the loaded model slices (lazy per section)
   ├─ journal    — op log + undo stacks (one per section FOCUS,
   │              global order preserved)
   ├─ clock      — master frame, playback state, scene mapping
   ├─ language   — active language, line resolution (§6.2)
   └─ sections[] — mounted section frontends
```

- **Ops carry a section tag.** Undo is per-section-focus (undoing a
  writing edit from inside Roughs would be chaos) but the journal is one
  globally-ordered stream, so replay reconstructs the whole project.
- **The clock is owned by the session, not a section.** Play/scrub in any
  synced section drives the same clock; every mounted synced view renders
  the same frame. Preview composition (roughs over boards over audio
  waveform, etc.) is a render-graph question, not a data question.
- **DrawingSurface** = the current editor packaged: takes a y2kvector
  document + materials + tool palette config, emits ops. Sections
  configure it down as well as up (Brainstorm: no onion skin; Roughs:
  onion skin + frame rail, NO material brushes, minimal fixed layer
  setup; Actors: symbol nesting breadcrumb, full materials; Storyboards:
  panel-sized fixed canvas).
- Rendering stays pixi for all canvas/drawing surfaces (established
  directive); regular UI/GUI is DOM until further notice.

---

## 5. Streaming architecture (REQUIRED — the app breaks without it)

Every view in this suite is data-heavy: stems and baked masters in
Audio, waveform strips under every timeline, onion-skin frame runs in
Roughs, symbol thumbnail walls in Actors, background plates and scene
renders in Compositing, artifact previews in Export, image boards in
Brainstorm. Whole-resource loading dies at production scale on an iPad.
The reference prototype already streams where it hurts — audio playback
is a pull-model `QIODevice.readData(maxlen)` feeding PCM on demand, and
waveform peaks are computed from fixed-size windowed reads, never a
whole stem in memory. This section generalizes that discipline app-wide.

### 5.1 The contract

- **Views subscribe to windows, not files.** A view declares a window
  over an addressable resource — a time range around the playhead, a
  viewport rect over a board, a scroll range of thumbnails — and the
  streaming layer delivers the units inside it, nearest-first. Scrub,
  scroll, or zoom = window update, not a new load.
- **Streaming is caching, never truth.** The journal and ops NEVER
  depend on what happens to be resident. A missing chunk delays a
  pixel/sample, it cannot change geometry, timing, or an op's result —
  determinism and replay stay exact regardless of residency. (This is
  why streaming lives under the store, not inside sections.)
- **Every streamed surface has a placeholder ladder**: empty → cheap
  proxy (solid/blurhash/peak-outline) → full quality. Views render at
  whatever rung is resident; the prefetcher climbs rungs in priority
  order. No view ever blocks on I/O.

### 5.2 The pieces

```
ChunkSource   — range reads over package files (Blob.slice / OPFS /
                native bridge on iPad); all reads are (unit, range)
Decoders      — workerized: audio PCM windows, image/bitmap decode
                (createImageBitmap), y2kvector parse, waveform peaks
AssetCache    — one LRU per asset class under an explicit global
                memory budget (raster sprites + matcap buffers join it)
Prefetcher    — single priority queue; priority = f(distance to
                playhead/viewport, rung, section focus); playback
                registers a lookahead window that outranks everything
Proxy store   — persisted derived data: waveform peak tiles, thumbnails,
                blurhashes — computed once (background, workerized),
                saved in the package next to their source, invalidated
                by the source unit's journal revision
```

### 5.3 What streams where (first inventory)

| View | Unit | Window | Proxy rungs |
| --- | --- | --- | --- |
| Audio edit/playback | PCM windows per stem | playhead ± lookahead | peak tiles → PCM |
| Timeline strips | waveform peak tiles | visible frame range | coarse → fine tiles |
| Roughs | frame y2kvector docs | current ± onion depth ± playback lookahead | bbox ghost → parsed doc |
| Actors | symbol drawings + thumbnail wall | active drawing + visible thumbs | thumb → full doc |
| Compositing | plates, placed actor art, scene renders | scene ± 1 | blurhash → bitmap |
| Storyboards | panel art | visible panels ± row | thumb → full doc |
| Brainstorm | images, sketch patches | viewport rect ± margin | blurhash → full |
| Export | encode pipeline | render frame cursor | n/a — pipelined, never whole-movie in RAM |
| Homescreen | covers, shelf previews | visible cells | thumb only |

- **Playback is the hard client**: at 24fps the prefetcher must keep the
  lookahead window fed across audio + frames + plates simultaneously;
  when it can't, playback degrades rung-by-rung (proxy frames, coarse
  audio) instead of stuttering the clock.
- **Export is a stream end-to-end**: render frame → encode → append to
  artifact; buffers recycle. Whole-movie memory residency is forbidden.

### 5.4 Platform backends

One `ChunkSource` interface, one backend per shell (§10 ladder): browser
dev build = `File.slice`/OPFS; iPad native app = native file bridge
(WKWebView message-ports for range reads — measured before trusting,
see OPEN); desktop shells (Windows/macOS/Linux, Electron or native) =
direct filesystem range reads, the easy case. The model layer sees none
of this (multiplatform principle, §1.5).

### 5.5 OPEN questions — streaming

1. Audio playback transport on iPad: Web Audio + worker-fed ring buffer
   (AudioWorklet) vs `<audio>`/MediaSource over the baked master —
   worklet is the flexible one, MSE the cheap one; measure both in the
   wrapper early (this decides part of the Audio section design).
2. WKWebView bridge throughput for range reads (message-port copy cost)
   — if too slow, fall back to OPFS mirroring of the open project.
3. Proxy generation timing: at save (deterministic, costs save latency)
   vs background daemon (needs invalidation bookkeeping). Leaning: at
   op-flush for the touched unit, background for bulk import.
4. Global memory budget number(s) per device class, and whether the
   budget adapts (iPadOS jetsam pressure events via the wrapper).
5. y2kvector partial parse: is a bbox+fill-census header worth adding to
   the codec so ghosts render without full parse? (Cheap to reserve in
   the header now — decide when Roughs is built.)
6. Journal segmentation size vs streaming granularity — segments should
   align with section files so warm-load of one section doesn't replay
   unrelated ops.

---

## 6. Sections

(Brainstorm, Writing, and Audio carry a shared caveat from the user
review: fine as sketched, details will be understood when each is
actually built. The DECIDED/PROPOSED markers below respect that.)

### 6.1 Sketchbook (brainstorm)

- Infinite canvas; content = placed objects: images, text notes, sketch
  patches (small y2kvector docs), and **NoteObjects**.
- **NoteObject = declarative package, not code.** A pack ships JSON:
  schema (fields/types), layout (composition of built-in primitives:
  text, checklist, table, image well, link-to(line/scene/actor), sticker
  art as y2kvector), and optional behaviors chosen from a fixed verb set
  (collapse, checkoff, tally, date-stamp). No scripting — packs stay
  App-Store-safe, sandbox-safe, and forward-compatible. Sellable packs
  are then pure data (`.notepack`).
- OPEN: layers on the brainstorm canvas. Recommendation: no layers —
  z-order + grouping + lock/pin (reference boards use lock/pin and it is
  enough there); revisit only if real boards drown.

### 6.2 Pitch

- A simple SEQUENTIAL set of slides used to demonstrate the idea to
  team members (user-specified, 2026-07-10) — the bridge between loose
  Notepad material and the written story.
- Each slide is a y2kvector cell drawn with the stage tools (the same
  journaled editTarget mechanism as actor cells and the Notepad
  canvas), so slides are vector-native and replay byte-exact. Slides
  order by array position; add/remove/reorder are journaled ops.
- A minimal Present mode plays the deck full-frame with arrow-key
  navigation. Future: speaker notes, slide export (PDF/video to the
  Test Exports shelf), and pulling reference images from the Notepad.

### 6.3 Story (writing)

- Documents (script, outline, loose notes) made of blocks; dialogue
  blocks own **Line objects**: `line_id → { character?, per-language
  text, revision }`.
- **Lines are the language backbone of the whole app.** Storyboards (and
  later lip-sync in Actors, subtitle export in Export) reference
  `line_id`. Switching project language re-resolves every reference live
  — text now, audio later via per-language stem sets tagged with the same
  line ids (RISKY per user note — architecture reserves the id hook, the
  feature ships much later).
- Editing a line from any section (e.g. from a storyboard panel) is the
  same `writing.lineEdit` op — there is one source of truth, so
  "editing storyboard writing changes writing docs" is automatic.

### 6.4 Boards (storyboards)

- **Panel** = one y2kvector drawing + optional line refs + duration +
  notes. Panels with NO text at all are first-class (user note); lines
  are attachments, never a required field. **Beat group** = ordered
  panels under a label (reference: boards + timeline clips). Board
  timeline = ordered beats; playable as an animatic: panels held for
  their duration, scratch audio underneath (basic slideshow support —
  DECIDED as in-scope).
- Line flow is TWO-WAY: panels fetch existing Lines from Writing, and a
  line drafted on a panel can be **sent back** to a writing doc (it is
  the same `writing.*` op family either way — the Line store is the one
  source of truth, panels and docs are both views of it).
- Panels can be promoted later: "send to scene" seeds a Scene's rough
  pass with the panel art as a locked reference layer.
- The animatic is the project's first export artifact (Test Exports
  shelf) and the timing seed for Roughs: establishing scenes from beats
  copies beat durations into scene instance durations.
- FLAGGED TRICKY (user): board arrangement, categorization, and ordering
  UX has real unknowns — expect this section's information architecture
  (grid vs corkboard vs timeline-first, beat nesting depth) to be worked
  out during development, not up front.

### 6.5 Audio

- Stems (imported files) → non-destructive edit list (trim, gain, fade,
  placement on tracks) → **bake** to a master (reference README:
  "load audio stems to create or bake a master"). The master is what
  synced sections scrub against; stems remain for re-bakes.
- Own mini-suite: track lanes, waveforms, snap-to-frame; no plugin/DSP
  ambitions in v1 beyond gain/fade/pan.
- Baked masters are per-language when language-tagged stems exist (the
  reserved hook from §6.3); default is one master.

### 6.6 Roughs

- **Scenes are established here, by the user** (DECIDED — per the
  Animation Program V2 workflow). A Scene is a sub-timeline (reference:
  `Scene` + `SceneInstance`): rough animation passes (frame-by-frame
  y2kvector docs with onion skin — reference
  `SceneAnimation`/`CanvasAnimationFrame`), board references, and the
  scene's slice of the audio master.
- Roughs cover the WHOLE master track: the sequence editor (order scenes,
  set durations, insert holds) lives at the top of this section.
- A rough pass is cheap and disposable by design: flat drawing frames
  with a **small fixed layer count** (user: limited layers for drawing),
  no actors, no material brushes — the point is timing against audio.

### 6.7 Actors

- Actor = canvas size + **poses → symbol groups → drawings** (reference
  `Actor/Pose/Symbol/SymbolDrawing`, .actor format v3). Drawings are
  y2kvector docs; symbols nest (eyes → pupils; mouth → phoneme set).
- Edited here as a library (no timeline); PLACED into scenes with
  pose/symbol tracks driven per scene instance (reference: character
  tracks on `SceneInstance`, NLA/step-sequencer editors). The placement
  and track editing UI lives with the timeline in Compositing; the asset
  and its art live here.
- `.y2kactor` import/export from day one (marketplace-shaped, like
  NoteObject packs; ids regenerate on import per the reference spec —
  reading the prototype's `.actor` v3 files is a cheap compatibility
  importer worth keeping).

### 6.8 Composite (compositing)

- Per scene: actor placements (position/scale/rotation in 2D, reserved z
  for 2.5D), backgrounds, camera (a transform track over the scene),
  actor pose/symbol/visibility tracks on the scene timeline.
- This is the section that owns "what the frame actually shows"; its
  render graph consumes Actors (art), Roughs (as toggleable underlay),
  and Audio (clock).
- **three.js integration is probable** (user direction) for the
  camera/space/plane work. Position taken here: our placement records
  stay the document truth and three.js is a RENDERER/inspector over
  them, never the model — journal determinism and exports must not
  depend on a library scene graph. Scope, render-path coexistence with
  pixi, vendoring, and the oracle story are open (§11.3).
- Blender bridge (reference `blender_compositing_addon.py`): EXPORT-ONLY
  (decided) — camera + placement tracks + plates out; no import.

### 6.9 Grading (post-processing)

- UX shape: a **CapCut-style effects editing area** (user direction) —
  effect clips on lanes over the scene/master timeline, tap to add,
  drag to trim, parameters in a bottom sheet. Approachable first,
  node-graph power later if ever.
- Under it: per-scene and global effect stacks built on the
  2DMaterials/WebGPU model already designed: an effect = a material
  graph over the composited frame (blur, glow, color grade, halftone…),
  with the same deterministic cost profile so artists see "how heavy"
  before they commit (the OperationEstimator applies directly).
- Post never touches geometry — it is strictly frame-space, which keeps
  the oracle discipline intact (CPU reference implementation per effect,
  GPU validated against it, same as matcaps).

### 6.10 Export

- One pipeline, many targets: animatic (video), scene render, master
  render, image sequences, per-actor sheets, `.y2kactor`, Blender bundle
  (§6.8), audio master, subtitle/dialogue sheets from Lines (§6.3), SWF7
  for the classic-Flash interchange goal, and `.y2kvector`.
- Every export = journal revision + settings snapshot → artifact +
  shelf entry (Test or Finished). Reproducible by construction.
- Text-in-SWF export remains permanently out of scope (standing decision).

---

## 7. What already exists and where it lands

| Today | Becomes |
| --- | --- |
| VBDocument planar map + booleans + mask | The y2kvector document engine (renamed), unchanged core |
| Tools (pencil/brush/bucket/eraser/arrow/text) | DrawingSurface component, config per section |
| pixi renderer + Canvas2D oracle + parity gate | DrawingSurface rendering, plus scene compositor base |
| 2DMaterials + matcaps + estimator | Fill materials everywhere; Post effect model |
| Command journal + ops registry | Project-wide journal (section-tagged ops) |
| `.vbd` v4 codec | `.y2kvector` codec (rename + version bump at shell time) |
| history.js snapshots | Per-section undo over the shared journal |
| Suite + flood + parity + boot battery | Grows per section; same gate rhythm |
| Raster sprite / matcap caches | First tenants of the global AssetCache budget (§5.2) |

The current single-canvas app becomes the DrawingSurface embedded in four
sections — it is the hardest part of the suite and it is already built.

---

## 8. Build order (PROPOSED — one shippable slice at a time)

1. **Shell + package format + streaming skeleton**: homescreen, project
   index, package folder, manifest, journal segmentation — and the
   streaming layer's bones (ChunkSource interface, AssetCache budget,
   prefetcher shell, §5.2), because retrofitting streaming under live
   sections is how programs break. The `.vbd`→`.y2kvector` /
   VBDocument→y2kvector rename lands here too. The current editor mounts
   as the only section ("Sketch") so the shell ships around working
   tools.
2. **Actors**: pose/symbol/drawing tree around DrawingSurface +
   `.y2kactor` round-trip; first real streaming client (thumbnail wall).
   (Most reuse, highest value, no timeline dependency.)
3. **Sequence + Roughs**: scenes, master timeline, onion-skinned rough
   passes, playback clock — the prefetcher's playback window proves out
   here.
4. **Audio**: stems → edits → baked master; clock sync; pull-model
   playback + waveform peak tiles (the §5.5 transport decision gates
   this step).
5. **Storyboards + Writing** (paired — lines and panels prove the
   reference model): animatic export → Test Exports shelf lights up.
6. **Compositing**: placements, camera, pose/visibility tracks.
7. **Brainstorm + NoteObjects** (data-only packs).
8. **Post + Export hardening** (effect graphs on the materials/WebGPU
   work; export matrix; Blender bundle).

Each step lands behind the battery + a new section-specific gate, one at
a time, per the standing stability rule.

## 9. Collaboration posture (hooks now, feature later)

Teams are in scope ("teams and creators"), but nothing ships until the
app is production-ready with testers available (user decision). What we
build NOW are only the hooks that cannot be retrofitted: stable
prototype/instance ids, section-tagged deterministic ops, and journal
segmentation. **Files are local** — v1 projects live on-device (synced
by the OS's own iCloud/Files machinery at most). A future project type,
the **"Studio Project"**, will appear on the homescreen alongside local
projects and carry the team/collaboration behavior; it is explicitly out
of scope for now and must not leak requirements into v1 beyond the hooks
above. No CRDT/server work; just don't break id stability or op
determinism, which we already enforce.

## 10. Platform plan (DECIDED ladder)

Ship order (user, 2026-07-09):

0. **Prototype in the current form.** The whole suite is prototyped as
   the app exists today — the browser build, no native shell, no store.
   Sections, formats, journal, streaming, and workflows get proven here
   first; nothing below starts until the prototype has earned it.
1. **iPad — native App Store app.** A real native shell (WKWebView-hosted
   engine inside a native iPad app), distributed through the App Store.
   Not a website, not a PWA.
2. **Windows**, 3. **macOS**, 4. **Linux** — each natively or via
   Electron "or some other solution"; the wrapper choice is per-platform
   and deliberately deferred. Nothing in the model or views may care
   which shell it is running in.

Consequences:

- **One engine, N shells.** Engine and app remain vanilla JS + vendored
  libs (no build step — toolchain constraint stands). Each platform gets
  a thin native shell exposing the same bridge surface: file/range I/O
  (ChunkSource backend, §5.4), share/export handoff, memory-pressure
  signals, window/document lifecycle. The bridge interface is defined
  once, in the repo; shells implement it. The browser build is rung 0
  AND stays the dev/oracle environment and CI gate runner forever — it
  just never becomes a shipping target itself.
- **Prototype honestly.** Rung 0 uses the browser `ChunkSource` backend
  (`File.slice`/OPFS) and a placeholder memory budget — but streaming,
  window subscriptions, and placeholder ladders are REAL in the
  prototype, not stubbed, or rung 1 will surface every shortcut at
  review time.
- **Vendoring is unconstrained.** Packaged apps carry their libraries;
  three.js (or anything else that earns its place) vendors in whole like
  paper.js and pixi did. Trimming is a memory question, not a
  distribution one.
- App Store realities land early on purpose: NoteObject packs, themes,
  and `.y2kactor` files are DATA-ONLY partly because review-safe
  extensibility is a store requirement (no downloadable code).
- Input: pointer events already unify mouse/touch/Pencil. Add: Pencil
  pressure → brush radius (op already records final geometry, so
  determinism is untouched), two-finger pan/zoom, long-press context
  menus, palm rejection via pointerType. Desktop shells inherit the
  mouse/keyboard paths that exist today.
- Memory: per-fill raster sprite caches and matcap buffers get an LRU
  budget (iPad WKWebView process limits set the floor; desktop budgets
  are laxer but come from the same AssetCache knob, §5.2).
- Files: the `.y2kproj` package maps to an iOS document package (Files
  app / iCloud sync friendly); exports register with the share sheet.
  Desktop shells map the same package to a plain folder.
- WebGPU (Post, matcap stage 2b) ships behind capability detection with
  the CPU oracle as the always-available fallback — same policy as today.

## 11. Open decisions

Resolved 2026-07-09 (user review): Brainstorm has NO layers (z-order +
groups + lock/pin). Blender is EXPORT-ONLY — no import direction at all.
Homescreen group graphics and Test-Export pruning policy are deferred to
build time (graphics likely land with the `.theme` work).

Still open:

1. **Language-switched downstream tracks.** Doable per user, but the true
   cost is now understood: every language needs its own actor tracks and
   downstream timelines (lip-sync differs per language), so the compositor
   needs a way to keep per-language actor object tracks in sync — likely
   a base-track + per-language override model where untouched tracks
   follow the base automatically. Id hooks reserved now; design deferred
   until the pipeline sections exist.
2. **Scene z-model in Compositing**: pure 2D draw order vs 2.5D planes —
   `z` reserved in placement records either way; interacts with the
   three.js question below.
3. **three.js in Compositing** (user: integration probable):
   - scope: camera + planes-in-space + Blender-export math only, or the
     actual scene render path? (If it renders, it must coexist with the
     pixi surface — two GL contexts vs render-to-texture into pixi.)
   - does the 2.5D/3D scene graph become the compositing document model,
     or is three.js only a view over our own placement records?
     (Recommendation: our records stay truth, three.js is a renderer —
     keeps determinism, journal, and Blender export independent of a
     library's scene graph.)
   - vendoring itself is a non-issue (packaged apps, §10) — vendor it
     whole like paper.js/pixi; only runtime memory on iPad decides
     whether a trimmed build is worth the maintenance.
   - oracle discipline: what is the CPU/Canvas2D reference for a 3D-ish
     compositor view — full parity like pixi, or golden-frame fixtures?
4. **Streaming (§5.5)**: audio transport on iPad, WKWebView range-read
   throughput, proxy generation timing, memory budgets, y2kvector
   partial-parse header, journal segment alignment.

---

## Appendix A — Native-rebuild options for the iPad app (rung 1 study)

What a "true native rebuild" would mean, recorded so the rung-1 decision
is made against the full option space. Every option is really an answer
to one question: **what happens to the engine we already have?** The
geometry core (planar map, booleans, mask, journal, SWF/y2kvector
codecs) is pure JS with no DOM dependencies, and the correctness
discipline — the paper.js-faithful boolean contract, the flood
baselines, the oracle battery — is welded to it.

Two facts constrain every option below:

- Any native iPad build — including Flutter/RN — requires a Mac with
  Xcode to compile and submit. That is a new dev-machine requirement on
  top of the current Windows/Python/Git toolchain.
- Any move off paper.js booleans (to Skia PathOps, Clipper2, or a
  hand-port) produces DIFFERENT geometry: every baseline and fixture
  resets, and the standing "faithful to paper.js booleans" directive is
  forfeited. The current app stops being an oracle and becomes a spec.

### The options

**A. Native shell hosting the JS engine in WKWebView** — the plan of
record (rung 1, §10). All engine code survives bit-exact. WKWebView is
the ONLY context Apple grants JIT, so the hot loops (brush commit,
mask, booleans) keep their speed. UI chrome can go progressively native
(SwiftUI panels around the web canvas). Ceiling: Pencil input arrives
via pointer events ~1–2 frames later than native touch delivery, and
no predicted-touches API.

**B. Swift/SwiftUI + Metal, full rewrite** — the Procreate shape.
Raw UITouch with coalesced + predicted touches gives the platform's
best drawing latency (~9–16ms motion-to-photon); AVFoundation covers
the audio suite; UIDocument covers packages. Cost is total: no Swift
paper.js exists, so the boolean core is rewritten on Skia
PathOps/Clipper2 (contract reset, above), and Swift buys nothing for
rungs 2–4 — Windows/Linux would need a second app or Electron anyway.

**C. C++ or Rust engine core + thin native UI per platform** — the
professional-suite architecture (Affinity, Fresco, Clip Studio,
Toon Boom). One native core owns geometry/document/journal/streaming;
Swift+Metal shell on iPad; native or lightweight shells on desktop.
Rust is notable because ruffle (mature Rust SWF implementation) is
already vendored in this repo, and wgpu covers Metal/Vulkan/DX12 with
one renderer. Strongest 10-year end-state; largest rewrite — today's
app becomes the reference implementation the new core is validated
against.

**D. Native UI + JS core embedded in JavaScriptCore/Hermes (no
WebView)** — a trap. App-embedded JSC runs WITHOUT JIT (only WKWebView
gets JIT) and Hermes never JITs; interpreter-only execution multiplies
the boolean hot path several-fold. Fine for journal/codecs, wrong for
geometry. Only viable paired with a native geometry core — at which
point it is option C.

**E. Cross-platform native-ish frameworks — Flutter, React Native +
Skia, Kotlin/Compose Multiplatform.** One rewrite, all four rungs from
one codebase, store-legal. Flutter (Impeller) and RN-Skia both expose a
Skia canvas — Skia includes PathOps, so the boolean story is at least
industrial. RN is the odd standout because Hermes could host chunks of
existing JS logic. All of them put a framework between us and the
Pencil (latency between A and B) and still reset the boolean contract
if geometry moves to Skia.

**F. Game-engine shells (Unity/Godot).** Listed for completeness:
strong GPU/touch, wrong shape for a document-centric suite. No.

### Position

The ladder stands: prototype at rung 0, ship rung 1 as **option A**.
One targeted hybrid is worth planning for inside A: keep the JS engine
in WKWebView for all COMMITTED geometry (JIT, determinism, baselines
intact) and add a **native Metal overlay only for the live stroke
preview**, fed by predicted touches. The architecture already separates
the uncommitted overlay from journaled commits, so the seam exists
today — this buys Procreate-class pen feel without rewriting the core.
If the suite outgrows that, option C (Rust core, ruffle-adjacent) is
the honest end-game, with today's app as its validation oracle rather
than dead code.
