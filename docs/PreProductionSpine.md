# VectorBrush2 — The Pre-Production Spine (ontology ladder)

Status: DESIGN, revised 2026-07-10 to the PANEL-DRIVEN model (user
decision, derived from real storyboard workflows) and IMPLEMENTED
through the flat-spine slices (spine.js). How Story, Boards, Audio, and
Roughs share data without sync hell, and the interchange unit that lets
writing in the text editor create storyboard panels and vice-versa.
Companion to [Architecture.md](Architecture.md) §6.3–§6.6 and
[SystemsDeepDive.md](SystemsDeepDive.md) §5.

The governing principles (all standing):

1. **Single writer.** Every entity type has exactly ONE owning
   workspace. Nobody keeps a copy of anyone else's data.
2. **Op routing, not data conversion.** Editing "someone else's" data
   from your workspace issues an op from the OWNER's op family. There
   is no interchange *file* between workspaces — the interchange format
   is the spine itself.
3. **References by id, downstream→upstream only.** Numbering and
   grouping are PRESENTATION, derived live; identity is the stable
   random id underneath.
4. **Promotion + drift, never auto-sync.** Crossing a rung of the
   ladder is an explicit journaled op that records what revision it
   consumed. Upstream edits after promotion make downstream *stale*
   (visible badge, one-tap re-pull) — they never silently rewrite it.

---

## 1. The model: ONE container — the PANEL

Scene, shot, and panel are the same thing here (user decision): the
spine is ONE flat, ordered list of panels. A panel is a story moment:

```
project.spine = {
  panels:     [ { id, rows: [row…], setting: settingId|null,
                  cell: <y2kvector doc>, duration: <frames> } ],
  characters: [ { id, name } ],     — registry (casting sheet → Actors)
  settings:   [ { id, name } ]      — registry (casting sheet → Backgrounds)
}
row = { id, kind: "action"|"note", content }
    | { id, kind: "line", character: <characterId>, text: {lang: str} }
```

- **The rows are the script** (Story-owned, `writing.*` block ops); the
  **cell is the drawing** (Boards-owned, drawn through the journaled
  editTarget); the **duration is the animatic timing**. One script,
  two views — the Story editor renders the row stacks as prose, the
  Boards deck renders the same rows under each frame, both editing the
  same blocks by op routing.
- **Panel numbering is presentation**: index + 1, live-renumbered on
  insert/delete. Identity is the stable id; nothing references numbers.
- **SCENES ARE DERIVED, never stored**: a run of consecutive panels
  sharing a setting is a scene (film grammar — continuous action in one
  setting; `VB.spineSceneRuns`). Change one panel's setting chip and
  the boundary moves. No settings assigned = one implicit scene.
- **The registries are the casting sheets.** Characters and settings
  auto-create on first use (typing a new name in a WHO field or setting
  chip mints the entry — the recorder journals the add). Renaming an
  entry renames it everywhere. Later rungs LINK them: a character to an
  Actor, a setting to a Background — that is the bridge from
  pre-production into the production pipeline.
- Multi-drawing coverage of one moment = consecutive panels (text on
  the first, art-only siblings after). Art-only and text-only panels
  are both first-class; an undrawn panel renders as a dashed SLOT in
  the deck and a hollow marker (▢) on the script rail.

### The ladder (entities by production stage)

```
L0  CONCEPT      Sketchbook items, Pitch slides     (isolated; copy-out only)
L1  SCRIPT       Panel rows + Characters/Settings   (Story owns content)
L2  PICTURE+SOUND Panel art + durations, Takes       (Boards / Audio own;
                                                      the animatic timeline)
L3  PRODUCTION   Scene, SceneInstance, master seq   (Roughs owns; THE clock)
L4  DOWNSTREAM   cast instances, tracks, camera,    (already built; addresses
                 grading, exports                    time as (instance, frame))
```

### Timing (who owns time, when)

| Rung | Time | Owner | Notes |
| --- | --- | --- | --- |
| T1 | animatic time | the panel list | per-panel `duration` in frames is the STORED truth; the audio-backed timeline lane (planned) EDITS it — panels laid against the waveform, boundary drags emitting `panelDuration` ops. Never absolute audio ms: re-cutting audio must not re-time the board |
| T2 | sequence time | Roughs | "establish scenes" consumes setting runs + panel durations with provenance; from then on the master sequence owns time (already true in code) |
| T3 | downstream | — | `(sceneInstance, localFrame)`; already built |

