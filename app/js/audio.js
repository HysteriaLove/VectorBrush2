/* audio.js — the Audio workspace (Architecture §6.5): stems → track/
 * clip edits → the baked master.
 *
 * Engine decision (docs/AudioResearch.md): raw Web Audio, zero vendored
 * libraries. Audio BYTES are package units ("assets/audio/<id>" via
 * VB.projectAssets — never journal payload); journaled ops carry only
 * ids and integer-millisecond structure, so the journal replays
 * byte-exact with or without the bytes present. Decoded buffers are
 * derived, evictable content (AssetCache tenants); the baked master is
 * derived too — OfflineAudioContext renders are NOT bit-exact across
 * engines, so determinism lives in the ops, never in rendered PCM.
 *
 * Time base: integer milliseconds. The project clock (frames at
 * project.fps) maps onto it exactly; the ruler shows both.
 * Thin UI, real model.
 */
(function () {
  "use strict";

  // pens can drop their pointer between down and capture (Windows Ink,
  // out-of-range lift) — the NotFoundError must never kill the handler
  function capturePtr(el, ev) {
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* pen */ }
  }

  var MIN_CLIP_MS = 20;

  // ---- model + ops -----------------------------------------------------------

  function audioOf(project) {
    project.audio = project.audio || { assets: [], tracks: [] };
    return project.audio;
  }

  function assetById(project, id) {
    var assets = audioOf(project).assets;
    for (var i = 0; i < assets.length; i++) {
      if (assets[i].id === id) return { asset: assets[i], index: i };
    }
    return null;
  }

  function trackById(project, id) {
    var tracks = audioOf(project).tracks;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].id === id) return { track: tracks[i], index: i };
    }
    return null;
  }

  function clipById(project, id) {
    var tracks = audioOf(project).tracks;
    for (var t = 0; t < tracks.length; t++) {
      for (var c = 0; c < tracks[t].clips.length; c++) {
        if (tracks[t].clips[c].id === id) {
          return { track: tracks[t], trackIndex: t,
                   clip: tracks[t].clips[c], index: c };
        }
      }
    }
    return null;
  }

  /** Timeline end: the last clip's tail, in ms. */
  function audioEndMs(project) {
    var end = 0;
    audioOf(project).tracks.forEach(function (tr) {
      tr.clips.forEach(function (cl) {
        end = Math.max(end, cl.at + cl.duration);
      });
    });
    return end;
  }

  // A stem lands in the project: metadata only — the bytes were written
  // to the package (op.unit) by the importer before this op ran.
  VB.defineOp("audioImport", function (c, op) {
    c.history.push(c.project);
    var assets = audioOf(c.project).assets;
    assets.push({
      id: op.id, name: op.name || "stem " +
        String(assets.length + 1).padStart(2, "0"),
      unit: op.unit,
      duration: Math.max(1, op.duration | 0), // ms
      sampleRate: op.sampleRate | 0,
      channels: op.channels | 0
    });
    c.sync();
  });

  // removing a stem removes every clip that plays it — ONE undo step
  VB.defineOp("audioRemove", function (c, op) {
    var hit = assetById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    audioOf(c.project).assets.splice(hit.index, 1);
    audioOf(c.project).tracks.forEach(function (tr) {
      tr.clips = tr.clips.filter(function (cl) { return cl.asset !== op.id; });
    });
    c.sync();
  });

  VB.defineOp("trackAdd", function (c, op) {
    c.history.push(c.project);
    var tracks = audioOf(c.project).tracks;
    tracks.push({
      id: op.id,
      name: op.name || "Track " + String(tracks.length + 1).padStart(2, "0"),
      clips: []
    });
    c.sync();
  });

  VB.defineOp("trackRename", function (c, op) {
    var hit = trackById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.track.name = op.name;
    c.sync();
  });

  VB.defineOp("trackRemove", function (c, op) {
    var hit = trackById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    audioOf(c.project).tracks.splice(hit.index, 1);
    c.sync();
  });

  VB.defineOp("clipAdd", function (c, op) {
    var tr = trackById(c.project, op.track);
    var as = assetById(c.project, op.asset);
    if (!tr || !as) return;
    c.history.push(c.project);
    tr.track.clips.push({
      id: op.id, asset: op.asset,
      at: Math.max(0, op.at | 0),
      offset: Math.max(0, op.offset | 0),
      duration: Math.max(MIN_CLIP_MS,
        (op.duration === undefined ? as.asset.duration : op.duration) | 0),
      gain: op.gain === undefined ? 1 : op.gain
    });
    c.sync();
  });

  VB.defineOp("clipMove", function (c, op) {
    var hit = clipById(c.project, op.id);
    if (!hit) return;
    var dest = op.track !== undefined ? trackById(c.project, op.track) : null;
    c.history.push(c.project);
    hit.clip.at = Math.max(0, op.at | 0);
    if (dest && dest.track !== hit.track) {
      hit.track.clips.splice(hit.index, 1);
      dest.track.clips.push(hit.clip);
    }
    c.sync();
  });

  // the op carries FINAL values (at/offset/duration) so replay never
  // re-derives edge math
  VB.defineOp("clipTrim", function (c, op) {
    var hit = clipById(c.project, op.id);
    if (!hit) return;
    var as = assetById(c.project, hit.clip.asset);
    c.history.push(c.project);
    hit.clip.at = Math.max(0, op.at | 0);
    hit.clip.offset = Math.max(0, op.offset | 0);
    var maxDur = as ? as.asset.duration - hit.clip.offset : op.duration | 0;
    hit.clip.duration = Math.max(MIN_CLIP_MS,
      Math.min(maxDur, op.duration | 0));
    c.sync();
  });

  VB.defineOp("clipGain", function (c, op) {
    var hit = clipById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.clip.gain = Math.max(0, Math.min(2, +op.gain || 0));
    c.sync();
  });

  VB.defineOp("clipRemove", function (c, op) {
    var hit = clipById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.track.clips.splice(hit.index, 1);
    c.sync();
  });

  // ---- WAV codec (own — ~40 lines, like every other codec here) ---------------

  /** 16-bit PCM WAV from Float32 channel arrays. Returns ArrayBuffer. */
  VB.wavEncode = function (channels, sampleRate) {
    var ch = channels.length, n = channels[0].length;
    var blockAlign = ch * 2, dataLen = n * blockAlign;
    var buf = new ArrayBuffer(44 + dataLen);
    var v = new DataView(buf);
    function str(off, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    }
    str(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);              // PCM
    v.setUint16(22, ch, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * blockAlign, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, dataLen, true);
    var off = 44;
    for (var i = 0; i < n; i++) {
      for (var c = 0; c < ch; c++) {
        var s = Math.max(-1, Math.min(1, channels[c][i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return buf;
  };

  // ---- the rig: decode, peaks, transport, bake --------------------------------
  // Live-view machinery — never touched by ops or replay. Decoded
  // buffers are AssetCache tenants (evict = re-decode from the package,
  // sample-identical).

  var rig = {
    ctx: null,           // realtime AudioContext (gesture-created)
    buffers: {},         // assetId -> AudioBuffer
    peaks: {},           // assetId -> { bins, min: Float32Array, max: Float32Array }
    pending: {},         // assetId -> Promise (decode in flight)
    playing: null,       // { sources: [], t0, fromMs, endMs, raf }
    masterMs: 0          // THE shared playhead — every workspace reads it
  };

  function ensureCtx() {
    if (!rig.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      rig.ctx = new AC();
    }
    if (rig.ctx.state === "suspended") rig.ctx.resume();
    return rig.ctx;
  }

  function decodeBytes(bytes) {
    // decode on an offline context: works headless, no gesture needed
    var oc = new (window.OfflineAudioContext ||
                  window.webkitOfflineAudioContext)(1, 1, 48000);
    var buf = bytes.buffer.slice(bytes.byteOffset,
                                 bytes.byteOffset + bytes.byteLength);
    return new Promise(function (res, rej) {
      oc.decodeAudioData(buf, res, rej);
    });
  }

  /** Decoded buffer for an asset — from cache or the package unit. */
  function decodeAsset(asset) {
    if (rig.buffers[asset.id]) return Promise.resolve(rig.buffers[asset.id]);
    if (rig.pending[asset.id]) return rig.pending[asset.id];
    var get = VB.projectAssets ? VB.projectAssets.get(asset.unit)
      : Promise.resolve(null);
    rig.pending[asset.id] = Promise.resolve(get).then(function (bytes) {
      if (!bytes) throw new Error("missing unit " + asset.unit);
      return decodeBytes(bytes);
    }).then(function (buffer) {
      delete rig.pending[asset.id];
      rig.buffers[asset.id] = buffer;
      var claim = buffer.length * buffer.numberOfChannels * 4;
      if (VB.assets) {
        VB.assets.claim("audio:" + asset.id, claim, function () {
          delete rig.buffers[asset.id];
          delete rig.peaks[asset.id];
        });
      }
      return buffer;
    }, function (err) {
      delete rig.pending[asset.id];
      throw err;
    });
    return rig.pending[asset.id];
  }

  /** Min/max peak pyramid (mono mixdown) for lane drawing. */
  function peaksFor(asset) {
    if (rig.peaks[asset.id]) return rig.peaks[asset.id];
    var buffer = rig.buffers[asset.id];
    if (!buffer) return null;
    var BIN = 512;
    var bins = Math.ceil(buffer.length / BIN);
    var min = new Float32Array(bins), max = new Float32Array(bins);
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var data = buffer.getChannelData(c);
      for (var b = 0; b < bins; b++) {
        var lo = c === 0 ? 0 : min[b], hi = c === 0 ? 0 : max[b];
        var end = Math.min(data.length, (b + 1) * BIN);
        for (var i = b * BIN; i < end; i++) {
          if (data[i] < lo) lo = data[i];
          if (data[i] > hi) hi = data[i];
        }
        min[b] = lo; max[b] = hi;
      }
    }
    rig.peaks[asset.id] = { bin: BIN, rate: buffer.sampleRate,
                            bins: bins, min: min, max: max };
    return rig.peaks[asset.id];
  }

  /** Schedule every clip intersecting [fromMs, end] onto ctx. */
  function scheduleClips(ctx, project, fromMs, when0) {
    var sources = [];
    audioOf(project).tracks.forEach(function (tr) {
      tr.clips.forEach(function (cl) {
        var buffer = rig.buffers[cl.asset];
        if (!buffer) return;
        var clEnd = cl.at + cl.duration;
        if (clEnd <= fromMs) return;
        var lead = Math.max(0, cl.at - fromMs) / 1000;     // s until start
        var skip = Math.max(0, fromMs - cl.at);            // ms into the clip
        var src = ctx.createBufferSource();
        src.buffer = buffer;
        var g = ctx.createGain();
        g.gain.value = cl.gain;
        src.connect(g); g.connect(ctx.destination);
        src.start(when0 + lead, (cl.offset + skip) / 1000,
                  (cl.duration - skip) / 1000);
        sources.push(src);
      });
    });
    return sources;
  }

  function stopPlayback() {
    if (!rig.playing) return;
    rig.playing.sources.forEach(function (s) {
      try { s.stop(); } catch (e) { /* already ended */ }
    });
    if (rig.playing.raf) cancelAnimationFrame(rig.playing.raf);
    rig.playing = null;
  }

  /** Decode whatever is missing, then play from fromMs. */
  function startPlayback(project, fromMs, onTick, onDone) {
    stopPlayback();
    var need = {};
    audioOf(project).tracks.forEach(function (tr) {
      tr.clips.forEach(function (cl) { need[cl.asset] = true; });
    });
    var jobs = Object.keys(need).map(function (id) {
      var hit = assetById(project, id);
      return hit ? decodeAsset(hit.asset).catch(function () {}) : null;
    });
    return Promise.all(jobs).then(function () {
      var ctx = ensureCtx();
      var endMs = audioEndMs(project);
      if (fromMs >= endMs) fromMs = 0;
      var t0 = ctx.currentTime + 0.03;
      var sources = scheduleClips(ctx, project, fromMs, t0);
      rig.playing = { sources: sources, t0: t0, fromMs: fromMs,
                      endMs: endMs, raf: 0 };
      (function tick() {
        if (!rig.playing) return;
        var ms = rig.playing.fromMs + (ctx.currentTime - rig.playing.t0) * 1000;
        if (ms >= rig.playing.endMs) {
          rig.masterMs = rig.playing.endMs;
          stopPlayback();
          tickUI(rig.masterMs);
          if (onDone) onDone();
          return;
        }
        ms = Math.max(rig.playing.fromMs, ms);
        rig.masterMs = ms;
        tickUI(ms);
        if (onTick) onTick(ms);
        rig.playing.raf = requestAnimationFrame(tick);
      })();
    });
  }

  /** Every tick reaches every mounted view, regardless of who started
   *  the transport — the playhead is ONE thing across workspaces. */
  function tickUI(ms) {
    if (view.host) {
      if (view.timeEl) view.timeEl.textContent = fmtMs(ms);
      syncBoardStrip();
      renderLanes();
    }
    if (VB.audioTickHook) {
      try { VB.audioTickHook(ms); } catch (e) { /* display only */ }
    }
  }

  /** Offline render → 16-bit WAV bytes. 48kHz stereo master. */
  function bakeMaster(project) {
    var endMs = audioEndMs(project);
    if (!endMs) return Promise.reject(new Error("nothing to bake"));
    var need = {};
    audioOf(project).tracks.forEach(function (tr) {
      tr.clips.forEach(function (cl) { need[cl.asset] = true; });
    });
    return Promise.all(Object.keys(need).map(function (id) {
      var hit = assetById(project, id);
      return hit ? decodeAsset(hit.asset) : null;
    })).then(function () {
      var rate = 48000;
      var oc = new (window.OfflineAudioContext ||
        window.webkitOfflineAudioContext)(2, Math.ceil(endMs / 1000 * rate), rate);
      scheduleClips(oc, project, 0, 0);
      return oc.startRendering();
    }).then(function (rendered) {
      var chans = [];
      for (var c = 0; c < rendered.numberOfChannels; c++) {
        chans.push(rendered.getChannelData(c));
      }
      return new Uint8Array(VB.wavEncode(chans, rendered.sampleRate));
    });
  }

  // ---- workspace view -----------------------------------------------------------
  // Two stacked views (user spec, the AP2 shape): the BOARD STRIP —
  // storyboard panels playing left-to-right — over the SYNC TIMELINE:
  // a panel lane (board lengths against real time), the MASTER track
  // (the mixdown every workspace scrubs against), and the stem tracks
  // that feed it. Panel durations stay journaled FRAMES; the lane only
  // EDITS them (never absolute audio ms — re-cutting audio must not
  // re-time the board).

  var RULER_H = 24, LANE_H = 64;
  var PANEL_LANE_H = 54, MASTER_LANE_H = 34;

  var view = {
    host: null, app: null, lanes: null, stems: null, timeEl: null,
    playBtn: null, ro: null, board: null,
    bmain: null, bsides: [],       // the leica viewer slots
    bcenterId: null, bcenterHash: null,
    pxPerMs: 0.1, panMs: 0,        // 100 px/s default
    sel: null,                     // selected clip id
    drag: null                     // {kind, ...} pointer session
  };

  function exec(op) { view.app.exec(op); }

  function fmtMs(ms) {
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0") + "." +
      String(Math.floor(ms % 1000 / 100));
  }

  function xOf(ms) { return (ms - view.panMs) * view.pxPerMs; }
  function msOf(x) { return x / view.pxPerMs + view.panMs; }

  function tracksY() { return RULER_H + PANEL_LANE_H + MASTER_LANE_H; }

  function laneIndexAt(y) {
    if (y < tracksY()) return -1;
    return Math.floor((y - tracksY()) / LANE_H);
  }

  /** Which band of the sync timeline a y sits in. */
  function zoneAt(y) {
    if (y < RULER_H) return "ruler";
    if (y < RULER_H + PANEL_LANE_H) return "panels";
    if (y < tracksY()) return "master";
    return "tracks";
  }

  // ---- the panel lane (T1 animatic time = the audio ms axis) ----------------------

  function frameMsOf(project) { return 1000 / (project.fps || 24); }

  /** Panel spans in ms: [{ panel, index, startMs, endMs }]. */
  function panelSpans(project) {
    var fm = frameMsOf(project);
    var out = [];
    var at = 0;
    (VB.spineOf ? VB.spineOf(project).panels : []).forEach(function (p, i) {
      var len = Math.max(1, p.duration | 0) * fm;
      out.push({ panel: p, index: i, startMs: at, endMs: at + len });
      at += len;
    });
    return out;
  }

  function panelSpanAt(project, ms) {
    var spans = panelSpans(project);
    for (var i = 0; i < spans.length; i++) {
      if (ms < spans[i].endMs || i === spans.length - 1) return spans[i];
    }
    return null;
  }

  /** The boundary (panel end) within grab range of x, or null. */
  function boundaryAt(project, x) {
    var spans = panelSpans(project);
    for (var i = 0; i < spans.length; i++) {
      if (Math.abs(xOf(spans[i].endMs) - x) < 6) return spans[i];
    }
    return null;
  }

  function clipAt(x, y) {
    var lane = laneIndexAt(y);
    var tracks = audioOf(view.app.project).tracks;
    if (lane < 0 || lane >= tracks.length) return null;
    var ms = msOf(x);
    var tr = tracks[lane];
    for (var i = tr.clips.length - 1; i >= 0; i--) {
      var cl = tr.clips[i];
      if (ms >= cl.at && ms <= cl.at + cl.duration) {
        return { track: tr, trackIndex: lane, clip: cl };
      }
    }
    return null;
  }

  function theme(name, fallback) {
    var v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function renderLanes() {
    if (!view.lanes) return;
    var cvs = view.lanes;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    var ctx = cvs.getContext("2d");
    var project = view.app.project;
    var tracks = audioOf(project).tracks;
    var C = {
      bg: theme("--bg", "#e4e6e9"), panel: theme("--panel", "#f2f3f5"),
      edge: theme("--panel-edge", "#c6cad0"), text: theme("--text", "#24262a"),
      dim: theme("--text-dim", "#6b7079"), accent: theme("--accent", "#2f7fd6"),
      field: theme("--field", "#ffffff"), hover: theme("--hover", "#cfe0f5")
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // ruler: seconds always, frame ticks when they resolve (>4px apart)
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, w, RULER_H);
    var frameMs = 1000 / (project.fps || 24);
    ctx.strokeStyle = C.edge;
    ctx.fillStyle = C.dim;
    ctx.font = "10px system-ui";
    ctx.textAlign = "left";
    var stepMs = 1000;
    while (stepMs * view.pxPerMs < 60) stepMs *= 2;
    var startS = Math.max(0, Math.floor(view.panMs / stepMs) * stepMs);
    ctx.beginPath();
    for (var t = startS; xOf(t) < w; t += stepMs) {
      var x = Math.round(xOf(t)) + 0.5;
      ctx.moveTo(x, 10); ctx.lineTo(x, RULER_H);
      ctx.fillText(fmtMs(t), x + 3, 9);
    }
    if (frameMs * view.pxPerMs > 4) {
      for (var f = Math.max(0, Math.floor(view.panMs / frameMs) * frameMs);
           xOf(f) < w; f += frameMs) {
        var fx = Math.round(xOf(f)) + 0.5;
        ctx.moveTo(fx, RULER_H - 5); ctx.lineTo(fx, RULER_H);
      }
    }
    ctx.stroke();

    // the PANEL LANE: board lengths against real time — blocks drawn
    // from journaled frame durations, boundaries dragged here
    var py = RULER_H;
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, py, w, PANEL_LANE_H);
    var spans = panelSpans(project);
    var curSpan = panelSpanAt(project, rig.masterMs);
    spans.forEach(function (sp) {
      var bx = xOf(sp.startMs);
      var bw = (sp.endMs - sp.startMs) * view.pxPerMs;
      if (view.drag && view.drag.kind === "pboundary") {
        // live ghost: the dragged boundary re-times this pair
        var d = view.drag;
        var fm = frameMsOf(project);
        if (sp.index === d.index) {
          bw = d.frames * fm * view.pxPerMs;
        } else if (sp.index === d.index + 1 && d.nextFrames0 !== null) {
          var lx = xOf(sp.startMs) +
            (d.frames - d.frames0) * fm * view.pxPerMs;
          bx = lx;
          bw = (d.frames0 + d.nextFrames0 - d.frames) * fm * view.pxPerMs;
        }
      }
      if (bx + bw < 0 || bx > w) return;
      ctx.fillStyle = "#ece0b4"; // the paper-board tan
      ctx.strokeStyle = sp === curSpan ? C.accent : "#8f8869";
      ctx.lineWidth = sp === curSpan ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(bx + 1, py + 5, Math.max(2, bw - 2), PANEL_LANE_H - 10, 2);
      ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1;
      // the FILMSTRIP: the board's art tiles across its whole span
      // (NLE clip style — the storyboard's actual look on the track)
      var num = String(sp.index + 1);
      if (bw > 24 && VB.thumbGet) {
        var cached = VB.thumbGet("panel:" + sp.panel.id, sp.panel.cell);
        if (cached) {
          var th = PANEL_LANE_H - 14;
          var tw = th * 4 / 3; // boards are 800×600
          ctx.save();
          ctx.beginPath();
          ctx.rect(bx + 2, py + 7, Math.max(1, bw - 4), th);
          ctx.clip();
          for (var tx = bx + 2; tx < bx + bw - 2; tx += tw + 2) {
            ctx.drawImage(cached, tx, py + 7, tw, th);
          }
          ctx.restore();
        } else if (VB.thumbRequest) {
          VB.thumbRequest("panel:" + sp.panel.id, sp.panel.cell,
                          96, 72, sp.index).then(function () {
            if (view.host) renderLanes();
          });
        }
      }
      ctx.fillStyle = "#4b4736";
      ctx.font = "10px system-ui";
      ctx.textAlign = "right";
      ctx.save();
      ctx.beginPath(); ctx.rect(bx, py, Math.max(2, bw), PANEL_LANE_H);
      ctx.clip();
      ctx.fillText(num, bx + bw - 5, py + PANEL_LANE_H - 10);
      ctx.restore();
    });
    if (!spans.length) {
      ctx.fillStyle = C.dim;
      ctx.font = "11px system-ui";
      ctx.textAlign = "left";
      ctx.fillText("no panels yet — write in Story or board in Boards",
                   6, py + PANEL_LANE_H / 2 + 4);
    }
    ctx.strokeStyle = C.edge;
    ctx.beginPath();
    ctx.moveTo(0, py + PANEL_LANE_H + 0.5);
    ctx.lineTo(w, py + PANEL_LANE_H + 0.5);
    ctx.stroke();

    // the MASTER track: every stem mixes into this one lane — the
    // sync everything scrubs against (combined peak envelope, drawn
    // per visible pixel from the per-clip pyramids; no bake needed)
    var my = RULER_H + PANEL_LANE_H;
    ctx.fillStyle = "#2f3350";
    ctx.fillRect(0, my, w, MASTER_LANE_H);
    ctx.fillStyle = "#7b86e8";
    var mid = my + MASTER_LANE_H / 2;
    var amp = MASTER_LANE_H / 2 - 3;
    for (var mx = 0; mx < w; mx++) {
      var ms = msOf(mx);
      if (ms < 0) continue;
      var lo = 0, hi = 0;
      for (var ti = 0; ti < tracks.length; ti++) {
        for (var ci = 0; ci < tracks[ti].clips.length; ci++) {
          var cl = tracks[ti].clips[ci];
          if (ms < cl.at || ms > cl.at + cl.duration) continue;
          var ah = assetById(project, cl.asset);
          var pk = ah && peaksFor(ah.asset);
          if (!pk) continue;
          var b = Math.floor((cl.offset + ms - cl.at) / 1000 *
                             pk.rate / pk.bin);
          if (b < 0 || b >= pk.bins) continue;
          lo += pk.min[b] * (cl.gain || 1);
          hi += pk.max[b] * (cl.gain || 1);
        }
      }
      lo = Math.max(-1, lo); hi = Math.min(1, hi);
      if (hi > lo) {
        ctx.fillRect(mx, mid + lo * amp, 1,
                     Math.max(1, (hi - lo) * amp));
      }
    }
    ctx.fillStyle = "#aab2f0";
    ctx.font = "10px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("master", 6, my + 12);
    ctx.strokeStyle = C.edge;
    ctx.beginPath();
    ctx.moveTo(0, my + MASTER_LANE_H + 0.5);
    ctx.lineTo(w, my + MASTER_LANE_H + 0.5);
    ctx.stroke();

    // stem lanes
    for (var i = 0; i < tracks.length; i++) {
      var y = tracksY() + i * LANE_H;
      ctx.fillStyle = i % 2 ? C.bg : C.panel;
      ctx.fillRect(0, y, w, LANE_H);
      ctx.strokeStyle = C.edge;
      ctx.beginPath();
      ctx.moveTo(0, y + LANE_H + 0.5); ctx.lineTo(w, y + LANE_H + 0.5);
      ctx.stroke();
      tracks[i].clips.forEach(function (cl) {
        drawClip(ctx, tracks[i], cl, y, C);
      });
      ctx.fillStyle = C.dim;
      ctx.font = "11px system-ui";
      ctx.textAlign = "left";
      ctx.fillText(tracks[i].name, 6, y + 14);
    }
    // the track area extends to the BOTTOM: empty ghost lanes keep the
    // alternating pattern going (the DAW look — and where new tracks
    // will land)
    var gi = tracks.length;
    for (var gy = tracksY() + tracks.length * LANE_H; gy < h;
         gy += LANE_H, gi++) {
      ctx.fillStyle = gi % 2 ? C.bg : C.panel;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, gy, w, Math.min(LANE_H, h - gy));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = C.edge;
      ctx.beginPath();
      ctx.moveTo(0, gy + Math.min(LANE_H, h - gy) + 0.5);
      ctx.lineTo(w, gy + Math.min(LANE_H, h - gy) + 0.5);
      ctx.stroke();
    }

    // drop ghost while dragging a stem in
    if (view.drag && view.drag.kind === "place" && view.drag.overMs !== undefined) {
      var gy = tracksY() + view.drag.overLane * LANE_H;
      ctx.fillStyle = C.hover;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(xOf(view.drag.overMs), gy + 4,
                   view.drag.asset.duration * view.pxPerMs, LANE_H - 8);
      ctx.globalAlpha = 1;
    }

    // playhead
    var px = Math.round(xOf(rig.masterMs)) + 0.5;
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = theme("--hot", "#d03030");
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
      ctx.stroke();
    }
  }

  function drawClip(ctx, track, cl, laneY, C) {
    var project = view.app.project;
    // live drag ghost overrides the model position
    var at = cl.at, dur = cl.duration, off = cl.offset;
    if (view.drag && view.drag.clip === cl) {
      at = view.drag.at; dur = view.drag.duration; off = view.drag.offset;
      laneY = tracksY() + view.drag.lane * LANE_H;
    }
    var x = xOf(at), cw = dur * view.pxPerMs;
    if (x + cw < 0 || x > ctx.canvas.width) return;
    var y = laneY + 4, chh = LANE_H - 8;
    ctx.fillStyle = C.field;
    ctx.strokeStyle = view.sel === cl.id ? C.accent : C.edge;
    ctx.lineWidth = view.sel === cl.id ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(2, cw), chh, 3);
    ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1;

    var hit = assetById(project, cl.asset);
    if (hit) {
      var pk = peaksFor(hit.asset);
      if (pk) {
        ctx.fillStyle = C.accent;
        var mid = y + chh / 2, amp = (chh / 2 - 3) * (cl.gain || 1);
        var x0 = Math.max(0, x), x1 = Math.min(ctx.canvas.width, x + cw);
        for (var sx = Math.floor(x0); sx < x1; sx++) {
          var ms0 = off + (msOf(sx) - at);
          var b = Math.floor(ms0 / 1000 * pk.rate / pk.bin);
          if (b < 0 || b >= pk.bins) continue;
          ctx.fillRect(sx, mid + pk.min[b] * amp, 1,
                       Math.max(1, (pk.max[b] - pk.min[b]) * amp));
        }
      } else {
        // decode kicks off; redraw arrives via the promise
        decodeAsset(hit.asset).then(function () { renderLanes(); },
                                    function () {});
      }
      ctx.fillStyle = C.text;
      ctx.font = "10px system-ui";
      ctx.textAlign = "left";
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, Math.max(2, cw), chh); ctx.clip();
      ctx.fillText(hit.asset.name + (cl.gain !== 1
        ? " · " + Math.round(cl.gain * 100) + "%" : ""), x + 4, y + 11);
      ctx.restore();
    }
  }

  // ---- the board viewer: the playhead's panel LARGE and centered --------------------
  // a leica focus view (user spec): the current board big in the
  // middle, its neighbors small and dim at the sides, swapping as the
  // playhead crosses boundaries. The center renders straight from the
  // cell (always current, DPR-crisp); the sides ride the shared
  // thumbnail cache + prefetcher (the streaming proxy ladder).

  function drawPanelInto(cvs, panel) {
    var dpr = window.devicePixelRatio || 1;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== Math.round(w * dpr)) {
      cvs.width = Math.round(w * dpr);
      cvs.height = Math.round(h * dpr);
    }
    var ctx = cvs.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!panel) return;
    var cw = panel.cell.width / VB.TWIPS, ch = panel.cell.height / VB.TWIPS;
    var zoom = Math.min(w / cw, h / ch);
    VB.render(ctx, panel.cell, {
      zoom: zoom, panX: (w - cw * zoom) / 2, panY: (h - ch * zoom) / 2,
      dpr: dpr
    });
  }

  function seekToSpan(sp) {
    if (!sp) return;
    view.app.exec({ op: "boardsSelect", panel: sp.index });
    // land safely INSIDE the span: boundaries sit on fractional ms
    // (frames × 1000/fps), and rounding DOWN parked the playhead a
    // hair before the boundary — still in the previous panel, so the
    // center never advanced (user bug). Ceil is always ≥ the start
    // and a frame is ~42ms, so it can never overshoot the span.
    rig.masterMs = Math.ceil(sp.startMs);
    if (view.timeEl) view.timeEl.textContent = fmtMs(rig.masterMs);
    if (rig.playing) {
      // clicking a board WHILE PLAYING jumps the transport there
      stopPlayback();
      togglePlay();
    }
    syncBoardStrip();
    renderLanes();
  }

  function makeViewerSlot(className, offset) {
    var root = document.createElement("div");
    root.className = className;
    var cvs = document.createElement("canvas");
    root.appendChild(cvs);
    var num = document.createElement("span");
    num.className = "au-bnum";
    root.appendChild(num);
    root.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0) return;
      var project = view.app.project;
      var cur = panelSpanAt(project, rig.masterMs);
      var spans = panelSpans(project);
      var target = cur ? spans[cur.index + offset] : spans[0];
      seekToSpan(target);
    });
    return { root: root, cvs: cvs, num: num };
  }

  /** The CENTER is a full board card — the same form the Boards page
   *  shows (header fields, action title, drawing, Dialog) — while the
   *  side slots stay plain drawing previews (user spec). Display-only:
   *  editing lives in Boards; timing lives in the lane below. */
  function makeCenterCard() {
    var root = document.createElement("div");
    root.className = "bdcard au-bcard";
    var cvs = document.createElement("canvas");
    cvs.className = "bdframe";
    root.appendChild(cvs);
    var dialog = document.createElement("div");
    dialog.className = "bddialog";
    var title = document.createElement("div");
    title.className = "bdtitle";
    dialog.appendChild(title);
    var lines = document.createElement("div");
    lines.className = "bdlines";
    dialog.appendChild(lines);
    root.appendChild(dialog);
    return { root: root, cvs: cvs, title: title, lines: lines };
  }

  function updateCenterCard(cur, force) {
    var project = view.app.project;
    var c = view.bmain;
    var hash = VB.pixiHashCell ? VB.pixiHashCell(cur.panel.cell) : 0;
    var changed = view.bcenterId !== cur.panel.id ||
                  view.bcenterHash !== hash;
    if (changed) drawPanelInto(c.cvs, cur.panel);
    if (!changed && !force) return;
    view.bcenterId = cur.panel.id;
    view.bcenterHash = hash;
    var action = null;
    cur.panel.rows.forEach(function (r) {
      if (!action && r.kind === "action") action = r;
    });
    c.title.textContent = action ? (action.content || "") : "";
    c.lines.innerHTML = "";
    cur.panel.rows.forEach(function (r) {
      if (r.kind !== "line") return;
      var row = document.createElement("div");
      row.className = "bdline";
      var who = document.createElement("div");
      who.className = "au-bcwho";
      var entry = VB.spineCharacterById(project, r.character);
      who.textContent = entry ? entry.name : "";
      var say = document.createElement("div");
      say.className = "bdsay";
      say.textContent = VB.lineTextOf(r);
      row.appendChild(who);
      row.appendChild(say);
      c.lines.appendChild(row);
    });
  }

  function sideThumb(slot, sp, curIndex) {
    // offscreen/absent boards CULL (no reserved gap at the reel ends)
    slot.root.style.display = sp ? "" : "none";
    if (!sp) return;
    // 4:3 — the boards' half-stage shape
    if (slot.cvs.width !== 128 || slot.cvs.height !== 96) {
      slot.cvs.width = 128; slot.cvs.height = 96;
    }
    slot.num.textContent = String(sp.index + 1) + " · " +
      ((sp.endMs - sp.startMs) / 1000).toFixed(1) + "s";
    var ctx = slot.cvs.getContext("2d");
    var cached = VB.thumbGet &&
      VB.thumbGet("panel:" + sp.panel.id, sp.panel.cell);
    if (cached) {
      ctx.clearRect(0, 0, slot.cvs.width, slot.cvs.height);
      ctx.drawImage(cached, 0, 0, slot.cvs.width, slot.cvs.height);
    } else {
      ctx.clearRect(0, 0, slot.cvs.width, slot.cvs.height);
      if (VB.thumbRequest) {
        VB.thumbRequest("panel:" + sp.panel.id, sp.panel.cell, 128, 96,
                        Math.abs(sp.index - curIndex)).then(function (cv) {
          if (cv && slot.cvs.isConnected) {
            slot.cvs.getContext("2d")
              .drawImage(cv, 0, 0, slot.cvs.width, slot.cvs.height);
          }
        });
      }
    }
  }

  /** As many side boards as each ZONE affords — the reel fills the
   *  screen left-to-right and culls past the ends (user spec). */
  function ensureSideSlots() {
    var zoneW = Math.max(view.bzoneL.clientWidth || 0,
                         view.bzoneR.clientWidth || 0);
    var perSide = Math.max(1, Math.min(12, Math.floor(zoneW / 152)));
    if (view.bsides.length === perSide * 2) return;
    view.bsides.forEach(function (s) { s.slot.root.remove(); });
    view.bsides = [];
    var o;
    for (o = -perSide; o <= -1; o++) {
      var sl = { off: o, slot: makeViewerSlot("au-bside", o) };
      view.bsides.push(sl);
      view.bzoneL.appendChild(sl.slot.root);
    }
    for (o = 1; o <= perSide; o++) {
      var sr = { off: o, slot: makeViewerSlot("au-bside", o) };
      view.bsides.push(sr);
      view.bzoneR.appendChild(sr.slot.root);
    }
  }

  /** The center card fits the BOARD AREA: dragging the splitter (a
   *  taller timeline = a shorter viewer) shrinks the card so the whole
   *  form — 4:3 drawing + dialogue — stays inside (user spec). Width
   *  follows the height budget; the canvas redraws when it moves. */
  function sizeCenterCard(cur) {
    var c = view.bmain;
    if (!c || !view.board) return;
    var dlg = c.root.lastElementChild;
    // the card may be CLIPPED right now (max-height) — measure the
    // dialog by its natural scrollHeight, capped so a long dialogue
    // scrolls instead of crushing the drawing
    var chrome = Math.max(0,
      c.root.offsetHeight - c.cvs.offsetHeight - dlg.offsetHeight);
    var want = Math.min(dlg.scrollHeight, 120);
    var free = view.board.clientHeight - 20 - chrome - want;
    var w = Math.min(520, window.innerWidth * 0.38,
                     Math.max(200, free * 4 / 3));
    var px = Math.round(w) + "px";
    if (c.root.style.width !== px) {
      c.root.style.width = px;
      drawPanelInto(c.cvs, cur ? cur.panel : null);
    }
  }

  function syncBoardStrip(force) {
    if (!view.board || !view.app || !view.bmain) return;
    var project = view.app.project;
    var spans = panelSpans(project);
    var cur = panelSpanAt(project, rig.masterMs);
    view.board.classList.toggle("empty", spans.length === 0);
    ensureSideSlots();
    if (!cur) {
      view.bmain.root.style.visibility = "hidden";
      view.bsides.forEach(function (s) { sideThumb(s.slot, null, 0); });
      return;
    }
    view.bmain.root.style.visibility = "visible";
    updateCenterCard(cur, force);
    sizeCenterCard(cur);
    view.bsides.forEach(function (s) {
      sideThumb(s.slot, spans[cur.index + s.off] || null, cur.index);
    });
  }

  /** Warm the caches nearest-first (the §5 contract): stems whose
   *  clips play soonest decode first; everything is droppable — the
   *  AssetCache evict just forces a re-decode later. */
  function prefetchAround(project, ms) {
    var jobs = [];
    audioOf(project).tracks.forEach(function (tr) {
      tr.clips.forEach(function (cl) {
        var hit = assetById(project, cl.asset);
        if (!hit || rig.buffers[cl.asset]) return;
        var dist = cl.at + cl.duration < ms ? ms - (cl.at + cl.duration)
          : cl.at > ms ? cl.at - ms : 0;
        jobs.push({ id: cl.asset, asset: hit.asset, dist: dist });
      });
    });
    jobs.sort(function (a, b) { return a.dist - b.dist; });
    jobs.forEach(function (j, i) {
      if (VB.prefetcher) {
        VB.prefetcher.schedule("audio:" + j.id, i, function () {
          return decodeAsset(j.asset).then(function () {
            if (view.host) renderLanes();
          }, function () {});
        });
      } else {
        decodeAsset(j.asset).then(function () {
          if (view.host) renderLanes();
        }, function () {});
      }
    });
  }

  function refreshStems() {
    if (!view.stems) return;
    view.stems.innerHTML = "";
    var assets = audioOf(view.app.project).assets;
    if (!assets.length) {
      var empty = document.createElement("div");
      empty.className = "au-empty";
      empty.textContent = "Import stems, then drag them onto a track.";
      view.stems.appendChild(empty);
      return;
    }
    assets.forEach(function (asset) {
      var row = document.createElement("div");
      row.className = "au-stem";
      row.dataset.id = asset.id;
      row.title = "Drag onto a track to place a clip";
      var nm = document.createElement("span");
      nm.className = "aname";
      nm.textContent = asset.name;
      var dur = document.createElement("span");
      dur.className = "au-dur";
      dur.textContent = fmtMs(asset.duration);
      var del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Remove this stem and every clip that plays it";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (!confirm('Remove "' + asset.name + '" and all of its clips?')) return;
        exec({ op: "audioRemove", id: asset.id });
      });
      row.appendChild(nm); row.appendChild(dur); row.appendChild(del);
      // drag a stem out onto the lanes
      row.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0 || ev.target === del) return;
        ev.preventDefault();
        view.drag = { kind: "place", asset: asset };
        capturePtr(row, ev);
      });
      row.addEventListener("pointermove", function (ev) {
        if (!view.drag || view.drag.kind !== "place") return;
        var r = view.lanes.getBoundingClientRect();
        var x = ev.clientX - r.left, y = ev.clientY - r.top;
        var lane = laneIndexAt(y);
        var tracks = audioOf(view.app.project).tracks;
        if (x >= 0 && x <= r.width && lane >= 0 &&
            lane < Math.max(1, tracks.length)) {
          view.drag.overLane = Math.min(lane, Math.max(0, tracks.length - 1));
          view.drag.overMs = Math.max(0, Math.round(msOf(x)));
        } else {
          view.drag.overMs = undefined;
        }
        renderLanes();
      });
      row.addEventListener("pointerup", function () {
        var d = view.drag;
        view.drag = null;
        if (!d || d.kind !== "place" || d.overMs === undefined) {
          renderLanes(); return;
        }
        var tracks = audioOf(view.app.project).tracks;
        var trackId;
        if (!tracks.length) {
          trackId = VB.actorNewId("track");
          exec({ op: "trackAdd", id: trackId });
        } else {
          trackId = tracks[d.overLane].id;
        }
        var clipId = VB.actorNewId("clip");
        exec({ op: "clipAdd", id: clipId, track: trackId,
               asset: d.asset.id, at: d.overMs });
        view.sel = clipId;
        renderLanes();
      });
      row.addEventListener("pointercancel", function () {
        view.drag = null; renderLanes();
      });
      view.stems.appendChild(row);
    });
  }

  function importFiles(files) {
    Array.prototype.slice.call(files).forEach(function (file) {
      file.arrayBuffer().then(function (raw) {
        var bytes = new Uint8Array(raw);
        return decodeBytes(bytes).then(function (buffer) {
          var id = VB.actorNewId("aud");
          var unit = "assets/audio/" + id;
          var put = VB.projectAssets
            ? VB.projectAssets.put(unit, bytes) : Promise.resolve();
          return Promise.resolve(put).then(function () {
            rig.buffers[id] = buffer; // already decoded — keep it warm
            if (VB.assets) {
              VB.assets.claim("audio:" + id,
                buffer.length * buffer.numberOfChannels * 4, function () {
                  delete rig.buffers[id];
                  delete rig.peaks[id];
                });
            }
            exec({ op: "audioImport", id: id,
                   name: file.name.replace(/\.[^.]+$/, ""),
                   unit: unit,
                   duration: Math.round(buffer.duration * 1000),
                   sampleRate: buffer.sampleRate,
                   channels: buffer.numberOfChannels });
          });
        });
      }).catch(function (err) {
        view.app.setMsg('could not decode "' + file.name + '" — ' +
          (err && err.message || "unsupported format"));
      });
    });
  }

  // The transport toggle is GLOBAL: it works from any workspace (the
  // Audio view merely shows it), and keeps playing across tab switches.
  function togglePlay() {
    if (rig.playing) {
      stopPlayback();
      syncPlayBtn();
      return;
    }
    var appRef = view.app || window.VBApp;
    if (!appRef || !appRef.project) return;
    startPlayback(appRef.project, rig.masterMs, null, function () {
      syncPlayBtn(); // tickUI already fans out the position
    }).then(syncPlayBtn);
  }

  function syncPlayBtn() {
    if (view.playBtn) view.playBtn.textContent = rig.playing ? "⏹" : "▶";
  }

  function onKeyDown(ev) {
    if (!view.host) return;
    var tag = ev.target && ev.target.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (view.app.doUndo) view.app.doUndo();
      return;
    }
    if ((ev.ctrlKey && ev.key.toLowerCase() === "y") ||
        (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "z")) {
      ev.preventDefault();
      if (view.app.doRedo) view.app.doRedo();
      return;
    }
    // Space is handled by the GLOBAL transport toggle below
    if ((ev.key === "Delete" || ev.key === "Backspace") && view.sel) {
      ev.preventDefault();
      exec({ op: "clipRemove", id: view.sel });
      view.sel = null;
      return;
    }
    if (ev.key === "Escape") { view.sel = null; renderLanes(); }
  }

  function mount(host, app) {
    if (view.host === host) { view.app = app; refresh(); return; }
    unmount();
    view.host = host;
    view.app = app;
    host.innerHTML = "";

    // toolpanels join the floating ISLANDS (the core xRack UI
    // language) and leave with the workspace
    var bar = document.getElementById("topbar");
    view.xpanels = [];
    function xpanel(name) {
      var p;
      if (app.xpanel) {
        p = app.xpanel(bar, "au-" + name);
      } else {
        p = document.createElement("div");
        p.className = "y2kxpanel";
        (bar || host).appendChild(p);
      }
      view.xpanels.push(p);
      return p;
    }
    function toolBtn(label, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "audio/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    fileInput.addEventListener("change", function () {
      importFiles(fileInput.files || []);
      fileInput.value = "";
    });
    var stemsPanel = xpanel("stems");
    stemsPanel.appendChild(toolBtn("⭱ Import", "Import audio stems (WAV/MP3/AAC/FLAC)",
      function () { fileInput.click(); }));
    stemsPanel.appendChild(fileInput);
    view.playBtn = toolBtn("▶", "Play / stop (Space)", togglePlay);
    var transPanel = xpanel("transport");
    transPanel.appendChild(view.playBtn);
    view.timeEl = document.createElement("span");
    view.timeEl.id = "au-time";
    view.timeEl.textContent = fmtMs(rig.masterMs);
    transPanel.appendChild(view.timeEl);
    stemsPanel.appendChild(toolBtn("＋ Track", "Add a track", function () {
      exec({ op: "trackAdd", id: VB.actorNewId("track") });
    }));
    xpanel("bake").appendChild(toolBtn("⤓ Bake", "Render the master (48kHz WAV into the package)",
      function () {
        view.app.setMsg("baking the master…");
        bakeMaster(view.app.project).then(function (wav) {
          var put = VB.projectAssets
            ? VB.projectAssets.put("assets/audio/master.wav", wav)
            : Promise.resolve();
          return Promise.resolve(put).then(function () {
            view.app.setMsg("master baked — " +
              Math.round(wav.length / 1024) + " KB WAV in the package");
          });
        }).catch(function (err) {
          view.app.setMsg("bake failed: " + (err && err.message || err));
        });
      }));

    // the BOARD VIEWER (current panel large + centered) over the SYNC
    // TIMELINE
    view.board = document.createElement("div");
    view.board.id = "au-board";
    view.board.dataset.ph =
      "the storyboard plays here — panels appear as they are written";
    // BALANCED ZONES keep the main board pinned to the true middle
    // (user spec) no matter how many side boards each side has; side
    // slots fill each zone's width and cull past the ends
    view.bsides = [];
    view.bzoneL = document.createElement("div");
    view.bzoneL.className = "au-bzone left";
    view.bzoneR = document.createElement("div");
    view.bzoneR.className = "au-bzone right";
    view.bmain = makeCenterCard();
    view.bcenterId = null;
    view.bcenterHash = null;
    view.board.appendChild(view.bzoneL);
    view.board.appendChild(view.bmain.root);
    view.board.appendChild(view.bzoneR);
    host.appendChild(view.board);
    // the viewer/timeline split is the user's to size (drag handle);
    // the height persists as view state
    try {
      var savedH = parseInt(localStorage.getItem("vb-au-boardh"), 10);
      if (savedH >= 140) view.board.style.height = savedH + "px";
    } catch (e) { /* defaults */ }
    var split = document.createElement("div");
    split.id = "au-split";
    split.title = "Drag to resize the board viewer and the timeline";
    split.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      capturePtr(split, ev);
      var y0 = ev.clientY;
      var h0 = view.board.offsetHeight;
      function onMove(e2) {
        var hMax = Math.round(host.clientHeight * 0.75);
        var hNew = Math.max(140, Math.min(hMax, h0 + (e2.clientY - y0)));
        view.board.style.height = hNew + "px";
        syncBoardStrip();
        renderLanes();
      }
      function onUp() {
        split.removeEventListener("pointermove", onMove);
        split.removeEventListener("pointerup", onUp);
        split.removeEventListener("pointercancel", onUp);
        try {
          localStorage.setItem("vb-au-boardh",
            String(view.board.offsetHeight));
        } catch (e) { /* storage unavailable */ }
      }
      split.addEventListener("pointermove", onMove);
      split.addEventListener("pointerup", onUp);
      split.addEventListener("pointercancel", onUp);
    });
    host.appendChild(split);

    var body = document.createElement("div");
    body.id = "au-body";
    view.stems = document.createElement("div");
    view.stems.id = "au-stems";
    body.appendChild(view.stems);
    view.lanes = document.createElement("canvas");
    view.lanes.id = "au-lanes";
    body.appendChild(view.lanes);
    host.appendChild(body);

    // ---- lane pointer interactions ----
    var lanes = view.lanes;
    lanes.addEventListener("pointerdown", function (ev) {
      var r = lanes.getBoundingClientRect();
      var x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (ev.button === 1) {
        ev.preventDefault();
        capturePtr(lanes, ev);
        view.drag = { kind: "pan", x0: x, pan0: view.panMs };
        return;
      }
      if (ev.button !== 0) return;
      capturePtr(lanes, ev);
      var zone = zoneAt(y);
      if (zone === "panels") {
        // a boundary drag re-times the pair (zone-preserving); any
        // other press scrubs AND selects the panel under the pointer
        var project = view.app.project;
        var bd = boundaryAt(project, x);
        if (bd && bd.index < panelSpans(project).length - 0) {
          var next = VB.spineOf(project).panels[bd.index + 1];
          view.drag = { kind: "pboundary", id: bd.panel.id,
                        index: bd.index, x0: x,
                        frames0: Math.max(1, bd.panel.duration | 0),
                        nextFrames0: next
                          ? Math.max(1, next.duration | 0) : null,
                        frames: Math.max(1, bd.panel.duration | 0) };
          renderLanes();
          return;
        }
        var sp = panelSpanAt(project, msOf(x));
        if (sp) view.app.exec({ op: "boardsSelect", panel: sp.index });
        rig.masterMs = Math.max(0, Math.round(msOf(x)));
        if (view.timeEl) view.timeEl.textContent = fmtMs(rig.masterMs);
        if (rig.playing) { stopPlayback(); togglePlay(); }
        view.drag = { kind: "seek" };
        syncBoardStrip();
        renderLanes();
        return;
      }
      if (zone === "ruler" || zone === "master") {
        // scrub/seek the SHARED master position
        rig.masterMs = Math.max(0, Math.round(msOf(x)));
        if (view.timeEl) view.timeEl.textContent = fmtMs(rig.masterMs);
        if (rig.playing) { stopPlayback(); togglePlay(); }
        view.drag = { kind: "seek" };
        syncBoardStrip();
        renderLanes();
        return;
      }
      var hit = clipAt(x, y);
      if (!hit) { view.sel = null; renderLanes(); return; }
      view.sel = hit.clip.id;
      var cx0 = xOf(hit.clip.at);
      var cx1 = xOf(hit.clip.at + hit.clip.duration);
      var kind = x - cx0 < 6 ? "trim-l" : cx1 - x < 6 ? "trim-r" : "move";
      view.drag = {
        kind: kind, clip: hit.clip, x0: x,
        at: hit.clip.at, offset: hit.clip.offset,
        duration: hit.clip.duration, lane: hit.trackIndex,
        asset: assetById(view.app.project, hit.clip.asset)
      };
      renderLanes();
    });
    lanes.addEventListener("pointermove", function (ev) {
      var r = lanes.getBoundingClientRect();
      var x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (!view.drag) {
        if (zoneAt(y) === "panels") {
          lanes.style.cursor = boundaryAt(view.app.project, x)
            ? "ew-resize" : "default";
          return;
        }
        var over = clipAt(x, y);
        if (over) {
          var ex0 = xOf(over.clip.at), ex1 = xOf(over.clip.at + over.clip.duration);
          lanes.style.cursor = (x - ex0 < 6 || ex1 - x < 6)
            ? "ew-resize" : "grab";
        } else lanes.style.cursor = "default";
        return;
      }
      var d = view.drag;
      if (d.kind === "pan") {
        view.panMs = Math.max(-200 / view.pxPerMs,
          d.pan0 - (x - d.x0) / view.pxPerMs);
        renderLanes();
        return;
      }
      if (d.kind === "seek") {
        rig.masterMs = Math.max(0, Math.round(msOf(x)));
        if (view.timeEl) view.timeEl.textContent = fmtMs(rig.masterMs);
        syncBoardStrip();
        renderLanes();
        return;
      }
      if (d.kind === "pboundary") {
        var fm = frameMsOf(view.app.project);
        var dFrames = Math.round((x - d.x0) / view.pxPerMs / fm);
        var want = Math.max(1, d.frames0 + dFrames);
        if (d.nextFrames0 !== null) {
          want = Math.min(want, d.frames0 + d.nextFrames0 - 1);
        }
        d.frames = want;
        renderLanes();
        return;
      }
      if (!d.clip) return;
      var dMs = Math.round((x - d.x0) / view.pxPerMs);
      var maxDur = d.asset ? d.asset.asset.duration : Infinity;
      if (d.kind === "move") {
        d.at = Math.max(0, d.clip.at + dMs);
        var lane = laneIndexAt(y);
        var nTracks = audioOf(view.app.project).tracks.length;
        if (lane >= 0 && lane < nTracks) d.lane = lane;
      } else if (d.kind === "trim-l") {
        var lead = Math.max(-d.clip.offset,
          Math.min(d.clip.duration - MIN_CLIP_MS, dMs));
        d.at = d.clip.at + lead;
        d.offset = d.clip.offset + lead;
        d.duration = d.clip.duration - lead;
      } else if (d.kind === "trim-r") {
        d.duration = Math.max(MIN_CLIP_MS,
          Math.min(maxDur - d.clip.offset, d.clip.duration + dMs));
      }
      renderLanes();
    });
    lanes.addEventListener("pointerup", function () {
      var d = view.drag;
      view.drag = null;
      if (d && d.kind === "pboundary") {
        if (d.frames !== d.frames0) {
          exec({ op: "panelBoundary", id: d.id, frames: d.frames });
        }
        refresh();
        return;
      }
      if (!d || !d.clip) { renderLanes(); return; }
      var tracks = audioOf(view.app.project).tracks;
      if (d.kind === "move" &&
          (d.at !== d.clip.at || tracks[d.lane].clips.indexOf(d.clip) < 0)) {
        exec({ op: "clipMove", id: d.clip.id, at: d.at,
               track: tracks[d.lane].id });
      } else if ((d.kind === "trim-l" || d.kind === "trim-r") &&
                 (d.at !== d.clip.at || d.offset !== d.clip.offset ||
                  d.duration !== d.clip.duration)) {
        exec({ op: "clipTrim", id: d.clip.id, at: d.at,
               offset: d.offset, duration: d.duration });
      }
      renderLanes();
    });
    lanes.addEventListener("pointercancel", function () {
      view.drag = null;
      renderLanes();
    });
    lanes.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var r = lanes.getBoundingClientRect();
      var x = ev.clientX - r.left;
      var msAt = msOf(x);
      var factor = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
      view.pxPerMs = Math.max(0.005, Math.min(2, view.pxPerMs * factor));
      view.panMs = msAt - x / view.pxPerMs;
      renderLanes();
    }, { passive: false });
    // drop audio files straight onto the lanes
    lanes.addEventListener("dragover", function (ev) { ev.preventDefault(); });
    lanes.addEventListener("drop", function (ev) {
      ev.preventDefault();
      if (ev.dataTransfer && ev.dataTransfer.files.length) {
        importFiles(ev.dataTransfer.files);
      }
    });

    window.addEventListener("keydown", onKeyDown);
    if (window.ResizeObserver) {
      view.ro = new ResizeObserver(function () {
        syncBoardStrip(); // the reel re-fills the new width
        renderLanes();
      });
      view.ro.observe(host);
    }
    refresh();
  }

  function refresh() {
    if (!view.host) return;
    // prune a stale selection
    if (view.sel && !clipById(view.app.project, view.sel)) view.sel = null;
    refreshStems();
    syncBoardStrip(true); // doc changed: the card's text may differ
    renderLanes();
    syncPlayBtn();
    prefetchAround(view.app.project, rig.masterMs);
  }

  function unmount() {
    if (!view.host) return;
    (view.xpanels || []).forEach(function (p) { p.remove(); });
    view.xpanels = [];
    // the transport deliberately KEEPS PLAYING — audio runs on while
    // the user works in other tabs; Space or ▶ stops it from anywhere
    window.removeEventListener("keydown", onKeyDown);
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    view.host.innerHTML = "";
    view.host = null;
    view.lanes = null;
    view.stems = null;
    view.board = null;
    view.bmain = null;
    view.bsides = [];
    view.bzoneL = null;
    view.bzoneR = null;
    view.bcenterId = null;
    view.bcenterHash = null;
    view.timeEl = null;
    view.playBtn = null;
    view.drag = null;
    view.sel = null;
  }

  // ---- the global Space bar --------------------------------------------------
  // Space starts/stops audio from ANY workspace (user directive) —
  // except while typing, and except when a view with a richer Space
  // meaning is active: interceptors run first (the Boards animatic and
  // the sequence playhead stop themselves; Pitch keeps Space for slide
  // advance while presenting). Views register on VB.audioSpaceIntercept.
  VB.audioSpaceIntercept = VB.audioSpaceIntercept || [];
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== " " || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    var el = ev.target;
    var tag = el && el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (el && el.isContentEditable)) return;
    var hooks = VB.audioSpaceIntercept;
    for (var i = 0; i < hooks.length; i++) {
      if (hooks[i]()) { ev.preventDefault(); return; }
    }
    var appRef = view.app || window.VBApp;
    if (!rig.playing &&
        !(appRef && appRef.project && VB.audioHasClips(appRef.project))) {
      return; // nothing to play — leave Space to whoever else wants it
    }
    ev.preventDefault();
    togglePlay();
  });

  window.VB = window.VB || {};
  VB.AudioView = {
    mount: mount, unmount: unmount, refresh: refresh,
    isMounted: function () { return !!view.host; }
  };
  VB.audioEndMs = audioEndMs;
  VB.audioAssetById = assetById;
  VB.audioClipById = clipById;
  VB.audioBakeMaster = bakeMaster;
  // the shared transport — the Boards animatic (and later the master
  // timeline) plays the project's audio through the SAME rig, so there
  // is exactly one thing making sound at a time
  VB.audioHasClips = function (project) {
    return audioOf(project).tracks.some(function (tr) {
      return tr.clips.length > 0;
    });
  };
  VB.audioPlay = startPlayback;
  VB.audioStop = stopPlayback;
  // the master clock: ONE playhead across every workspace
  VB.audioNow = function () { return rig.masterMs || 0; };
  VB.audioSeek = function (ms) {
    if (!rig.playing) rig.masterMs = Math.max(0, ms || 0);
  };
  VB.audioIsPlaying = function () { return !!rig.playing; };
  /** A MediaStream of the project's audio scheduled from fromMs — the
   *  video export records this track alongside the canvas frames. */
  VB.audioExportStream = function (project, fromMs) {
    var need = {};
    audioOf(project).tracks.forEach(function (tr) {
      tr.clips.forEach(function (cl) { need[cl.asset] = true; });
    });
    var jobs = Object.keys(need).map(function (id) {
      var hit = assetById(project, id);
      return hit ? decodeAsset(hit.asset).catch(function () {}) : null;
    });
    return Promise.all(jobs).then(function () {
      var ctx = ensureCtx();
      var dest = ctx.createMediaStreamDestination();
      var when0 = ctx.currentTime + 0.05;
      var sources = [];
      audioOf(project).tracks.forEach(function (tr) {
        tr.clips.forEach(function (cl) {
          var buffer = rig.buffers[cl.asset];
          if (!buffer) return;
          if (cl.at + cl.duration <= fromMs) return;
          var lead = Math.max(0, cl.at - fromMs) / 1000;
          var skip = Math.max(0, fromMs - cl.at);
          var src = ctx.createBufferSource();
          src.buffer = buffer;
          var g = ctx.createGain();
          g.gain.value = cl.gain;
          src.connect(g);
          g.connect(dest); // to the stream only — the export is silent
          src.start(when0 + lead, (cl.offset + skip) / 1000,
                    (cl.duration - skip) / 1000);
          sources.push(src);
        });
      });
      return {
        stream: dest.stream,
        stop: function () {
          sources.forEach(function (s) {
            try { s.stop(); } catch (e) { /* ended */ }
          });
        }
      };
    });
  };
  /** Peaks for drawing a stem elsewhere (the sequence strip's audio
   *  band): returns the pyramid, or null while the decode it kicked
   *  off is still running (onReady fires when it lands). */
  VB.audioPeaks = function (project, assetId, onReady) {
    var hit = assetById(project, assetId);
    if (!hit) return null;
    var pk = peaksFor(hit.asset);
    if (!pk) {
      decodeAsset(hit.asset).then(function () {
        if (onReady) onReady();
      }, function () {});
    }
    return pk;
  };
})();
