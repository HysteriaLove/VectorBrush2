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
2. **Sections are views, not silos.** "Synced to the main animation" means
   there is exactly ONE project model and one master clock; Roughs,
   Actors, Compositing, and Post are editors over different slices of that
   model. No section keeps a private copy of shared state.
3. **The drawing engine is a component.** The current editor (canvas +
   pencil/brush/bucket/eraser/arrow/text + materials + pixi surface)
   becomes an embeddable `DrawingSurface` that Brainstorm, Storyboards,
   Roughs, and Actors instantiate against different backing documents.
   One geometry core, one renderer, one battery of tests.
4. **Deterministic and gated.** The oracle discipline (Canvas2D truth,
   pixi validated against it) and the battery-gate rhythm stay. New
   sections ship one at a time behind the same kind of gates.
5. **iPad-first.** Touch + Apple Pencil are the primary inputs; screen
   real estate, memory ceilings, and no-filesystem assumptions shape every
   section (see §9).

---

## 2. Application shell (DECIDED, layout details PROPOSED)

```
App
├─ Homescreen
│  ├─ Projects list  — groupable (by project / series), group artwork
│  ├─ Test Exports   — scratch renders, auto-pruned shelf
│  └─ Finished Exports — curated deliverables
└─ Project workspace (one open project)
   ├─ Brainstorm │ Writing │ Storyboards │ Audio
   ├─ Roughs │ Actors │ Compositing │ Post
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
- Section navigation inside a project is a persistent rail (the nine
  sections in production order). Sections lazy-load: opening a project
  loads the manifest + the section you enter, nothing else (§4).

---

## 3. Project data model — the spine (PROPOSED)

The reference prototype validates the shape (Managment.py `Project`):

```
Project
├─ meta            — title, fps, language list, cover, ids
├─ notes           — Brainstorm canvas (infinite, NoteObjects)
├─ writing         — documents → dialogue Lines (line-id, per-language text)
├─ boards          — storyboard panels, grouped by beat, timed
├─ audio           — stems, edits, baked master(s)
├─ sequence        — MASTER TIMELINE: ordered SceneInstances
│    └─ Scene      — a sub-timeline: rough passes, actor placements,
│                    camera/comp clips, per-scene tracks
├─ actors          — Actor = poses → symbol groups → drawings (VBDocuments)
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
  sequence. Audio's baked master aligns to the master clock.
- **Everything has a stable id** (`scene_xxxx`, `actor_xxxx`, `line_xxxx`
  — reference convention). Cross-section references are by id, never by
  index or text, so renames and reorders never break links.
- **All vector art is a VBDocument** (the planar map we already have) —
  symbol drawings, rough frames, storyboard panels, brainstorm sketches.
  The `.vbd` codec, materials library, and the whole tool suite apply
  everywhere for free.

### On-disk format: a package folder, not a monolith

Reference validated this too (`project.json` + mirrored folders). One
JSON blob does not survive a 40-scene production on an iPad: partial
load, autosave granularity, and team sync all want per-unit files.

```
MyShow.vbproj/
  manifest.json        — meta, section index, format versions
  journal/             — op log, segmented (crash recovery, bug export)
  notes/board.json     + notes/assets/…
  writing/doc-*.json
  boards/board-*.json  + boards/art/*.vbd
  audio/stems/…        + audio/master-*.m4a + audio/edits.json
  sequence.json        — scene instances, master tracks
  scenes/scene-*/      — scene.json + roughs/*.vbd
  actors/actor-*/      — actor.json + drawings/*.vbd
  compositing/scene-*.json
  post/…
  exports/index.json   + artifacts…
```

- Load = manifest + entered section; a background indexer warms the rest.
- Save = journaled ops flush to the touched files only (autosave-friendly,
  Files-app/iCloud sync writes small deltas).
- Interchange formats stay separate from the package: `.vbd` (drawing),
  `.actor` (portable actor, reference format v3 — ids regenerate on
  import), and later `.notepack` (NoteObjects, §5.1).

---

## 4. Runtime architecture (PROPOSED)

```
Shell (homescreen, project rail, section router)
└─ ProjectSession
   ├─ store      — the loaded model slices (lazy per section)
   ├─ journal    — op log + undo stacks (one per section FOCUS,
   │              global order preserved)
   ├─ clock      — master frame, playback state, scene mapping
   ├─ language   — active language, line resolution (§5.2)
   └─ sections[] — mounted section frontends
```

- **Ops carry a section tag.** Undo is per-section-focus (undoing a
  writing edit from inside Roughs would be chaos) but the journal is one
  globally-ordered stream, so replay reconstructs the whole project.