Audio re-conform (decision still pending with Roughs/Audio
integration): clips today anchor at absolute master-ms; scene-anchored
placement (`{seqInstance, offsetMs}`) should join before T2 re-timing
ships.

### The animatic sync area (Audio workspace — SHIPPED first slice)

The AP2 two-timeline shape: the BOARD STRIP (panels playing
left-to-right, following the playhead) over the SYNC TIMELINE — ruler,
PANEL LANE, MASTER track, then the stem tracks that feed it.

**Sync model — one clock, one axis, no conversions:**

- T1 animatic time IS the audio ms axis: panel k occupies the ms span
  of its cumulative frame range (`frames × 1000/fps` from 0), exactly
  where clips already live. `rig.masterMs` stays THE playhead; the
  strip, the lanes, the boards animatic, and every other workspace
  read the same number. No second clock exists.
- The MASTER track is the stems' mixdown — the sync surface. It renders
  as a combined peak envelope summed per visible pixel from the
  per-clip pyramids (no bake required; the baked WAV remains the export
  artifact). Playback already schedules the same clips, so what the
  lane shows is what plays.
- Board lengths are determined HERE: dragging a boundary on the panel
  lane emits one journaled `panelBoundary` op — zone-preserving (the
  pair re-times, total kept) so downstream panels stay on their audio
  hits; the last boundary extends the reel. Durations remain FRAMES in
  the journal; the lane is only their editor.

**Streaming / dynamic loading (the §5 contract applied):**

- Proxy ladder per resource: stems = nothing → peak pyramid → decoded
  PCM (AssetCache tenant, evict = re-decode); panels = nothing → shared
  thumbnail (cellHash-invalidated) → full cell (only the Boards cards
  render cells).
- Nearest-first prefetch: on mount/refresh the view schedules decodes
  for stems whose clips play soonest relative to the playhead
  (VB.prefetcher priority = time distance), and panel thumbs request
  with priority = panel distance from the playhead.
- Rendering is windowed by construction: peaks and lane blocks are
  sampled per visible pixel only; nothing decodes to draw off-screen
  time.
- Known seam for scale: the transport still awaits full decode of
  needed stems and schedules whole BufferSources. When stems outgrow
  memory, the §5.5 windowed transport (AudioWorklet ring fed by PCM
  windows) replaces the internals of `startPlayback` — the call sites
  and the clock don't change.

### Fixed resolutions + stroke consistency (SHIPPED)

Vector cells thumbnail badly when authored at arbitrary scales, so the
resolutions are now FIXED by decree:

- the project stage defaults to **1600×1200 px** (32000×24000 twips) —
  `Project()` defaults, the boot session, and the shell's new-project
  path all agree (`Session(opts)` now constructs the live project from
  the same dims its seeded `new` op carries; they can never diverge);
- storyboard panels mint at exactly **0.5× = 800×600** (spine.js
  `PANEL_W/H`), so a board maps onto the stage at a clean 2×. Board
  card frames, reel thumbs, and filmstrip tiles are all 4:3.

Stroke consistency across the scales is enforced at RECORD time:
`app.strokeScale()` = active cell width / PROJECT width, and every
drawing tool (brush + eraser radius, pencil + shapes width) multiplies
by it before the op is journaled. Ops carry final scaled geometry, so
replay needs no context and cross-resolution paste stays honest. A
50 px brush on the stage and a 50 px brush on a board read as the same
weight when the board is referenced at 2× over the canvas.

### The Roughs timeline (roughtl.js — SHIPPED, block model)

Roughs swaps the editor's scene strip + step sequencer (`body.ws-roughs`
hides `#seqbar`/`#timebar`, shows `#roughbar`; Actors keeps the classic
pair) for a three-lane view on the SAME T1 ms axis as Audio
(`VB.spinePanelSpans`/`VB.spinePanelAtMs`):

- **BOARDS** — the storyboard filmstrip, read-only here (clicks seek,
  never edit; board lengths are still cut in Audio);
