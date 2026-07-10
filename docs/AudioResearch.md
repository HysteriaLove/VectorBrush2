# Audio Library Research — the Audio section (Architecture §6.5)

*2026-07-10 · rung-0 prototype planning. Decision inputs for the Audio
slice: stems → track/clip edits → baked master.*

---

## 1. What the Audio slice needs

Requirements the candidates are judged against, in order of weight:

1. **Journal fidelity.** Audio structure (tracks, clips, trims, gains)
   must be journaled ops that replay byte-exact. Audio BYTES are
   package assets referenced by id — never journal payload. Any library
   that owns its own state/transport model fights this.
2. **The project clock is the master.** Playback, scrub, and the Boards
   animatic all align to `project.fps`. We need sample-accurate
   scheduling **against our clock**, not a framework's transport.
3. **Streaming.** Waveform overviews and decoded buffers are AssetCache
   tenants (one global byte budget, evict = recompute). A library that
   caches internally double-books memory we're supposed to govern.
4. **No build toolchain.** Only Python + Git on this machine. A
   candidate must ship a prebuilt single-file script-tag build (IIFE/
   UMD, WASM inlined). npm-only / ESM-only distributions are out until
   the native rung.
5. **Platform ladder.** Browser now → iPad App Store → Win/macOS/Linux.
   Prefer MIT/BSD; LGPL is a relink-obligation headache in packaged
   App Store binaries, GPL is out.
6. **Determinism.** Same journal → same audible result. (See §2.3 for
   what "same" can and cannot mean for rendered audio.)

## 2. The baseline: the Web Audio API itself (no library)

Everything below is measured against what the platform already gives
us for free:

- **`decodeAudioData`** — full decode of WAV, MP3, AAC/M4A, and FLAC in
  every current engine. Ogg Vorbis/Opus decode everywhere EXCEPT
  Safari older than 18.4; Safari 18.4 (iOS/iPadOS 18.4, March 2025)
  added Opus and Vorbis in Ogg containers, closing the historic gap on
  current devices.
- **`AudioBufferSourceNode`** — sample-accurate scheduled playback with
  offset + duration per clip: precisely the clip/trim model. `GainNode`
  per clip/track covers mixing. That is the ENTIRE node vocabulary the
  slice needs.
- **`OfflineAudioContext`** — renders the same graph faster than
  realtime into an AudioBuffer: the **bake**.
- **`AudioWorklet`** — custom DSP on the render thread (Safari 14.1+).
  Not needed for the slice; the door for future scrub/stretch.

### 2.1 iPad / WKWebView caveats (rung 1)

- Audio must be unlocked by a user gesture (first tap creates/resumes
  the AudioContext). A native wrapper can relax this
  (`mediaTypesRequiringUserActionForPlayback = []`).
- Hardware runs at 48 kHz; assume resampling and never bake
  rate-dependent assumptions into ops.
- Background/silent-switch behavior is governed by the wrapper's
  native `AVAudioSession` — a wrapper concern, not an engine concern.

### 2.2 Verdict

**The core engine should be raw Web Audio.** The slice's needs map
1:1 onto four platform primitives; every framework below adds a
state/transport model we would have to fight to keep the journal in
charge. This also matches how the drawing engine was built: own the
core, vendor only leaf utilities.

### 2.3 Determinism note (design constraint, not a library question)

`OfflineAudioContext` output is deterministic for a given
engine+version+platform but **not bit-exact across them** (float
rounding, resampler differences). Consequences:

- The baked master is **derived content** — like thumbnails: evict or
  rebuild = recompute, perceptually identical, possibly not
  byte-identical across machines.
- Key baked audio by a **hash of the audio ops that produced it**,
  not by content hash of the rendered bytes.
- If a team workflow ever needs a canonical master, the bake that
  ships is the one committed into the package as an asset; replay
  compares ops, never rendered PCM.

## 3. Engines / frameworks

