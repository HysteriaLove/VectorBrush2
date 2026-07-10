# VectorBrush2 — The Pre-Production Spine (ontology ladder)

Status: DESIGN (2026-07-10). How Story, Boards, Audio, and Roughs share
data without sync hell, and the interchange units that let writing in
the text editor create storyboard panels and vice-versa. Companion to
[Architecture.md](Architecture.md) §6.3–§6.6 and
[SystemsDeepDive.md](SystemsDeepDive.md) §5.

The governing principles (all already standing):

1. **Single writer.** Every entity type has exactly ONE owning
   workspace. Nobody keeps a copy of anyone else's data.
2. **Op routing, not data conversion.** Editing "someone else's" data
   from your workspace issues an op from the OWNER's op family (the
   mechanism Lines already use: a line edited on a panel is a
   `writing.*` op). There is no interchange *file* between workspaces —
   the interchange format is the spine itself.
3. **References by id, downstream→upstream only.** Panels point at
   lines; scenes point at the beats that seeded them. Upstream never
   points down; reverse lookups are queries over the one model
   (`VB.refsTo`).
4. **Promotion + drift, never auto-sync.** Crossing a rung of the
   ladder is an explicit journaled op that records WHAT REVISION it
   consumed. Upstream edits after promotion make downstream *stale*
   (visible badge, one-tap re-pull) — they never silently rewrite it.

---

## 1. The ladder

Entities are born on a rung, get referenced from below, and cross rungs
only by explicit promotion. Sketchbook and Pitch sit OFF the ladder by
decision (2026-07-10): they are isolated concepting spaces; pulling
material out of them is promotion-as-COPY (optional provenance note,
never a live link).

```
L0  CONCEPT      Sketchbook items, Pitch slides        (isolated; copy-out only)
L1  SCRIPT       Slug → Beat → Block / Line             (Story owns; the content spine)
L2  PICTURE+SOUND Panel (per beat), Take (per line),    (Boards / Audio own;
                 animatic timing                         the first real timeline)
L3  PRODUCTION   Scene, SceneInstance, master sequence  (Roughs owns; THE clock)
L4  DOWNSTREAM   cast instances, tracks, camera,        (already built; addresses
                 grading passes, exports                 time as (instance, frame))
```

### The entity table

| Entity | Id | Owner | Created by | Referenced by | Promotes to |
| --- | --- | --- | --- | --- | --- |
| **Slug** (story scene) | `slug_xxxx` | Story spine | either editor | beats (membership), scene provenance | seeds a production Scene |
| **Beat** (one story moment) | `beat_xxxx` | Story spine | either editor | blocks+panels (membership), scene provenance | its duration seeds scene timing |
| **Block** (action / note) | `blk_xxxx` | Story | Writing (or Boards caption edit → op-routed) | beats | — |
| **Line** (dialogue: character, per-language text, rev) | `line_xxxx` | Story | Writing (or drafted on a panel → op-routed) | panels, takes, lip-sync, subtitles | — |
| **Panel** (art cell, duration, notes) | `panel_xxxx` | Boards | Boards | animatic, scene provenance | art can seed a rough layer (copy) |
| **Take** (recorded audio of a line) | `take_xxxx` | Audio | Audio | timeline clips | placed on the master timeline |
| **Scene / SceneInstance** | `scene_xxxx` / `seq_xxxx` | Roughs (sequence) | "establish scenes" promotion | everything downstream | — |

Notes:

- **Ids are random and collision-resistant** (the `VB.actorNewId`
  discipline) — this design depends on the scene-id migration
  (SystemsDeepDive §5.1.2) landing first.
- **Scenes are still established in Roughs, by the user** (standing
  decision). Slugs do NOT auto-become scenes; "establish scenes from
  the spine" is the explicit promotion that mints `scene_xxxx`, records
  `seededFrom: {slug, beats, revs}`, and copies beat durations into
  instance durations. The default mapping is one slug → one scene, and
  the user can split/merge at establishment.