- **The clock is owned by the session, not a section.** Play/scrub in any
  synced section drives the same clock; every mounted synced view renders
  the same frame. Preview composition (roughs over boards over audio
  waveform, etc.) is a render-graph question, not a data question.
- **DrawingSurface** = the current editor packaged: takes a VBDocument +
  materials + tool palette config, emits ops. Sections configure it
  (Brainstorm: no onion skin; Roughs: onion skin + frame rail; Actors:
  symbol nesting breadcrumb; Storyboards: panel-sized fixed canvas).
- Rendering stays pixi for all canvas/drawing surfaces (established
  directive); regular UI/GUI is DOM until further notice.

---

## 5. Sections

### 5.1 Brainstorm (Notes)

- Infinite canvas; content = placed objects: images, text notes, sketch
  patches (small VBDocuments), and **NoteObjects**.
- **NoteObject = declarative package, not code.** A pack ships JSON:
  schema (fields/types), layout (composition of built-in primitives:
  text, checklist, table, image well, link-to(line/scene/actor), sticker
  art as .vbd), and optional behaviors chosen from a fixed verb set
  (collapse, checkoff, tally, date-stamp). No scripting — packs stay
  App-Store-safe, sandbox-safe, and forward-compatible. Sellable packs
  are then pure data (`.notepack`).
- OPEN: layers on the brainstorm canvas. Recommendation: no layers —
  z-order + grouping + lock/pin (reference boards use lock/pin and it is
  enough there); revisit only if real boards drown.

### 5.2 Writing

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

### 5.3 Storyboards

- **Panel** = one .vbd drawing + attached line refs + duration + notes.
  **Beat group** = ordered panels under a label (reference: boards +
  timeline clips). Board timeline = ordered beats; playable as an
  animatic: panels held for their duration, scratch audio underneath
  (basic slideshow support — DECIDED as in-scope).
- Panels can be promoted later: "send to scene" seeds a Scene's rough
  pass with the panel art as a locked reference layer.
- The animatic is the project's first export artifact (Test Exports
  shelf) and the timing seed for Roughs: establishing scenes from beats
  copies beat durations into scene instance durations.

### 5.4 Audio

- Stems (imported files) → non-destructive edit list (trim, gain, fade,
  placement on tracks) → **bake** to a master (reference README:
  "load audio stems to create or bake a master"). The master is what
  synced sections scrub against; stems remain for re-bakes.
- Own mini-suite: track lanes, waveforms, snap-to-frame; no plugin/DSP
  ambitions in v1 beyond gain/fade/pan.
- Baked masters are per-language when language-tagged stems exist (the
  reserved hook from §5.2); default is one master.

### 5.5 Roughs

- **Scenes are established here** (DECIDED). A Scene is a sub-timeline
  (reference: `Scene` + `SceneInstance`): rough animation passes
  (frame-by-frame VBDocuments with onion skin — reference
  `SceneAnimation`/`CanvasAnimationFrame`), board references, and the
  scene's slice of the audio master.
- Roughs cover the WHOLE master track: the sequence editor (order scenes,
  set durations, insert holds) lives at the top of this section.
- A rough pass is cheap and disposable by design: flat drawing frames, no
  actors — the point is timing against audio.

### 5.6 Actors

- Actor = canvas size + **poses → symbol groups → drawings** (reference
  `Actor/Pose/Symbol/SymbolDrawing`, .actor format v3). Drawings are
  VBDocuments; symbols nest (eyes → pupils; mouth → phoneme set).
- Edited here as a library (no timeline); PLACED into scenes with
  pose/symbol tracks driven per scene instance (reference: character
  tracks on `SceneInstance`, NLA/step-sequencer editors). The placement
  and track editing UI lives with the timeline in Compositing; the asset
  and its art live here.
- `.actor` import/export from day one (marketplace-shaped, like
  NoteObject packs; ids regenerate on import per the reference spec).

### 5.7 Compositing

- Per scene: actor placements (position/scale/rotation in 2D, reserved z
  for 2.5D), backgrounds, camera (a transform track over the scene),
  actor pose/symbol/visibility tracks on the scene timeline.
- This is the section that owns "what the frame actually shows"; its
  render graph consumes Actors (art), Roughs (as toggleable underlay),
  and Audio (clock).
- Blender bridge (reference `blender_compositing_addon.py`): export
  camera + placement tracks + plates for teams that ground scenes in 3D.
  Import side OPEN (probably plates-only for a long time).

### 5.8 Post-processing

- Per-scene and global effect stacks built on the 2DMaterials/WebGPU
  model already designed: an effect = a material graph over the composited
  frame (blur, glow, color grade, halftone…), with the same deterministic
  cost profile so artists see "how heavy" before they commit (the
  OperationEstimator applies directly).
