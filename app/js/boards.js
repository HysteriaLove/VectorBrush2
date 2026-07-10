/* boards.js — the Boards workspace (Architecture §6.4): storyboard
 * PANELS, deck-style like Pitch (user decision 2026-07-10) with a text
 * entry field at the bottom — the panel's caption, which the animatic
 * shows as its subtitle.
 *
 * The model keeps BEATS as the grouping container (the deck UI feeds a
 * default beat for now; beat arrangement UX returns later), and panels
 * keep attached Story line ids (dormant until the dialogue-id system
 * lands). A panel is a y2kvector cell drawn with the real stage tools
 * through the journaled editTarget, a duration in frames, a caption,
 * and line refs. The animatic plays panels in order, each held for its
 * duration at project.fps. Thin UI, real model.
 */
(function () {
  "use strict";

  var PANEL_W = 960 * 20, PANEL_H = 540 * 20;
  var DEFAULT_DURATION = 24; // frames

  // ---- model + ops -----------------------------------------------------------

  function boardsOf(project) {
    project.boards = project.boards || { beats: [], cur: { beat: 0, panel: 0 } };
    return project.boards;
  }

  function beatById(project, id) {
    var beats = boardsOf(project).beats;
    for (var i = 0; i < beats.length; i++) {
      if (beats[i].id === id) return { beat: beats[i], index: i };
    }
    return null;
  }

  function panelById(project, id) {
    var beats = boardsOf(project).beats;
    for (var b = 0; b < beats.length; b++) {
      for (var p = 0; p < beats[b].panels.length; p++) {
        if (beats[b].panels[p].id === id) {
          return { beat: beats[b], beatIndex: b,
                   panel: beats[b].panels[p], index: p };
        }
      }
    }
    return null;
  }

  /** Panels in playback order with their beat. */
  function flattenPanels(project) {
    var out = [];
    boardsOf(project).beats.forEach(function (beat) {
      beat.panels.forEach(function (panel) {
        out.push({ beat: beat, panel: panel });
      });
    });
    return out;
  }

  function totalFrames(project) {
    return flattenPanels(project).reduce(function (n, e) {
      return n + Math.max(1, e.panel.duration | 0);
    }, 0);
  }

  function newPanelCell() {
    var d = new VB.Y2KVectorDocument();
    d.width = PANEL_W;
    d.height = PANEL_H;
    return d;
  }

  function clampCur(project) {
    var boards = boardsOf(project);
    boards.cur.beat = Math.max(0, Math.min(boards.beats.length - 1, boards.cur.beat));
    var beat = boards.beats[boards.cur.beat];
    boards.cur.panel = beat
      ? Math.max(0, Math.min(beat.panels.length - 1, boards.cur.panel)) : 0;
  }

  VB.defineOp("beatAdd", function (c, op) {
    c.history.push(c.project);
    var boards = boardsOf(c.project);
    boards.beats.push({
      id: op.id,
      name: op.name || "Beat " + String(boards.beats.length + 1).padStart(2, "0"),
      panels: []
    });
    boards.cur = { beat: boards.beats.length - 1, panel: 0 };
    c.sync();
  });

  VB.defineOp("beatRename", function (c, op) {
    var hit = beatById(c.project, op.beat);
    if (!hit) return;
    c.history.push(c.project);
    hit.beat.name = op.name;
    c.sync();
  });

  VB.defineOp("beatMove", function (c, op) {
    var hit = beatById(c.project, op.beat);
    if (!hit) return;
    var beats = boardsOf(c.project).beats;
    var to = Math.max(0, Math.min(beats.length - 1, op.index));
    if (to === hit.index) return;
    c.history.push(c.project);
    beats.splice(hit.index, 1);
    beats.splice(to, 0, hit.beat);
    clampCur(c.project);
    c.sync();
  });

  VB.defineOp("beatRemove", function (c, op) {
    var hit = beatById(c.project, op.beat);
    if (!hit) return;
    c.history.push(c.project);
    boardsOf(c.project).beats.splice(hit.index, 1);
    clampCur(c.project);
    c.sync();
  });

  VB.defineOp("panelAdd", function (c, op) {
    var hit = beatById(c.project, op.beat);
    if (!hit) return;
    c.history.push(c.project);
    var at = op.index === undefined ? hit.beat.panels.length
      : Math.max(0, Math.min(hit.beat.panels.length, op.index));
    hit.beat.panels.splice(at, 0, {
      id: op.id, cell: newPanelCell(),
      duration: op.duration || DEFAULT_DURATION,
      caption: op.caption || "",
      lines: []
    });
    boardsOf(c.project).cur = { beat: hit.index, panel: at };
    c.sync();
  });

  VB.defineOp("panelMove", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    var destBeat = op.beat ? beatById(c.project, op.beat) : null;
    var target = destBeat ? destBeat.beat : hit.beat;
    c.history.push(c.project);
    hit.beat.panels.splice(hit.index, 1);
    var to = Math.max(0, Math.min(target.panels.length, op.index));
    target.panels.splice(to, 0, hit.panel);
    clampCur(c.project);
    c.sync();
  });

  VB.defineOp("panelRemove", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.beat.panels.splice(hit.index, 1);
    clampCur(c.project);
    c.sync();
  });

  VB.defineOp("panelDuration", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.panel.duration = Math.max(1, Math.min(9999, op.frames | 0));
    c.sync();
  });

  /** The panel's text — the entry field at the bottom of the deck;
   *  the animatic shows it as the subtitle. */
  VB.defineOp("panelCaption", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.panel.caption = op.text;
    c.sync();
  });

  VB.defineOp("panelLineAttach", function (c, op) {
    var hit = panelById(c.project, op.panel);
    if (!hit || (hit.panel.lines || []).indexOf(op.line) >= 0) return;
    c.history.push(c.project);
    hit.panel.lines = (hit.panel.lines || []).concat([op.line]); // copy-on-write
    c.sync();
  });

  VB.defineOp("panelLineDetach", function (c, op) {
    var hit = panelById(c.project, op.panel);
    if (!hit || (hit.panel.lines || []).indexOf(op.line) < 0) return;
    c.history.push(c.project);
    hit.panel.lines = hit.panel.lines.filter(function (l) {
      return l !== op.line;
    });
    c.sync();
  });

  VB.defineOp("boardsSelect", function (c, op) {
    var boards = boardsOf(c.project);
    boards.cur = { beat: op.beat | 0, panel: op.panel | 0 };
    clampCur(c.project);
    c.sync();
  });

  function currentPanel(project) {
    var boards = boardsOf(project);
    var beat = boards.beats[boards.cur.beat];
    return beat ? (beat.panels[boards.cur.panel] || null) : null;
  }

  // ---- workspace view (deck-style, like Pitch) -----------------------------------

  var DRAW_TOOLS = [
    ["select", "➤", "Select / marquee (V)"],
    ["lasso", "➰", "Lasso (L)"],
    ["transform", "▣", "Free Transform (Q)"],
    ["pencil", "✎", "Pencil (P)"],
    ["line", "╱", "Line (N)"],
    ["oval", "◯", "Oval (O)"],
    ["rect", "▭", "Rectangle (R)"],
    ["brush", "🖌", "Brush (B)"],
    ["bucket", "🪣", "Paint bucket (K)"],
    ["eraser", "🧽", "Eraser (E)"]
  ];
  var DRAW_SET = {};
  DRAW_TOOLS.forEach(function (t) { DRAW_SET[t[0]] = true; });

  var view = {
    host: null, app: null, stage: null, strip: null, captionEl: null,
    toolStrip: null, drawBtn: null, durInput: null, ro: null,
    drawMode: false,
    animatic: { playing: false, raf: 0, last: 0, ms: 0, at: 0, frame: 0,
                audio: false }
  };

  function stageMetrics() {
    var w = view.stage.clientWidth, h = view.stage.clientHeight;
    var zoom = Math.min(w / (PANEL_W / VB.TWIPS), h / (PANEL_H / VB.TWIPS)) * 0.94;
    return {
      zoom: zoom,
      panX: (w - (PANEL_W / VB.TWIPS) * zoom) / 2,
      panY: (h - (PANEL_H / VB.TWIPS) * zoom) / 2
    };
  }

  function stageTwips(ev) {
    var rect = view.stage.getBoundingClientRect();
    var m = stageMetrics();
    return {
      x: (ev.clientX - rect.left - m.panX) / m.zoom * VB.TWIPS,
      y: (ev.clientY - rect.top - m.panY) / m.zoom * VB.TWIPS
    };
  }

  function drawPanelToStage(panel, subtitle) {
    var cvs = view.stage;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    var ctx = cvs.getContext("2d");
    if (!panel) {
      var theme = getComputedStyle(document.body);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = theme.getPropertyValue("--bg").trim() || "#e4e6e9";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = theme.getPropertyValue("--text-dim").trim() || "#6b7079";
      ctx.font = "13px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("No panels yet — add one.", w / 2, h / 2);
      return;
    }
    var m = stageMetrics();
    VB.render(ctx, panel.cell, {
      zoom: m.zoom, panX: m.panX, panY: m.panY, dpr: 1
    });
    if (view.drawMode && !view.animatic.playing) {
      var tool = view.app.toolByName(view.app.tool);
      if (tool && tool.drawOverlay) {
        var s = m.zoom / VB.TWIPS;
        ctx.setTransform(s, 0, 0, s, m.panX, m.panY);
        try { tool.drawOverlay(ctx); } catch (e) { /* overlay only */ }
      }
    }
    if (subtitle) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = "16px system-ui";
      ctx.textAlign = "center";
      var lines = subtitle.split("\n");
      var y = h - 16 - (lines.length - 1) * 22;
      lines.forEach(function (ln) {
        var tw = ctx.measureText(ln).width;
        ctx.fillStyle = "#000000b0";
        ctx.fillRect(w / 2 - tw / 2 - 8, y - 16, tw + 16, 22);
        ctx.fillStyle = "#fff";
        ctx.fillText(ln, w / 2, y);
        y += 22;
      });
    }
  }

  function subtitleFor(panel) {
    if (!panel) return "";
    if (panel.caption) return panel.caption;
    if (!panel.lines || !panel.lines.length) return "";
    return panel.lines.map(function (lineId) {
      var hit = VB.lineById(view.app.project, lineId);
      if (!hit) return "";
      var who = hit.block.character ? hit.block.character + ": " : "";
      return who + VB.lineTextOf(hit.block);
    }).filter(Boolean).join("\n");
  }

  function renderStage() {
    if (!view.stage) return;
    var panel = currentPanel(view.app.project);
    drawPanelToStage(panel, view.animatic.playing ? subtitleFor(panel) : "");
  }

  function isEditingCaption() {
    return document.activeElement === view.captionEl;
  }

  function commitCaption() {
    var panel = currentPanel(view.app.project);
    if (!panel || !view.captionEl) return;
    var val = view.captionEl.value;
    if (val !== (panel.caption || "")) {
      exec({ op: "panelCaption", id: panel.id, text: val });
    }
  }

  function refresh() {
    if (!view.host) return;
    var project = view.app.project;
    var boards = boardsOf(project);
    var flat = flattenPanels(project);
    var current = currentPanel(project);

    view.strip.innerHTML = "";
    flat.forEach(function (entry, i) {
      var panel = entry.panel;
      var isCur = panel === current;
      var cellEl = document.createElement("div");
      cellEl.className = "ptthumb" + (isCur ? " cur" : "");
      cellEl.title = "Panel " + (i + 1) + " · " + panel.duration + "f" +
        (panel.caption ? " · " + panel.caption.split("\n")[0] : "");
      var tc = document.createElement("canvas");
      tc.width = 96;
      tc.height = 54;
      cellEl.appendChild(tc);
      var cached = VB.thumbGet("panel:" + panel.id, panel.cell);
      var paint = function (cv) {
        if (cv && tc.isConnected) tc.getContext("2d").drawImage(cv, 0, 0);
      };
      if (cached) paint(cached);
      else VB.thumbRequest("panel:" + panel.id, panel.cell, 96, 54, i).then(paint);
      var num = document.createElement("span");
      num.textContent = panel.duration + "f";
      cellEl.appendChild(num);
      cellEl.addEventListener("click", function () {
        stopAnimatic();
        commitCaption();
        var hit = panelById(project, panel.id);
        exec({ op: "boardsSelect", beat: hit.beatIndex, panel: hit.index });
        if (view.drawMode) retargetDraw();
      });
      view.strip.appendChild(cellEl);
    });

    if (view.captionEl && !isEditingCaption()) {
      view.captionEl.value = current ? (current.caption || "") : "";
      view.captionEl.disabled = !current;
    }
    if (view.durInput && current &&
        document.activeElement !== view.durInput) {
      view.durInput.value = String(current.duration);
    }
    if (view.drawBtn) view.drawBtn.classList.toggle("active", view.drawMode);
    syncToolStrip();
    renderStage();
  }

  function exec(op) {
    view.app.exec(op);
    refresh();
  }

  /** The deck UI keeps a default beat under the hood; beat arrangement
   *  UX comes back later. */
  function ensureBeat() {
    var boards = boardsOf(view.app.project);
    if (!boards.beats.length) {
      view.app.exec({ op: "beatAdd", id: VB.actorNewId("beat"), name: "Board" });
    }
    return boardsOf(view.app.project).beats[
      boardsOf(view.app.project).cur.beat];
  }

  function retargetDraw() {
    var panel = currentPanel(view.app.project);
    if (panel) {
      view.app.exec({ op: "editTargetSet", target: { boardPanel: panel.id } });
    }
  }

  function setDrawMode(on) {
    if (on === view.drawMode) return;
    if (on && !currentPanel(view.app.project)) return;
    view.drawMode = on;
    view.toolStrip.style.display = on ? "inline-flex" : "none";
    if (on) {
      stopAnimatic();
      retargetDraw();
      if (!DRAW_SET[view.app.tool]) view.app.switchTool("pencil");
    } else {
      var t = view.app.project.editTarget;
      if (t && t.boardPanel) view.app.exec({ op: "editTargetClear" });
    }
    refresh();
  }

  function syncToolStrip() {
    if (!view.toolStrip) return;
    var kids = view.toolStrip.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle("active", kids[i].dataset.tool === view.app.tool);
    }
  }

  // ---- animatic ----------------------------------------------------------------

  // The reel plays panels against a millisecond clock. When the project
  // has audio clips, the AUDIO is the master clock (drift-free leica
  // reel); the performance clock covers projects without sound and the
  // silent tail after the audio ends. Looping restarts both together.
  function startAnimatic() {
    var flat = flattenPanels(view.app.project);
    if (view.animatic.playing || flat.length === 0) return;
    if (view.drawMode) setDrawMode(false);
    commitCaption();
    var an = view.animatic;
    an.playing = true;
    an.at = 0;
    an.frame = 0;
    an.ms = 0;
    an.last = performance.now();
    an.audio = false;
    view.host.classList.add("animatic");
    drawPanelToStage(flat[0].panel, subtitleFor(flat[0].panel));
    function startAudio() {
      if (!(VB.audioHasClips && VB.audioHasClips(view.app.project))) return;
      an.audio = true;
      VB.audioPlay(view.app.project, 0, function (ms) {
        if (an.playing) an.ms = ms;         // audio drives the clock
      }, function () {
        an.audio = false;                   // silent tail: raf clock resumes
      });
    }
    startAudio();
    function tick(now) {
      if (!an.playing) return;
      var dt = now - an.last;
      an.last = now;
      if (!an.audio) an.ms += dt;
      var f = flattenPanels(view.app.project);
      if (!f.length) { stopAnimatic(); return; }
      var frame = Math.floor(an.ms * (view.app.project.fps || 24) / 1000);
      var remaining = frame;
      var idx = 0;
      while (idx < f.length &&
             remaining >= Math.max(1, f[idx].panel.duration | 0)) {
        remaining -= Math.max(1, f[idx].panel.duration | 0);
        idx++;
      }
      if (idx >= f.length) { // loop the reel; the audio restarts with it
        an.ms = 0;
        frame = 0;
        idx = 0;
        if (VB.audioStop) VB.audioStop();
        startAudio();
      }
      if (idx !== an.at || !frame) {
        an.at = idx;
        drawPanelToStage(f[idx].panel, subtitleFor(f[idx].panel));
      }
      an.frame = frame;
      an.raf = requestAnimationFrame(tick);
    }
    an.raf = requestAnimationFrame(tick);
  }

  function stopAnimatic() {
    var an = view.animatic;
    if (!an.playing) return;
    an.playing = false;
    an.audio = false;
    if (VB.audioStop) VB.audioStop();
    cancelAnimationFrame(an.raf);
    view.host.classList.remove("animatic");
    // pin the landing panel so replay agrees with what was on screen
    var f = flattenPanels(view.app.project);
    if (f.length && f[an.at]) {
      var hit = panelById(view.app.project, f[an.at].panel.id);
      if (hit) {
        view.app.exec({ op: "boardsSelect",
                        beat: hit.beatIndex, panel: hit.index });
      }
    }
    refresh();
  }

  function onKeyDown(ev) {
    if (!view.host) return;
    var tag = ev.target && ev.target.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (view.animatic.playing &&
        (ev.key === "Escape" || ev.key === " " || ev.key === "Enter")) {
      ev.preventDefault();
      stopAnimatic();
      return;
    }
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
    if (view.drawMode && (ev.key === "Delete" || ev.key === "Backspace")) {
      if (view.app.deleteSelection && view.app.deleteSelection()) {
        ev.preventDefault();
        renderStage();
      }
      return;
    }
    var flat = flattenPanels(view.app.project);
    if (ev.key === "ArrowRight" && !view.drawMode && flat.length) {
      var cur = flat.indexOf(flat.filter(function (e) {
        return e.panel === currentPanel(view.app.project); })[0]);
      var next = flat[Math.min(flat.length - 1, cur + 1)];
      var hitN = panelById(view.app.project, next.panel.id);
      exec({ op: "boardsSelect", beat: hitN.beatIndex, panel: hitN.index });
      return;
    }
    if (ev.key === "ArrowLeft" && !view.drawMode && flat.length) {
      var cur2 = flat.indexOf(flat.filter(function (e) {
        return e.panel === currentPanel(view.app.project); })[0]);
      var prev = flat[Math.max(0, cur2 - 1)];
      var hitP = panelById(view.app.project, prev.panel.id);
      exec({ op: "boardsSelect", beat: hitP.beatIndex, panel: hitP.index });
      return;
    }
    if (ev.key === "Escape" && view.drawMode) {
      setDrawMode(false);
      return;
    }
    if (view.drawMode && !ev.ctrlKey && !ev.altKey) {
      var toolKeys = { v: "select", l: "lasso", q: "transform",
                       p: "pencil", n: "line", o: "oval", r: "rect",
                       b: "brush", k: "bucket", e: "eraser" };
      var k = ev.key.toLowerCase();
      if (toolKeys[k]) {
        view.app.switchTool(toolKeys[k]);
        syncToolStrip();
        renderStage();
      }
    }
  }

  function onViewResize() {
    renderStage();
  }

  function mount(host, app) {
    if (view.host === host) { view.app = app; refresh(); return; }
    unmount();
    view.host = host;
    view.app = app;
    host.innerHTML = "";

    var bar = document.createElement("div");
    bar.id = "bd-tools";
    function toolBtn(label, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }
    bar.appendChild(toolBtn("＋ Panel", "Add a panel after the current one",
      function () {
        commitCaption();
        var beat = ensureBeat();
        exec({ op: "panelAdd", beat: beat.id, id: VB.actorNewId("panel"),
               index: boardsOf(app.project).cur.panel + 1 });
        if (view.drawMode) retargetDraw();
      }));
    bar.appendChild(toolBtn("⇤", "Move panel earlier", function () {
      var panel = currentPanel(app.project);
      var hit = panel && panelById(app.project, panel.id);
      if (hit) exec({ op: "panelMove", id: panel.id, index: hit.index - 1 });
    }));
    bar.appendChild(toolBtn("⇥", "Move panel later", function () {
      var panel = currentPanel(app.project);
      var hit = panel && panelById(app.project, panel.id);
      if (hit) exec({ op: "panelMove", id: panel.id, index: hit.index + 1 });
    }));
    bar.appendChild(toolBtn("🗑", "Remove the current panel", function () {
      var panel = currentPanel(app.project);
      if (!panel) return;
      if (!confirm("Remove this panel?")) return;
      if (view.drawMode) setDrawMode(false);
      exec({ op: "panelRemove", id: panel.id });
    }));

    var durLabel = document.createElement("label");
    durLabel.className = "ctl";
    durLabel.title = "Panel duration in frames (at the project fps)";
    var durInput = document.createElement("input");
    durInput.type = "number";
    durInput.min = "1";
    durInput.max = "9999";
    durInput.style.width = "52px";
    durInput.addEventListener("change", function () {
      var panel = currentPanel(app.project);
      var frames = parseInt(durInput.value, 10);
      if (panel && isFinite(frames)) {
        exec({ op: "panelDuration", id: panel.id, frames: frames });
      }
    });
    durLabel.appendChild(durInput);
    durLabel.appendChild(document.createTextNode(" frames"));
    bar.appendChild(durLabel);
    view.durInput = durInput;

    view.drawBtn = toolBtn("✎ Draw", "Draw on the panel with the stage tools",
      function () { setDrawMode(!view.drawMode); });
    bar.appendChild(view.drawBtn);

    var strip = document.createElement("span");
    strip.id = "bd-toolstrip";
    strip.style.display = "none";
    DRAW_TOOLS.forEach(function (t) {
      var b = document.createElement("button");
      b.dataset.tool = t[0];
      b.textContent = t[1];
      b.title = t[2];
      b.addEventListener("click", function () {
        view.app.switchTool(t[0]);
        syncToolStrip();
        renderStage();
      });
      strip.appendChild(b);
    });
    view.toolStrip = strip;
    bar.appendChild(strip);

    bar.appendChild(toolBtn("▶ Animatic", "Play the whole board as an animatic",
      function () {
        if (view.animatic.playing) stopAnimatic(); else startAnimatic();
      }));

    var hint = document.createElement("span");
    hint.id = "bd-hint";
    hint.textContent = "←/→ change panels · the text below plays as the panel's subtitle";
    bar.appendChild(hint);
    host.appendChild(bar);

    var body = document.createElement("div");
    body.id = "bd-body";
    var stage = document.createElement("canvas");
    stage.id = "bd-stage";
    body.appendChild(stage);
    host.appendChild(body);

    var caption = document.createElement("textarea");
    caption.id = "bd-caption";
    caption.rows = 2;
    caption.placeholder = "panel text — action, dialogue, timing notes…";
    caption.addEventListener("blur", commitCaption);
    caption.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
    host.appendChild(caption);
    view.captionEl = caption;

    var stripEl = document.createElement("div");
    stripEl.id = "bd-strip";
    host.appendChild(stripEl);
    view.stage = stage;
    view.strip = stripEl;

    var activeTool = null;
    stage.addEventListener("pointerdown", function (ev) {
      if (view.animatic.playing) { stopAnimatic(); return; }
      if (!view.drawMode || ev.button !== 0) return;
      stage.setPointerCapture(ev.pointerId);
      activeTool = view.app.toolByName(view.app.tool);
      if (activeTool && activeTool.onDown) {
        activeTool.onDown(stageTwips(ev));
        renderStage();
      }
    });
    stage.addEventListener("pointermove", function (ev) {
      if (!activeTool) return;
      if (activeTool.onMove) {
        activeTool.onMove(stageTwips(ev));
        renderStage();
      }
    });
    stage.addEventListener("pointerup", function (ev) {
      if (!activeTool) return;
      if (activeTool.onUp) activeTool.onUp(stageTwips(ev));
      activeTool = null;
      renderStage();
    });
    stage.addEventListener("pointercancel", function () {
      if (activeTool && activeTool.cancel) activeTool.cancel();
      activeTool = null;
    });
    // right-click a marquee/lasso selection → send it to the library
    stage.addEventListener("contextmenu", function (ev) {
      if (!view.drawMode || view.animatic.playing) return;
      var clip = view.app.currentSelectionClip &&
                 view.app.currentSelectionClip();
      if (!clip) return;
      view.app.showMenu(ev.clientX, ev.clientY, [
        { label: "Convert to Symbol",
          fn: view.app.convertSelectionToSymbol }
      ]);
    });

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewResize);
    if (window.ResizeObserver) {
      view.ro = new ResizeObserver(onViewResize);
      view.ro.observe(body);
    }
    refresh();
  }

  function unmount() {
    if (!view.host) return;
    stopAnimatic();
    commitCaption();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onViewResize);
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    var t = view.app && view.app.project.editTarget;
    if (view.drawMode && t && t.boardPanel) {
      view.app.exec({ op: "editTargetClear" });
    }
    view.drawMode = false;
    view.host.classList.remove("animatic");
    view.host.innerHTML = "";
    view.host = null;
    view.stage = null;
    view.strip = null;
    view.captionEl = null;
  }

  window.VB = window.VB || {};
  VB.boardsPanelById = panelById;
  VB.boardsFlatten = flattenPanels;
  VB.boardsTotalFrames = totalFrames;
  VB.BoardsView = {
    mount: mount,
    unmount: unmount,
    refresh: refresh,
    isMounted: function () { return !!view.host; }
  };
})();