- **"Actions" from the data list are Blocks** — an action block is the
  story event ("Kai ducks behind the console"). It doesn't need a
  richer entity until something downstream points at individual actions
  (the "data earns an id when a second workspace points at it" rule —
  blocks already have ids, so the hook exists for free).
- **Quirks** (camera notes, transitions, mood refs) are plain fields on
  their owner (panel.notes, beat title, slug synopsis). Not entities.

### The timing ladder (who owns time, when)

| Rung | Time | Owner | Notes |
| --- | --- | --- | --- |
| T0 | script pacing | Story | optional per-slug estimate; advisory only |
| T1 | animatic time | Boards | panel durations; beat duration = Σ its panels (a panel-less beat holds a default 1 s); scratch audio aligns here |
| T2 | sequence time | Roughs | "establish scenes" copies beat durations → instance durations; from this moment the master sequence owns time FOREVER (already true in code — the audio-rig master clock) |
| T3 | downstream | — | `(sceneInstance, localFrame)` addressing; already built |

Each promotion stores consumed revisions; later upstream edits show as
drift ("3 beats changed since Scene 4 was established"), resolved by an
explicit re-pull op or dismissed.

**Audio re-conform (decision needed with Roughs/Audio integration):**
clips today anchor at absolute master-ms. Once T2 re-timing exists,
dialogue belonging to a scene should move WITH the scene. Add optional
scene-anchored placement — `{anchor: seqInstanceId, offsetMs}` — beside
absolute placement; re-timing then re-conforms anchored clips for free.

---

## 2. Story ⟷ Boards: the interchange units

**The unit of bidirectional sync is the BEAT.** Not the block (too
fine: a ten-line exchange would explode into ten panels), not the panel
(too visual: three panels of camera coverage are one story moment).
A beat is one discrete story moment; on the Writing side it is a
contiguous span of blocks, on the Boards side a group of panels. The
spine holds the ordering; both editors are views of it:

```
project.spine = {
  scenes: [ { id: "slug_x", title, synopsis?, beats: [beatId…] } ],
  beats:  { beat_x: { id, title?, blocks: [blkId…], panels: [panelId…] } }
}
writing owns block/line CONTENT;   boards owns panel CONTENT (art, duration)
```

### Creation sync (the vice-versa rules)

The key trick is **lazy materialization**: creating a beat from either
side creates ONLY the beat. The other side renders a beat with no
native content as a *placeholder* — an empty paragraph slot in Writing,
an empty frame in Boards — and the real block/panel entity is minted
only when someone actually types or draws. No phantom entities, no
round-trip echo.

1. **Writer starts a new beat** (beat break) → `spineBeatAdd`. Boards
   immediately shows a new empty frame in story order, captioned by the
   beat's action text as it is typed. The panel entity appears when the
   artist first draws (`panelAdd {beat}`).
2. **Artist adds a panel in a gap between beats** → `spineBeatAdd` +
   `panelAdd`. Writing immediately shows an empty paragraph slot at the
   corresponding position; the block entity appears when the writer
   types.
3. **Within-beat edits never cross.** A second panel in a beat is
   camera coverage — no text is created. A second paragraph in a beat
   is prose detail — no panel is created. This asymmetry is what keeps
   both tools usable; the beat spine is the only thing that echoes.
4. **Reorder is one op** (`spineBeatMove`) — both views re-sort. Order
   lives in the spine, nowhere else.
5. **Split/merge**: splitting a beat mid-text (`spineBeatSplit {beat,
   atBlock, newId}`) keeps panels with the FIRST half (deterministic
   default; artist redistributes after). Merge concatenates both lists.
6. **Delete** (`spineBeatRemove`) is journaled and undoable; the UI
   confirms when the other side has content. (A "parked panels" shelf —
   panels out of the cut but not deleted, standard board practice — is
   a candidate v2; noted in §5.)

### Text flows both ways through ownership, not copies

- **Dialogue on panels**: a panel shows chips for the lines its beat
  contains; editing one issues `writing.lineEdit` (already the spec'd
  Line mechanism — unchanged).
