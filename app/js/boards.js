/* boards.js — the Boards workspace (Architecture §6.4, thin slice):
 * storyboard PANELS grouped into BEATS, playable as an animatic.
 *
 * A panel is a y2kvector cell (drawn with the real stage tools through
 * the journaled editTarget), a duration in frames, and attached Story
 * LINE ids. Line flow is two-way (Architecture §6.4): panels attach
 * existing lines by id, and editing a line from a panel is the same
 * blockEdit op the Story workspace uses — one source of truth.
 *
 * The animatic plays panels in beat order, each held for its duration
 * at project.fps, with attached lines as subtitles — the project's
 * first end-to-end preview and the timing seed for Roughs later.
 * Thin UI, real model.
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

  VB.defineOp("panelLineAttach", function (c, op) {
    var hit = panelById(c.project, op.panel);
    if (!hit || hit.panel.lines.indexOf(op.line) >= 0) return;
    c.history.push(c.project);
    hit.panel.lines = hit.panel.lines.concat([op.line]); // copy-on-write
    c.sync();
  });

  VB.defineOp("panelLineDetach", function (c, op) {
    var hit = panelById(c.project, op.panel);
    if (!hit || hit.panel.lines.indexOf(op.line) < 0) return;
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

  // ---- workspace view -----------------------------------------------------------

  var DRAW_TOOLS = [
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
    host: null, app: null, stage: null, beatsEl: null, linesEl: null,
    toolStrip: null, drawBtn: null, durInput: null, lineSelect: null,
    drawMode: false,
    animatic: { playing: false, raf: 0, last: 0, acc: 0, at: 0, frame: 0 }
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
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#26282c";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#888";
      ctx.font = "13px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("No panels yet — add a beat, then a panel.", w / 2, h / 2);
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
    if (!panel || !panel.lines.length) return "";
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
    drawPanelToStage(panel, subtitleFor(panel));
  }

  function refresh() {
    if (!view.host) return;
    var project = view.app.project;
    var boards = boardsOf(project);

    view.beatsEl.innerHTML = "";
    boards.beats.forEach(function (beat, bi) {
      var row = document.createElement("div");
      row.className = "bdbeat";
      var head = document.createElement("div");
      head.className = "bdbeathead";
      var nm = document.createElement("span");
      nm.className = "aname";
      nm.textContent = beat.name;
      nm.title = "Double-click to rename";
      nm.addEventListener("dblclick", function () {
        var n = prompt("Beat name", beat.name);
        if (n && n !== beat.name) {
          exec({ op: "beatRename", beat: beat.id, name: n });
        }
      });
      head.appendChild(nm);
      function headBtn(label, title, fn) {
        var b = document.createElement("button");
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", fn);
        return b;
      }
      head.appendChild(headBtn("＋", "Add a panel to this beat", function () {
        exec({ op: "panelAdd", beat: beat.id, id: VB.actorNewId("panel") });
        if (view.drawMode) retargetDraw();
      }));
      head.appendChild(headBtn("◀", "Move beat earlier", function () {
        exec({ op: "beatMove", beat: beat.id, index: bi - 1 });
      }));
      head.appendChild(headBtn("▶", "Move beat later", function () {
        exec({ op: "beatMove", beat: beat.id, index: bi + 1 });
      }));
      head.appendChild(headBtn("✕", "Delete beat (and its panels)", function () {
        if (!confirm('Delete "' + beat.name + '" and its panels?')) return;
        if (view.drawMode) setDrawMode(false);
        exec({ op: "beatRemove", beat: beat.id });
      }));
      row.appendChild(head);
      var strip = document.createElement("div");
      strip.className = "bdpanels";
      beat.panels.forEach(function (panel, pi) {
        var cellEl = document.createElement("div");
        cellEl.className = "ptthumb" +
          (bi === boards.cur.beat && pi === boards.cur.panel ? " cur" : "");
        cellEl.title = beat.name + " · panel " + (pi + 1) + " · " +
          panel.duration + "f" + (panel.lines.length ?
          " · " + panel.lines.length + " line(s)" : "");
        var tc = document.createElement("canvas");
        tc.width = 96;
        tc.height = 54;
        cellEl.appendChild(tc);
        var cached = VB.thumbGet("panel:" + panel.id, panel.cell);
        if (cached) {
          tc.getContext("2d").drawImage(cached, 0, 0);
        } else {
          VB.thumbRequest("panel:" + panel.id, panel.cell, 96, 54, pi)
            .then(function (cv) {
              if (cv && tc.isConnected) tc.getContext("2d").drawImage(cv, 0, 0);
            });
        }
        var num = document.createElement("span");
        num.textContent = panel.duration + "f";
        cellEl.appendChild(num);
        cellEl.addEventListener("click", function () {
          stopAnimatic();
          exec({ op: "boardsSelect", beat: bi, panel: pi });
          if (view.drawMode) retargetDraw();
        });
        strip.appendChild(cellEl);
      });
      row.appendChild(strip);
      view.beatsEl.appendChild(row);
    });

    // attached lines of the current panel + the attach picker
    var panel = currentPanel(project);
    view.linesEl.innerHTML = "";
    if (panel) {
      panel.lines.forEach(function (lineId) {
        var hit = VB.lineById(project, lineId);
        var chip = document.createElement("div");
        chip.className = "bdline" + (hit ? "" : " missing");
        var txt = document.createElement("span");
        txt.className = "aname";
        txt.textContent = hit
          ? (hit.block.character ? hit.block.character + ": " : "") +
            VB.lineTextOf(hit.block)
          : "(missing line " + lineId + ")";
        txt.title = "Double-click to edit the line (edits the Story doc)";
        txt.addEventListener("dblclick", function () {
          if (!hit) return;
          var next = prompt("Line text (edits the Story document)",
                            VB.lineTextOf(hit.block));
          if (next !== null && next !== VB.lineTextOf(hit.block)) {
            exec({ op: "blockEdit", doc: hit.doc.id, block: hit.block.id,
                   lang: "default", text: next });
          }
        });
        chip.appendChild(txt);
        var del = document.createElement("button");
        del.textContent = "✕";
        del.title = "Detach line";
        del.addEventListener("click", function () {
          exec({ op: "panelLineDetach", panel: panel.id, line: lineId });
        });
        chip.appendChild(del);
        view.linesEl.appendChild(chip);
      });
    }
    // picker options: every line in the project
    var sel = view.lineSelect;
    sel.innerHTML = "";
    var lines = [];
    (project.writing && project.writing.docs || []).forEach(function (doc) {
      doc.blocks.forEach(function (b) {
        if (b.kind === "line") lines.push(b);
      });
    });
    var opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = lines.length ? "attach a line…" : "no lines in Story yet";
    sel.appendChild(opt0);
    lines.forEach(function (b) {
      var opt = document.createElement("option");
      opt.value = b.id;
      var t = (b.character ? b.character + ": " : "") + VB.lineTextOf(b);
      opt.textContent = t.length > 48 ? t.slice(0, 45) + "…" : t;
      sel.appendChild(opt);
    });

    if (view.durInput && panel &&
        document.activeElement !== view.durInput) {
      view.durInput.value = String(panel.duration);
    }
    if (view.drawBtn) view.drawBtn.classList.toggle("active", view.drawMode);
    syncToolStrip();
    renderStage();
  }

  function exec(op) {
    view.app.exec(op);
    refresh();
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

  function startAnimatic() {
    var flat = flattenPanels(view.app.project);
    if (view.animatic.playing || flat.length === 0) return;
    if (view.drawMode) setDrawMode(false);
    var an = view.animatic;
    an.playing = true;
    an.at = 0;
    an.frame = 0;
    an.last = performance.now();
    an.acc = 0;
    view.host.classList.add("animatic");
    function tick(now) {
      if (!an.playing) return;
      an.acc += now - an.last;
      an.last = now;
      var msPerFrame = 1000 / (view.app.project.fps || 24);
      var advanced = false;
      while (an.acc >= msPerFrame) {
        an.acc -= msPerFrame;
        an.frame++;
        advanced = true;
      }
      if (advanced) {
        var f = flattenPanels(view.app.project);
        if (!f.length) { stopAnimatic(); return; }
        var remaining = an.frame;
        var idx = 0;
        while (idx < f.length &&
               remaining >= Math.max(1, f[idx].panel.duration | 0)) {
          remaining -= Math.max(1, f[idx].panel.duration | 0);
          idx++;
        }
        if (idx >= f.length) { an.frame = 0; idx = 0; } // loop
        an.at = idx;
        drawPanelToStage(f[idx].panel, subtitleFor(f[idx].panel));
      }
      an.raf = requestAnimationFrame(tick);
    }
    an.raf = requestAnimationFrame(tick);
  }

  function stopAnimatic() {
    var an = view.animatic;
    if (!an.playing) return;
    an.playing = false;
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
    if (ev.key === "Escape" && view.drawMode) {
      setDrawMode(false);
      return;
    }
    if (view.drawMode && !ev.ctrlKey && !ev.altKey) {
      var toolKeys = { p: "pencil", n: "line", o: "oval", r: "rect",
                       b: "brush", k: "bucket", e: "eraser" };
      var k = ev.key.toLowerCase();
      if (toolKeys[k]) {
        view.app.switchTool(toolKeys[k]);
        syncToolStrip();
        renderStage();
      }
    }
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
    bar.appendChild(toolBtn("＋ Beat", "Add a beat (a group of panels)",
      function () {
        exec({ op: "beatAdd", id: VB.actorNewId("beat") });
      }));
    bar.appendChild(toolBtn("＋ Panel", "Add a panel to the current beat",
      function () {
        var boards = boardsOf(app.project);
        var beat = boards.beats[boards.cur.beat];
        if (!beat) {
          exec({ op: "beatAdd", id: VB.actorNewId("beat") });
          beat = boardsOf(app.project).beats[boardsOf(app.project).cur.beat];
        }
        exec({ op: "panelAdd", beat: beat.id, id: VB.actorNewId("panel"),
               index: boards.cur.panel + 1 });
        if (view.drawMode) retargetDraw();
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

    var lineSelect = document.createElement("select");
    lineSelect.id = "bd-linesel";
    bar.appendChild(lineSelect);
    view.lineSelect = lineSelect;
    bar.appendChild(toolBtn("💬 Attach", "Attach the picked Story line to this panel",
      function () {
        var panel = currentPanel(app.project);
        if (panel && lineSelect.value) {
          exec({ op: "panelLineAttach", panel: panel.id,
                 line: lineSelect.value });
        }
      }));

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
    hint.textContent = "panels hold for their duration · lines attach from Story · double-click a line chip to edit it";
    bar.appendChild(hint);
    host.appendChild(bar);

    var body = document.createElement("div");
    body.id = "bd-body";
    var stage = document.createElement("canvas");
    stage.id = "bd-stage";
    body.appendChild(stage);
    var lines = document.createElement("div");
    lines.id = "bd-lines";
    body.appendChild(lines);
    host.appendChild(body);
    var beats = document.createElement("div");
    beats.id = "bd-beats";
    host.appendChild(beats);
    view.stage = stage;
    view.beatsEl = beats;
    view.linesEl = lines;

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

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", renderStage);
    refresh();
  }

  function unmount() {
    if (!view.host) return;
    stopAnimatic();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", renderStage);
    var t = view.app && view.app.project.editTarget;
    if (view.drawMode && t && t.boardPanel) {
      view.app.exec({ op: "editTargetClear" });
    }
    view.drawMode = false;
    view.host.classList.remove("animatic");
    view.host.innerHTML = "";
    view.host = null;
    view.stage = null;
    view.beatsEl = null;
    view.linesEl = null;
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
