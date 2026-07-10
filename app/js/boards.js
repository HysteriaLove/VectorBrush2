/* boards.js — the Boards workspace (Architecture §6.4): a production
 * BOARD PAGE over the story spine's flat panel list (spine.js,
 * PreProductionSpine.md). Each panel is a SELF-CONTAINED CARD in the
 * page — a header strip (Scene · Panel · Time · Frames, like a paper
 * board), its own small DRAWABLE frame (the panel's y2kvector cell,
 * drawn in place with the real stage tools through the journaled
 * editTarget, safe-area guides included), and a Dialog box holding the
 * panel's script rows (action + dialogue), op-routed through writing.*
 * (one script, two views). Scene numbers derive from setting runs.
 *
 * Cards are RECONCILED, never rebuilt (keyed by panel id) so pointer
 * capture and focus survive the docChanged refresh storm — the same
 * discipline as the pixi cell cache. The animatic swaps the page for
 * one full stage and plays panels against the audio clock.
 */
(function () {
  "use strict";

  // ---- model helpers (structure + ops live in spine.js) ---------------------------
  // boards keeps only its SELECTION: the current panel index

  function boardsOf(project) {
    project.boards = project.boards || { cur: { panel: 0 } };
    return project.boards;
  }

  function panelsOf(project) {
    return VB.spineOf(project).panels;
  }

  function panelById(project, id) {
    return VB.spinePanelById(project, id);
  }

  function totalFrames(project) {
    return panelsOf(project).reduce(function (n, p) {
      return n + Math.max(1, p.duration | 0);
    }, 0);
  }

  function clampCur(project) {
    var boards = boardsOf(project);
    boards.cur.panel = Math.max(0,
      Math.min(panelsOf(project).length - 1, boards.cur.panel | 0));
  }

  VB.defineOp("boardsSelect", function (c, op) {
    boardsOf(c.project).cur = { panel: op.panel | 0 };
    clampCur(c.project);
    c.sync();
  });

  function currentPanel(project) {
    return panelsOf(project)[boardsOf(project).cur.panel] || null;
  }

  /** The panel's first action row — what the card's Dialog box edits. */
  function actionRowOf(panel) {
    for (var i = 0; i < panel.rows.length; i++) {
      if (panel.rows[i].kind === "action") return panel.rows[i];
    }
    return null;
  }

  /** Typed character name → registry id, minting on first use (same
   *  discipline as the Story editor — the recorder journals the add). */
  function characterIdFor(name) {
    var project = view.app.project;
    var v = String(name || "").trim();
    if (!v) return "";
    var hit = VB.spineFindByName(VB.spineOf(project).characters, v);
    if (hit) return hit.id;
    var id = VB.actorNewId("char");
    view.app.exec({ op: "characterAdd", id: id, name: v });
    return id;
  }

  // ---- workspace view: the board page of panel cards ------------------------------

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
    host: null, app: null, grid: null, stage: null,
    toolStrip: null, drawBtn: null, xpanels: [], ro: null,
    drawMode: false, drawing: false,
    cards: {}, // panel id -> card (reconciled, never rebuilt)
    animatic: { playing: false, raf: 0, last: 0, ms: 0, at: 0, frame: 0,
                audio: false }
  };

  function exec(op) {
    view.app.exec(op);
    refresh();
  }

  /** Commit any in-progress card edit (blur fires the commit). */
  function flushCardEdits() {
    var el = document.activeElement;
    if (el && view.grid && view.grid.contains(el)) el.blur();
  }

  function editingInGrid() {
    var el = document.activeElement;
    return !!(el && view.grid && view.grid.contains(el) &&
              (el.isContentEditable || el.tagName === "INPUT" ||
               el.tagName === "TEXTAREA"));
  }

  // ---- the card's drawable frame ---------------------------------------------------

  function cardMetrics(panel, cvs) {
    var w = cvs.clientWidth, h = cvs.clientHeight;
    var cw = panel.cell.width / VB.TWIPS, ch = panel.cell.height / VB.TWIPS;
    var zoom = Math.min(w / cw, h / ch);
    return { zoom: zoom, w: w, h: h,
             panX: (w - cw * zoom) / 2, panY: (h - ch * zoom) / 2 };
  }

  function cardTwips(panel, cvs, ev) {
    var rect = cvs.getBoundingClientRect();
    var m = cardMetrics(panel, cvs);
    return {
      x: (ev.clientX - rect.left - m.panX) / m.zoom * VB.TWIPS,
      y: (ev.clientY - rect.top - m.panY) / m.zoom * VB.TWIPS
    };
  }

  function drawCardFrame(panel, cvs, isCur) {
    var dpr = window.devicePixelRatio || 1;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== Math.round(w * dpr)) {
      cvs.width = Math.round(w * dpr);
      cvs.height = Math.round(h * dpr);
    }
    var ctx = cvs.getContext("2d");
    var m = cardMetrics(panel, cvs);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    VB.render(ctx, panel.cell, {
      zoom: m.zoom, panX: m.panX, panY: m.panY, dpr: dpr
    });
    // safe-area guides (paper-board style): a light inner frame plus
    // dashed side margins — presentation only, never exported
    var x0 = m.panX, y0 = m.panY;
    var fw = w - 2 * m.panX, fh = h - 2 * m.panY;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = "rgba(120,126,134,0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + fw * 0.05, y0 + fh * 0.05, fw * 0.9, fh * 0.9);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x0 + fw * 0.125, y0 + 2);
    ctx.lineTo(x0 + fw * 0.125, y0 + fh - 2);
    ctx.moveTo(x0 + fw * 0.875, y0 + 2);
    ctx.lineTo(x0 + fw * 0.875, y0 + fh - 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // the live tool overlay rides the CURRENT card while drawing
    if (isCur && view.drawMode && !view.animatic.playing) {
      var tool = view.app.toolByName(view.app.tool);
      if (tool && tool.drawOverlay) {
        var s = m.zoom / VB.TWIPS;
        ctx.setTransform(dpr * s, 0, 0, dpr * s,
                         dpr * m.panX, dpr * m.panY);
        try { tool.drawOverlay(ctx); } catch (e) { /* overlay only */ }
      }
    }
  }

  // ---- card construction + reconcile ------------------------------------------------

  function headField(label) {
    var box = document.createElement("div");
    box.className = "bdheadfield";
    var lab = document.createElement("span");
    lab.className = "bdheadlab";
    lab.textContent = label;
    box.appendChild(lab);
    var val = document.createElement("span");
    val.className = "bdheadval";
    box.appendChild(val);
    return { box: box, val: val };
  }

  function createCard(panel) {
    var app = view.app;
    var pid = panel.id;
    // cards outlive refreshes (reconciled, never rebuilt) but panel
    // OBJECTS are replaced by history restore (undo/redo) — handlers
    // must resolve the live object at event time, or a mid-stroke
    // render paints the stale pre-undo cell (ghost content that
    // vanishes on pointerup — user bug)
    function livePanel() {
      var hit = panelById(view.app.project, pid);
      return hit ? hit.panel : null;
    }
    var root = document.createElement("div");
    root.className = "bdcard";
    root.dataset.panel = pid;

    // header strip: Scene · Panel · Time · Frames (the paper form)
    var head = document.createElement("div");
    head.className = "bdhead";
    var fScene = headField("Scene");
    var fPanel = headField("Panel");
    var fTime = headField("Time");
    var fFrames = headField("Frames");
    fFrames.val.remove();
    var frames = document.createElement("input");
    frames.type = "number";
    frames.min = "1";
    frames.max = "9999";
    frames.className = "bdframesin";
    frames.title = "Hold this panel for N frames (at the project fps)";
    frames.addEventListener("change", function () {
      var v = parseInt(frames.value, 10);
      if (isFinite(v)) exec({ op: "panelDuration", id: pid, frames: v });
    });
    frames.addEventListener("keydown", function (ev) {
      ev.stopPropagation();
    });
    fFrames.box.appendChild(frames);
    head.appendChild(fScene.box);
    head.appendChild(fPanel.box);
    head.appendChild(fTime.box);
    head.appendChild(fFrames.box);
    root.appendChild(head);

    // the self-contained drawable frame
    var cvs = document.createElement("canvas");
    cvs.className = "bdframe";
    root.appendChild(cvs);

    var activeTool = null;
    cvs.addEventListener("pointerdown", function (ev) {
      if (view.animatic.playing) { stopAnimatic(); return; }
      flushCardEdits();
      var hit = panelById(app.project, pid);
      if (!hit) return;
      if (boardsOf(app.project).cur.panel !== hit.index) {
        exec({ op: "boardsSelect", panel: hit.index });
      }
      if (!view.drawMode || ev.button !== 0) return;
      retargetDraw();
      cvs.setPointerCapture(ev.pointerId);
      view.drawing = true;
      activeTool = app.toolByName(app.tool);
      if (activeTool && activeTool.onDown) {
        activeTool.onDown(cardTwips(hit.panel, cvs, ev));
        drawCardFrame(hit.panel, cvs, true);
      }
    });
    cvs.addEventListener("pointermove", function (ev) {
      if (!activeTool) return;
      var live = livePanel();
      if (!live) return;
      if (activeTool.onMove) activeTool.onMove(cardTwips(live, cvs, ev));
      drawCardFrame(live, cvs, true);
    });
    function endStroke(ev, cancel) {
      if (!activeTool) return;
      var t = activeTool;
      activeTool = null;
      view.drawing = false;
      var live = livePanel();
      if (cancel || !live) { if (t.cancel) t.cancel(); }
      else if (t.onUp) t.onUp(cardTwips(live, cvs, ev));
      refresh();
    }
    cvs.addEventListener("pointerup", function (ev) { endStroke(ev, false); });
    cvs.addEventListener("pointercancel", function (ev) { endStroke(ev, true); });
    cvs.style.touchAction = "none";

    // the Dialog box: the panel's script rows, edited in place
    var dialog = document.createElement("div");
    dialog.className = "bddialog";
    var dlab = document.createElement("span");
    dlab.className = "bddialoglab";
    dlab.textContent = "Dialog";
    dialog.appendChild(dlab);
    var action = document.createElement("div");
    action.className = "bdaction";
    action.contentEditable = "true";
    action.dataset.ph = "action…";
    action.addEventListener("blur", function () {
      var val = action.innerText.replace(/\n+$/, "");
      var hit = panelById(app.project, pid);
      if (!hit) return;
      var row = actionRowOf(hit.panel);
      if (row) {
        if (val !== (row.content || "")) {
          exec({ op: "blockEdit", block: row.id, content: val });
        }
      } else if (val.trim() !== "") {
        exec({ op: "blockAdd", id: VB.actorNewId("blk"), panel: pid,
               index: 0, kind: "action", content: val });
      }
    });
    action.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") action.blur();
      ev.stopPropagation();
    });
    dialog.appendChild(action);
    var lines = document.createElement("div");
    lines.className = "bdlines";
    dialog.appendChild(lines);
    var add = document.createElement("button");
    add.className = "bdaddline";
    add.textContent = "＋ dialogue";
    add.title = "Add a dialogue line to this panel's script";
    add.addEventListener("click", function () {
      exec({ op: "blockAdd", id: VB.actorNewId("line"),
             panel: pid, kind: "line", character: "", text: "" });
      var whos = lines.querySelectorAll(".bdwho");
      if (whos.length) whos[whos.length - 1].focus();
    });
    dialog.appendChild(add);
    root.appendChild(dialog);

    var card = { root: root, cvs: cvs, frames: frames, action: action,
                 lines: lines, scene: fScene.val, num: fPanel.val,
                 time: fTime.val };
    view.cards[pid] = card;
    return card;
  }

  function renderCardLines(card, panel) {
    var project = view.app.project;
    if (card.lines.contains(document.activeElement)) return;
    card.lines.innerHTML = "";
    panel.rows.forEach(function (b) {
      if (b.kind !== "line") return;
      var row = document.createElement("div");
      row.className = "bdline";
      var entry = VB.spineCharacterById(project, b.character);
      var who = document.createElement("input");
      who.value = entry ? entry.name : "";
      who.placeholder = "WHO";
      who.className = "bdwho";
      who.addEventListener("blur", function () {
        var v = who.value.trim();
        var cur = VB.spineCharacterById(project, b.character);
        if (v !== ((cur && cur.name) || "")) {
          exec({ op: "blockEdit", block: b.id,
                 character: characterIdFor(v) });
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
      card.lines.appendChild(row);
    });
  }

  function updateCard(card, panel, index, sceneNo, isCur) {
    var fps = view.app.project.fps || 24;
    card.root.classList.toggle("cur", isCur);
    card.scene.textContent = String(sceneNo);
    card.num.textContent = String(index + 1);
    card.time.textContent =
      (Math.max(1, panel.duration | 0) / fps).toFixed(1) + "s";
    if (document.activeElement !== card.frames) {
      card.frames.value = String(panel.duration);
    }
    if (document.activeElement !== card.action) {
      var row = actionRowOf(panel);
      card.action.innerText = row ? (row.content || "") : "";
    }
    renderCardLines(card, panel);
    drawCardFrame(panel, card.cvs, isCur);
  }

  function refresh() {
    if (!view.host || !view.grid) return;
    if (view.drawing) return; // never rebuild under a live stroke
    var project = view.app.project;
    var panels = panelsOf(project);
    var cur = boardsOf(project).cur.panel;
    // scene numbers derive from setting runs
    var runOf = [];
    VB.spineSceneRuns(project).forEach(function (run, ri) {
      for (var i = run.from; i <= run.to; i++) runOf[i] = ri + 1;
    });
    // reconcile: create/update in order, only re-append when order drifts
    var want = [];
    panels.forEach(function (panel, i) {
      var card = view.cards[panel.id] || createCard(panel);
      updateCard(card, panel, i, runOf[i] || 1, i === cur);
      want.push(card.root);
    });
    Object.keys(view.cards).forEach(function (id) {
      if (!panelById(project, id)) {
        view.cards[id].root.remove();
        delete view.cards[id];
      }
    });
    var have = Array.prototype.filter.call(view.grid.children,
      function (k) { return k.classList.contains("bdcard"); });
    var same = have.length === want.length && want.every(function (el, i) {
      return have[i] === el;
    });
    if (!same && !editingInGrid()) {
      want.forEach(function (el) { view.grid.appendChild(el); });
    }
    view.grid.classList.toggle("empty", panels.length === 0);
    if (view.drawBtn) view.drawBtn.classList.toggle("active", view.drawMode);
    syncToolStrip();
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

  // ---- animatic (one full stage; the reel swaps the page in/out) -------------------

  function subtitleFor(panel) {
    if (!panel) return "";
    return VB.spinePanelText(view.app.project, panel);
  }

  function drawPanelToStage(panel, subtitle) {
    var cvs = view.stage;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    var ctx = cvs.getContext("2d");
    if (!panel) return;
    var cw = panel.cell.width / VB.TWIPS, ch = panel.cell.height / VB.TWIPS;
    var zoom = Math.min(w / cw, h / ch) * 0.94;
    var m = { zoom: zoom, panX: (w - cw * zoom) / 2,
              panY: (h - ch * zoom) / 2 };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    VB.render(ctx, panel.cell, {
      zoom: m.zoom, panX: m.panX, panY: m.panY, dpr: 1
    });
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

  // The reel plays panels against a millisecond clock. When the project
  // has audio clips, the AUDIO is the master clock (drift-free leica
  // reel); the performance clock covers projects without sound and the
  // silent tail after the audio ends. Looping restarts both together.
  function startAnimatic() {
    var flat = panelsOf(view.app.project);
    if (view.animatic.playing || flat.length === 0) return;
    if (view.drawMode) setDrawMode(false);
    flushCardEdits();
    var an = view.animatic;
    an.playing = true;
    an.at = 0;
    an.frame = 0;
    an.ms = 0;
    an.last = performance.now();
    an.audio = false;
    view.host.classList.add("animatic");
    drawPanelToStage(flat[0], subtitleFor(flat[0]));
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
      var f = panelsOf(view.app.project);
      if (!f.length) { stopAnimatic(); return; }
      var frame = Math.floor(an.ms * (view.app.project.fps || 24) / 1000);
      var remaining = frame;
      var idx = 0;
      while (idx < f.length &&
             remaining >= Math.max(1, f[idx].duration | 0)) {
        remaining -= Math.max(1, f[idx].duration | 0);
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
        drawPanelToStage(f[idx], subtitleFor(f[idx]));
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
    var f = panelsOf(view.app.project);
    if (f.length && f[an.at]) {
      view.app.exec({ op: "boardsSelect",
                      panel: Math.min(an.at, f.length - 1) });
    }
    refresh();
  }

  // ---- keys, mount, unmount ---------------------------------------------------------

  function onKeyDown(ev) {
    if (!view.host) return;
    var tag = ev.target && ev.target.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (ev.target && ev.target.isContentEditable) return;
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
        refresh();
      }
      return;
    }
    var flat = panelsOf(view.app.project);
    if (ev.key === "ArrowRight" && !view.drawMode && flat.length) {
      exec({ op: "boardsSelect", panel: Math.min(flat.length - 1,
        boardsOf(view.app.project).cur.panel + 1) });
      return;
    }
    if (ev.key === "ArrowLeft" && !view.drawMode && flat.length) {
      exec({ op: "boardsSelect", panel: Math.max(0,
        boardsOf(view.app.project).cur.panel - 1) });
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
        refresh();
      }
    }
  }

  function mount(host, app) {
    if (view.host === host) { view.app = app; refresh(); return; }
    unmount();
    view.host = host;
    view.app = app;
    host.innerHTML = "";
    view.cards = {};

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
    panelsPanel.appendChild(toolBtn("＋ Panel",
      "New story moment — one panel, one script row",
      function () {
        flushCardEdits();
        var project = app.project;
        var cur = currentPanel(project);
        var at = cur ? panelById(project, cur.id).index + 1
                     : panelsOf(project).length;
        var pid = VB.actorNewId("panel");
        exec({ op: "panelAdd", id: pid, index: at,
               setting: (cur && cur.setting) || null });
        exec({ op: "boardsSelect", panel: at });
        if (view.drawMode) retargetDraw();
      }));
    panelsPanel.appendChild(toolBtn("⇤", "Move panel earlier", function () {
      var panel = currentPanel(app.project);
      var hit = panel && panelById(app.project, panel.id);
      if (hit && hit.index > 0) {
        exec({ op: "panelMove", id: panel.id, index: hit.index - 1 });
        exec({ op: "boardsSelect", panel: hit.index - 1 });
      }
    }));
    panelsPanel.appendChild(toolBtn("⇥", "Move panel later", function () {
      var panel = currentPanel(app.project);
      var hit = panel && panelById(app.project, panel.id);
      if (hit) {
        exec({ op: "panelMove", id: panel.id, index: hit.index + 1 });
        exec({ op: "boardsSelect",
               panel: Math.min(panelsOf(app.project).length - 1,
                               hit.index + 1) });
      }
    }));
    panelsPanel.appendChild(toolBtn("🗑", "Remove the current panel", function () {
      var panel = currentPanel(app.project);
      if (!panel) return;
      if (!confirm("Remove this panel?")) return;
      if (view.drawMode) setDrawMode(false);
      exec({ op: "panelRemove", id: panel.id });
    }));

    view.drawBtn = toolBtn("✎ Draw", "Draw on panels with the stage tools",
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
        refresh();
      });
      strip.appendChild(b);
    });
    view.toolStrip = strip;
    drawPanel.appendChild(strip);

    xpanel("animatic").appendChild(toolBtn("▶ Animatic",
      "Play the whole board as an animatic",
      function () {
        if (view.animatic.playing) stopAnimatic(); else startAnimatic();
      }));

    // the board page (cards) + the animatic stage (swapped by class)
    var grid = document.createElement("div");
    grid.id = "bd-grid";
    grid.dataset.ph = "no panels yet — ＋ Panel starts the story";
    host.appendChild(grid);
    view.grid = grid;
    var stage = document.createElement("canvas");
    stage.id = "bd-stage";
    host.appendChild(stage);
    view.stage = stage;
    stage.addEventListener("pointerdown", function () {
      if (view.animatic.playing) stopAnimatic();
    });

    window.addEventListener("keydown", onKeyDown);
    if (window.ResizeObserver) {
      view.ro = new ResizeObserver(function () {
        if (!view.animatic.playing) refresh();
      });
      view.ro.observe(host);
    }
    refresh();
  }

  function unmount() {
    if (!view.host) return;
    flushCardEdits();
    stopAnimatic();
    if (view.drawMode) setDrawMode(false);
    window.removeEventListener("keydown", onKeyDown);
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    (view.xpanels || []).forEach(function (p) { p.remove(); });
    view.xpanels = [];
    view.host.innerHTML = "";
    view.host = null;
    view.grid = null;
    view.stage = null;
    view.cards = {};
  }

  window.VB = window.VB || {};
  VB.boardsPanelById = panelById;
  VB.boardsFlatten = panelsOf;
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
