/* main.js — GUI shell: canvas viewport, toolbar, tools, file I/O.
 *
 * Pointer routing: middle-drag (or Space+drag) always pans; otherwise the
 * active tool's onDown/onMove/onUp receive positions in stage twips.
 * The render loop draws the document, then the active tool's overlay,
 * then the vector debug overlay when enabled (D).
 */
(function () {
  "use strict";

  var canvas = document.getElementById("stage-canvas");
  var ctx = canvas.getContext("2d");

  var app = {
    project: new VB.Project(),
    fileName: null,
    sourceBytes: 0,
    tool: "select",
    view: { zoom: 1, panX: 40, panY: 40, dpr: window.devicePixelRatio || 1 },
    strokeColor: { r: 0, g: 0, b: 0, a: 255 },
    strokeWidth: 20,          // twips (1 px), Flash's default pencil width
    fillColor: { r: 102, g: 204, b: 255, a: 255 },
    eraserWidth: 20,          // eraser diameter, px
    brushWidth: 10,           // brush diameter, px
    debug: false,
    debugHover: -1,
    debugPin: -1,
    journal: [{ op: "new", width: 550 * VB.TWIPS, height: 400 * VB.TWIPS }],
    record: function (op) { app.journal.push(op); },
    requestRender: requestRender,
    setMsg: setMsg,
    setCursor: function (c) { canvas.style.cursor = c || ""; },
    toolByName: function (name) { return tools[name]; },
    switchTool: function (name) { selectTool(name); },
    onEdgeSelected: function (idx) {
      if (!app.debug) return;
      app.debugPin = idx;
      setMsg(idx >= 0 ? VB.debugDescribeEdge(app.doc, idx) : "");
      refreshDebugEdge();
      requestRender();
    },
    docChanged: docChanged
  };

  // Every tool and the boolean core edit ONE planar map: the active
  // layer's frame cell. Assigning a bare document (file loads) wraps it
  // as a single-layer project.
  Object.defineProperty(app, "doc", {
    get: function () { return app.project.activeCell(); },
    set: function (d) { app.project = VB.wrapDoc(d); }
  });

  // Command-pattern workflow: journal + apply in ONE call, dispatched
  // through the same registered command the replay uses (journal.js
  // VB.defineOp/applyOp) — live and replay cannot diverge for anything
  // routed through here. The command manages its own history snapshot.
  var execCtx = {
    get doc() { return app.doc; },
    get project() { return app.project; },
    set project(p) { app.project = p; },
    get history() { return app.history; },
    sync: function () {} // live doc/project are getters — always current
  };
  app.exec = function (op) {
    app.record(op);
    var r = VB.applyOp(execCtx, op);
    app.docChanged();
    return r;
  };

  // Undo snapshots capture the WHOLE project, so layer add/delete/move
  // are single undo steps. Tools call app.history.push(app.doc) — the
  // wrapper ignores the argument and snapshots the project.
  var projectHistory = new VB.History();
  app.history = {
    push: function () { projectHistory.push(app.project); },
    undo: function () { return projectHistory.undo(app.project); },
    redo: function () { return projectHistory.redo(app.project); },
    canUndo: function () { return projectHistory.canUndo(); },
    canRedo: function () { return projectHistory.canRedo(); },
    clear: function () { projectHistory.clear(); },
    get undoStack() { return projectHistory.undoStack; },
    get redoStack() { return projectHistory.redoStack; }
  };

  var tools = {
    select: VB.ArrowTool(app),
    transform: VB.FreeTransformTool(app),
    lasso: VB.LassoTool(app),
    pencil: new VB.PencilTool(app),
    brush: new VB.BrushTool(app),
    bucket: new VB.BucketTool(app),
    eraser: new VB.EraserTool(app),
    line: VB.LineTool(app),
    oval: VB.OvalTool(app),
    rect: VB.RectTool(app),
    text: VB.TextTool(app)
  };

  // ---- rendering loop ------------------------------------------------------

  var renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      VB.renderProject(ctx, app.project, app.view);
      var tool = tools[app.tool];
      // a pending transform session stays visible while a sibling
      // selection tool is active
      if (tools.transform && tool !== tools.transform &&
          tools.transform.hasSession && tools.transform.hasSession()) {
        try { tools.transform.drawOverlay(ctx); }
        catch (err) { trapError("overlay: " + err.message, err.stack); }
      }
      if (tool && tool.drawOverlay) {
        try { tool.drawOverlay(ctx); }
        catch (err) { trapError("overlay: " + err.message, err.stack); }
      }
      if (app.debug) {
        VB.renderDebug(ctx, app.doc, app.view,
          app.debugPin >= 0 ? app.debugPin : app.debugHover);
      }
      refreshRotationField();
      syncTextPanel();
      updateStatus();
    });
  }

  // Called after any document mutation (draw, undo, load): refreshes the
  // debug panel's style tables and record-stream stats, which are too
  // costly to rebuild on every pointer move.
  function docChanged() {
    if (tools.select && tools.select.clearSelection) tools.select.clearSelection();
    // a pending free-transform session's picks are stale now — drop it
    // WITHOUT committing (its own commit calls docChanged after landing)
    if (tools.transform && tools.transform.discard) tools.transform.discard();
    refreshLayers(); // undo/redo/load can change the layer structure
    app.debugPin = -1;
    app.debugHover = -1;
    refreshDebugPanel();
    requestRender();
    // Integrity sentinel: surface corruption the moment it happens so the
    // journal can be exported as a deterministic bug report.
    if (app.doc.edges.length <= 4000) {
      var problems = VB.integrityReport(app.doc);
      if (problems.length) {
        setMsg("⚠ " + problems.join(" · ") + " — use Save log to export a repro");
      }
    }
  }

  function refreshDebugPanel() {
    if (!app.debug) return;
    document.getElementById("dbg-styles").innerHTML = VB.debugStylesPanelHTML(app.doc);
    document.getElementById("dbg-stream").innerHTML = VB.debugStreamPanelHTML(app.doc);
    refreshDebugEdge();
  }

  function refreshDebugEdge() {
    if (!app.debug) return;
    var idx = app.debugPin >= 0 ? app.debugPin : app.debugHover;
    document.getElementById("dbg-edge").innerHTML =
      (app.debugPin >= 0 ? '<div class="dim">📌 pinned — Esc to unpin</div>' : "") +
      VB.debugEdgePanelHTML(app.doc, idx);
  }

  function resizeCanvas() {
    var rect = canvas.parentElement.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    app.view.dpr = dpr;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    requestRender();
  }
  new ResizeObserver(resizeCanvas).observe(canvas.parentElement);
  window.addEventListener("resize", resizeCanvas);

  // ---- view helpers --------------------------------------------------------

  function clientToStagePx(ev) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left - app.view.panX) / app.view.zoom,
      y: (ev.clientY - r.top - app.view.panY) / app.view.zoom
    };
  }

  function clientToTwips(ev) {
    var p = clientToStagePx(ev);
    return { x: p.x * VB.TWIPS, y: p.y * VB.TWIPS };
  }

  function setZoom(zoom, cx, cy) {
    zoom = Math.min(64, Math.max(0.02, zoom));
    if (cx === undefined) {
      var r = canvas.getBoundingClientRect();
      cx = r.width / 2; cy = r.height / 2;
    }
    var v = app.view;
    var sx = (cx - v.panX) / v.zoom;
    var sy = (cy - v.panY) / v.zoom;
    v.zoom = zoom;
    v.panX = cx - sx * zoom;
    v.panY = cy - sy * zoom;
    requestRender();
  }

  function fitView() {
    var r = canvas.getBoundingClientRect();
    var stageW = app.doc.width / VB.TWIPS, stageH = app.doc.height / VB.TWIPS;
    var zoom = Math.min((r.width - 60) / stageW, (r.height - 60) / stageH);
    zoom = Math.min(8, Math.max(0.02, zoom));
    app.view.zoom = zoom;
    app.view.panX = (r.width - stageW * zoom) / 2;
    app.view.panY = (r.height - stageH * zoom) / 2;
    requestRender();
  }

  // ---- status / toast ------------------------------------------------------

  function updateStatus() {
    var s = app.doc.stats();
    var layers = app.project.scene().layers;
    document.getElementById("status-doc").textContent =
      (app.doc.width / VB.TWIPS) + "×" + (app.doc.height / VB.TWIPS) + " px · " +
      app.project.activeLayer().name +
      (layers.length > 1 ? " (of " + layers.length + ")" : "") + " · " +
      s.edges + " edges (" + s.straight + " straight, " + s.curved + " curved) · " +
      s.fills + " fills · " + s.lines + " line styles" +
      (app.doc.texts && app.doc.texts.length
        ? " · " + app.doc.texts.length + " text (" + app.doc.fonts.length + " fonts)"
        : "");
    document.getElementById("status-zoom").textContent =
      "zoom " + Math.round(app.view.zoom * 100) + "%" + (app.debug ? " · DEBUG" : "");
    document.getElementById("btn-undo").disabled = !app.history.canUndo();
    document.getElementById("btn-redo").disabled = !app.history.canRedo();
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, ms || 3500);
  }

  function setMsg(msg) {
    document.getElementById("status-msg").textContent = msg || "";
  }

  // ---- file loading --------------------------------------------------------

  async function loadArrayBuffer(name, buf) {
    var bytes = new Uint8Array(buf);
    try {
      if (/\.(ttf|ttc|otf)$/i.test(name)) {
        // a dropped font goes to the text tool's font list, not the doc
        var fe = VB.textFonts.addBuffer(name, buf);
        toast("Font loaded: " + fe.label);
        return;
      }
      var result, kind;
      if (VB.isVBD(bytes)) {
        result = await VB.decodeVBD(bytes);
        kind = "VBD";
      } else {
        result = await VB.parseSWF(buf);
        kind = "SWF v" + result.info.version;
      }
      if (result.project) app.project = result.project;
      else app.doc = result.doc; // wraps as a single-layer project
      app.fileName = name;
      app.sourceBytes = bytes.length;
      app.history.clear();
      app.journal.length = 0;
      app.journal.push({ op: "load", name: name, b64: VB.bytesToB64(bytes) });
      document.getElementById("fileinfo").textContent =
        name + " · " + kind + " · " + bytes.length.toLocaleString() + " B";
      var warn = (result.info.warnings || []);
      setMsg(warn.length ? warn[0] : "");
      docChanged();
      fitView();
      toast("Loaded " + name);
    } catch (err) {
      toast("Failed to load " + name + ": " + err.message, 6000);
    }
  }

  function openFile(file) {
    file.arrayBuffer().then(function (buf) { loadArrayBuffer(file.name, buf); });
  }

  var fileInput = document.getElementById("file-input");
  fileInput.addEventListener("change", function () {
    if (fileInput.files.length) openFile(fileInput.files[0]);
    fileInput.value = "";
  });

  document.getElementById("btn-open").addEventListener("click", function () {
    fileInput.click();
  });

  // Crash black box: any uncaught exception is captured (with stack and
  // the current op count) and shipped inside the exported log, so a
  // "the app crashed" report carries its own diagnosis. Replay ignores
  // the errors field.
  app.errors = [];
  function trapError(msg, stack) {
    app.errors.push({ atOp: app.journal.length, msg: String(msg),
                      stack: String(stack || "").split("\n").slice(0, 8).join(" | ") });
    setMsg("✖ internal error: " + msg + " — use Save log to export a report");
  }
  window.addEventListener("error", function (ev) {
    trapError(ev.message, ev.error && ev.error.stack);
  });
  window.addEventListener("unhandledrejection", function (ev) {
    trapError(ev.reason && ev.reason.message || ev.reason,
              ev.reason && ev.reason.stack);
  });

  document.getElementById("btn-log").addEventListener("click", function () {
    var blob = new Blob(
      [JSON.stringify({ version: 1, ops: app.journal, errors: app.errors })],
      { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "vectorbrush-log.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Saved action log (" + app.journal.length + " ops) — replay with test/replay.html");
  });

  document.getElementById("btn-save").addEventListener("click", async function () {
    try {
      var bytes = await VB.encodeVBD(app.project, { compress: true });
      var base = app.fileName ? app.fileName.replace(/\.[^.]+$/, "") : "drawing";
      var blob = new Blob([bytes], { type: "application/octet-stream" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = base + ".vbd";
      a.click();
      URL.revokeObjectURL(a.href);
      var note = "Saved " + a.download + " · " + bytes.length.toLocaleString() + " B";
      if (app.sourceBytes) {
        note += " (source " + app.sourceBytes.toLocaleString() + " B)";
      }
      toast(note, 5000);
    } catch (err) {
      toast("Save failed: " + err.message, 6000);
    }
  });

  document.getElementById("btn-save-swf").addEventListener("click", function () {
    try {
      var textCount = 0;
      app.project.eachCell(function (cell) { textCount += cell.texts.length; });
      if (textCount) {
        toast("Note: " + textCount + " text block(s) are not yet " +
          "written to SWF (coming next) — the .vbd save keeps them", 6000);
      }
      var bytes = VB.encodeSWF(app.project);
      var base = app.fileName ? app.fileName.replace(/\.[^.]+$/, "") : "drawing";
      var blob = new Blob([bytes], { type: "application/x-shockwave-flash" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = base + ".swf";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Saved " + a.download + " · " + bytes.length.toLocaleString() +
        " B (SWF v7 — import into Flash MX 2004)", 5000);
    } catch (err) {
      toast("SWF export failed: " + err.message, 6000);
    }
  });

  var wrap = document.getElementById("canvaswrap");
  wrap.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  wrap.addEventListener("drop", function (ev) {
    ev.preventDefault();
    if (ev.dataTransfer.files.length) openFile(ev.dataTransfer.files[0]);
  });

  // ---- undo / redo -----------------------------------------------------------

  function doUndo() {
    // a floating (uncommitted) selection undoes by restoration, without
    // a journal record — its lift was never journaled either
    if (tools.select && tools.select.undoFloat && tools.select.undoFloat()) return;
    // likewise a pending free-transform: step back one gesture, no record
    if (tools.transform && tools.transform.undoPending && tools.transform.undoPending()) return;
    if (app.history.undo(app.doc)) { app.record({ op: "undo" }); setMsg("undo"); docChanged(); }
  }
  function doRedo() {
    if (app.history.redo(app.doc)) { app.record({ op: "redo" }); setMsg("redo"); docChanged(); }
  }
  document.getElementById("btn-undo").addEventListener("click", doUndo);
  document.getElementById("btn-redo").addEventListener("click", doRedo);

  // ---- zoom / pan / pointer routing ------------------------------------------

  document.getElementById("btn-zoom-in").addEventListener("click", function () {
    setZoom(app.view.zoom * 1.25);
  });
  document.getElementById("btn-zoom-out").addEventListener("click", function () {
    setZoom(app.view.zoom / 1.25);
  });
  document.getElementById("btn-zoom-100").addEventListener("click", function () {
    setZoom(1);
  });
  document.getElementById("btn-fit").addEventListener("click", fitView);

  canvas.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    var r = canvas.getBoundingClientRect();
    var factor = Math.pow(1.0015, -ev.deltaY);
    setZoom(app.view.zoom * factor, ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });

  var panning = null;
  var spaceDown = false;
  var activePointerTool = null;

  canvas.addEventListener("pointerdown", function (ev) {
    if (ev.button === 1 || (ev.button === 0 && spaceDown)) {
      panning = { x: ev.clientX, y: ev.clientY };
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
    if (ev.button === 0) {
      if (app.project.activeLayer().locked) {
        toast("Layer “" + app.project.activeLayer().name + "” is locked");
        return;
      }
      var tool = tools[app.tool];
      // a pending transform session stays GRABBABLE across the selection
      // family: presses on its frame route to the transform tool; a
      // press anywhere else lands the session first, then the active
      // tool proceeds normally
      var tf = tools.transform;
      if (tf && tool !== tf && SEL_FAMILY[app.tool] &&
          tf.hasSession && tf.hasSession()) {
        var tp = clientToTwips(ev);
        if (tf.hitsFrame(tp)) {
          activePointerTool = tf;
          canvas.setPointerCapture(ev.pointerId);
          tf.onDown(tp, ev);
          ev.preventDefault();
          return;
        }
        if (tf.commitPending) tf.commitPending();
      }
      if (tool && tool.onDown) {
        activePointerTool = tool;
        canvas.setPointerCapture(ev.pointerId);
        tool.onDown(clientToTwips(ev), ev);
        ev.preventDefault();
      }
    }
  });

  canvas.addEventListener("pointermove", function (ev) {
    if (panning) {
      app.view.panX += ev.clientX - panning.x;
      app.view.panY += ev.clientY - panning.y;
      panning = { x: ev.clientX, y: ev.clientY };
      requestRender();
    } else if (activePointerTool && activePointerTool.onMove) {
      activePointerTool.onMove(clientToTwips(ev));
    } else {
      var hp = clientToTwips(ev);
      var tfh = tools.transform;
      if (tfh && tools[app.tool] !== tfh && SEL_FAMILY[app.tool] &&
          tfh.hasSession && tfh.hasSession() && tfh.hitsFrame(hp)) {
        tfh.onHover(hp); // frame cursors work from sibling tools too
      } else if (tools[app.tool] && tools[app.tool].onHover) {
        tools[app.tool].onHover(hp);
      }
      if (app.debug) {
        // hover inspector (pin wins) — runs alongside the active tool
        var pt = clientToTwips(ev);
        var tol = 5 * VB.TWIPS / app.view.zoom;
        var idx = VB.debugPickEdge(app.doc, pt.x, pt.y, tol);
        if (idx !== app.debugHover) {
          app.debugHover = idx;
          if (app.debugPin < 0) {
            setMsg(idx >= 0 ? VB.debugDescribeEdge(app.doc, idx) : "");
            refreshDebugEdge();
            requestRender();
          }
        }
      }
    }
    var p = clientToStagePx(ev);
    document.getElementById("status-pos").textContent =
      "(" + Math.round(p.x * VB.TWIPS) + ", " + Math.round(p.y * VB.TWIPS) + ") tw · " +
      p.x.toFixed(1) + ", " + p.y.toFixed(1) + " px";
  });

  canvas.addEventListener("dblclick", function (ev) {
    var tool = tools[app.tool];
    if (tool && tool.onDblClick) tool.onDblClick(clientToTwips(ev));
  });

  canvas.addEventListener("pointerup", function (ev) {
    if (panning) { panning = null; return; }
    if (activePointerTool) {
      var tool = activePointerTool;
      activePointerTool = null;
      if (tool.onUp) tool.onUp(clientToTwips(ev));
    }
  });

  canvas.addEventListener("pointercancel", function () {
    panning = null;
    if (activePointerTool && activePointerTool.cancel) activePointerTool.cancel();
    activePointerTool = null;
  });

  // ---- keyboard ---------------------------------------------------------------

  window.addEventListener("keydown", function (ev) {
    // typing in a form field (the text tool's hidden textarea, layer
    // rename, size inputs) must never trigger tool shortcuts
    var tag = ev.target && ev.target.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (ev.code === "Space") { spaceDown = true; }
    if (ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === "z") { ev.preventDefault(); doUndo(); return; }
    if ((ev.ctrlKey && ev.key.toLowerCase() === "y") ||
        (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "z")) { ev.preventDefault(); doRedo(); return; }
    if (ev.ctrlKey && ev.key.toLowerCase() === "o") { ev.preventDefault(); fileInput.click(); return; }
    if (ev.ctrlKey && !ev.altKey) {
      var ck = ev.key.toLowerCase();
      if (ck === "c") { ev.preventDefault(); copySelection(); return; }
      if (ck === "x") { ev.preventDefault(); cutSelection(); return; }
      if (ck === "v") { ev.preventDefault(); pasteClipboard(); return; }
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (deleteSelection()) { ev.preventDefault(); return; }
    }
    if (ev.key === "Escape") {
      if (activePointerTool && activePointerTool.cancel) {
        activePointerTool.cancel();
        activePointerTool = null;
      } else if (SEL_FAMILY[app.tool] && tools.transform &&
                 tools.transform.revertPending && tools.transform.revertPending()) {
        // pending free-transform abandoned, selection kept
      } else if (app.debugPin >= 0) {
        app.debugPin = -1;
        refreshDebugEdge();
        requestRender();
      }
      return;
    }
    if (ev.ctrlKey || ev.altKey) return;
    var k = ev.key.toLowerCase();
    if (k === "d") { toggleDebug(); return; }
    // Flash-accurate bindings: B = brush, K = paint bucket, N = line,
    // O = oval, R = rectangle
    var toolKeys = { v: "select", p: "pencil", b: "brush", k: "bucket",
                     e: "eraser", n: "line", o: "oval", r: "rect",
                     q: "transform", l: "lasso", t: "text" };
    if (toolKeys[k]) selectTool(toolKeys[k]);
  });
  window.addEventListener("keyup", function (ev) {
    if (ev.code === "Space") spaceDown = false;
  });

  // ---- debug toggle -------------------------------------------------------------

  function toggleDebug() {
    app.debug = !app.debug;
    app.debugHover = -1;
    app.debugPin = -1;
    document.getElementById("btn-debug").classList.toggle("active", app.debug);
    document.getElementById("debugpanel").classList.toggle("hidden", !app.debug);
    if (!app.debug) setMsg("");
    refreshDebugPanel();
    requestRender();
    resizeCanvas(); // panel changes the canvas area width
  }
  document.getElementById("btn-debug").addEventListener("click", toggleDebug);

  // ---- stroke style controls ------------------------------------------------------

  var colorInput = document.getElementById("stroke-color");
  colorInput.addEventListener("input", function () {
    var v = colorInput.value;
    app.strokeColor = {
      r: parseInt(v.slice(1, 3), 16),
      g: parseInt(v.slice(3, 5), 16),
      b: parseInt(v.slice(5, 7), 16),
      a: 255
    };
  });

  var widthInput = document.getElementById("stroke-width");
  widthInput.addEventListener("input", function () {
    var px = parseFloat(widthInput.value);
    if (isFinite(px) && px > 0) app.strokeWidth = Math.round(px * VB.TWIPS);
  });

  var brushInput = document.getElementById("brush-size");
  brushInput.addEventListener("input", function () {
    var px = parseFloat(brushInput.value);
    if (isFinite(px) && px > 0) app.brushWidth = px;
  });

  var eraserInput = document.getElementById("eraser-size");
  eraserInput.addEventListener("input", function () {
    var px = parseFloat(eraserInput.value);
    if (isFinite(px) && px > 0) app.eraserWidth = px;
  });

  var fillInput = document.getElementById("fill-color");
  fillInput.addEventListener("input", function () {
    var v = fillInput.value;
    app.fillColor = {
      r: parseInt(v.slice(1, 3), 16),
      g: parseInt(v.slice(3, 5), 16),
      b: parseInt(v.slice(5, 7), 16),
      a: 255
    };
  });

  // ---- tool palette -----------------------------------------------------------------

  // The tool the user came FROM when entering the transform tool —
  // clicking away from a finished transform returns there (lasso a
  // region, transform it, land back in the lasso).
  var returnTool = null;
  // A pending transform session survives switching among these; it
  // only commits when the user acts elsewhere or picks a drawing tool.
  var SEL_FAMILY = { select: true, lasso: true, transform: true };

  function selectTool(tool) {
    canvas.style.cursor = "";
    if (tool === "transform" && app.tool !== "transform") returnTool = app.tool;
    if (tools.select && tools.select.commitFloat) tools.select.commitFloat();
    if (tools.text && tools.text.commitPending) tools.text.commitPending();
    // the text properties panel shows/hides in syncTextPanel (it also
    // serves arrow-selected blocks, not just the text tool)
    if (tool === "transform" && tools.select.exportSelection) {
      var handoff = tools.select.exportSelection();
      if (handoff.text != null) {
        tools.transform.adopt({ textIndex: handoff.text });
        if (tools.select.clearSelection) tools.select.clearSelection();
      } else if (handoff.region || handoff.fills.length || handoff.edgeKeys.length) {
        tools.transform.adopt(handoff); // commits any older session first
        if (tools.select.clearSelection) tools.select.clearSelection();
      }
      // no new selection: whatever session the tool already holds stays
    } else if (!SEL_FAMILY[tool] && tools.transform && tools.transform.adopt) {
      tools.transform.adopt(null); // leaving the selection family commits
    }
    if (activePointerTool && activePointerTool.cancel) activePointerTool.cancel();
    activePointerTool = null;
    app.tool = tool;
    document.querySelectorAll("#tools button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tool === tool);
    });
    if (tool !== "select" && !tools[tool]) {
      setMsg(tool + " tool is scheduled for the next milestone");
    } else {
      setMsg("");
    }
    requestRender();
  }
  document.querySelectorAll("#tools button").forEach(function (b) {
    b.addEventListener("click", function () { selectTool(b.dataset.tool); });
  });

  app.transformDone = function () {
    if (app.tool !== "transform") return;
    selectTool(returnTool && tools[returnTool] ? returnTool : "select");
  };

  // ---- clipboard (Ctrl+C / Ctrl+X / Ctrl+V) + Delete ---------------------------
  // Internal clipboard; payloads are self-contained (shape clips as
  // plain planar-map JSON, text as textCreate ops), so pasting is ONE
  // registered command through app.exec and replays bit-for-bit.
  var clipboard = null;
  var pasteBump = 0; // each paste of the same payload lands 10px further

  function selectionSource() {
    if (tools.transform && tools.transform.hasSession &&
        tools.transform.hasSession()) return tools.transform;
    return tools.select;
  }

  function copySelection() {
    var src = selectionSource();
    var payload = src.copySelection ? src.copySelection() : null;
    if (!payload) { setMsg("nothing selected to copy"); return false; }
    clipboard = payload;
    pasteBump = 0;
    setMsg("copied — Ctrl+V to paste");
    return true;
  }

  function deleteSelection() {
    if (tools.transform && tools.transform.hasSession &&
        tools.transform.hasSession()) {
      return tools.transform.deleteSelection();
    }
    if (SEL_FAMILY[app.tool] && tools.select.onDeleteKey) {
      return tools.select.onDeleteKey();
    }
    return false;
  }

  function cutSelection() {
    if (!copySelection()) return false;
    if (!deleteSelection()) { setMsg("copied — nothing deletable"); return true; }
    setMsg("cut — Ctrl+V to paste");
    return true;
  }

  function pasteClipboard() {
    if (!clipboard) { setMsg("clipboard is empty"); return false; }
    if (app.project.activeLayer().locked) { setMsg("layer is locked"); return false; }
    pasteBump += 200;
    if (clipboard.kind === "shape") {
      app.exec({
        op: "paste",
        clip: JSON.parse(JSON.stringify(clipboard.clip)),
        m: [1, 0, 0, 1, pasteBump, pasteBump]
      });
      // pasted content lands selected: its bbox becomes a region the
      // transform tool adopts (Flash pastes as a movable selection)
      var bb = null;
      clipboard.clip.edges.forEach(function (e) {
        [[e.ax, e.ay], [e.bx, e.by]].concat(
          e.cx === null ? [] : [[e.cx, e.cy]]).forEach(function (p) {
          if (!bb) bb = { x0: p[0], y0: p[1], x1: p[0], y1: p[1] };
          bb.x0 = Math.min(bb.x0, p[0]); bb.x1 = Math.max(bb.x1, p[0]);
          bb.y0 = Math.min(bb.y0, p[1]); bb.y1 = Math.max(bb.y1, p[1]);
        });
      });
      if (bb) {
        var pad = 20, dx = pasteBump, dy = pasteBump;
        tools.select.sel = {
          fills: [], edgeKeys: [], text: null,
          region: [
            { x: bb.x0 + dx - pad, y: bb.y0 + dy - pad },
            { x: bb.x1 + dx + pad, y: bb.y0 + dy - pad },
            { x: bb.x1 + dx + pad, y: bb.y1 + dy + pad },
            { x: bb.x0 + dx - pad, y: bb.y1 + dy + pad }
          ]
        };
        selectTool("transform");
      }
      setMsg("pasted");
      return true;
    }
    // text: one textCreate per part (a single part for app-authored
    // blocks; imported multi-font blocks paste as sibling blocks)
    var lastIndex = -1;
    clipboard.parts.forEach(function (part) {
      var op = JSON.parse(JSON.stringify(part));
      op.matrix[4] += pasteBump;
      op.matrix[5] += pasteBump;
      app.exec(op);
      lastIndex = app.doc.texts.length - 1;
    });
    if (lastIndex >= 0) {
      tools.select.sel = { fills: [], edgeKeys: [], region: null, text: lastIndex };
      selectTool("select");
    }
    setMsg("text pasted");
    return true;
  }

  document.getElementById("btn-delete").addEventListener("click", function () {
    if (!deleteSelection()) setMsg("nothing selected to delete");
  });

  // Double-clicking a text block (from any selection tool) opens it in
  // the text tool's edit session.
  app.editText = function (index) {
    selectTool("text");
    tools.text.editBlock(index);
  };

  // ---- selection rotation field ------------------------------------------------
  // Shows the selection's absolute angle; typing a value (0 to snap
  // upright) rotates about the selection's center.

  function rotationTarget() {
    if (tools.transform && tools.transform.hasSession && tools.transform.hasSession()) {
      return { kind: "session", m: tools.transform.sessionMatrix() };
    }
    if (tools.select && tools.select.sel && tools.select.sel.text != null &&
        app.doc.texts[tools.select.sel.text]) {
      return { kind: "text", index: tools.select.sel.text,
               m: app.doc.texts[tools.select.sel.text].matrix };
    }
    return null;
  }

  function refreshRotationField() {
    var inp = document.getElementById("sel-rotation");
    if (!inp || document.activeElement === inp) return;
    var t = rotationTarget();
    if (!t) { inp.value = "0"; inp.disabled = true; return; }
    inp.disabled = false;
    inp.value = String(Math.round(Math.atan2(t.m[1], t.m[0]) * 1800 / Math.PI) / 10);
  }

  document.getElementById("sel-rotation").addEventListener("change", function () {
    var deg = parseFloat(this.value) || 0;
    var t = rotationTarget();
    if (!t) return;
    if (t.kind === "session") {
      tools.transform.rotateTo(deg);
      return;
    }
    var block = app.doc.texts[t.index];
    var cur = Math.atan2(block.matrix[1], block.matrix[0]);
    var a = deg * Math.PI / 180 - cur;
    if (Math.abs(a) < 1e-6) return;
    var bb = VB.textBlockBounds(app.doc, block);
    var lx = (bb.x0 + bb.x1) / 2, ly = (bb.y0 + bb.y1) / 2;
    var c = { x: block.matrix[0] * lx + block.matrix[2] * ly + block.matrix[4],
              y: block.matrix[1] * lx + block.matrix[3] * ly + block.matrix[5] };
    var cos = Math.cos(a), sin = Math.sin(a);
    var m = [cos, sin, -sin, cos,
             c.x - cos * c.x + sin * c.y, c.y - sin * c.x - cos * c.y];
    app.record({ op: "textTransform", index: t.index, m: m });
    app.history.push();
    VB.textTransformApply(app.doc, t.index, m);
    var keep = t.index;
    docChanged();
    tools.select.sel.text = keep;
    requestRender();
    setMsg("rotation set to " + deg + "°");
  });

  // ---- canvas context menu ------------------------------------------------------

  var ctxmenu = document.getElementById("ctxmenu");
  function hideCtxMenu() { ctxmenu.classList.add("hidden"); }
  canvas.addEventListener("contextmenu", function (ev) {
    ev.preventDefault();
    flushSelections(); // lifted sessions land so the hit test sees them
    var pos = clientToTwips(ev);
    var ti = VB.textHit(app.doc, pos.x, pos.y);
    if (ti < 0) { hideCtxMenu(); return; }
    ctxmenu.innerHTML = "";
    [["Edit text", function () { app.editText(ti); }],
     ["Break apart into vectors", function () {
       app.record({ op: "textBreak", index: ti });
       app.history.push();
       VB.textBreakApply(app.doc, ti);
       docChanged();
       toast("Text broken into vectors — it now merges like any ink");
     }],
     ["Delete text", function () {
       app.record({ op: "textDelete", index: ti });
       app.history.push();
       VB.textDeleteApply(app.doc, ti);
       docChanged();
     }]].forEach(function (item) {
      var row = document.createElement("div");
      row.className = "ctxitem";
      row.textContent = item[0];
      row.addEventListener("click", function () { hideCtxMenu(); item[1](); });
      ctxmenu.appendChild(row);
    });
    var wrap = document.getElementById("canvaswrap").getBoundingClientRect();
    ctxmenu.style.left = (ev.clientX - wrap.left) + "px";
    ctxmenu.style.top = (ev.clientY - wrap.top) + "px";
    ctxmenu.classList.remove("hidden");
  });
  canvas.addEventListener("pointerdown", hideCtxMenu);

  // ---- text tool options ------------------------------------------------------

  function refreshFontList() {
    var sel = document.getElementById("text-font");
    var keep = sel.value;
    sel.innerHTML = "";
    VB.textFonts.entries.forEach(function (e) {
      var o = document.createElement("option");
      o.value = e.label;
      o.textContent = e.label;
      sel.appendChild(o);
    });
    if (keep && VB.textFonts.find(keep)) sel.value = keep;
    else if (VB.textFonts.find("DejaVu Sans")) sel.value = "DejaVu Sans";
  }
  VB.textFonts.onChange(refreshFontList);
  refreshFontList(); // the bundled DejaVu faces registered before boot

  document.getElementById("btn-fonts").addEventListener("click", async function () {
    try {
      await VB.textFonts.loadLocal();
      toast(VB.textFonts.entries.length + " font families available");
    } catch (err) {
      toast(err.message, 6000);
    }
  });

  // ---- text properties panel -----------------------------------------------
  // Edits the live text session, or restyles the arrow-selected block.

  function textPropsTarget() {
    if (tools.text && tools.text.sessionProps && tools.text.sessionProps()) {
      return { kind: "session" };
    }
    if (tools.select && tools.select.sel && tools.select.sel.text != null &&
        app.doc.texts[tools.select.sel.text]) {
      return { kind: "block", index: tools.select.sel.text };
    }
    return null;
  }

  function findFace(family, bold, italic) {
    var best = null;
    VB.textFonts.entries.forEach(function (e) {
      if (e.family !== family) return;
      var s = (e.style || "").toLowerCase();
      var isB = s.indexOf("bold") >= 0;
      var isI = s.indexOf("italic") >= 0 || s.indexOf("oblique") >= 0;
      if (isB === !!bold && isI === !!italic) best = e;
    });
    return best;
  }

  function cssColor(c) {
    function hex(v) { return ("0" + v.toString(16)).slice(-2); }
    return "#" + hex(c.r) + hex(c.g) + hex(c.b);
  }

  function syncTextPanel() {
    var panel = document.getElementById("text-opts");
    var target = textPropsTarget();
    var show = app.tool === "text" || !!target;
    // the properties row keeps its height; controls only gray out —
    // hiding it resized the toolbar and made the canvas jump
    panel.classList.toggle("inactive", !show);
    if (!show) return;
    function setVal(id, v) {
      var el = document.getElementById(id);
      if (document.activeElement !== el) el.value = v;
    }
    var props = null, block = null;
    if (target && target.kind === "session") {
      props = tools.text.sessionProps();
    } else if (target && target.kind === "block") {
      block = app.doc.texts[target.index];
      var f = app.doc.fonts[block.records[0].font];
      props = { sizeTw: block.records[0].height, color: block.records[0].color,
                align: block.align || 0, spacing: block.spacing || 0,
                family: f ? f.name : "", bold: f && f.bold, italic: f && f.italic,
                wrapWidth: block.wrapWidth, matrix: block.matrix };
    }
    if (!props) return;
    setVal("text-size", Math.round(props.sizeTw / 20));
    setVal("text-color", cssColor(props.color));
    setVal("text-spacing", (props.spacing || 0) / 20);
    document.getElementById("text-bold").classList.toggle("active", !!props.bold);
    document.getElementById("text-italic").classList.toggle("active", !!props.italic);
    ["l", "c", "r"].forEach(function (k, i) {
      document.getElementById("text-align-" + k)
        .classList.toggle("active", (props.align || 0) === i);
    });
    var faceLabel = props.family +
      (props.bold || props.italic
        ? " " + (props.bold ? "Bold" : "") + (props.bold && props.italic ? " " : "") +
          (props.italic ? "Oblique" : "") : "");
    var sel = document.getElementById("text-font");
    if (document.activeElement !== sel) {
      if (VB.textFonts.find(faceLabel)) sel.value = faceLabel;
      else if (VB.textFonts.find(props.family)) sel.value = props.family;
    }
    setVal("text-x", Math.round(props.matrix[4] / 20));
    setVal("text-y", Math.round(props.matrix[5] / 20));
    if (block) {
      var bb = VB.textBoxBounds(app.doc, block);
      setVal("text-w", Math.round(((props.wrapWidth || (bb ? bb.x1 - Math.min(0, bb.x0) : 0))) / 20));
      setVal("text-h", bb ? Math.round((bb.y1 - bb.y0) / 20) : 0);
    } else {
      setVal("text-w", props.wrapWidth ? Math.round(props.wrapWidth / 20) : "");
      setVal("text-h", props.boxHeight ? Math.round(props.boxHeight / 20) : "");
    }
  }

  /** Apply a panel change: live session or a self-contained op on the
   *  selected block (restyle needs the face's TTF — bundled fonts make
   *  this the common case). */
  async function applyTextProps(change) {
    var target = textPropsTarget();
    if (!target) return;
    if (target.kind === "session") {
      var sp = tools.text.sessionProps();
      var props = {};
      if (change.sizeTw) props.sizeTw = change.sizeTw;
      if (change.color) props.color = change.color;
      if (change.align !== undefined) props.align = change.align;
      if (change.spacing !== undefined) props.spacing = change.spacing;
      if (change.wrapWidth) props.wrapWidth = change.wrapWidth;
      if (change.boxHeight) props.boxHeight = change.boxHeight;
      if (change.family || change.bold !== undefined || change.italic !== undefined) {
        var fam = change.family || sp.family;
        var bold = change.bold !== undefined ? change.bold : sp.bold;
        var italic = change.italic !== undefined ? change.italic : sp.italic;
        var face = findFace(fam, bold, italic) || VB.textFonts.find(fam);
        if (!face) { toast("no " + fam + " face for that style"); return; }
        try {
          props.ttf = await VB.textFonts.ensureParsed(face.label);
          props.meta = { name: face.family, bold: bold, italic: italic };
        } catch (err) { toast(err.message, 5000); return; }
      }
      tools.text.setSessionProps(props);
      return;
    }
    // a selected block
    var index = target.index;
    var block = app.doc.texts[index];
    if (change.x !== undefined || change.y !== undefined) {
      var dx = change.x !== undefined ? change.x - block.matrix[4] : 0;
      var dy = change.y !== undefined ? change.y - block.matrix[5] : 0;
      if (!dx && !dy) return;
      app.record({ op: "textTransform", index: index, m: [1, 0, 0, 1, dx, dy] });
      app.history.push();
      VB.textTransformApply(app.doc, index, [1, 0, 0, 1, dx, dy]);
    } else if (change.wrapWidth) {
      app.record({ op: "textWrap", index: index, width: change.wrapWidth, dx: 0 });
      app.history.push();
      VB.textWrapApply(app.doc, index, change.wrapWidth, 0);
    } else if (change.boxHeight) {
      // H grows the CONTAINER only — glyphs stay their size
      app.record({ op: "textBoxH", index: index,
                   height: change.boxHeight, dy: 0 });
      app.history.push();
      VB.textBoxHApply(app.doc, index, change.boxHeight, 0);
    } else {
      // full restyle via a self-contained textEdit
      var font = app.doc.fonts[block.records[0].font];
      var fam2 = change.family || font.name;
      var bold2 = change.bold !== undefined ? change.bold : font.bold;
      var italic2 = change.italic !== undefined ? change.italic : font.italic;
      var face2 = findFace(fam2, bold2, italic2) || VB.textFonts.find(fam2);
      if (!face2) { toast("no " + fam2 + " face for that style — load it first"); return; }
      var ttf2;
      try { ttf2 = await VB.textFonts.ensureParsed(face2.label); }
      catch (err) { toast("restyling needs the font: " + err.message, 5000); return; }
      var str = "";
      block.records.forEach(function (rec, ri) {
        if (ri > 0 && !rec.soft) str += "\n";
        str += rec.glyphs.map(function (g) {
          var gl = font.glyphs[g.gi];
          return gl ? String.fromCharCode(gl.code) : "";
        }).join("");
      });
      var op = VB.buildTextOp(ttf2, { name: face2.family, bold: bold2, italic: italic2 },
        str, change.sizeTw || block.records[0].height,
        change.color || block.records[0].color, 0, 0,
        block.wrapWidth,
        change.align !== undefined ? change.align : (block.align || 0),
        change.spacing !== undefined ? change.spacing : (block.spacing || 0));
      if (!op) return;
      var edit = { op: "textEdit", index: index, font: op.font,
                   records: op.records, wrapWidth: op.wrapWidth,
                   pitch: op.pitch, align: op.align, spacing: op.spacing };
      app.record(edit);
      app.history.push();
      VB.textEditApply(app.doc, edit);
    }
    var keep = index;
    docChanged();
    tools.select.sel.text = keep;
    requestRender();
  }

  document.getElementById("text-size").addEventListener("change", function () {
    applyTextProps({ sizeTw: Math.round((parseFloat(this.value) || 24) * 20) });
  });
  document.getElementById("text-color").addEventListener("change", function () {
    var v = this.value;
    applyTextProps({ color: { r: parseInt(v.slice(1, 3), 16),
                              g: parseInt(v.slice(3, 5), 16),
                              b: parseInt(v.slice(5, 7), 16), a: 255 } });
  });
  document.getElementById("text-bold").addEventListener("click", function () {
    applyTextProps({ bold: !this.classList.contains("active") });
  });
  document.getElementById("text-italic").addEventListener("click", function () {
    applyTextProps({ italic: !this.classList.contains("active") });
  });
  ["l", "c", "r"].forEach(function (k, i) {
    document.getElementById("text-align-" + k).addEventListener("click", function () {
      applyTextProps({ align: i });
    });
  });
  document.getElementById("text-spacing").addEventListener("change", function () {
    applyTextProps({ spacing: Math.round((parseFloat(this.value) || 0) * 20) });
  });
  document.getElementById("text-x").addEventListener("change", function () {
    applyTextProps({ x: Math.round((parseFloat(this.value) || 0) * 20) });
  });
  document.getElementById("text-y").addEventListener("change", function () {
    applyTextProps({ y: Math.round((parseFloat(this.value) || 0) * 20) });
  });
  document.getElementById("text-w").addEventListener("change", function () {
    var w = Math.round((parseFloat(this.value) || 0) * 20);
    if (w > 0) applyTextProps({ wrapWidth: w });
  });
  document.getElementById("text-h").addEventListener("change", function () {
    var h = Math.round((parseFloat(this.value) || 0) * 20);
    if (h > 0) applyTextProps({ boxHeight: h });
  });
  document.getElementById("text-font").addEventListener("change", function () {
    var e = VB.textFonts.find(this.value);
    if (e) applyTextProps({ family: e.family, bold: undefined, italic: undefined });
  });

  // ---- layers & scenes panel ---------------------------------------------------

  // Pending selections (arrow float, transform session) belong to the
  // ACTIVE cell — land them before the active cell changes.
  function flushSelections() {
    if (tools.select && tools.select.commitFloat) tools.select.commitFloat();
    if (tools.transform && tools.transform.adopt) tools.transform.adopt(null);
    if (tools.text && tools.text.commitPending) tools.text.commitPending();
    if (tools.select && tools.select.clearSelection) tools.select.clearSelection();
  }

  function refreshLayers() {
    var sel = document.getElementById("scene-select");
    sel.innerHTML = "";
    app.project.scenes.forEach(function (sc, i) {
      var o = document.createElement("option");
      o.value = i;
      o.textContent = sc.name;
      sel.appendChild(o);
    });
    sel.value = app.project.cur.scene;

    var list = document.getElementById("layerlist");
    list.innerHTML = "";
    app.project.scene().layers.forEach(function (l, i) {
      var row = document.createElement("div");
      row.className = "layerrow" + (i === app.project.cur.layer ? " active" : "");

      var eye = document.createElement("span");
      eye.className = "toggle" + (l.visible ? "" : " off");
      eye.textContent = "◉"; // ◉
      eye.title = "Show/hide layer";
      eye.addEventListener("click", function (ev) {
        ev.stopPropagation();
        app.record({ op: "layerVisible", index: i, on: !l.visible });
        l.visible = !l.visible;
        refreshLayers();
        requestRender();
      });

      var lock = document.createElement("span");
      lock.className = "toggle" + (l.locked ? "" : " off");
      lock.textContent = "🔒"; // 🔒
      lock.title = "Lock/unlock layer";
      lock.addEventListener("click", function (ev) {
        ev.stopPropagation();
        app.record({ op: "layerLock", index: i, on: !l.locked });
        l.locked = !l.locked;
        refreshLayers();
      });

      var name = document.createElement("span");
      name.className = "lname";
      name.textContent = l.name;
      name.title = l.name + " (double-click to rename)";
      name.addEventListener("dblclick", function (ev) {
        ev.stopPropagation();
        var newName = prompt("Layer name:", l.name);
        if (newName && newName !== l.name) {
          app.record({ op: "layerRename", index: i, name: newName });
          app.history.push();
          l.name = newName;
          refreshLayers();
        }
      });

      row.appendChild(eye);
      row.appendChild(lock);
      row.appendChild(name);
      row.addEventListener("click", function () {
        if (i === app.project.cur.layer) return;
        flushSelections();
        app.record({ op: "layerSelect", index: i });
        app.project.selectLayer(i);
        app.debugPin = -1;
        refreshLayers();
        refreshDebugPanel();
        requestRender();
        updateStatus();
      });
      list.appendChild(row);
    });
  }

  document.getElementById("btn-layer-add").addEventListener("click", function () {
    flushSelections();
    app.record({ op: "layerAdd" });
    app.history.push();
    app.project.addLayer();
    refreshLayers();
    requestRender();
    updateStatus();
  });

  document.getElementById("btn-layer-del").addEventListener("click", function () {
    if (app.project.scene().layers.length <= 1) {
      toast("A scene keeps at least one layer");
      return;
    }
    flushSelections();
    var index = app.project.cur.layer;
    app.record({ op: "layerDelete", index: index });
    app.history.push();
    app.project.deleteLayer(index);
    docChanged();
  });

  function moveActiveLayer(delta) {
    var from = app.project.cur.layer;
    var to = from + delta;
    if (to < 0 || to >= app.project.scene().layers.length) return;
    app.record({ op: "layerMove", from: from, to: to });
    app.history.push();
    app.project.moveLayer(from, to);
    refreshLayers();
    requestRender();
  }
  document.getElementById("btn-layer-up").addEventListener("click", function () {
    moveActiveLayer(-1); // up in the panel = toward the top (index 0)
  });
  document.getElementById("btn-layer-down").addEventListener("click", function () {
    moveActiveLayer(1);
  });

  document.getElementById("scene-select").addEventListener("change", function () {
    var i = parseInt(this.value, 10);
    if (i === app.project.cur.scene) return;
    flushSelections();
    app.record({ op: "sceneSelect", index: i });
    app.project.selectScene(i);
    app.debugPin = -1;
    refreshLayers();
    refreshDebugPanel();
    requestRender();
    updateStatus();
  });

  document.getElementById("btn-scene-add").addEventListener("click", function () {
    flushSelections();
    app.record({ op: "sceneAdd" });
    app.history.push();
    app.project.addScene();
    refreshLayers();
    requestRender();
    updateStatus();
  });

  // Empty-space drags in the transform tool draw a fresh region band —
  // shaped like the selection tool the user came from.
  app.regionSelectStyle = function () {
    return returnTool === "lasso" ? "lasso" : "marquee";
  };

  // ---- boot ------------------------------------------------------------------------

  resizeCanvas();
  fitView();
  refreshLayers();

  // #demo: synthetic document with the debug view on — used by headless
  // screenshots and handy for demonstrating the record inspector.
  if (location.hash === "#demo") {
    var d = app.doc;
    d.fills.push(VB.solidFill(120, 200, 255));
    d.edges.push(
      VB.edge(2000, 1600, null, null, 8000, 1600, 0, 1, 0),
      VB.edge(8000, 1600, null, null, 8000, 6400, 0, 1, 0),
      VB.edge(8000, 6400, null, null, 2000, 6400, 0, 1, 0),
      VB.edge(2000, 6400, null, null, 2000, 1600, 0, 1, 0));
    var wavePts = [];
    for (var wv = 0; wv <= 60; wv++) {
      wavePts.push({ x: 400 + wv * 165, y: 4000 + Math.round(2400 * Math.sin(wv / 6)) });
    }
    VB.pencilCommit(d, wavePts, { width: 40, color: { r: 200, g: 40, b: 40, a: 255 } });
    // bucket-fill one of the faces the wave carved out of the square
    VB.bucketFill(d, 5000, 2200, { color: { r: 255, g: 214, b: 79, a: 255 } });
    // erase a swipe across fills, borders, and the pencil wave
    VB.eraseStroke(d, [
      { x: 2600, y: 1000 }, { x: 4200, y: 3200 }, { x: 6200, y: 4600 }, { x: 8600, y: 5400 }
    ], 260);
    // brush a stroke over fills, the erase channel, and the pencil wave
    VB.brushStroke(d, [
      { x: 1200, y: 5200 }, { x: 3200, y: 4400 }, { x: 5400, y: 3600 }, { x: 7600, y: 2400 }
    ], 180, { r: 204, g: 102, b: 102, a: 255 });
    toggleDebug();
    app.debugPin = Math.min(9, d.edges.length - 1);
    refreshDebugEdge();
    fitView();
  }

  // Expose for debugging / tests.
  window.VBApp = app;
  window.VBAppLoad = loadArrayBuffer;
})();