- Post never touches geometry — it is strictly frame-space, which keeps
  the oracle discipline intact (CPU reference implementation per effect,
  GPU validated against it, same as matcaps).

### 5.9 Export

- One pipeline, many targets: animatic (video), scene render, master
  render, image sequences, per-actor sheets, `.actor`, Blender bundle
  (§5.7), audio master, subtitle/dialogue sheets from Lines (§5.2), SWF7
  for the classic-Flash interchange goal, and `.vbd`.
- Every export = journal revision + settings snapshot → artifact +
  shelf entry (Test or Finished). Reproducible by construction.
- Text-in-SWF export remains permanently out of scope (standing decision).

---

## 6. What already exists and where it lands

| Today | Becomes |
| --- | --- |
| VBDocument planar map + booleans + mask | The universal vector art unit, unchanged |
| Tools (pencil/brush/bucket/eraser/arrow/text) | DrawingSurface component, config per section |
| pixi renderer + Canvas2D oracle + parity gate | DrawingSurface rendering, plus scene compositor base |
| 2DMaterials + matcaps + estimator | Fill materials everywhere; Post effect model |
| Command journal + ops registry | Project-wide journal (section-tagged ops) |
| `.vbd` v4 | Drawing unit format inside packages |
| history.js snapshots | Per-section undo over the shared journal |
| Suite + flood + parity + boot battery | Grows per section; same gate rhythm |

The current single-canvas app becomes the DrawingSurface embedded in four
sections — it is the hardest part of the suite and it is already built.

---

## 7. Build order (PROPOSED — one shippable slice at a time)

1. **Shell + package format**: homescreen, project index, package
   folder, manifest, journal segmentation. The current editor mounts as
   the only section ("Sketch") so the shell ships around working tools.
2. **Actors**: pose/symbol/drawing tree around DrawingSurface + `.actor`
   round-trip. (Most reuse, highest value, no timeline dependency.)
3. **Sequence + Roughs**: scenes, master timeline, onion-skinned rough
   passes, playback clock.
4. **Audio**: stems → edits → baked master; clock sync.
5. **Storyboards + Writing** (paired — lines and panels prove the
   reference model): animatic export → Test Exports shelf lights up.
6. **Compositing**: placements, camera, pose/visibility tracks.
7. **Brainstorm + NoteObjects** (data-only packs).
8. **Post + Export hardening** (effect graphs on the materials/WebGPU
   work; export matrix; Blender bundle).

Each step lands behind the battery + a new section-specific gate, one at
a time, per the standing stability rule.

## 8. Collaboration posture (deferred, not precluded)

Teams are in scope ("teams and creators"). v1 is single-writer:
package-in-cloud-storage (iCloud/Drive) with the journal making merges
diagnosable. The journal being an op stream is the load-bearing choice —
real-time or branch-merge collaboration later builds on op transforms
instead of file locking. No CRDT/server work now; just don't break id
stability or op determinism, which we already enforce.

## 9. iPad / platform plan

- Engine and app remain vanilla JS + vendored libs (no build step —
  toolchain constraint stands). Ship as a wrapped WKWebView app
  (Capacitor-style shell added at packaging time, not in the repo now);
  the browser build remains the dev/oracle environment.
- Input: pointer events already unify mouse/touch/Pencil. Add: Pencil
  pressure → brush radius (op already records final geometry, so
  determinism is untouched), two-finger pan/zoom, long-press context
  menus, palm rejection via pointerType.
- Memory: per-fill raster sprite caches and matcap buffers get an LRU
  budget (iPad Safari WebGL/WebGPU process limits are the constraint);
  package lazy-load (§3) keeps 40-scene projects openable.
- Files: package folder maps to an iOS document package (Files app /
  iCloud sync friendly); exports register with the share sheet.
- WebGPU (Post, matcap stage 2b) ships behind capability detection with
  the CPU oracle as the always-available fallback — same policy as today.

## 10. Open decisions

1. Brainstorm layers — recommendation: none (z-order + groups + lock).
2. Language-switched audio/animation tracks — id hooks reserved now,
   feature explicitly deferred (user flagged risky).
3. Blender import direction (export-only vs round-trip) — export-only
   until a concrete team workflow demands more.
4. Group graphics on homescreen — cover images (user-picked or
   auto-thumbnail of a board panel)? Cheap either way; pick at build time.
5. Scene z-model in Compositing: pure 2D with draw order vs 2.5D planes —
   reserve `z` in placement records either way.
6. Whether Test Exports auto-prune by count, age, or size budget.
