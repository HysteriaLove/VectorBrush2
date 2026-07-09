# VectorBrush2 — Rung-0 Implementation Plan

Status: PLANNING. How the suite in `Architecture.md` actually gets built,
starting from the app as it exists today. Architecture.md says WHAT and
WHY; this says IN WHAT ORDER, WITH WHAT SEAMS, AND BEHIND WHAT GATES.
Scope here is rung 0 (the browser prototype) — build-order step 1 in
full detail, the pattern for the later steps in brief.

---

## 0. The governing method: strangler, not rewrite

The current editor keeps booting and passing its full battery at every
single commit. The suite grows AROUND it:

- New capability lands as a seam or an addition first, a behavior change
  second, a removal last.
- Every phase is commit-sized, risk-ordered, and battery-gated (suite +
  flood exact-baseline + pixi parity + boot), same as the geometry-core
  rhythm already in force.
- Nothing in this plan touches the planar map, the boolean core, or the
  mask. Drawing-engine work (mask perf, scoped-repair diagnosis, parked
  fixes) is an **orthogonal track** that interleaves freely between
  shell phases.
- Anything that changes drawing FEEL still gets a user stress-test
  between slices (standing stability rule). Shell phases mostly don't;
  the mount/unmount phase does.

---

## 1. Build-order step 1: shell + package + streaming skeleton

Six phases, strictly in this order — each is one or two commits.

### Phase 1 — y2kvector rename (mechanical first)

1. Commit A: rename the class and every reference — `VB.VBDocument` →
   `VB.Y2KVectorDocument` across `app/js/*` and `app/test/*`. Keep
   `VB.VBDocument` as a one-line alias for exactly this commit window so
   any missed external harness fails loudly rather than silently; the
   suite's 598 checks catch stragglers.
2. Commit B: codec — extension `.vbd` → `.y2kvector`, magic/version
   bump in `vbd.js` (which becomes `y2kvector.js`), decode guard reads
   BOTH magics forever (old stress-log fixtures and user files must
   keep loading). Drop the class alias.

Gate additions: a round-trip check old-magic → decode → re-encode →
new-magic; all existing vbd suite sections keep passing untouched.

### Phase 2 — the Session seam (no files move)

Introduce `app/js/session.js`: `VB.Session` owning exactly the §4 shape
— `store`, `journal` (op log + undo), `clock` (stub: frame 0, not used
yet), `language` (stub), `sections` (registry). The existing `app`
object in `main.js` DELEGATES: `app.doc`, `app.project`, `app.history`,
`app.exec`, `app.record` become thin forwards into the session. Zero
behavior change; the point is that after this phase nothing outside
`main.js` reaches for globals the shell will later own.

Gate additions: none needed beyond the battery — this phase is proven
by everything staying green. (If a forward is missed, replay or undo
breaks loudly in the suite.)

### Phase 3 — PackageStore (storage before shell UI)

`file://` cannot write real folders (no File System Access API), so the
package lands as an interface with two backends:

```
PackageStore
  list()                      — project index for the homescreen
  create(meta) / delete(id)
  open(id) → PackageHandle
  PackageHandle
    readUnit(path) / writeUnit(path, bytes)
    readRange(path, off, len)   — the ChunkSource substrate
    manifest() / flushManifest()
    exportZip() → Blob          — .y2kproj interchange
    importZip(blob)
```

- Backend 1 (ships first): **IndexedDB virtual package** — units are
  Blobs, `readRange` is `Blob.slice` (honest range reads, streaming
  contract intact), works under today's `file://` dev flow and inside
  headless Edge gates.
- Backend 2 (adopt when convenient): **real folder over localhost** —
  serve the app with `python -m http.server` (Python 3.13 is already
  the toolchain), unlocking OPFS/FSA and clean Workers. The gate
  scripts can start/stop the server themselves. `file://` + IndexedDB
  remains supported so nothing about the current workflow breaks.

Also in this phase: **journal segmentation** — the op log writes as
`journal/seg-NNNN.json` units through the PackageStore, manifest
records the segment list; a project reload = manifest + replay segments.

Gate additions (new suite section "package"): create → write units →
reopen → byte-identical reads; range reads equal whole-reads sliced;
zip export → delete → import → identical unit set; segmented journal
replay ≡ monolithic replay (byte-exact edge sets, same trick as the
swath-union equivalence tests).

### Phase 4 — streaming skeleton with a real tenant

Per Architecture §5.2, minimal but REAL:

- `ChunkSource` — wraps `PackageHandle.readRange`.
- `AssetCache` — ONE global LRU with an explicit byte budget;
  `cache.claim(key, bytes, build, evict)`.