| Library | License | Script-tag | Verdict |
|---|---|---|---|
| **Tone.js** (v15.x, active through 2026) | MIT | UMD, ~200 KB | **No.** Its Transport/Timeline IS the product — a second clock and a second event journal. Everything it adds (synths, scheduling, effects) is either unneeded or conflicts with ours. |
| **Howler.js** (v2.2.x) | MIT | single IIFE, ~30 KB | **No.** Playback convenience for games/sites (sprites, fallbacks, spatial). No graph access for per-clip trim/bake; wraps exactly the parts of Web Audio we want to touch directly. |
| **Elementary Audio** (v2+, open-sourced MIT) | MIT | npm/ESM-first | **No for the slice; watch for later.** Declarative "audio as a function of state" is philosophically close to our journal, and its engine is portable (browser/plugin/native) which rhymes with the platform ladder. But it's a full functional DSP runtime — vast overkill for clips+gain — and its distribution assumes a bundler. Reconsider if the Grading/Composite era ever needs real DSP chains. |
| **standardized-audio-context** | MIT | ESM-first | **No.** A compatibility shim from the era of `webkitAudioContext` divergence; current Safari/Chrome/Firefox agreement makes it dead weight. |

## 4. Waveform rendering

| Library | License | Script-tag | Verdict |
|---|---|---|---|
| **wavesurfer.js v7** (~7.9.x) | BSD-3 | UMD + plugin UMDs, ~40 KB | **No.** Best-in-class for a *player widget*, but it owns the element, the playback, and the peak cache. Our lanes need multi-track canvas rendering under pan/zoom with peaks streamed through AssetCache — wavesurfer would be a decoration we render around, not a component. |
| **peaks.js** (BBC) + waveform-data.js | **LGPL-3** | UMD | **No.** Same architectural mismatch as wavesurfer plus an LGPL obligation we don't want in an App Store binary. |
| **Own renderer** | — | — | **Yes.** A min/max **peak pyramid** (mipmap-style: peaks at 256/1024/4096 samples-per-bin) computed once per asset at import, stored as a small package unit next to the audio bytes. Lane drawing is then a trivial canvas strip at any zoom. Overviews are AssetCache tenants exactly like thumbs.js — evict = recompute from the decoded buffer, pixel-identical. ~150 lines, and it reuses patterns we already battle-tested. |

## 5. Decoders (beyond `decodeAudioData`)

Policy first: **normalize at import**. Decode once when the user drops
a file in; keep the original bytes in the package for fidelity; decoded
PCM is a derived, evictable asset. Then the decoder question is only
"what formats can be *imported* on which platform":

| Need | Option | License | Weight | Verdict |
|---|---|---|---|---|
| WAV/MP3/AAC/FLAC | browser `decodeAudioData` | — | 0 | **Default.** Universal. |
| Ogg Vorbis/Opus on Safari < 18.4 | **@wasm-audio-decoders** (`ogg-vorbis`, `opus-decoder`) | wrapper MIT; libvorbis/libopus BSD | ~100 KB each, single file, WASM inlined (yEnc+DEFLATE) | **Vendor on demand.** Exactly our shape: one script tag, no fetch, no build. Add per-format only when a real import fails. |
| MP3 via WASM | `mpg123-decoder` (same family) | wrapper MIT, **libmpg123 LGPL-2.1** | ~70 KB | **Never needed** — browsers decode MP3 natively; skip and dodge the LGPL question entirely. |
| Everything | **ffmpeg.wasm** | MIT wrapper over LGPL/GPL ffmpeg | ~25–30 MB + workers | **No.** Size, worker/threading plumbing, and license exposure — all to solve a problem we don't have. |

## 6. Encoders / the bake

