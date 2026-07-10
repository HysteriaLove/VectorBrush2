/* roughtl.js — the ROUGHS timeline (user spec, fixed-resolution
 * round): three lanes on the shared T1 ms axis —
 *
 *   BOARDS   the storyboard filmstrip, READ-ONLY here (a reference:
 *            clicking seeks; editing lives in Boards/Audio)
 *   MASTER   the stems' mixdown envelope, READ-ONLY (sync surface)
 *   ROUGH    the frame-by-frame animation track — ONE track: the
 *            current scene's active layer; click a cell to land on it
 *
 * The playhead is rig.masterMs like every other timeline. The board
 * reference OVERLAY on the canvas (opacity slider, top-right) draws
 * the panel under the playhead across the rough canvas at 2× (boards
 * are exactly half the stage) — referencing, never editable here.
 */
(function () {
  "use strict";

  var RULER_H = 20, BOARDS_H = 46, MASTER_H = 28, FRAMES_H = 34;

  var view = {
    host: null, app: null, cvs: null, alphaEl: null, ro: null,
    pxPerMs: 0.08, panMs: 0,
    drag: null
  };

  function frameMs() {
    return 1000 / (view.app.project.fps || 24);
  }

  function xOf(ms) { return (ms - view.panMs) * view.pxPerMs; }
  function msOf(x) { return x / view.pxPerMs + view.panMs; }

  /** Where the current scene sits on the master axis: the start of
   *  its FIRST sequence instance, in ms. */
  function sceneStartMs() {
    var project = view.app.project;
    var scene = project.scenes[project.cur.scene];
    if (!scene) return 0;
    var at = 0;
    for (var i = 0; i < (project.sequence || []).length; i++) {
      var inst = project.sequence[i];
      if (inst.scene === scene.id) return at * frameMs();
      at += Math.max(1, inst.duration | 0);
    }
    return 0;
  }

  function lanes() {
    return {
      ruler: 0,
      boards: RULER_H,
      master: RULER_H + BOARDS_H,
      frames: RULER_H + BOARDS_H + MASTER_H,
      end: RULER_H + BOARDS_H + MASTER_H + FRAMES_H
    };
  }

  function theme(name, fallback) {
    var v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function render() {
    if (!view.cvs || !view.app) return;
    var cvs = view.cvs;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    var ctx = cvs.getContext("2d");
    var project = view.app.project;
    var L = lanes();
    var C = {
      bg: theme("--bg", "#f1f5f9"), panel: theme("--panel", "#f8fafc"),
      edge: theme("--panel-edge", "#d7dee7"), text: theme("--text", "#1e293b"),
      dim: theme("--text-dim", "#64748b"), accent: theme("--accent", "#2563eb"),
      hot: theme("--hot", "#dc2626"), field: theme("--field", "#ffffff")
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // ruler (seconds + frame ticks when they resolve)
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = C.edge;
    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui";
    ctx.textAlign = "left";
    var stepMs = 1000;
    while (stepMs * view.pxPerMs < 56) stepMs *= 2;
    ctx.beginPath();
    for (var t = Math.max(0, Math.floor(view.panMs / stepMs) * stepMs);
         xOf(t) < w; t += stepMs) {
      var x = Math.round(xOf(t)) + 0.5;
      ctx.moveTo(x, 8); ctx.lineTo(x, RULER_H);
      ctx.fillText((t / 1000).toFixed(1) + "s", x + 3, 8);
    }
    if (frameMs() * view.pxPerMs > 4) {
      for (var f = Math.max(0, Math.floor(view.panMs / frameMs()) * frameMs());
           xOf(f) < w; f += frameMs()) {
        var fx = Math.round(xOf(f)) + 0.5;
        ctx.moveTo(fx, RULER_H - 4); ctx.lineTo(fx, RULER_H);
      }
    }
    ctx.stroke();

    // BOARDS lane — the read-only filmstrip (reference, click = seek)
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, L.boards, w, BOARDS_H);
    var spans = VB.spinePanelSpans(project);
    var curSpan = VB.spinePanelAtMs(project, VB.audioNow());
    spans.forEach(function (sp) {
      var bx = xOf(sp.startMs);
      var bw = (sp.endMs - sp.startMs) * view.pxPerMs;
      if (bx + bw < 0 || bx > w) return;
      var isCur = curSpan && sp.panel.id === curSpan.panel.id;
      ctx.fillStyle = "#ece0b4";
      ctx.strokeStyle = isCur ? C.accent : "#8f8869";
      ctx.lineWidth = isCur ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(bx + 1, L.boards + 4, Math.max(2, bw - 2),
                    BOARDS_H - 8, 2);
      ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1;
      if (bw > 24 && VB.thumbGet) {
        var cached = VB.thumbGet("panel:" + sp.panel.id, sp.panel.cell);
        if (cached) {
          var th = BOARDS_H - 12;
          var tw = th * 4 / 3; // boards are 800×600
          ctx.save();
          ctx.beginPath();
          ctx.rect(bx + 2, L.boards + 6, Math.max(1, bw - 4), th);
          ctx.clip();
          for (var tx = bx + 2; tx < bx + bw - 2; tx += tw + 2) {
            ctx.drawImage(cached, tx, L.boards + 6, tw, th);
          }
          ctx.restore();
        } else if (VB.thumbRequest) {
          VB.thumbRequest("panel:" + sp.panel.id, sp.panel.cell,
                          96, 72, sp.index).then(function () {
            if (view.host) render();
          });
        }
      }
    });
    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui";
    if (!spans.length) {
      ctx.fillText("boards appear here as the story is written",
                   6, L.boards + BOARDS_H / 2 + 3);
    }
    ctx.strokeStyle = C.edge;
    ctx.beginPath();
    ctx.moveTo(0, L.master + 0.5); ctx.lineTo(w, L.master + 0.5);
    ctx.stroke();

    // MASTER lane — the mixdown envelope (read-only sync surface)
    ctx.fillStyle = "#2f3350";
    ctx.fillRect(0, L.master, w, MASTER_H);
    ctx.fillStyle = "#7b86e8";
    var mid = L.master + MASTER_H / 2;
    var amp = MASTER_H / 2 - 2;
    var tracks = (project.audio && project.audio.tracks) || [];
    for (var mx = 0; mx < w; mx++) {
      var ms = msOf(mx);
      if (ms < 0) continue;
      var lo = 0, hi = 0;
      for (var ti = 0; ti < tracks.length; ti++) {
        for (var ci = 0; ci < tracks[ti].clips.length; ci++) {
          var cl = tracks[ti].clips[ci];
          if (ms < cl.at || ms > cl.at + cl.duration) continue;
          var pk = VB.audioPeaks(project, cl.asset, function () {
            if (view.host) render();
          });
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
        ctx.fillRect(mx, mid + lo * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }
    ctx.fillStyle = "#aab2f0";
    ctx.font = "9px system-ui";
    ctx.fillText("master", 6, L.master + 10);

    // ROUGH frames lane — THE editable track: the current scene's
    // active layer, frame by frame
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, L.frames, w, FRAMES_H);
    var scene = project.scenes[project.cur.scene];
    var layer = scene && scene.layers[project.cur.layer];
    if (layer) {
      var start = sceneStartMs();
      var span = project.sceneSpan();
      var fm = frameMs();
      for (var i = 0; i < span; i++) {
        var cx = xOf(start + i * fm);
        var cw = fm * view.pxPerMs;
        if (cx + cw < 0 || cx > w) continue;
        var drawn = i < layer.frames.length;
        var has = drawn && (layer.frames[i].edges.length > 0 ||
                            layer.frames[i].texts.length > 0);
        ctx.fillStyle = !drawn ? C.bg : has ? "#b6c2d2" : C.field;
        ctx.fillRect(cx + 0.5, L.frames + 4, Math.max(1, cw - 1),
                     FRAMES_H - 8);
        ctx.strokeStyle = i === (project.cur.frame || 0)
          ? C.accent : C.edge;
        ctx.lineWidth = i === (project.cur.frame || 0) ? 2 : 1;
        ctx.strokeRect(cx + 0.5, L.frames + 4, Math.max(1, cw - 1),
                       FRAMES_H - 8);
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = C.dim;
      ctx.font = "9px system-ui";
      ctx.fillText("rough · " + layer.name, 6, L.frames + FRAMES_H - 8);
    }

    // the ONE playhead
    var px = Math.round(xOf(VB.audioNow())) + 0.5;
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = C.hot;
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
      ctx.stroke();
    }
  }

  /** Scrub: the shared playhead moves, and when the ms lands inside
   *  the current scene the drawn frame follows LIVE (direct cur.frame,
   *  like the step grid) — the landing frame is pinned in the journal
   *  on release. */
  function scrubTo(ms) {
    var project = view.app.project;
    var f = Math.floor((ms - sceneStartMs()) / frameMs());
    if (f >= 0 && f < project.sceneSpan()) project.cur.frame = f;
    VB.audioSeek(Math.max(0, Math.round(ms)));
    render();
    if (view.app.requestRender) view.app.requestRender();
  }

  function wire() {
    var cvs = view.cvs;
    cvs.addEventListener("pointerdown", function (ev) {
      var r = cvs.getBoundingClientRect();
      var x = ev.clientX - r.left;
      if (ev.button === 1) {
        ev.preventDefault();
        cvs.setPointerCapture(ev.pointerId);
        view.drag = { kind: "pan", x0: x, pan0: view.panMs };
        return;
      }
      if (ev.button !== 0) return;
      if (view.app.stopPlayback) view.app.stopPlayback();
      cvs.setPointerCapture(ev.pointerId);
      scrubTo(msOf(x));
      view.drag = { kind: "seek" };
    });
    cvs.addEventListener("pointermove", function (ev) {
      if (!view.drag) return;
      var r = cvs.getBoundingClientRect();
      var x = ev.clientX - r.left;
      if (view.drag.kind === "pan") {
        view.panMs = Math.max(-100 / view.pxPerMs,
          view.drag.pan0 - (x - view.drag.x0) / view.pxPerMs);
        render();
        return;
      }
      if (view.drag.kind === "seek") scrubTo(msOf(x));
    });
    function endDrag() {
      var was = view.drag;
      view.drag = null;
      if (was && was.kind === "seek") {
        // pin the landing frame (clamps identically live and in replay)
        view.app.exec({ op: "frameSelect",
                        index: view.app.project.cur.frame || 0 });
      }
    }
    cvs.addEventListener("pointerup", endDrag);
    cvs.addEventListener("pointercancel", endDrag);
    cvs.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var r = cvs.getBoundingClientRect();
      var x = ev.clientX - r.left;
      var msAt = msOf(x);
      var factor = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
      view.pxPerMs = Math.max(0.01, Math.min(2, view.pxPerMs * factor));
      view.panMs = msAt - x / view.pxPerMs;
      render();
    }, { passive: false });
  }

  function mount(host, app) {
    if (view.host === host) { view.app = app; render(); return; }
    view.host = host;
    view.app = app;
    host.innerHTML = "";
    view.cvs = document.createElement("canvas");
    view.cvs.id = "rt-canvas";
    host.appendChild(view.cvs);

    // the board REFERENCE opacity — how strongly the storyboard under
    // the playhead shows over the rough canvas
    var refWrap = document.createElement("label");
    refWrap.id = "rt-ref";
    refWrap.title = "Board reference opacity over the rough canvas";
    refWrap.textContent = "board ref ";
    view.alphaEl = document.createElement("input");
    view.alphaEl.type = "range";
    view.alphaEl.min = "0";
    view.alphaEl.max = "100";
    var savedAlpha = 35;
    try {
      var sv = parseInt(localStorage.getItem("vb-roughref"), 10);
      if (isFinite(sv)) savedAlpha = Math.max(0, Math.min(100, sv));
    } catch (e) { /* defaults */ }
    view.alphaEl.value = String(savedAlpha);
    app.boardRefAlpha = savedAlpha / 100;
    view.alphaEl.addEventListener("input", function () {
      app.boardRefAlpha = (parseInt(view.alphaEl.value, 10) || 0) / 100;
      try {
        localStorage.setItem("vb-roughref", view.alphaEl.value);
      } catch (e) { /* storage unavailable */ }
      app.requestRender();
    });
    refWrap.appendChild(view.alphaEl);
    host.appendChild(refWrap);

    wire();
    if (window.ResizeObserver) {
      view.ro = new ResizeObserver(function () { render(); });
      view.ro.observe(host);
    }
    render();
  }

  window.VB = window.VB || {};
  VB.RoughTimeline = {
    mount: mount,
    refresh: render,
    isMounted: function () { return !!view.host; }
  };
})();