- **Captions**: a panel group's caption in Boards IS the beat's first
  action block, rendered read-write; editing it issues
  `writingBlockEdit`. One source of truth; the "caption" stops being a
  separate Boards field for spine-bound boards.
- Free-form boards (mood boards) and free writing docs (outlines,
  notes) stay unbound — the spine binds ONE canonical screenplay
  structure per project in v1.

### Block model (Fountain-shaped on purpose)

Writing's block types map 1:1 onto Fountain elements: scene heading =
slug, action paragraph = action block, character+dialogue = Line,
`[[note]]` = note block, `= synopsis` = beat title/break. We adopt the
SEMANTICS, not the storage — but a Fountain import/export becomes a
cheap projection, which is the external-interchange story for scripts
(same position as OpenTimelineIO for timing: exports are projections,
the journal stays truth).

---

## 3. Ops sketch (model + ops first, no UI — the standing pattern)

New `spine.*` family (issuable from Writing OR Boards):

```
spineSceneAdd    {id, index, title}
spineSceneMove/Rename/Remove
spineBeatAdd     {id, scene, index, title?}
spineBeatMove    {id, scene, index}
spineBeatSplit   {beat, atBlock, newId}
spineBeatMerge   {first, second}
spineBeatRemove  {id}
```

Existing families gain beat membership:

```
writing:  blockAdd {id, beat, index, type, text|lineId} · blockEdit ·
          blockMove {beat, index} · blockRemove · lineEdit (unchanged)
boards:   panelAdd {id, beat, index} · panelMove {beat, index} ·
          panelDuration · panelRemove · art via journaled editTarget
          (all existing mechanisms)
audio:    takeLink {take, line} · clip anchor {seqInst, offsetMs}
roughs:   establishScenes {scenes:[{id, slug, beats, revs, duration}]}
```

Revisions: `rev` bumps on Line/Block/Beat edit ops; promotion ops store
consumed revs; `VB.refsTo(id)` (pure reverse-index helper over the one
in-memory model) powers where-used and drift badges everywhere.

Migration: current `boards.beats` lift into the spine (a journaled
migration op or replay-compat shim — old `beatAdd` ops replay as spine
beats with no blocks); current free-form writing docs stay as they are;
binding a doc to the spine is a new op.

Gates (suite section "spine"): replay determinism for every op;
referential integrity after arbitrary op sequences — every beat's
blocks/panels resolve, every block/panel belongs to exactly one beat,
scene lists contain each beat exactly once, line refs resolve or render
as explicitly-dangling chips; split/merge round-trip; establishScenes
provenance and drift computation.

---

## 4. What we are deliberately NOT building

- No per-workspace mirror documents, no converters, no diff/merge of
  prose against panels. The moment two workspaces both own a fact, the
  sync problem the spine exists to prevent comes back.
- No automatic writeback from downstream: re-timing a scene never edits
  a beat; redrawing a panel never touches text. Drift badges only.
- No live links out of Sketchbook/Pitch (copy-out only).
- No auto-establishment of scenes from slugs (user establishes in
  Roughs; the spine just makes it one tap and records provenance).

## 5. Open questions

1. **Parked-panels shelf** (panels out of the cut, kept): v2 candidate,
   affects `spineBeatRemove` semantics.
2. **Beat granularity pressure**: dialogue-heavy scenes may want a
   panel per line; the model allows it (many panels per beat) — whether
   the UI offers "explode beat to panels per line" is a build-time call.
3. **Multiple screenplay docs** (episodes/drafts) binding to one spine:
   v1 binds one; drafts likely want spine VERSIONS, which is a bigger
   feature (journal already gives history).
4. **Slug↔scene 1:1 default**: establishment UI should offer split/
   merge at promotion time; how much re-establishment (re-seeding an
   already-established scene from changed beats) is allowed before it
   fights Roughs edits — needs the drift UX to answer.
5. **Take management** (multiple takes per line, language-tagged takes)
   interacts with the reserved per-language hooks (Architecture §6.3) —
   design when Audio grows recording/import-per-line flows.