- `Prefetcher` — single priority queue, priority = f(distance, rung);
  only client at first: viewport-driven.
- **First tenants immediately, same commit**: the pixi per-fill raster
  sprite cache and the matcap buffer/paint caches move under
  AssetCache. That enforces "not stubbed" structurally — eviction bugs
  surface NOW, in the editor we can stress-test, not in Actors later.

Gate additions: eviction test — set a tiny budget, draw enough fills to
force eviction, assert redraw correctness (pixi parity run under the
tiny budget) and that total resident bytes never exceed budget.

### Phase 5 — shell: hash routes + homescreen

- Routing INSIDE the one page: `#home`, `#project/<id>/sketch`. One
  page keeps `file://` simple and forces an honest mount/unmount
  lifecycle instead of page reloads hiding leaks.
- Homescreen v1: project list from `PackageStore.list()` — create,
  open, rename, duplicate, delete. Groups/series, cover art, export
  shelves: deferred (shelves come with the first real export; covers
  with `.theme` work, per Architecture §11).
- The current editor becomes the mounted **"Sketch" section**:
  `mount(host, session)` / `unmount()` — create/destroy the pixi
  surface, attach/detach every listener, release AssetCache claims,
  flush pending ops. Section rail renders with Sketch as the only
  entry.

Gate additions: boot gate extends to homescreen boot → create project →
enter Sketch → draw op → leave → re-enter → art present. Plus the
**remount tripwire**: mount/unmount N times, assert stable canvas
count, listener count (via instrumented add/remove), AssetCache
resident bytes, and doc edge counts — mount leaks are THE classic
failure of this refactor.

### Phase 6 — persistence wiring end-to-end

Autosave = journaled ops flush to touched units (debounced); manifest
tracks dirty state; crash recovery = manifest + journal tail replay on
open; "export project" = `.y2kproj` zip via share/download.

**Definition of done for step 1**: open app → homescreen → create
project → enter Sketch → draw → leave → close browser → reopen → art
restored from the package → export zip, delete project, re-import →
identical; battery + all new gates green; journal alone reconstructs
the project.

---

## 2. The pattern for later steps (2–8)

Every section follows the same three-beat shape:

1. **Model + ops first, no UI** — the section's data shape and its
   journaled ops land as a suite-tested module (e.g. Actors: the
   pose→symbol→drawing tree, `actor.*` ops, `.y2kactor` codec with
   id-regeneration — all provable headless before a pixel exists).
2. **View second** — the section frontend mounts through the same
   `mount/unmount` contract as Sketch; DrawingSurface configs
   (Architecture §4) parameterize the editor rather than forking it.
3. **Streaming client third** — the section's inventory row
   (Architecture §5.3) gets implemented against the real Prefetcher
   (Actors: thumbnail wall; Roughs: playback window — the prefetcher's
   first hard client; Audio: peak tiles + pull-model playback).

Specific step notes:

- **Step 2 Actors** starts with DrawingSurface extraction — done as a
  THIN ADAPTER over the existing editor (config: which tools, which
  panels, onion on/off), not a rewrite of `main.js`. Sketch and Actors
  both consume it; Sketch is the regression control.
- **Step 3 Sequence/Roughs** introduces the real `clock` (replacing the
  Phase-2 stub) and the first frame-addressed documents. Onion skin =
  neighbor frames through AssetCache.
- **Step 4 Audio** is gated on the §5.5 transport decision (worklet vs
  MSE) — prototype BOTH behind the same PlaybackSource interface in a
  scratch harness before building the section.
- **Steps 5–8** per Architecture §8; each lights up its export(s) and
  its shelf entries as it lands.

---

## 3. Gate growth policy

- Every phase adds its checks to the ONE suite (`app/test/test.html`);
  no parallel test worlds. Headless gates stay `msedge --headless`
  (file:// or self-started localhost).
- The flood scan and pixi parity gates never change meaning: geometry
  and rendering are untouched by shell work BY DEFINITION — if a shell
  phase makes either budge, the phase is wrong, revert it.
- New long-lived invariants get tripwires, not one-off tests: remount
  stability, budget ceiling, segmented-replay equivalence run on every
  battery, forever.

## 4. What is explicitly NOT in rung-0 step 1

No estimator/profiling in ported code paths (standing directive), no
themes, no groups/covers, no export shelves, no collaboration hooks
beyond ids+ops (already present), no native bridge code, no three.js,
no Workers requirement (localhost makes them available; nothing depends
on them yet).