- **AUDIO** — the stems' mixdown envelope, read-only (same per-pixel
  peak sum as the Audio lane);
- **ROUGH** — the one editable track, and NOT a step grid (user
  decision): each drawing is a duration BLOCK, sequenced exactly like
  the storyboard lane. The data is `layer.holds[i]` — drawing i's
  EXPOSURE in frames (Flash's frame-hold as data; `VB.frameCell` maps
  timeline frame → covering drawing, `VB.frameSpans`/`VB.layerSpan`
  expose the blocks). Boundary drags emit one journaled
  `frameBoundary` op: zone-preserving between pairs (the right
  neighbor compensates, downstream drawings keep their audio sync),
  free at the last drawing. Scrubbing any lane drives `cur.frame`
  live and pins one `frameSelect` on release. Onion skin ghosts the
  adjacent DRAWINGS (not adjacent timeline frames).

The BOARD REFERENCE: a slider on the bar (persisted,
`vb-roughref`) sets `app.boardRefAlpha`; the render loop draws the
panel under the current frame across the stage at 2× with that opacity
— referencing, never editable from Roughs.

---

## 2. The membrane: two personas, one script

Some authors write scripts; others write THROUGH storyboards. Both have
the same effect and control over the script — **there is one script,
rendered twice**, and with the panel-driven model the membrane is
symmetric and trivial: **paragraph = panel, both directions, 1:1.**

**Script → Boards:**

| Writing act | Boards consequence |
| --- | --- |
| ＋ panel / Enter at the end of a panel's action | a NEW panel — a dashed slot in the deck, numbered in sequence |
| Type action / dialogue / note rows | the frame's text — same rows, live |
| WHO field | dialogue references a registry character (minted on first use) |
| Setting chip | scene boundaries move (derived runs) |
| Backspace on an empty, art-less panel | the panel is removed (merge up) |

**Boards → Script:**

| Boards act | Script consequence |
| --- | --- |
| ＋ Panel | a new panel = a new script row slot (inherits the current panel's setting) |
| Type the frame's text field | the panel's action row — script prose (`writing.*` op-routed) |
| Add/edit a dialogue row | a real Line (registry character + per-language text) |
| Reorder panels | the script reorders — rows travel with their panel |
| Draw / duration | Boards-local craft; never generates text |
| Delete a panel | journaled + undoable; rows and art go together (it is one entity) |

Determinism note: everything above is the EDITOR deciding which ops to
emit — the journal only ever sees explicit `panelAdd/Move/Remove/
Duration/Setting`, `blockAdd/Edit/Move/Remove`, `characterAdd/…`,
`settingAdd/…`. Gesture defaults can be retuned without touching op
semantics or replay.

Fountain remains the external-interchange shape (scene heading =
derived setting-run header, action/dialogue/notes = rows); an
import/export is a projection, the journal stays truth.

---

## 3. What is deliberately NOT built

- No stored scene/beat/group level — grouping is derived from settings.
- No per-workspace mirror documents, no converters, no auto-writeback
  from downstream (re-timing a scene never edits a panel; redrawing
  never touches text).
- No live links out of Sketchbook/Pitch (copy-out only).
- No separate "Notes" script mode — one script (user decision); loose
  ideation lives in the Sketchbook, in-panel notes are note rows.

## 4. Open questions

1. ~~The audio-ruler timing lane~~ SHIPPED — the Audio workspace's
   sync area (board strip + panel lane + master track + stems;
   `panelBoundary` op). Remaining: bake-aware master rendering and the
   windowed transport at scale.
2. **establishScenes promotion**: consumes setting runs + durations,
   mints production scenes with `seededFrom` provenance and revs; the
   drift-badge UX rides on it.
3. **Registry management UI** (rename/merge/delete characters and
   settings, see-where-used) — auto-create covers authoring; cleanup
   needs a small panel later. Removing an entry currently leaves
   dangling refs that render empty (tested, accepted for now).
4. **Take management** (multiple takes per line, language-tagged) —
   design when Audio grows per-line recording flows.
5. **Transitions** (CUT TO:) as boundary properties — model when
   something consumes them.
6. **Panel gestures**: drag-reorder in both editors, split (a panel's
   tail rows → new panel), duplicate-as-coverage. UX slice.
