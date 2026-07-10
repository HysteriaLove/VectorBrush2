# The Actor Step Sequencer — reference spec

*2026-07-10 · Reference: the Animation Program V2 screenshot + Managment.py
(D:\DriveDProjects\Animation Program V2). This is the standing spec for
the context timeline that grows out of the bottom dock — the user has
designated the reference UI as the target.*

## What the reference does

The per-scene timeline stack, top to bottom:

1. **Scene track** — the scene NLE lane (we have this: the scene strip).
2. **Scene header row** — the selected scene's `Scene In / Scene Out`,
   an `Audio` toggle, and `Audio H` (the audio lane's height).
3. **Audio lane** — the scene's audio as one tall waveform block.
4. **Actor Step Tracks** — a names column on the left, step grids on the
   right, one GROUP of rows per actor placed in the scene:
   - `actor / Visibility` — blue SPAN clips ("Visible") over frame ranges.
   - `actor / Transform` — keyed transform spans; metadata
     `{x, y, scale, rotation}`.
   - `actor / Poses / <pose>` — green EXPOSURE CELLS (one per frame:
     which pose shows).
   - `actor / <pose> / <symbol> / <drawing>` — colored exposure cells per
     nested symbol drawing — this is the lip-sync surface (`Mouth / AEI`,
     `Mouth / O`, `Mouth / TH`, …).
   - Groups collapse from the names column (the `-` prefixes).
5. **Transport** — Play, Frame, Time, End, `Loop` + `Loop In/Out`.
6. **Right panel** — Scene / Symbols / Refs / Assets browser with
   thumbnails; dragging assets places them (plus Show Boards / Show
   Actors / Show Outlines overlays).

## The reference's data model (verified in code)

- `TimelineClip { id, label, start, duration, lane, target_id, locked,
  metadata }` — ONE generic clip type for every lane (audio, visibility,
  transform, exposure).
- **Rows are GENERATED from the actor/pose/symbol structure**
  (`build_character_lanes`); `TimelineClip`s exist only for *painted
  timing regions* (`ensure_character_tracks` is a no-op — an empty row
  is just structure).
- Lanes address their subject via `target_id` conventions:
  `actor_visibility:<actorId>`, `actor_transform:<actorId>`, etc.
- `SceneInstance.character_tracks` — each sequence instance carries its
  OWN timing (falling back to the scene's), so two instances of one
  scene can animate differently. Instance track ids regenerate on copy.
- `SceneActorRef { x, y, scale, rotation }` — the placed actor instance
  (the prototype/instance discipline: Architecture already mandates it).
- Default visibility: placing an actor may add one "Visible" span over
  the whole scene (`add_default_visibility_clip`, dedup by target).

## Mapping onto VectorBrush2

| Reference | Ours |
|---|---|
| `Scene.scene_sequence` instances | `project.sequence` ✔ shipped |
| Scene NLE lane | the scene strip ✔ shipped |
| Audio lane | the strip's audio band ✔ (grows into its own lane here) |
| `SceneActorRef` | **NEW**: per-scene actor/symbol instance placements |
| `character_tracks` clips | **NEW**: journaled generic track-clip ops |
| generated rows | derived from `project.actors` structure at render time |
| step grid | the expandable `#timebar` area (the bottom dock already grows for it) |
| Assets browser | the Library rack module (drag to stage places an instance) |
| Loop In/Out | future `project.loop` (view-adjacent, journaled) |

## Op vocabulary (planned)

- `instancePlace { id, scene, ref (actor/symbol/background id), x, y,
  scale, rotation }` — places an instance in a scene (rendered by BOTH
  backends — parity-gated work).
- `instanceMove / instanceTransform / instanceRemove`.
- `trackClipAdd { id, scene|inst, lane, target, start, duration, label?,
  metadata? }`, `trackClipResize`, `trackClipMove`, `trackClipRemove` —
  the generic TimelineClip vocabulary.
- `exposureSet { scene|inst, target, from, to, value }` — paint/erase
  exposure cells over a frame range in ONE op (drag-painting cells must
  not journal per cell).

## Build phases

1. **Placement** — instances on the stage (model + ops + oracle/pixi
   rendering + Library drag + transform-tool selection). Default
   whole-scene Visibility span on place.
2. **Step grid UI** — names column + rows generated from placed actors'
   structure, visibility spans and pose exposure cells editable
   (drag-paint), the shared master-clock playhead, group collapse.
3. **Transform keys** — keyed `{x,y,scale,rotation}` metadata with
   playback interpolation.
4. **Nested exposure / lip sync** — symbol-drawing rows (`Mouth / AEI`
   …), the reference's colored cell rows.
5. **Loop In/Out + per-instance tracks** (instances override scene
   timing, ids regenerate on instance copy).

Rendering instances touches the render pipeline on both backends —
every phase here is battery-gated with the parity suite, one slice at
a time.
