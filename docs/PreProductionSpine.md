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

1. **The audio-ruler timing lane** (T1 editor): panel blocks against
   the waveform, boundary drags → `panelDuration` ops. Next slice.
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
