/* boards.js — the Boards workspace (Architecture §6.4): storyboard
 * PANELS over the story SPINE (spine.js, PreProductionSpine.md).
 * Beats live on the spine — Boards owns each beat's PANEL group (a
 * panel = a y2kvector cell drawn with the real stage tools through the
 * journaled editTarget + a duration in frames). The deck's text field
 * is NOT a boards field: it reads and writes the beat's action block
 * through the owning writing.* ops (one script, rendered twice), and
 * the animatic subtitles show the beat's full story text — action
 * lines plus dialogue. The animatic plays panels in order, each held
 * for its duration at project.fps. Thin UI, real model.
 */
(function () {
  "use strict";

  var PANEL_W = 960 * 20, PANEL_H = 540 * 20;
  var DEFAULT_DURATION = 24; // frames

  // ---- model + ops -----------------------------------------------------------
  // structure = spine beats (flattened across slugs for the deck);
  // boards keeps only its SELECTION over that flat list

  function boardsOf(project) {
    project.boards = project.boards || { cur: { beat: 0, panel: 0 } };
    return project.boards;
  }

  /** The deck's beat list: every spine beat in story order. */
  function beatsOf(project) {
    return VB.spineFlatBeats(project).map(function (e) { return e.beat; });
  }

  function panelById(project, id) {
    var beats = beatsOf(project);
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
    beatsOf(project).forEach(function (beat) {
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
    var beats = beatsOf(project);
    boards.cur.beat = Math.max(0, Math.min(beats.length - 1, boards.cur.beat));
    var beat = beats[boards.cur.beat];
    boards.cur.panel = beat
      ? Math.max(0, Math.min(beat.panels.length - 1, boards.cur.panel)) : 0;
  }

  VB.defineOp("panelAdd", function (c, op) {
    var hit = VB.spineBeatById(c.project, op.beat);
    if (!hit) return;
    c.history.push(c.project);
    var at = op.index === undefined ? hit.beat.panels.length
      : Math.max(0, Math.min(hit.beat.panels.length, op.index));
    hit.beat.panels.splice(at, 0, {
      id: op.id, cell: newPanelCell(),
      duration: op.duration || DEFAULT_DURATION
    });
    var flat = beatsOf(c.project);
    boardsOf(c.project).cur = { beat: flat.indexOf(hit.beat), panel: at };
    c.sync();
  });

  VB.defineOp("panelMove", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    var dest = op.beat ? VB.spineBeatById(c.project, op.beat) : null;
    var target = dest ? dest.beat : hit.beat;
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

  VB.defineOp("boardsSelect", function (c, op) {
    var boards = boardsOf(c.project);
    boards.cur = { beat: op.beat | 0, panel: op.panel | 0 };
    clampCur(c.project);
    c.sync();
  });

  function currentPanel(project) {
    var boards = boardsOf(project);
    var beat = beatsOf(project)[boards.cur.beat];
    return beat ? (beat.panels[boards.cur.panel] || null) : null;
  }

  /** The deck's current BEAT (selection is beat-indexed, so a written
   *  but unboarded beat — an empty slot — is selectable too). */
  function beatOfCurrent(project) {
    var beat = beatsOf(project)[boardsOf(project).cur.beat];
    return beat ? VB.spineBeatById(project, beat.id) : null;
  }

  /** The beat's first action block — what the deck's text field edits. */
  function actionBlockOf(beat) {
    for (var i = 0; i < beat.blocks.length; i++) {
      if (beat.blocks[i].kind === "action") return beat.blocks[i];
    }
    return null;
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
      ctx.fillText(beatOfCurrent(view.app.project)
        ? "no frame here yet — ＋ Panel boards this beat"
        : "no beats yet — ＋ Beat starts the story", w / 2, h / 2);
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
    var hit = VB.spineBeatOfPanel(view.app.project, panel.id);
    return hit ? VB.spineBeatText(hit.beat) : "";
  }

  function renderStage() {
    if (!view.stage) return;
    var panel = currentPanel(view.app.project);
    drawPanelToStage(panel, view.animatic.playing ? subtitleFor(panel) : "");
  }

  function isEditingCaption() {
    return document.activeElement === view.captionEl;
  }

  // The deck's text field IS the beat's action block — editing it here
  // writes the script through the owning writing.* ops (op routing)
  function commitCaption() {
    if (!view.captionEl) return;
    var hit = beatOfCurrent(view.app.project);
    if (!hit) return;
    var val = view.captionEl.value;
    var block = actionBlockOf(hit.beat);
    if (block) {
      if (val !== (block.content || "")) {
        exec({ op: "blockEdit", block: block.id, content: val });
      }
    } else if (val.trim() !== "") {
      exec({ op: "blockAdd", id: VB.actorNewId("blk"), beat: hit.beat.id,
             index: 0, kind: "action", content: val });
    }
  }

  function refresh() {
    if (!view.host) return;
    var project = view.app.project;
    var current = currentPanel(project);

    view.strip.innerHTML = "";
    var beats = beatsOf(project);
    var curBeatIdx = boardsOf(project).cur.beat;
    var count = 0;
    beats.forEach(function (beat, bi) {
      if (!beat.panels.length) {
        // a written-but-unboarded beat: an EMPTY SLOT (the membrane's
        // placeholder — the writer made it, the artist fills it)
        var slot = document.createElement("div");
        slot.className = "ptthumb bdslot" +
          (bi === curBeatIdx ? " cur" : "");
        var slotLine = VB.spineBeatText(beat).split("\n")[0];
        slot.title = slotLine ? slotLine + " — no frame yet"
                              : "empty beat — no frame yet";
        slot.textContent = "▢";
        slot.addEventListener("click", function () {
          stopAnimatic();
          commitCaption();
          exec({ op: "boardsSelect", beat: bi, panel: 0 });
        });
        view.strip.appendChild(slot);
        return;
      }
      beat.panels.forEach(function (panel, pi) {
        var i = count++;
        var isCur = panel === current;
        var cellEl = document.createElement("div");
        cellEl.className = "ptthumb" + (isCur ? " cur" : "");
        var beatLine = VB.spineBeatText(beat).split("\n")[0];
        cellEl.title = "Panel " + (i + 1) + " · " + panel.duration + "f" +
          (beatLine ? " · " + beatLine : "");
        var tc = document.createElement("canvas");
        tc.width = 96;
        tc.height = 54;
        cellEl.appendChild(tc);
        var cached = VB.thumbGet("panel:" + panel.id, panel.cell);
        var paint = function (cv) {
          if (cv && tc.isConnected) tc.getContext("2d").drawImage(cv, 0, 0);
        };
        if (cached) paint(cached);
        else VB.thumbRequest("panel:" + panel.id, panel.cell,
                             96, 54, i).then(paint);
        var num = document.createElement("span");
        num.textContent = panel.duration + "f";
        cellEl.appendChild(num);
        cellEl.addEventListener("click", function () {
          stopAnimatic();
          commitCaption();
          exec({ op: "boardsSelect", beat: bi, panel: pi });
          if (view.drawMode) retargetDraw();
        });
        view.strip.appendChild(cellEl);
      });
    });

    if (view.captionEl && !isEditingCaption()) {
      var curBeat = beatOfCurrent(project);
      var action = curBeat && actionBlockOf(curBeat.beat);
      view.captionEl.value = action ? (action.content || "") : "";
      view.captionEl.disabled = !curBeat; // text belongs to the BEAT
    }
    renderLines();
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

  // the current beat's dialogue as editable rows — every commit is the
  // owning writing.* op, so the script editor sees it instantly
  function renderLines() {
    if (!view.linesEl) return;
    if (view.linesEl.contains(document.activeElement)) return;
    view.linesEl.innerHTML = "";
    var hit = beatOfCurrent(view.app.project);
    if (!hit) return;
    hit.beat.blocks.forEach(function (b) {
      if (b.kind !== "line") return;
      var row = document.createElement("div");
      row.className = "bdline";
      var who = document.createElement("input");
      who.value = b.character || "";
      who.placeholder = "WHO";
      who.className = "bdwho";
      who.addEventListener("blur", function () {
        var v = who.value.trim();
        if (v !== (b.character || "")) {
          exec({ op: "blockEdit", block: b.id, character: v });
        }
      });
      var say = document.createElement("input");
      say.value = VB.lineTextOf(b);
      say.placeholder = "dialogue…";
      say.className = "bdsay";
      say.addEventListener("blur", function () {
        if (say.value !== VB.lineTextOf(b)) {
          exec({ op: "blockEdit", block: b.id, text: say.value });
        }
      });
      [who, say].forEach(function (inp) {
        inp.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter" || ev.key === "Escape") inp.blur();
          ev.stopPropagation();
        });
      });
      var del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Remove this line from the script";
      del.addEventListener("click", function () {
        exec({ op: "blockRemove", block: b.id });
      });
      row.appendChild(who);
      row.appendChild(say);
      row.appendChild(del);
      view.linesEl.appendChild(row);
    });
    var add = document.createElement("button");
    add.className = "bdaddline";
    add.textContent = "＋ dialogue";
    add.title = "Add a dialogue line to this beat's script";
    add.addEventListener("click", function () {
      exec({ op: "blockAdd", id: VB.actorNewId("line"),
             beat: hit.beat.id, kind: "line", character: "", text: "" });
      var rows = view.linesEl.querySelectorAll(".bdwho");
      if (rows.length) rows[rows.length - 1].focus();
    });
    view.linesEl.appendChild(add);
  }

  /** The deck feeds the current spine beat, minting a slug + beat when
   *  the spine is empty (a boards-first author's first frame — the
   *  membrane's "artist adds a panel in a gap" rule, degenerate case).
   *  Full beat arrangement UX lands with the interchange slice. */
  function ensureBeat() {
    var project = view.app.project;
    if (!VB.spineOf(project).scenes.length) {
      view.app.exec({ op: "spineSceneAdd", id: VB.actorNewId("slug") });
    }
    if (!beatsOf(project).length) {
      view.app.exec({ op: "spineBeatAdd", id: VB.actorNewId("beat"),
                      scene: VB.spineOf(project).scenes[0].id });
    }
    var beats = beatsOf(project);
    return beats[Math.max(0, Math.min(beats.length - 1,
                                      boardsOf(project).cur.beat))];
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

    // toolpanels join the floating ISLANDS (the core xRack UI
    // language) and leave with the workspace
    var bar = document.getElementById("topbar");
    view.xpanels = [];
    function xpanel(name) {
      var p;
      if (app.xpanel) {
        p = app.xpanel(bar, "bd-" + name);
      } else {
        p = document.createElement("div");
        p.className = "y2kxpanel";
        (bar || host).appendChild(p);
      }
      view.xpanels.push(p);
      return p;
    }
    var panelsPanel = xpanel("panels");
    function toolBtn(label, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }
    panelsPanel.appendChild(toolBtn("＋ Beat",
      "New story moment — a new frame AND a new script beat",
      function () {
        commitCaption();
        var base = ensureBeat();
        var project = app.project;
        if (!base.panels.length) {
          // an empty beat is an empty SLOT (a written-but-unboarded
          // moment): the first frame fills it, no new beat
          exec({ op: "panelAdd", beat: base.id,
                 id: VB.actorNewId("panel") });
        } else {
          var hit = VB.spineBeatById(project, base.id);
          var bid = VB.actorNewId("beat");
          app.exec({ op: "spineBeatAdd", id: bid, scene: hit.scene.id,
                     index: hit.index + 1 });
          exec({ op: "panelAdd", beat: bid, id: VB.actorNewId("panel") });
        }
        if (view.drawMode) retargetDraw();
      }));
    panelsPanel.appendChild(toolBtn("＋ Panel",
      "More coverage of the CURRENT beat (no script change)",
      function () {
        commitCaption();
        var beat = ensureBeat();
        exec({ op: "panelAdd", beat: beat.id, id: VB.actorNewId("panel"),
               index: boardsOf(app.project).cur.panel + 1 });
        if (view.drawMode) retargetDraw();
      }));
    panelsPanel.appendChild(toolBtn("⇤", "Move panel earlier", function () {
      var panel = currentPanel(app.project);
      var hit = panel && panelById(app.project, panel.id);
      if (hit) exec({ op: "panelMove", id: panel.id, index: hit.index - 1 });
    }));
    panelsPanel.appendChild(toolBtn("⇥", "Move panel later", function () {
      var panel = currentPanel(app.project);
      var hit = panel && panelById(app.project, panel.id);
      if (hit) exec({ op: "panelMove", id: panel.id, index: hit.index + 1 });
    }));
    panelsPanel.appendChild(toolBtn("🗑", "Remove the current panel", function () {
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
    panelsPanel.appendChild(durLabel);
    view.durInput = durInput;

    view.drawBtn = toolBtn("✎ Draw", "Draw on the panel with the stage tools",
      function () { setDrawMode(!view.drawMode); });
    var drawPanel = xpanel("draw");
    drawPanel.appendChild(view.drawBtn);

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
    drawPanel.appendChild(strip);

    xpanel("animatic").appendChild(toolBtn("▶ Animatic", "Play the whole board as an animatic",
      function () {
        if (view.animatic.playing) stopAnimatic(); else startAnimatic();
      }));


    var body = document.createElement("div");
    body.id = "bd-body";
    var stage = document.createElement("canvas");
    stage.id = "bd-stage";
    body.appendChild(stage);
    host.appendChild(body);

    var caption = document.createElement("textarea");
    caption.id = "bd-caption";
    caption.rows = 2;
    caption.placeholder = "the beat's action text — this IS the script…";
    caption.addEventListener("blur", commitCaption);
    caption.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
    host.appendChild(caption);
    view.captionEl = caption;

    // the beat's dialogue — real script Lines, edited from the deck
    // through the owning writing.* ops (op routing)
    var linesEl = document.createElement("div");
    linesEl.id = "bd-lines";
    host.appendChild(linesEl);
    view.linesEl = linesEl;

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
    (view.xpanels || []).forEach(function (p) { p.remove(); });
    view.xpanels = [];
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
    view.linesEl = null;
  }

  window.VB = window.VB || {};
  VB.boardsPanelById = panelById;
  VB.boardsFlatten = flattenPanels;
  VB.boardsTotalFrames = totalFrames;
  // the global Space bar defers to a playing animatic: it stops the
  // reel (sound included) instead of toggling raw audio underneath it
  VB.audioSpaceIntercept = VB.audioSpaceIntercept || [];
  VB.audioSpaceIntercept.push(function () {
    if (view.animatic.playing) { stopAnimatic(); return true; }
    return false;
  });

  VB.BoardsView = {
    mount: mount,
    unmount: unmount,
    refresh: refresh,
    isMounted: function () { return !!view.host; }
  };
})();