| Need | Option | Verdict |
|---|---|---|
| Bake master into the package | `OfflineAudioContext` → **own WAV writer** | **Yes.** 16-bit or float32 PCM WAV is ~40 lines of DataView code (we already hand-roll zip/SWF codecs; this is smaller). Packages are local; WAV size is a non-issue under streaming. |
| Compressed delivery (MP3/Ogg) | lamejs (LGPL), wasm-media-encoders (MIT wrapper, LAME LGPL) | **Not in the slice.** Compressed export belongs to the Export section with the movie encoder decision; decide there. |
| Record the mix | MediaRecorder | **No.** Realtime-only, lossy, nondeterministic. |

## 7. Time-stretch / pitch (future shelf, not the slice)

| Library | License | Notes |
|---|---|---|
| **signalsmith-stretch** (v1.3.x) | **MIT** | C++ library with an official WASM/AudioWorklet web release. Quality is state-of-the-art for open source; the C++ core also ports to the native rung. **The pick when stretch is needed.** |
| soundtouchjs | LGPL-2.1 | Older algorithm, weaker quality, license friction. Pass. |
| Rubber Band (incl. WASM builds) | **GPL** / paid commercial | Out unless we ever buy the license. |

Clip-speed ops can even ship *before* any stretch library: plain
`playbackRate` on the source node is journal-safe (pitch shifts, like
tape) and the op vocabulary (`clipSpeed`) stays identical when a
stretcher upgrades the render path later.

## 8. The native rung (engine outlook, for the record)

The journal is the contract: audio ops are engine-agnostic, so the
engine can be swapped per rung without touching project data.

- **WKWebView wrapper (rung 1):** keep Web Audio; the wrapper supplies
  `AVAudioSession` config, gesture-unlock relaxation, background audio.
  Zero engine rewrite.
- **Full native (later):** `AVAudioEngine` (first-party, free),
  **AudioKit** (MIT Swift sugar over it), or **miniaudio** (MIT-0 C,
  single file) if we ever want one C core across desktop platforms.
  **JUCE** is GPL/commercial — avoid by default.

## 9. Recommendation

**Ship the Audio slice with zero vendored libraries.**

| Layer | Choice | Vendored bytes |
|---|---|---|
| Engine / graph | raw Web Audio (`AudioBufferSourceNode` + `GainNode`) | 0 |
| Transport | own, driven by the project clock | 0 |
| Bake | `OfflineAudioContext` + own WAV writer | 0 |
| Waveforms | own peak pyramid + canvas lanes (thumbs.js pattern, AssetCache tenant) | 0 |
| Decode | browser `decodeAudioData`; normalize at import | 0 |
| Decode fallback | @wasm-audio-decoders per format, **only when a real import fails** | ~100 KB each, deferred |
| Stretch | none; `playbackRate` op now, signalsmith-stretch (MIT) when quality stretch is asked for | deferred |

The first vendored dependency appears the day someone imports an Ogg
file on a pre-18.4 iPad or asks for pitch-preserving stretch — and both
slots already have a named, license-clean, script-tag-ready candidate.

## Sources

- [wavesurfer.js v7 README (unpkg)](https://app.unpkg.com/wavesurfer.js@7.9.9/files/README.md) · [repo](https://github.com/katspaugh/wavesurfer.js)
- [MDN Web audio codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs) · [Opus format — Safari 18.4 Ogg support](https://en.wikipedia.org/wiki/Opus_(audio_format))
- [signalsmith-stretch (MIT, WASM/AudioWorklet release)](https://github.com/Signalsmith-Audio/signalsmith-stretch) · [project page](https://signalsmith-audio.co.uk/code/stretch/)
- [wasm-audio-decoders (single-file builds, inlined WASM)](https://github.com/eshaz/wasm-audio-decoders) · [@wasm-audio-decoders/ogg-vorbis](https://www.npmjs.com/package/@wasm-audio-decoders/ogg-vorbis)
- [Elementary Audio v2 open source (MIT)](https://www.nickwritesablog.com/elementary-audio-v2-0-now-open-source/) · [repo](https://github.com/elemaudio/elementary)
- [Tone.js releases (15.x, active 2025–2026)](https://github.com/Tonejs/Tone.js/releases) · [docs](https://tonejs.github.io/docs/)
