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

  var RULER_H = 24, LANE_H = 64;

  var view = {
    host: null, app: null, lanes: null, stems: null, timeEl: null,
    playBtn: null, ro: null,
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

  function laneIndexAt(y) {
    if (y < RULER_H) return -1;
    return Math.floor((y - RULER_H) / LANE_H);
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

    // lanes
    for (var i = 0; i < tracks.length; i++) {
      var y = RULER_H + i * LANE_H;
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

    // drop ghost while dragging a stem in
    if (view.drag && view.drag.kind === "place" && view.drag.overMs !== undefined) {
      var gy = RULER_H + view.drag.overLane * LANE_H;
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
      laneY = RULER_H + view.drag.lane * LANE_H;
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
        row.setPointerCapture(ev.pointerId);
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

    var bar = document.createElement("div");
    bar.id = "au-tools";
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
    bar.appendChild(toolBtn("⭱ Import", "Import audio stems (WAV/MP3/AAC/FLAC)",
      function () { fileInput.click(); }));
    bar.appendChild(fileInput);
    view.playBtn = toolBtn("▶", "Play / stop (Space)", togglePlay);
    bar.appendChild(view.playBtn);
    view.timeEl = document.createElement("span");
    view.timeEl.id = "au-time";
    view.timeEl.textContent = fmtMs(rig.masterMs);
    bar.appendChild(view.timeEl);
    bar.appendChild(toolBtn("＋ Track", "Add a track", function () {
      exec({ op: "trackAdd", id: VB.actorNewId("track") });
    }));
    bar.appendChild(toolBtn("⤓ Bake", "Render the master (48kHz WAV into the package)",
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
    var hint = document.createElement("span");
    hint.id = "au-hint";
    hint.textContent = "drag stems onto tracks · drag clips to move · " +
      "drag edges to trim · Space plays · wheel zooms · middle-drag pans";
    bar.appendChild(hint);
    host.appendChild(bar);

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
        lanes.setPointerCapture(ev.pointerId);
        view.drag = { kind: "pan", x0: x, pan0: view.panMs };
        return;
      }
      if (ev.button !== 0) return;
      lanes.setPointerCapture(ev.pointerId);
      if (y < RULER_H) {
        // scrub/seek the SHARED master position
        rig.masterMs = Math.max(0, Math.round(msOf(x)));
        if (view.timeEl) view.timeEl.textContent = fmtMs(rig.masterMs);
        if (rig.playing) { stopPlayback(); togglePlay(); }
        view.drag = { kind: "seek" };
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
      view.ro = new ResizeObserver(function () { renderLanes(); });
      view.ro.observe(body);
    }
    refresh();
  }

  function refresh() {
    if (!view.host) return;
    // prune a stale selection
    if (view.sel && !clipById(view.app.project, view.sel)) view.sel = null;
    refreshStems();
    renderLanes();
    syncPlayBtn();
  }

  function unmount() {
    if (!view.host) return;
    // the transport deliberately KEEPS PLAYING — audio runs on while
    // the user works in other tabs; Space or ▶ stops it from anywhere
    window.removeEventListener("keydown", onKeyDown);
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    view.host.innerHTML = "";
    view.host = null;
    view.lanes = null;
    view.stems = null;
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
