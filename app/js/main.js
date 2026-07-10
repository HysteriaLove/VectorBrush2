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

  // The session owns the open project's live state (session.js): store,
  // journal, undo history, op dispatch. `app` is the GUI facade over
  // whichever session is BOUND — tools keep their `app.*` surface, the
  // shell (shell.js) binds a session per project and mounts/unmounts
  // the renderer around it.
  var app = {
    fileName: null,
    sourceBytes: 0,
    uiActive: true,           // false while the homescreen covers the editor
    tool: "select",
    view: { zoom: 1, panX: 40, panY: 40, dpr: window.devicePixelRatio || 1 },
    strokeColor: { r: 0, g: 0, b: 0, a: 255 },
    strokeWidth: 20,          // twips (1 px), Flash's default pencil width
    fillColor: { r: 102, g: 204, b: 255, a: 255 },
    fillMaterial: null,       // selected 2DMaterial — overrides fillColor
    eraserWidth: 20,          // eraser diameter, px
    brushWidth: 10,           // brush diameter, px
    debug: false,
    debugHover: -1,
    debugPin: -1,
    record: function (op) { app.session.record(op); },
    exec: function (op) { return app.session.exec(op); },
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
  app.session = new VB.Session({ width: 550 * VB.TWIPS, height: 400 * VB.TWIPS });

  Object.defineProperty(app, "history", {
    get: function () { return app.session.history; }
  });
  Object.defineProperty(app, "project", {
    get: function () { return app.session.project; },
    set: function (p) { app.session.project = p; }
  });
  Object.defineProperty(app, "journal", {
    get: function () { return app.session.journal; }
  });
  Object.defineProperty(app, "errors", {
    get: function () { return app.session.errors; }
  });

  // Every tool and the boolean core edit ONE planar map: the active
  // layer's frame cell. Assigning a bare document (file loads) wraps it
  // as a single-layer project.
  Object.defineProperty(app, "doc", {
    get: function () { return app.session.project.activeCell(); },
    set: function (d) { app.session.project = VB.wrapDoc(d); }
  });

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

  // ---- Pixi backend (docs/PixiPort.md) -------------------------------------------
  // THE document renderer: pixi draws everything drawing-related
  // (backdrop, stage, fills, strokes, materials, text) on a canvas
  // UNDER #stage-canvas; the Canvas2D overlay above keeps tool
  // overlays, debug decorations and pointer routing. Canvas2D remains
  // the tested oracle (app/test/pixi-parity.html) and the silent
  // fallback when WebGL is unavailable; ?canvas2d (or
  // localStorage.vbRenderer = "canvas2d") forces it.
  var pixiSurface = null;
  var pixiGen = 0; // guards against a create resolving after an unmount
  var canvas2dForced =
    /(^|[?&#])canvas2d(\b|=|$)/.test(location.search + location.hash) ||
    localStorage.getItem("vbRenderer") === "canvas2d";

  // The shell mounts the renderer when an editor route shows and
  // unmounts it on the homescreen — GPU surface and its AssetCache
  // claims live only while the Sketch section is visible.
  app.mountRenderer = function () {
    var gen = ++pixiGen;
    if (pixiSurface || canvas2dForced || !VB.createPixiSurface) {
      requestRender();
      return;
    }
    VB.createPixiSurface(canvas.parentElement, canvas).then(function (s) {
      if (!s) {
        setMsg("WebGL unavailable — Canvas2D renderer");
        requestRender();
        return;
      }
      if (gen !== pixiGen || pixiSurface) { s.destroy(); return; }
      pixiSurface = s;
      requestRender();
    });
  };
  app.unmountRenderer = function () {
    pixiGen++;
    if (pixiSurface) {
      pixiSurface.destroy(); // releases the surface's AssetCache claims
      pixiSurface = null;
    }
  };

  var renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      if (pixiSurface) {
        VB.renderProjectPixi(pixiSurface, app.project, app.view);
        VB.applyViewTransform(ctx, app.view); // overlays/debug only
      } else {
        VB.renderProject(ctx, app.project, app.view);
      }
      // onion skin: neighbor-frame ghosts of the active layer (roughs
      // workflow); skipped during playback and inside actor cells
      if (app.onion && !playback.playing && !app.project.editTarget) {
        var oLayer = app.project.activeLayer();
        var oFrame = app.project.cur.frame || 0;
        ctx.save();
        if (oFrame > 0 && oLayer.frames[oFrame - 1]) {
          ctx.globalAlpha = 0.3;
          VB.renderDocContent(ctx, oLayer.frames[oFrame - 1], app.view);
        }
        if (oLayer.frames[oFrame + 1]) {
          ctx.globalAlpha = 0.18;
          VB.renderDocContent(ctx, oLayer.frames[oFrame + 1], app.view);
        }
        ctx.restore();
      }
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
    refreshActors(); // …and the actor library / edit mode
    syncEditCrumb();
    refreshTimeline();
    refreshSequence();
    if (VB.BrainstormView) VB.BrainstormView.refresh(); // undo/redo on the board
    if (VB.WritingView) VB.WritingView.refresh();
    if (VB.PitchView) VB.PitchView.refresh();
    if (VB.BoardsView) VB.BoardsView.refresh();
    if (VB.AudioView) VB.AudioView.refresh();
    if (VB.CompositeView) VB.CompositeView.refresh(); // live 3D texture
    if (app.renderScratch) app.renderScratch(); // the shared scratchpad
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
    // the shell's autosave rides every mutation path (draw, undo, load)
    if (app.onDocChanged) app.onDocChanged();
  }

  function refreshDebugPanel() {
    if (!app.debug) return;
    document.getElementById("dbg-styles").innerHTML = VB.debugStylesPanelHTML(app.doc);
    document.getElementById("dbg-stream").innerHTML = VB.debugStreamPanelHTML(app.doc);
    renderEstimatePanel();
    refreshDebugEdge();
  }

  // ---- OperationEstimator debug hook -------------------------------------------
  // Every journaled op gets a deterministic PREFLIGHT profile in debug
  // mode (docs/OperationEstimator.md). The session's record hook runs
  // before the journal push on every path (tools record, then apply), so
  // the profile describes the document the op is about to act on.
  // Debug-only and side-effect free — replay never depends on it.
  function estimatorPreflight(op) {
    if (app.debug && VB.operationEstimate) {
      try {
        app.lastEstimate = VB.operationEstimate(
          { doc: app.doc, project: app.project }, op, { phase: "preflight" });
        updateEstimateBadge();
        renderEstimatePanel();
      } catch (err) {
        trapError("estimator: " + err.message, err.stack);
      }
    }
  }

  // Wires a session's hooks to this GUI. exec-applied ops refresh through
  // the session's changed hook, so future sections trigger it too.
  function wireSession(sess) {
    sess.onRecord = estimatorPreflight;
    sess.onChanged = function () { app.docChanged(); };
  }
  wireSession(app.session);

  /** The shell binds a different project's session; the editor rebinds
   *  every view of it (selections dropped, layers/debug refreshed). */
  app.bindSession = function (sess) {
    if (sess === app.session) return;
    app.session.onRecord = null;
    app.session.onChanged = null;
    app.session = sess;
    wireSession(sess);
    app.fileName = null;
    app.sourceBytes = 0;
    app.fillMaterial = null;
    matSelected = -1;   // material library is per-project
    refreshMaterials();
    docChanged();       // drops selections, refreshes layers/debug
    fitView();
    updateStatus();
  };

  function fmtScore(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(n);
  }

  function updateEstimateBadge() {
    var el = document.getElementById("status-est");
    var p = app.lastEstimate;
    if (!p || !app.debug) { el.textContent = ""; el.className = ""; return; }
    el.textContent = p.kind + ": " + fmtScore(p.totals.score) + " est" +
      (p.scope.candidateEdges ? " · " + p.scope.candidateEdges + " cand" : "") +
      " · " + p.level;
    el.className = "est-" + p.level;
    el.title = p.warnings.map(function (w) { return w.code; }).join(", ");
  }

  function renderEstimatePanel() {
    if (!app.debug) return;
    var el = document.getElementById("dbg-est");
    var p = app.lastEstimate;
    if (!p) { el.innerHTML = ""; return; }
    var h = '<div class="dim">op estimate — deterministic, ' +
      p.confidence + '</div>' +
      "<b>" + p.kind + "</b> score " + fmtScore(p.totals.score) +
      " (" + p.level + ")<br>" +
      "cpu " + fmtScore(p.totals.cpuUnits) +
      " · paint " + fmtScore(p.totals.paintPxOps) +
      (p.totals.gpuPasses ? " · gpu passes " + p.totals.gpuPasses : "") +
      (p.totals.textureBytes
        ? " · tex " + Math.round(p.totals.textureBytes / 1e6) + "MB" : "") +
      " · bits " + p.totals.recordBits +
      " · alloc " + p.totals.allocations + "<br>" +
      "edges " + p.scope.edgesBefore +
      " · candidates " + p.scope.candidateEdges +
      " · bbox " + p.scope.bboxMpx + "Mpx<br>";
    p.stages.forEach(function (s) {
      h += '<span class="dim">' + s.name + " · " + s.count + "×" + s.weight +
        " = " + fmtScore(s.score) + "</span><br>";
    });
    p.warnings.forEach(function (w) {
      h += "<b>⚠ " + w.code + "</b> " + w.text + "<br>";
    });
    el.innerHTML = h;
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
    if (pixiSurface) pixiSurface.resize();
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

  /** Select-tool drag of a placed instance (stepseq.js): topmost hit
   *  under the pointer takes the gesture — ghosted live, rewound, then
   *  ONE journaled instanceMove so undo lands on the pre-drag spot. */
  function instanceHitDrag(ev) {
    if (!VB.stepCellAt) return false;
    var scene = app.project.scenes[app.project.cur.scene];
    if (!scene || !scene.cast || !scene.cast.length) return false;
    var p = clientToTwips(ev);
    var frame = app.project.cur.frame || 0;
    var hit = null;
    for (var i = scene.cast.length - 1; i >= 0; i--) {
      var inst = scene.cast[i];
      var cell = VB.stepCellAt(app.project, scene, inst, frame);
      if (!cell) continue;
      var sc = inst.scale === undefined ? 1 : inst.scale;
      if (p.x >= inst.x && p.x <= inst.x + (cell.width || 0) * sc &&
          p.y >= inst.y && p.y <= inst.y + (cell.height || 0) * sc) {
        hit = inst;
        break;
      }
    }
    if (!hit) return false;
    canvas.setPointerCapture(ev.pointerId);
    var x0 = hit.x, y0 = hit.y, p0 = p;
    function onMove(e2) {
      var q = clientToTwips(e2);
      hit.x = Math.round(x0 + q.x - p0.x); // live ghost, no journal
      hit.y = Math.round(y0 + q.y - p0.y);
      requestRender();
    }
    function onUp() {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      var fx = hit.x, fy = hit.y;
      if (fx === x0 && fy === y0) return;
      hit.x = x0; hit.y = y0; // the op's history sees the pre-drag state
      app.exec({ op: "instanceMove", id: hit.id, x: fx, y: fy });
    }
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return true;
  }

  /** Drag a Library/Actors thumbnail onto the stage to PLACE an
   *  instance (a plain click keeps the row's own action). */
  function wirePlaceDrag(el, kind, refId, rowEl) {
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0) return;
      var started = false, ghost = null;
      el.setPointerCapture(ev.pointerId);
      var x0 = ev.clientX, y0 = ev.clientY;
      function onMove(e2) {
        if (!started &&
            Math.abs(e2.clientX - x0) + Math.abs(e2.clientY - y0) < 8) return;
        if (!started) {
          started = true;
          ghost = document.createElement("div");
          ghost.className = "placeghost";
          ghost.textContent = "＋ place";
          document.body.appendChild(ghost);
        }
        ghost.style.left = (e2.clientX + 12) + "px";
        ghost.style.top = (e2.clientY + 8) + "px";
      }
      function onUp(e2) {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        if (ghost) ghost.remove();
        if (!started) return; // plain click falls through to the row
        if (rowEl) { // a drag must not fire the row's click action
          var stop = function (ce) {
            ce.stopPropagation();
            ce.preventDefault();
          };
          rowEl.addEventListener("click", stop, true);
          setTimeout(function () {
            rowEl.removeEventListener("click", stop, true);
          }, 0);
        }
        var r = canvas.getBoundingClientRect();
        if (e2.clientX < r.left || e2.clientX > r.right ||
            e2.clientY < r.top || e2.clientY > r.bottom) return;
        if (app.project.editTarget) {
          setMsg("leave symbol edit to place instances");
          return;
        }
        var p = clientToTwips(e2);
        var sc = app.project.scenes[app.project.cur.scene];
        if (!sc || !sc.id) return;
        app.exec({ op: "instancePlace", id: VB.actorNewId("inst"),
                   scene: sc.id, ref: refId, kind: kind,
                   x: Math.round(p.x), y: Math.round(p.y) });
        setMsg("placed — select-tool drags move it; its rows are in the step grid");
      }
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    });
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
      if (VB.isY2KVector(bytes)) {
        result = await VB.decodeY2KVector(bytes);
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
  // the errors field. (The array itself lives on the session.)
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
      var bytes = await VB.encodeY2KVector(app.project, { compress: true });
      var base = app.fileName ? app.fileName.replace(/\.[^.]+$/, "") : "drawing";
      var blob = new Blob([bytes], { type: "application/octet-stream" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = base + ".y2kvector";
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
        toast("Note: " + textCount + " text block(s) are not " +
          "written to SWF — the .y2kvector save keeps them", 6000);
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
  app.doUndo = doUndo; // board workspaces drive undo through the app
  app.doRedo = doRedo;

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
      // placed INSTANCES (stepseq.js) grab before the planar tools:
      // with the select tool, pressing inside an instance's bounds
      // drags it — ghosted live, ONE journaled instanceMove on release
      if (app.tool === "select" && !app.project.editTarget &&
          instanceHitDrag(ev)) {
        ev.preventDefault();
        return;
      }
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
    if (!app.uiActive) return; // homescreen showing — editor keys off
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
    // timeline: Enter plays/stops the scene loop, Shift+Enter the whole
    // sequence, , / . step frames, F7 adds a frame
    if (ev.key === "Enter" && !ev.ctrlKey && !ev.altKey) {
      if (ev.shiftKey) {
        if (seqPlay.playing) stopSeqPlay(); else startSeqPlay();
      } else if (playback.playing) {
        stopPlay();
      } else {
        startPlay();
      }
      return;
    }
    if (ev.key === "." && !ev.ctrlKey) {
      stopPlay();
      app.exec({ op: "frameSelect", index: app.project.cur.frame + 1 });
      return;
    }
    if (ev.key === "," && !ev.ctrlKey) {
      stopPlay();
      app.exec({ op: "frameSelect", index: app.project.cur.frame - 1 });
      return;
    }
    if (ev.key === "F7") {
      ev.preventDefault();
      stopPlay();
      app.exec({ op: "frameAdd", layer: app.project.cur.layer });
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
    // picking a plain color returns the brush to solid painting
    if (app.fillMaterial) {
      app.fillMaterial = null;
      matSelected = -1;
      refreshMaterials();
    }
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

  /** The current selection as a self-contained clip (shape selections
   *  only) — what "Convert to Symbol" consumes. */
  app.currentSelectionClip = function () {
    var src = selectionSource();
    var payload = src.copySelection ? src.copySelection() : null;
    return payload && payload.kind === "shape" ? payload.clip : null;
  };

  app.deleteSelection = function () { return deleteSelection(); };

  /** Right-click → the library (library.js): the selection's clip
   *  materializes into a global symbol; the art stays in place. */
  app.convertSelectionToSymbol = function () {
    var clip = app.currentSelectionClip();
    if (!clip) { setMsg("select something first (marquee / lasso)"); return; }
    app.exec({ op: "symbolCreate", id: VB.actorNewId("sym"), clip: clip });
    setMsg("symbol added to the library");
  };

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
    // The previous selection must END before the clip lands: commit any
    // pending transform session and floating selection exactly like a
    // click-away, then deselect. Pasting into a live session would
    // inject the new content into the OLD transform state — and the
    // exec below would discard the session's un-journaled lift.
    if (tools.transform && tools.transform.adopt) tools.transform.adopt(null);
    if (tools.select.commitFloat) tools.select.commitFloat();
    if (tools.select.clearSelection) tools.select.clearSelection();
    pasteBump += 200;
    if (clipboard.kind === "shape") {
      // the pasted clip becomes an UNCOMMITTED floating object: the
      // document is untouched while the user places it; click-away
      // lands ONE paste op at the final position. It is never merged
      // and re-selected — a bbox re-selection would steal underlying
      // content on the first drag (user bug report).
      selectTool("transform");
      if (!tools.transform.adoptClip(
            JSON.parse(JSON.stringify(clipboard.clip)),
            [1, 0, 0, 1, pasteBump, pasteBump])) {
        setMsg("clipboard clip is empty");
        return false;
      }
      setMsg("pasted — drag to place, click away to commit");
      return true;
    }
    // text: one textCreate per part (a single part for app-authored
    // blocks; imported multi-font blocks paste as sibling blocks).
    // Text blocks are objects — creating one carves nothing — so the
    // new block lands and opens as a transform session for placing.
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
      selectTool("transform"); // handoff adopts the block as a session
    }
    setMsg("text pasted — drag to place");
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
    refreshMaterials();
  }

  // ---- 2DMaterials panel --------------------------------------------------------
  // Every fill style of the active cell, each with its deterministic
  // cost badge (docs/2DMaterials.md). Edits land as ONE registered
  // fillStyle op through app.exec.
  var matSelected = -1;

  function matSwatchCSS(style) {
    if (style.type === "linear" || style.type === "radial") {
      var st = style.gradient.stops;
      var a = st.length ? st[0].color : { r: 128, g: 128, b: 128, a: 255 };
      var b = st.length ? st[st.length - 1].color : a;
      return "linear-gradient(90deg, rgba(" + a.r + "," + a.g + "," + a.b + "," +
        (a.a / 255) + "), rgba(" + b.r + "," + b.g + "," + b.b + "," + (b.a / 255) + "))";
    }
    var c = VB.materialBaseColor(style);
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + (c.a / 255) + ")";
  }

  /** The active drawing paint: selecting a library material makes it
   *  THE drawing color for brush/bucket/shape fills; picking a plain
   *  color in the toolbar returns to solid. */
  function syncFillMaterial() {
    var mats = app.project.materials || [];
    var style = matSelected >= 0 ? mats[matSelected] : null;
    if (style && style.type !== "solid") {
      app.fillMaterial = VB.materialClone(style);
      // the toolbar swatch mirrors the material's base color so tool
      // previews read right
      var base = VB.materialBaseColor(style);
      app.fillColor = { r: base.r, g: base.g, b: base.b, a: base.a };
      var sw = document.getElementById("fill-color");
      if (sw) sw.value = colorToHex(base);
    } else if (style && style.type === "solid") {
      app.fillMaterial = null;
      app.fillColor = { r: style.color.r, g: style.color.g,
                       b: style.color.b, a: style.color.a };
      var sw2 = document.getElementById("fill-color");
      if (sw2) sw2.value = colorToHex(style.color);
    } else {
      app.fillMaterial = null;
    }
  }

  // The panel lists the GLOBAL library (project.materials) — the same
  // materials on every layer and scene, Flash-library style.
  function refreshMaterials() {
    var list = document.getElementById("matlist");
    list.innerHTML = "";
    document.getElementById("mat-gpu").textContent =
      VB.gpuMaterialsAvailable() ? "GPU ✓" : "no GPU";
    var mats = app.project.materials || [];
    if (matSelected >= mats.length) matSelected = -1;
    syncFillMaterial();
    mats.forEach(function (f, i) {
      var profile = VB.materialProfile(f);
      var row = document.createElement("div");
      row.className = "matrow2" + (i === matSelected ? " active" : "");
      var sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = matSwatchCSS(f);
      var nm = document.createElement("span");
      nm.className = "mname";
      nm.textContent = (i + 1) + " · " + f.type;
      var badge = document.createElement("span");
      badge.className = "badge" + (profile.gpu ? " gpu" : "");
      badge.textContent = profile.label;
      badge.title = profile.passes.map(function (p) {
        return p.name + ": " + p.perPx + " ops/px";
      }).join("\n");
      row.appendChild(sw); row.appendChild(nm); row.appendChild(badge);
      row.addEventListener("click", function () {
        matSelected = i === matSelected ? -1 : i;
        refreshMaterials();
      });
      list.appendChild(row);
    });

    // De-facto materials (user directive): every color with an
    // APPEARANCE on this canvas is a material — each fill style an edge
    // claims (bucket) and each line style an edge carries (line) lists
    // here whether or not it was crafted into the library. Clicking one
    // adopts it as the current bucket/pencil style.
    var doc = app.doc;
    var usedFills = [], usedLines = [];
    doc.edges.forEach(function (e) {
      if (e.fill0 > 0 && usedFills.indexOf(e.fill0) < 0) usedFills.push(e.fill0);
      if (e.fill1 > 0 && usedFills.indexOf(e.fill1) < 0) usedFills.push(e.fill1);
      if (e.line > 0 && usedLines.indexOf(e.line) < 0) usedLines.push(e.line);
    });
    usedFills.sort(function (a, b) { return a - b; });
    usedLines.sort(function (a, b) { return a - b; });
    function inLibrary(style) {
      var j = JSON.stringify(style);
      return mats.some(function (m) { return JSON.stringify(m) === j; });
    }
    function colorEq(a, b) {
      return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
    }
    var derivedRows = [];
    usedFills.forEach(function (fi) {
      var style = doc.fills[fi - 1];
      if (style && !inLibrary(style)) derivedRows.push({ kind: "bucket", style: style });
    });
    usedLines.forEach(function (li) {
      var ls = doc.lines[li - 1];
      if (ls) derivedRows.push({ kind: "line", style: ls });
    });
    if (derivedRows.length) {
      var divider = document.createElement("div");
      divider.className = "matdivider";
      divider.textContent = "on canvas";
      list.appendChild(divider);
    }
    derivedRows.forEach(function (d) {
      var row = document.createElement("div");
      var active;
      if (d.kind === "line") {
        active = colorEq(app.strokeColor, d.style.color) &&
                 app.strokeWidth === d.style.width;
      } else if (d.style.type === "solid") {
        active = !app.fillMaterial && colorEq(app.fillColor, d.style.color);
      } else {
        active = !!app.fillMaterial &&
          JSON.stringify(app.fillMaterial) === JSON.stringify(d.style);
      }
      row.className = "matrow2" + (active ? " active" : "");
      var sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = d.kind === "line"
        ? VB.colorToCSS(d.style.color) : matSwatchCSS(d.style);
      var nm = document.createElement("span");
      nm.className = "mname";
      nm.textContent = d.kind === "line"
        ? colorToHex(d.style.color) + " · " + (d.style.width / VB.TWIPS) + "px"
        : (d.style.type === "solid" ? colorToHex(d.style.color) : d.style.type);
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = d.kind;
      row.appendChild(sw); row.appendChild(nm); row.appendChild(badge);
      row.addEventListener("click", function () {
        if (d.kind === "line") {
          app.strokeColor = JSON.parse(JSON.stringify(d.style.color));
          app.strokeWidth = d.style.width;
          colorInput.value = colorToHex(d.style.color);
          widthInput.value = String(d.style.width / VB.TWIPS);
          setMsg("line material is now the pencil style");
        } else if (d.style.type === "solid") {
          matSelected = -1;
          app.fillMaterial = null;
          app.fillColor = JSON.parse(JSON.stringify(d.style.color));
          fillInput.value = colorToHex(d.style.color);
          setMsg("bucket material is now the fill color");
        } else {
          matSelected = -1;
          app.fillMaterial = VB.materialClone(d.style);
          setMsg("material is now the drawing color");
        }
        refreshMaterials();
      });
      list.appendChild(row);
    });
    syncMatEditor();
  }

  document.getElementById("btn-mat-add").addEventListener("click", function () {
    var style = VB.materialDefaults("linear");
    var sc = Math.max(app.doc.width, app.doc.height) / (2 * VB.GRAD_HALF);
    style.matrix = { sx: sc, sy: sc, r0: 0, r1: 0,
                     tx: app.doc.width / 2, ty: app.doc.height / 2 };
    app.exec({ op: "materialAdd", style: style });
    matSelected = (app.project.materials || []).length - 1;
    refreshMaterials();
    setMsg("material added — it is now the drawing color");
  });

  function hexToColor(hex, a) {
    return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16),
             b: parseInt(hex.slice(5, 7), 16), a: a === undefined ? 255 : a };
  }
  function colorToHex(c) {
    function h(v) { return ("0" + v.toString(16)).slice(-2); }
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }

  function syncMatEditor() {
    var ed = document.getElementById("matedit");
    var mats = app.project.materials || [];
    var style = matSelected >= 0 ? mats[matSelected] : null;
    ed.classList.toggle("hidden", !style);
    if (!style) return;
    var typeSel = document.getElementById("mat-type");
    if (!typeSel.options.length) {
      VB.materialTypes().forEach(function (t) {
        var o = document.createElement("option");
        o.value = t; o.textContent = t;
        typeSel.appendChild(o);
      });
    }
    typeSel.value = VB.materialTypes().indexOf(style.type) >= 0 ? style.type : "solid";
    document.getElementById("mat-color-row").classList.toggle(
      "hidden", !(style.type === "solid" || style.type === "matcap"));
    document.getElementById("mat-grad-row").classList.toggle(
      "hidden", !(style.type === "linear" || style.type === "radial"));
    document.getElementById("mat-matcap-row").classList.toggle(
      "hidden", style.type !== "matcap");
    document.getElementById("mat-matcap-tex-row").classList.toggle(
      "hidden", style.type !== "matcap");
    document.getElementById("mat-debug-row").classList.toggle(
      "hidden", style.type !== "matcap");
    if (style.color) document.getElementById("mat-color").value = colorToHex(style.color);
    if (style.gradient && style.gradient.stops.length) {
      var st = style.gradient.stops;
      document.getElementById("mat-grad-a").value = colorToHex(st[0].color);
      document.getElementById("mat-grad-b").value = colorToHex(st[st.length - 1].color);
      var m = style.matrix || { sx: 1, r0: 0 };
      document.getElementById("mat-grad-angle").value =
        Math.round(Math.atan2(m.r0, m.sx) * 180 / Math.PI);
    }
    if (style.type === "matcap") {
      document.getElementById("mat-bump").value = style.bumpScale;
      document.getElementById("mat-blur").value = style.blurPx;
      document.getElementById("mat-res").value = String(style.resolution);
      var msel = document.getElementById("mat-matcap-sel");
      if (!msel.options.length) {
        VB.matcapBuiltins.forEach(function (n) {
          var o = document.createElement("option");
          o.value = n; o.textContent = n;
          msel.appendChild(o);
        });
        var oc = document.createElement("option");
        oc.value = "__custom"; oc.textContent = "custom image";
        msel.appendChild(oc);
      }
      msel.value = typeof style.matcap === "string" ? style.matcap : "__custom";
      renderMatcapDebugViews(style);
    }
    var profile = VB.materialProfile(style);
    document.getElementById("mat-profile").textContent =
      profile.label + (profile.gpu && !VB.gpuMaterialsAvailable()
        ? " — no WebGPU here: renders base color" : "") + "\n" +
      profile.passes.map(function (p) {
        return "  " + p.name + " · " + p.perPx + " ops/px";
      }).join("\n") +
      (profile.texBytesPerMpx
        ? "\n  buffers · " + (profile.texBytesPerMpx / 1e6).toFixed(1) + " MB/Mpx" : "");
  }

  /** Rebuild the selected library material from the editor state and
   *  land it as ONE materialEdit op (updates every use, all layers). */
  function applyMatEdit() {
    var mats = app.project.materials || [];
    if (matSelected < 0 || matSelected >= mats.length) return;
    var old = mats[matSelected];
    var type = document.getElementById("mat-type").value;
    var style;
    if (type === old.type) style = VB.materialClone(old);
    else {
      style = VB.materialDefaults(type);
      // keep the artist's color across type switches
      var base = VB.materialBaseColor(old);
      if (style.color) style.color = base;
      if (style.gradient) style.gradient.stops[1].color = base;
      if (type === "linear" || type === "radial") {
        // default matrix: gradient square spans the stage, centered
        var sc = Math.max(app.doc.width, app.doc.height) / (2 * VB.GRAD_HALF);
        style.matrix = { sx: sc, sy: sc, r0: 0, r1: 0,
                         tx: app.doc.width / 2, ty: app.doc.height / 2 };
      }
    }
    if (style.type === "solid" || style.type === "matcap") {
      style.color = hexToColor(document.getElementById("mat-color").value,
                               (style.color || {}).a);
    }
    if (style.type === "linear" || style.type === "radial") {
      var st = style.gradient.stops;
      st[0].color = hexToColor(document.getElementById("mat-grad-a").value, st[0].color.a);
      st[st.length - 1].color = hexToColor(document.getElementById("mat-grad-b").value,
                                           st[st.length - 1].color.a);
      var deg = parseFloat(document.getElementById("mat-grad-angle").value) || 0;
      var rad = deg * Math.PI / 180;
      var m0 = style.matrix || { sx: 1, sy: 1, r0: 0, r1: 0,
                                 tx: app.doc.width / 2, ty: app.doc.height / 2 };
      var s0 = Math.hypot(m0.sx, m0.r0) ||
               Math.max(app.doc.width, app.doc.height) / (2 * VB.GRAD_HALF);
      style.matrix = { sx: Math.cos(rad) * s0, r0: Math.sin(rad) * s0,
                       r1: -Math.sin(rad) * s0, sy: Math.cos(rad) * s0,
                       tx: m0.tx, ty: m0.ty };
    }
    if (style.type === "matcap") {
      style.bumpScale = Math.max(0, parseFloat(document.getElementById("mat-bump").value) || 0);
      style.blurPx = Math.max(0, parseFloat(document.getElementById("mat-blur").value) || 0);
      style.resolution = parseFloat(document.getElementById("mat-res").value) || 1;
      var pick = document.getElementById("mat-matcap-sel").value;
      if (pick && pick !== "__custom") style.matcap = pick;
      else if (typeof style.matcap !== "object") style.matcap = old.matcap || "studio";
      if (!style.matcap) style.matcap = "studio";
    }
    var keep = matSelected; // docChanged rebuilds the panel
    app.exec({ op: "materialEdit", index: keep, style: style });
    matSelected = keep;
    refreshMaterials();
  }

  ["mat-type", "mat-color", "mat-grad-a", "mat-grad-b", "mat-grad-angle",
   "mat-bump", "mat-blur", "mat-res", "mat-matcap-sel"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", applyMatEdit);
  });

  // custom matcap image: embedded as PNG bytes in the style, so
  // documents and journals stay self-contained
  document.getElementById("mat-matcap-load").addEventListener("click", function () {
    document.getElementById("mat-matcap-file").click();
  });
  document.getElementById("mat-matcap-file").addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    var mats = app.project.materials || [];
    if (!file || matSelected < 0 || matSelected >= mats.length) return;
    var reader = new FileReader();
    reader.onload = function () {
      var b64 = String(reader.result).split(",")[1] || "";
      // the GLOBAL library entry (this handler predated the library
      // rework and read the cell fill table — the silent no-op bug)
      var style = VB.materialClone(mats[matSelected]);
      if (style.type !== "matcap") return;
      style.matcap = { b64: b64 };
      var keep = matSelected;
      app.exec({ op: "materialEdit", index: keep, style: style });
      matSelected = keep;
      refreshMaterials();
      setMsg("matcap image embedded in the material");
    };
    reader.readAsDataURL(file);
  });

  /** The matcap pipeline debug views: the region's BUMP MAP (height
   *  field), the derived NORMAL MAP, and the shaded result, computed
   *  by the same CPU pipeline the renderer uses (thumbnail-capped).
   *  Shows the material's first real use in the ACTIVE layer; unused
   *  library materials preview on a synthetic swatch region. */
  function matcapPreviewTarget(style) {
    var key = JSON.stringify(style);
    for (var i = 0; i < app.doc.fills.length; i++) {
      if (JSON.stringify(app.doc.fills[i]) === key) {
        return { doc: app.doc, fillIdx: i + 1 };
      }
    }
    var d = new VB.Y2KVectorDocument();
    d.width = 3000; d.height = 2200;
    d.fills.push(VB.materialClone(style));
    d.edges.push(
      VB.edge(400, 1100, 400, 300, 1500, 300, 0, 1, 0),
      VB.edge(1500, 300, 2600, 300, 2600, 1100, 0, 1, 0),
      VB.edge(2600, 1100, 2600, 1900, 1500, 1900, 0, 1, 0),
      VB.edge(1500, 1900, 400, 1900, 400, 1100, 0, 1, 0));
    return { doc: d, fillIdx: 1 };
  }

  function renderMatcapDebugViews(style) {
    var ids = ["mat-dbg-bump", "mat-dbg-normal", "mat-dbg-result"];
    var kinds = ["bump", "normal", "result"];
    var buffers = null;
    try {
      var target = matcapPreviewTarget(style);
      buffers = VB.matcapBuffers(target.doc, target.fillIdx, style, 84);
    } catch (err) { /* corrupt region: leave the views blank */ }
    for (var i = 0; i < 3; i++) {
      var cv = document.getElementById(ids[i]);
      var cx = cv.getContext("2d");
      cx.clearRect(0, 0, cv.width, cv.height);
      if (!buffers) continue;
      var dbg = VB.matcapDebugCanvas(buffers, kinds[i], style);
      var s = Math.min(cv.width / dbg.width, cv.height / dbg.height);
      cx.imageSmoothingEnabled = false;
      cx.drawImage(dbg, (cv.width - dbg.width * s) / 2,
                   (cv.height - dbg.height * s) / 2,
                   dbg.width * s, dbg.height * s);
    }
  }

  // embedded matcap textures decode async: repaint when pixels arrive
  VB.onMatcapReady = function () {
    requestRender();
    refreshMaterials();
  };

  // ---- y2kshell wiring (Phase A — the unified workspace frame) ------------------
  // The engine (y2kshell.js) owns the geometry; this block binds it to
  // the DOM: rack columns of movable modules replacing the old fixed
  // side panel, and collapsible drawers around the properties bar and
  // the sequencing stack. Shell state persists per user — never in the
  // journal.
  (function () {
    var S = VB.Y2KShell;
    var state = S.restore(localStorage.getItem("vb-y2kshell") || "");
    var MOD_H = { layers: 320, materials: 380, library: 340 };
    var racks = {
      left: document.getElementById("rack-left"),
      right: document.getElementById("rack-right")
    };
    var moduleDom = {};
    document.querySelectorAll(".y2kmod").forEach(function (el) {
      moduleDom[el.dataset.mod] = el;
    });
    // reconcile persisted state with the modules that actually exist
    ["left", "right"].forEach(function (side) {
      state.racks[side].modules = state.racks[side].modules.filter(
        function (m) { return !!moduleDom[m.id]; });
    });
    Object.keys(moduleDom).forEach(function (id) {
      if (!S.moduleById(state, id)) {
        S.addModule(state, "right", { id: id, h: MOD_H[id] || 300 });
      } else {
        S.moduleById(state, id).mod.h = MOD_H[id] || 300;
      }
    });

    function persist() {
      try { localStorage.setItem("vb-y2kshell", S.serialize(state)); }
      catch (e) { /* storage may be unavailable */ }
    }

    function applyShell() {
      S.packRack(state, "left");   // panels always group together
      S.packRack(state, "right");  // (user decision — no free positions)
      ["left", "right"].forEach(function (side) {
        var el = racks[side];
        if (!el) return;
        var rack = state.racks[side];
        var closed = !rack.open; // empty racks stay visible (drop targets)
        el.classList.toggle("closed", closed);
        el.classList.toggle("bare", rack.modules.length === 0);
        el.classList.remove("empty");
        el.style.width = (rack.width || S.RACK_DEFAULT) + "px";
        var reveal = document.querySelector(
          '.y2krackreveal[data-side="' + side + '"]');
        if (reveal) reveal.classList.toggle("show", closed);
        S.clampRackScroll(state, side, el.clientHeight || 600);
        rack.modules.forEach(function (m) {
          var dom = moduleDom[m.id];
          if (!dom) return;
          if (dom.parentElement !== el) el.appendChild(dom);
          dom.style.top = Math.round(m.y - rack.scroll) + "px";
          dom.style.height = S.moduleHeight(m) + "px";
          dom.classList.toggle("collapsed", !m.expanded);
        });
      });
      // the DOCKS: fixed [drawer + toolbar] units — the toolbars are
      // the drawer faces and slide with the pull, over the canvas
      var wsbar = document.getElementById("workspacebar");
      var sbar = document.getElementById("statusbar");
      var topdock = document.getElementById("topdock");
      var botdock = document.getElementById("botdock");
      if (topdock) {
        topdock.style.top = (wsbar ? wsbar.offsetHeight : 32) + "px";
      }
      if (botdock) {
        botdock.style.bottom = (sbar ? sbar.offsetHeight : 24) + "px";
      }
      ["top", "bottom"].forEach(function (which) {
        var drawer = document.getElementById("drawer-" + which);
        if (!drawer) return;
        var d = state.drawers[which];
        drawer.style.height =
          (d.open ? Math.max(0, d.h | 0) : 0) + "px";
      });
      // the resting faces keep their footprint in the layout — up top
      // that's just the slim scratchpad pull (the toolbar strip became
      // the floating islands)
      var dsTop = document.getElementById("dockspace-top");
      var th = document.getElementById("tophandle");
      if (dsTop && th) dsTop.style.height = th.offsetHeight + "px";
      var dsBot = document.getElementById("dockspace-bottom");
      var xb = document.getElementById("xbar-bottom");
      if (dsBot && xb) dsBot.style.height = xb.offsetHeight + "px";
      layoutFloats();
      persist();
    }

    // module tab: click toggles; drag chooses an INSERTION SLOT (the
    // packed stack closes up around it) — crossing the canvas midline
    // drops the module into the other rack
    Object.keys(moduleDom).forEach(function (id) {
      var tab = moduleDom[id].querySelector(".y2kmodtab");
      tab.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        tab.setPointerCapture(ev.pointerId);
        var p0 = { x: ev.clientX, y: ev.clientY };
        var moved = false;
        function onMove(e2) {
          if (!moved && Math.abs(e2.clientY - p0.y) < 5 &&
              Math.abs(e2.clientX - p0.x) < 5) return;
          moved = true;
          moduleDom[id].classList.add("dragging");
          var midX = window.innerWidth / 2;
          var side = e2.clientX < midX ? "left" : "right";
          var host = racks[side];
          if (!host) return;
          if (!state.racks[side].open &&
              state.racks[side].modules.length === 0) {
            state.racks[side].open = true; // dropping opens an empty rack
          }
          var r = host.getBoundingClientRect();
          var contentY = e2.clientY - r.top + state.racks[side].scroll;
          // slot over the stack WITHOUT the dragged module
          var others = state.racks[side].modules.filter(function (m) {
            return m.id !== id;
          });
          var acc = 0, idx = others.length;
          for (var i = 0; i < others.length; i++) {
            var h = S.moduleHeight(others[i]);
            if (contentY < acc + h / 2) { idx = i; break; }
            acc += h;
          }
          var cur = S.moduleById(state, id);
          var curIdx = cur.side === side ? cur.index : -1;
          if (cur.side !== side || idx !== curIdx) {
            S.reorderModule(state, id, side, idx);
            applyShell();
          }
        }
        function onUp() {
          tab.removeEventListener("pointermove", onMove);
          tab.removeEventListener("pointerup", onUp);
          tab.removeEventListener("pointercancel", onUp);
          moduleDom[id].classList.remove("dragging");
          if (!moved) S.toggleModule(state, id); // click: collapse/expand
          applyShell();
        }
        tab.addEventListener("pointermove", onMove);
        tab.addEventListener("pointerup", onUp);
        tab.addEventListener("pointercancel", onUp);
      });
    });

    // closed racks reopen by DRAGGING from their screen edge — an
    // invisible hot zone, no pillars or buttons (user spec); a plain
    // click still opens to the remembered width as a courtesy
    document.querySelectorAll(".y2krackreveal").forEach(function (strip) {
      var side = strip.dataset.side;
      strip.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        strip.setPointerCapture(ev.pointerId);
        var x0 = ev.clientX, moved = false;
        function onMove(e2) {
          var dx = side === "left" ? e2.clientX - x0 : x0 - e2.clientX;
          if (!moved && Math.abs(dx) < 3) return;
          moved = true;
          var mid = document.getElementById("middle");
          S.setRackWidth(state, side, dx,
                         mid ? mid.clientWidth : undefined);
          applyShell();
          requestRender();
        }
        function onUp() {
          strip.removeEventListener("pointermove", onMove);
          strip.removeEventListener("pointerup", onUp);
          strip.removeEventListener("pointercancel", onUp);
          if (!moved) { // click: open where it last was
            state.racks[side].open = true;
            applyShell();
          }
          requestRender();
          persist();
        }
        strip.addEventListener("pointermove", onMove);
        strip.addEventListener("pointerup", onUp);
        strip.addEventListener("pointercancel", onUp);
      });
    });

    // the toolbars PULL their drawers (user spec) — CONTINUOUSLY: the
    // drawer follows the drag and stays wherever it is released.
    // Panels, buttons, and inputs keep their own gestures.
    function wireDrawerPull(barEl, which, openDir) {
      if (!barEl) return;
      barEl.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        var t = ev.target;
        if (t !== barEl && !(t.classList &&
            t.classList.contains("spacer"))) return;
        barEl.setPointerCapture(ev.pointerId);
        var d = state.drawers[which];
        var y0 = ev.clientY;
        var h0 = d.open ? (d.h | 0) : 0;
        function onMove(e2) {
          // SMOOTH follow — the only snap is the ~4px close zone
          var h = Math.max(0, Math.min(
            Math.round(window.innerHeight * 0.7),
            h0 + (e2.clientY - y0) * openDir));
          d.open = h > S.SNAP_SHUT;
          if (d.open) d.h = h;
          applyShell();
          if (which === "top") renderScratch();
          else { renderSeqStrip(); refreshTimeline(); }
        }
        function onUp() {
          barEl.removeEventListener("pointermove", onMove);
          barEl.removeEventListener("pointerup", onUp);
          barEl.removeEventListener("pointercancel", onUp);
          requestRender();
        }
        barEl.addEventListener("pointermove", onMove);
        barEl.addEventListener("pointerup", onUp);
        barEl.addEventListener("pointercancel", onUp);
      });
    }
    wireDrawerPull(document.getElementById("tophandle"), "top", 1);
    wireDrawerPull(document.getElementById("xbar-bottom"), "bottom", -1);

    // the step sequencer keeps its OWN view: wheel zooms its cells
    // (the scene timeline zooms independently inside its strip)
    var stepGridEl = document.getElementById("step-grid");
    if (stepGridEl) {
      stepGridEl.addEventListener("wheel", function (ev) {
        ev.preventDefault();
        var factor = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
        state.step.cellW = Math.max(6, Math.min(40,
          Math.round(state.step.cellW * factor)));
        persist();
        refreshTimeline();
      }, { passive: false });
    }
    app.shellState = state; // the timeline views read step.cellW

    // ---- the shared scratchpad --------------------------------------------------
    // The drawer is another VIEW of the Sketchbook's shared vector cell
    // (project.notesCanvas(), journaled editTarget {notes:true}): visible
    // from EVERY workspace, drawn with the real tools, byte-exact in
    // replay, and the Sketchbook board shows the same ink.
    var scratch = {
      canvas: document.getElementById("scratch-canvas"),
      btn: document.getElementById("scratch-draw"),
      pan: { x: 40, y: 30 }, zoom: 1
    };
    function scratchDrawing() {
      var t = app.project.editTarget;
      return !!(t && t.notes);
    }
    function renderScratch() {
      var cvs = scratch.canvas;
      if (!cvs || !state.drawers.top.open) return;
      var w = cvs.clientWidth, h = cvs.clientHeight;
      if (!w || !h) return;
      if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
      var ctx = cvs.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var s = scratch.zoom / VB.TWIPS;
      ctx.setTransform(s, 0, 0, s, scratch.pan.x, scratch.pan.y);
      var cell = app.project.notes && app.project.notes.canvas;
      if (cell) VB.renderDocContent(ctx, cell, { zoom: scratch.zoom, dpr: 1 });
      if (scratchDrawing()) {
        var tool = app.toolByName(app.tool);
        if (tool && tool.drawOverlay) {
          try { tool.drawOverlay(ctx); } catch (e) { /* overlay only */ }
        }
      }
      if (scratch.btn) {
        scratch.btn.classList.toggle("active", scratchDrawing());
      }
    }
    app.renderScratch = renderScratch; // docChanged repaints the drawer
    function scratchTwips(ev) {
      var r = scratch.canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - r.left - scratch.pan.x) / scratch.zoom * VB.TWIPS,
        y: (ev.clientY - r.top - scratch.pan.y) / scratch.zoom * VB.TWIPS
      };
    }
    if (scratch.btn) {
      scratch.btn.addEventListener("click", function () {
        if (scratchDrawing()) app.exec({ op: "editTargetClear" });
        else app.exec({ op: "editTargetSet", target: { notes: true } });
        renderScratch();
      });
    }
    if (scratch.canvas) {
      var sDrag = null;
      scratch.canvas.addEventListener("pointerdown", function (ev) {
        scratch.canvas.setPointerCapture(ev.pointerId);
        if (ev.button === 1) {
          ev.preventDefault();
          sDrag = { kind: "pan", x0: ev.clientX, y0: ev.clientY,
                    p0: { x: scratch.pan.x, y: scratch.pan.y } };
          return;
        }
        if (ev.button !== 0 || !scratchDrawing()) return;
        var tool = app.toolByName(app.tool);
        if (tool && tool.onDown) {
          tool.onDown(scratchTwips(ev));
          renderScratch();
        }
        sDrag = { kind: "tool" };
      });
      scratch.canvas.addEventListener("pointermove", function (ev) {
        if (!sDrag) return;
        if (sDrag.kind === "pan") {
          scratch.pan.x = sDrag.p0.x + ev.clientX - sDrag.x0;
          scratch.pan.y = sDrag.p0.y + ev.clientY - sDrag.y0;
          renderScratch();
          return;
        }
        var tool = app.toolByName(app.tool);
        if (tool && tool.onMove) {
          tool.onMove(scratchTwips(ev));
          renderScratch();
        }
      });
      scratch.canvas.addEventListener("pointerup", function (ev) {
        if (!sDrag) return;
        if (sDrag.kind === "tool") {
          var tool = app.toolByName(app.tool);
          if (tool && tool.onUp) tool.onUp(scratchTwips(ev));
        }
        sDrag = null;
        renderScratch();
      });
      scratch.canvas.addEventListener("pointercancel", function () {
        sDrag = null;
      });
      scratch.canvas.addEventListener("wheel", function (ev) {
        ev.preventDefault();
        var r = scratch.canvas.getBoundingClientRect();
        var mx = ev.clientX - r.left, my = ev.clientY - r.top;
        var factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
        var z = Math.max(0.1, Math.min(8, scratch.zoom * factor));
        scratch.pan.x = mx - (mx - scratch.pan.x) * (z / scratch.zoom);
        scratch.pan.y = my - (my - scratch.pan.y) * (z / scratch.zoom);
        scratch.zoom = z;
        renderScratch();
      }, { passive: false });
      if (window.ResizeObserver) {
        new ResizeObserver(function () { renderScratch(); })
          .observe(scratch.canvas);
      }
    }

    // xToolbars: panels group left-to-right; drag the ⠿ grip to
    // rearrange, wheel scrolls an overflowing strip sideways
    function wireXbar(key, barEl) {
      if (!barEl) return;
      if (!state.toolbars[key]) {
        state.toolbars[key] = { scroll: 0, panels: [], order: [] };
      }
      var spacer = barEl.querySelector(".spacer");
      function panels() {
        return Array.prototype.slice.call(
          barEl.querySelectorAll(".y2kxpanel"));
      }
      // apply the persisted order
      (state.toolbars[key].order || []).forEach(function (pid) {
        var el = panels().filter(function (p) {
          return p.dataset.panel === pid;
        })[0];
        if (el) barEl.insertBefore(el, spacer);
      });
      function persistOrder() {
        state.toolbars[key].order = panels().map(function (p) {
          return p.dataset.panel;
        });
        persist();
      }
      panels().forEach(function (el) {
        if (el.dataset.xwired) return; // re-wiring after late panels
        el.dataset.xwired = "1";
        var grip = el.querySelector(".y2kxgrip");
        if (!grip) return;
        grip.addEventListener("pointerdown", function (ev) {
          if (ev.button !== 0) return;
          ev.preventDefault();
          grip.setPointerCapture(ev.pointerId);
          el.classList.add("dragging");
          function onMove(e2) {
            var before = null;
            panels().forEach(function (sib) {
              if (sib === el || before) return;
              var r = sib.getBoundingClientRect();
              if (e2.clientX < r.left + r.width / 2) before = sib;
            });
            barEl.insertBefore(el, before || spacer);
          }
          function onUp() {
            grip.removeEventListener("pointermove", onMove);
            grip.removeEventListener("pointerup", onUp);
            grip.removeEventListener("pointercancel", onUp);
            el.classList.remove("dragging");
            persistOrder();
          }
          grip.addEventListener("pointermove", onMove);
          grip.addEventListener("pointerup", onUp);
          grip.addEventListener("pointercancel", onUp);
        });
      });
      barEl.addEventListener("wheel", function (ev) {
        if (barEl.scrollWidth > barEl.clientWidth + 2) {
          ev.preventDefault();
          barEl.scrollLeft += ev.deltaY;
        }
      }, { passive: false });
    }
    // only the bottom PLAYBACK toolbar stays a fixed strip (user
    // spec) — every other toolpanel lives on the floating islands
    wireXbar("bottom", document.getElementById("xbar-bottom"));
    app.wireXbar = wireXbar;

    // ---- floating toolpanels -------------------------------------------
    // every xPanel is its OWN island (user spec): it attaches to the
    // top or bottom toolbar bounds — laying out in a row that rides
    // the drawer faces — or floats free wherever it was dropped. Drag
    // a panel's ⠿ near either bar to snap it in; placement persists
    // in the shell state across workspaces and reloads. A workspace's
    // panels leave with it but keep their seats for remount.
    var floatHost = document.getElementById("islands");
    var panelEls = {};          // panel name -> current element
    var snapzones = { top: null, bottom: null };
    var FLOAT_SNAP = 28;        // px band around a bar that captures a drop

    if (floatHost) {
      ["top", "bottom"].forEach(function (which) {
        var z = document.createElement("div");
        z.className = "y2ksnapzone";
        floatHost.appendChild(z);
        snapzones[which] = z;
      });
      // a workspace unmounting removes its panel elements — forget
      // them here (their seats stay in the state for remount)
      new MutationObserver(function (recs) {
        var gone = false;
        recs.forEach(function (rec) {
          Array.prototype.forEach.call(rec.removedNodes, function (n) {
            if (n.nodeType !== 1 || !n.dataset || !n.dataset.panel) return;
            if (!n.isConnected && panelEls[n.dataset.panel] === n) {
              delete panelEls[n.dataset.panel];
              gone = true;
            }
          });
        });
        if (gone) layoutFloats();
      }).observe(floatHost, { childList: true });
    }

    // the bounds panels attach to: under the top dock face, above the
    // bottom playback toolbar — both follow the drawer pulls live
    function floatBands() {
      var topdock = document.getElementById("topdock");
      var botdock = document.getElementById("botdock");
      return {
        top: (topdock ? topdock.getBoundingClientRect().bottom : 44) + 4,
        bottom: (botdock ? botdock.getBoundingClientRect().top
                         : window.innerHeight - 40) - 4
      };
    }

    // docked rows stay between the side racks (when a view shows them)
    function rackEdge(side) {
      var el = racks[side];
      if (!el || !el.offsetParent) return 0; // hidden with the view
      var w = el.getBoundingClientRect().width;
      return w > 24 ? w : 0;
    }

    function layoutFloats() {
      if (!floatHost) return;
      var bands = floatBands();
      var x0 = 8 + rackEdge("left");
      var maxW = window.innerWidth - 8 - rackEdge("right");
      if (maxW - x0 < 280) { x0 = 8; maxW = window.innerWidth - 8; }
      ["top", "bottom"].forEach(function (which) {
        // rows flow left-to-right and wrap; absent panels keep their
        // seat in the state for when their workspace comes back
        var lines = [], line = [], lineH = 0;
        var x = x0;
        S.floatRow(state, which).forEach(function (n) {
          var el = panelEls[n];
          if (!el) return;
          var w = el.offsetWidth || 100, h = el.offsetHeight || 26;
          if (line.length && x + w > maxW) {
            lines.push({ items: line, h: lineH });
            line = []; x = x0; lineH = 0;
          }
          line.push({ el: el, x: x });
          x += w + 6;
          lineH = Math.max(lineH, h);
        });
        if (line.length) lines.push({ items: line, h: lineH });
        var total = 0;
        lines.forEach(function (l, i) { total += l.h + (i ? 6 : 0); });
        var y = which === "top" ? bands.top : bands.bottom - total;
        lines.forEach(function (l) {
          l.items.forEach(function (it) {
            if (it.el.classList.contains("floatdrag")) return;
            it.el.classList.add("docked");
            it.el.style.left = it.x + "px";
            it.el.style.top = Math.round(y) + "px";
          });
          y += l.h + 6;
        });
      });
      var minY = 32;
      var wsb = document.getElementById("workspacebar");
      if (wsb && wsb.offsetHeight) minY = wsb.offsetHeight + 4;
      Object.keys(panelEls).forEach(function (n) {
        var e = S.floatGet(state, n);
        if (!e || e.dock !== "free") return;
        var el = panelEls[n];
        if (el.classList.contains("floatdrag")) return;
        el.classList.remove("docked");
        e.x = Math.max(0, Math.min(window.innerWidth - 72, e.x));
        e.y = Math.max(minY, Math.min(window.innerHeight - 40, e.y));
        el.style.left = Math.round(e.x) + "px";
        el.style.top = Math.round(e.y) + "px";
      });
    }

    function adoptPanel(p) {
      var name = p.dataset.panel;
      if (!name || !floatHost) return;
      panelEls[name] = p;
      // new panels attach to the top bar (the resting toolbar look)
      if (!S.floatGet(state, name)) S.floatDock(state, name, "top");
      if (p.parentElement !== floatHost) floatHost.appendChild(p);
      wireFloatPanel(p);
      layoutFloats();
      persist();
    }

    function wireFloatPanel(p) {
      if (p.dataset.floatwired) return;
      p.dataset.floatwired = "1";
      var grip = p.querySelector(".y2kxgrip");
      if (!grip) return;
      grip.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        grip.setPointerCapture(ev.pointerId);
        var r0 = p.getBoundingClientRect();
        var dx = ev.clientX - r0.left, dy = ev.clientY - r0.top;
        var moved = false;
        function zoneAt(e2) {
          var bands = floatBands();
          var top = e2.clientY - dy; // where the panel would land
          if (top < bands.top + FLOAT_SNAP) return "top";
          if (top + r0.height > bands.bottom - FLOAT_SNAP) return "bottom";
          return "free";
        }
        function onMove(e2) {
          if (!moved && Math.abs(e2.clientX - (r0.left + dx)) < 5 &&
              Math.abs(e2.clientY - (r0.top + dy)) < 5) return;
          if (!moved) {
            moved = true;
            p.classList.add("floatdrag");
            floatHost.appendChild(p); // raise over its siblings
          }
          p.style.left = (e2.clientX - dx) + "px";
          p.style.top = (e2.clientY - dy) + "px";
          var bands = floatBands();
          var z = zoneAt(e2);
          snapzones.top.style.top = Math.round(bands.top - 3) + "px";
          snapzones.bottom.style.top = Math.round(bands.bottom) + "px";
          snapzones.top.classList.toggle("show", z === "top");
          snapzones.bottom.classList.toggle("show", z === "bottom");
        }
        function onUp(e2) {
          grip.removeEventListener("pointermove", onMove);
          grip.removeEventListener("pointerup", onUp);
          grip.removeEventListener("pointercancel", onUp);
          snapzones.top.classList.remove("show");
          snapzones.bottom.classList.remove("show");
          if (!moved) return;
          p.classList.remove("floatdrag");
          var name = p.dataset.panel;
          var z = zoneAt(e2);
          if (z === "free") {
            S.floatFree(state, name, e2.clientX - dx, e2.clientY - dy);
          } else {
            // seat by pointer x among the row's present panels
            var others = S.floatRow(state, z).filter(function (n) {
              return n !== name;
            });
            var at = others.length;
            for (var i = 0; i < others.length; i++) {
              var el2 = panelEls[others[i]];
              if (!el2) continue;
              var r = el2.getBoundingClientRect();
              if (e2.clientX < r.left + r.width / 2) { at = i; break; }
            }
            S.floatDock(state, name, z, at);
          }
          layoutFloats();
          persist();
        }
        grip.addEventListener("pointermove", onMove);
        grip.addEventListener("pointerup", onUp);
        grip.addEventListener("pointercancel", onUp);
      });
    }

    // workspaces hand every toolpanel to the islands through this
    // seam — the old toolbar argument is accepted and ignored
    app.xpanel = function (bar, name) {
      var p = document.createElement("div");
      p.className = "y2kxpanel";
      p.dataset.panel = name;
      var g = document.createElement("span");
      g.className = "y2kxgrip";
      g.textContent = "⠿";
      g.title = "Drag to regroup these tools";
      p.appendChild(g);
      adoptPanel(p);
      return p;
    };
    app.adoptPanel = adoptPanel;

    // the core panels start life in a hidden nursery in the HTML
    var nursery = document.getElementById("panel-nursery");
    if (nursery) {
      Array.prototype.slice.call(nursery.querySelectorAll(".y2kxpanel"))
        .forEach(adoptPanel);
    }
    window.addEventListener("resize", function () { applyShell(); });

    // rack column wheel scroll + edge resize
    ["left", "right"].forEach(function (side) {
      var el = racks[side];
      if (!el) return;
      el.addEventListener("wheel", function (ev) {
        ev.preventDefault();
        state.racks[side].scroll += ev.deltaY;
        applyShell();
      }, { passive: false });
      var edge = el.querySelector(".y2krackedge");
      if (!edge) return;
      edge.addEventListener("pointerdown", function (ev) {
        ev.preventDefault();
        edge.setPointerCapture(ev.pointerId);
        edge.classList.add("dragging");
        var x0 = ev.clientX, w0 = state.racks[side].width || S.RACK_DEFAULT;
        function onMove(e2) {
          var dx = e2.clientX - x0;
          var w = side === "right" ? w0 - dx : w0 + dx;
          var mid = document.getElementById("middle");
          S.setRackWidth(state, side, w, mid ? mid.clientWidth : undefined);
          applyShell();
          requestRender();
        }
        function onUp() {
          edge.removeEventListener("pointermove", onMove);
          edge.removeEventListener("pointerup", onUp);
          edge.removeEventListener("pointercancel", onUp);
          edge.classList.remove("dragging");
          persist();
        }
        edge.addEventListener("pointermove", onMove);
        edge.addEventListener("pointerup", onUp);
        edge.addEventListener("pointercancel", onUp);
      });
    });

    // drawer handles
    document.querySelectorAll(".y2kdrawerhandle").forEach(function (handle) {
      handle.addEventListener("click", function () {
        var which = handle.dataset.drawer;
        state.drawers[which].open = !state.drawers[which].open;
        applyShell();
        requestRender();
      });
    });

    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { applyShell(); });
      if (racks.right) ro.observe(racks.right);
      if (racks.left) ro.observe(racks.left);
    }
    applyShell();
  })();

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
    // definition only (the reference's add_scene) — the sequence strip's
    // ＋ is the one that also places an instance
    app.exec({ op: "sceneAdd", id: VB.actorNewId("scene") });
  });

  // ---- the master timeline strip (sequence.js) -----------------------------------
  // Scene INSTANCES in play order. Click follows the scene into the
  // editor; drag reorders; right-click carries the reference's sequence
  // menu (add instance per scene, lock, durations, fill-to-audio).
  var seqSel = null;

  function selectSceneIndex(i) {
    if (i === app.project.cur.scene) return;
    flushSelections();
    app.record({ op: "sceneSelect", index: i });
    app.project.selectScene(i);
    app.debugPin = -1;
    refreshLayers();
    refreshDebugPanel();
    requestRender();
    updateStatus();
  }

  // The sequence menu (reference scene_sequence_context_menu): with an
  // instance under the cursor it carries the per-instance actions; on
  // empty strip space it still creates scenes and instances.
  function seqMenu(ev, inst) {
    var project = app.project;
    var sc = inst ? VB.sceneById(project, inst.scene) : null;
    var items = [
      { label: "Create Scene", fn: function () {
          var sid = VB.actorNewId("scene");
          app.exec({ op: "sceneAdd", id: sid });
          app.exec({ op: "sceneInstAdd", id: VB.actorNewId("seq"),
                     scene: sid, after: inst ? inst.id : undefined });
        } }
    ];
    if (inst) {
      items.push(
        { label: "Rename Scene", fn: function () {
            var n = prompt("Scene name", sc ? sc.scene.name : "");
            if (n && n.trim()) {
              app.exec({ op: "sceneRename", scene: inst.scene, name: n });
            }
          } },
        { label: "Set Duration…", fn: function () {
            var v = parseInt(prompt("Duration (frames)", inst.duration), 10);
            if (v > 0) {
              app.exec({ op: "sceneInstDuration", id: inst.id, frames: v });
            }
          } },
        { label: inst.locked ? "Unlock" : "Lock", fn: function () {
            app.exec({ op: "sceneInstLock", id: inst.id, on: !inst.locked });
          } });
    }
    project.scenes.forEach(function (s) {
      items.push({ label: "Add Instance: " + s.name, fn: function () {
        app.exec({ op: "sceneInstAdd", id: VB.actorNewId("seq"),
                   scene: s.id, after: inst ? inst.id : undefined });
      } });
    });
    if (inst && VB.sequenceOf(project).length > 1) {
      items.push({ label: "Remove Instance", fn: function () {
        app.exec({ op: "sceneInstRemove", id: inst.id });
      } });
    }
    // reference feature: fill numbered scenes until the audio is covered
    var frameMs = 1000 / (project.fps || 24);
    var audioEnd = VB.audioEndMs ? VB.audioEndMs(project) : 0;
    if (audioEnd > VB.sequenceDuration(project) * frameMs) {
      items.push({ label: "Create Scenes To Audio End", fn: function () {
        var guard = 0;
        while (VB.sequenceDuration(app.project) * frameMs <
               VB.audioEndMs(app.project) && guard++ < 200) {
          var sid = VB.actorNewId("scene");
          app.exec({ op: "sceneAdd", id: sid });
          app.exec({ op: "sceneInstAdd", id: VB.actorNewId("seq"),
                     scene: sid, duration: 144 });
        }
        // trim the tail so the sequence lands ON the audio end
        var wantF = Math.ceil(VB.audioEndMs(app.project) / frameMs);
        var seq = VB.sequenceOf(app.project);
        var last = seq[seq.length - 1];
        var trim = VB.sequenceDuration(app.project) - wantF;
        if (trim > 0 && last.duration - trim >= 1) {
          app.exec({ op: "sceneInstDuration", id: last.id,
                     frames: last.duration - trim });
        }
      } });
    }
    app.showMenu(ev.clientX, ev.clientY, items);
  }

  // The strip is the reference's NLE scene lane: frame-proportional
  // blocks in alternating blues (#6ea7df/#a9d0f5, active outlined
  // #1d4ed8), a frame ruler, a playhead, boundary drags that rebalance
  // the shared zone (sceneBoundaryDrag), block drags that reorder, and
  // the sequence menu on right-click.
  var SEQ_RULER = 15;
  var seqView = { canvas: null, playBtn: null, ro: null,
                  pxf: 0, pan: 0, userZoom: false, drag: null };

  function seqStarts() {
    var seq = VB.sequenceOf(app.project);
    var starts = [], acc = 0;
    for (var i = 0; i < seq.length; i++) {
      starts.push(acc);
      acc += Math.max(1, seq[i].duration | 0);
    }
    return { seq: seq, starts: starts, total: acc };
  }

  function seqFrameAt(x) { return seqView.pan + x / seqView.pxf; }
  function seqXOf(frame) { return (frame - seqView.pan) * seqView.pxf; }

  /** The playhead frame — ALWAYS the master clock, never derived from
   *  chip selection (deriving it made the playhead snap to the selected
   *  instance on every stop). Timelines REPOSITION the clock instead. */
  function seqMasterFrame() {
    var total = Math.max(1, VB.sequenceDuration(app.project));
    var f = Math.floor((VB.audioNow ? VB.audioNow() : 0) / seqFrameMs());
    return Math.max(0, Math.min(total - 1, f));
  }

  /** Journaled editor navigation moves the clock: keep the master on
   *  the instance it is already inside when that instance shows the
   *  current scene; otherwise jump to the scene's first instance. */
  function seqSyncMasterToCur() {
    var curScene = app.project.scenes[app.project.cur.scene];
    if (!curScene || !VB.audioSeek) return;
    var at = VB.sequenceAt(app.project, seqMasterFrame());
    if (!at || at.inst.scene !== curScene.id) {
      var s = seqStarts();
      at = null;
      for (var i = 0; i < s.seq.length; i++) {
        if (s.seq[i].scene === curScene.id) {
          at = { inst: s.seq[i], start: s.starts[i] };
          break;
        }
      }
    }
    if (!at) return;
    var frame = at.start + Math.min(app.project.cur.frame,
      Math.max(1, at.inst.duration | 0) - 1);
    VB.audioSeek(frame * seqFrameMs());
  }

  function ensureSeqStrip() {
    var bar = document.getElementById("seqbar");
    if (!bar || seqView.canvas) return;
    var play = document.createElement("button");
    play.id = "seq-play";
    play.textContent = "▶";
    play.title = "Play the sequence, audio-synced (Shift+Enter)";
    play.addEventListener("click", function () {
      if (seqPlay.playing) stopSeqPlay(); else startSeqPlay();
    });
    // the transport lives on the bottom xToolbar (always visible, even
    // with the sequencing drawer collapsed); older layouts keep it here
    var slot = document.getElementById("seq-play-slot");
    (slot || bar).appendChild(play);
    var cvs = document.createElement("canvas");
    cvs.id = "seq-strip";
    bar.appendChild(cvs);
    seqView.playBtn = play;
    seqView.canvas = cvs;
    wireSeqStrip(cvs);
    if (window.ResizeObserver) {
      seqView.ro = new ResizeObserver(function () { renderSeqStrip(); });
      seqView.ro.observe(bar);
    }
  }

  function renderSeqStrip() {
    var cvs = seqView.canvas;
    if (!cvs) return;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    var ctx = cvs.getContext("2d");
    var s = seqStarts();
    if (!seqView.userZoom) { // fit the whole sequence until the user zooms
      seqView.pxf = Math.min(6, Math.max(0.02, (w - 24) / Math.max(1, s.total)));
      seqView.pan = 0;
    }
    var css = getComputedStyle(document.body);
    var panel = css.getPropertyValue("--panel").trim() || "#f2f3f5";
    var edge = css.getPropertyValue("--panel-edge").trim() || "#c6cad0";
    var dim = css.getPropertyValue("--text-dim").trim() || "#6b7079";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, w, h);

    // frame ruler: ticks land on whole seconds when zoomed out
    var fps = app.project.fps || 24;
    var stepOpts = [1, 2, 4, 6, 12, fps, fps * 2, fps * 5, fps * 10,
                    fps * 20, fps * 60];
    var step = stepOpts[stepOpts.length - 1];
    for (var so = 0; so < stepOpts.length; so++) {
      if (stepOpts[so] * seqView.pxf >= 46) { step = stepOpts[so]; break; }
    }
    ctx.strokeStyle = edge;
    ctx.fillStyle = dim;
    ctx.font = "9px system-ui";
    ctx.textAlign = "left";
    ctx.beginPath();
    var f0 = Math.max(0, Math.floor(seqView.pan / step) * step);
    for (var f = f0; seqXOf(f) < w; f += step) {
      var tx = Math.round(seqXOf(f)) + 0.5;
      ctx.moveTo(tx, SEQ_RULER - 5);
      ctx.lineTo(tx, SEQ_RULER);
      ctx.fillText(String(f + 1), tx + 2, SEQ_RULER - 6);
    }
    ctx.moveTo(0, SEQ_RULER + 0.5);
    ctx.lineTo(w, SEQ_RULER + 0.5);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(s.total + "f · " + (s.total / fps).toFixed(1) + "s",
                 w - 4, SEQ_RULER - 6);

    // scene instance blocks — the reference's alternating blues; an
    // audio band below shows the stems against the scene cut
    var hasAudio = VB.audioHasClips && VB.audioHasClips(app.project);
    var bandH = hasAudio ? 18 : 0;
    var ghost = seqView.drag && seqView.drag.ghost;
    var y = SEQ_RULER + 4, bh = h - SEQ_RULER - 9 - bandH;
    var gStarts = 0;
    for (var i = 0; i < s.seq.length; i++) {
      var inst = s.seq[i];
      var dur = ghost && ghost[inst.id] !== undefined
        ? ghost[inst.id] : Math.max(1, inst.duration | 0);
      var bx = seqXOf(gStarts), bw = Math.max(2, dur * seqView.pxf);
      gStarts += dur;
      if (bx > w || bx + bw < 0) continue;
      var sc = VB.sceneById(app.project, inst.scene);
      ctx.fillStyle = i % 2 === 0 ? "#6ea7df" : "#a9d0f5";
      ctx.strokeStyle = "#11161b";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, y, bw, bh, 3);
      ctx.fill();
      ctx.stroke();
      if (seqSel === inst.id) { // the reference's active outline
        ctx.strokeStyle = "#1d4ed8";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(bx + 1, y + 1, Math.max(1, bw - 2), bh - 2, 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx + 2, y, Math.max(1, bw - 4), bh);
      ctx.clip();
      ctx.fillStyle = "#11161b";
      ctx.font = "10px system-ui";
      ctx.textAlign = "left";
      ctx.fillText((inst.locked ? "🔒 " : "") +
        (sc ? sc.scene.name : "?") + " · " + dur + "f",
        bx + 5, y + bh / 2 + 3);
      ctx.restore();
    }

    // reorder caret
    if (seqView.drag && seqView.drag.kind === "move" &&
        seqView.drag.to !== undefined) {
      var cx = seqXOf(seqView.drag.toFrame);
      ctx.strokeStyle = "#1d4ed8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, SEQ_RULER + 1);
      ctx.lineTo(cx, h - 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // the audio band (reference: the audio lane under the scene track)
    if (hasAudio) {
      var frameMs = 1000 / fps;
      var bandTop = h - bandH - 2;
      (app.project.audio.tracks || []).forEach(function (track) {
        track.clips.forEach(function (cl) {
          var fx = seqXOf(cl.at / frameMs);
          var fw = (cl.duration / frameMs) * seqView.pxf;
          if (fx > w || fx + fw < 0) return;
          ctx.fillStyle = "#e3ebf3";
          ctx.fillRect(fx, bandTop, Math.max(1, fw), bandH);
          var pk = VB.audioPeaks(app.project, cl.asset, renderSeqStrip);
          if (!pk) return;
          ctx.fillStyle = "#5b8fc9";
          var mid = bandTop + bandH / 2, amp = bandH / 2 - 1;
          var sx0 = Math.max(0, Math.floor(fx));
          var sx1 = Math.min(w, fx + fw);
          for (var sx = sx0; sx < sx1; sx++) {
            var ms0 = cl.offset + (seqFrameAt(sx) * frameMs -
                                   cl.at);
            var pb = Math.floor(ms0 / 1000 * pk.rate / pk.bin);
            if (pb < 0 || pb >= pk.bins) continue;
            ctx.fillRect(sx, mid + pk.min[pb] * amp, 1,
                         Math.max(1, (pk.max[pb] - pk.min[pb]) * amp));
          }
        });
      });
    }

    // playhead — the SHARED master clock while the transport runs,
    // the editor's scene/frame position otherwise
    var pFrame = (VB.audioIsPlaying && VB.audioIsPlaying())
      ? VB.audioNow() * fps / 1000 : seqMasterFrame();
    var px = Math.round(seqXOf(pFrame)) + 0.5;
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = css.getPropertyValue("--hot").trim() || "#d03030";
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }

  function wireSeqStrip(cvs) {
    function local(ev) {
      var r = cvs.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
    /** A draggable boundary within 5px: the right edge of block i. */
    function boundaryAt(x) {
      var s = seqStarts();
      var acc = 0;
      for (var i = 0; i < s.seq.length; i++) {
        acc += Math.max(1, s.seq[i].duration | 0);
        if (Math.abs(seqXOf(acc) - x) <= 5) {
          return { inst: s.seq[i], index: i };
        }
      }
      return null;
    }
    function instAt(x) {
      var s = seqStarts();
      var f = seqFrameAt(x);
      if (f < 0 || f >= s.total) return null;
      return VB.sequenceAt(app.project, Math.floor(f));
    }
    function scrubTo(x) {
      var s = seqStarts();
      var f = Math.max(0, Math.min(s.total - 1, Math.round(seqFrameAt(x))));
      var at = VB.sequenceAt(app.project, f);
      if (!at) return;
      seqSel = at.inst.id;
      var sc = VB.sceneById(app.project, at.inst.scene);
      if (sc && sc.index !== app.project.cur.scene) {
        app.project.selectScene(sc.index); // direct while scrubbing
        refreshLayers();
      }
      app.project.cur.frame = f - at.start;
      VB.audioSeek(f * seqFrameMs()); // the master clock follows the scrub
      requestRender();
      refreshTimeline();
      renderSeqStrip();
    }
    cvs.addEventListener("pointerdown", function (ev) {
      var p = local(ev);
      if (ev.button === 1) {
        ev.preventDefault();
        cvs.setPointerCapture(ev.pointerId);
        seqView.drag = { kind: "pan", x0: p.x, pan0: seqView.pan };
        return;
      }
      if (ev.button !== 0) return;
      stopSeqPlay();
      cvs.setPointerCapture(ev.pointerId);
      if (p.y < SEQ_RULER) { // scrub the master playhead
        seqView.drag = { kind: "scrub" };
        scrubTo(p.x);
        return;
      }
      var edge = boundaryAt(p.x);
      if (edge) {
        seqView.drag = { kind: "boundary", inst: edge.inst,
                         index: edge.index, ghost: null };
        return;
      }
      var at = instAt(p.x);
      if (!at) return;
      seqSel = at.inst.id;
      var sc = VB.sceneById(app.project, at.inst.scene);
      if (sc) selectSceneIndex(sc.index);
      // the playhead parks AT the clicked frame — mid-scene included
      // (the reference's scene_select carries the clicked frame)
      var dur = Math.max(1, at.inst.duration | 0);
      var f = Math.max(at.start, Math.min(at.start + dur - 1,
        Math.floor(seqFrameAt(p.x))));
      if (app.project.cur.frame !== f - at.start) {
        app.exec({ op: "frameSelect", index: f - at.start });
      }
      VB.audioSeek(f * seqFrameMs());
      seqView.drag = { kind: "maybe-move", inst: at.inst,
                       index: at.index, x0: p.x };
      renderSeqStrip();
    });
    cvs.addEventListener("pointermove", function (ev) {
      var p = local(ev);
      var d = seqView.drag;
      if (!d) {
        cvs.style.cursor = boundaryAt(p.x) ? "ew-resize"
          : (p.y < SEQ_RULER ? "crosshair" : "default");
        return;
      }
      if (d.kind === "pan") {
        seqView.userZoom = true;
        seqView.pan = Math.max(-20, d.pan0 - (p.x - d.x0) / seqView.pxf);
        renderSeqStrip();
        return;
      }
      if (d.kind === "scrub") { scrubTo(p.x); return; }
      if (d.kind === "boundary") {
        // ghost with the SAME zone-preserving math the op applies
        var s = seqStarts();
        var start = s.starts[d.index];
        var inst = d.inst;
        var next = s.seq[d.index + 1];
        var frame = Math.max(0, Math.round(seqFrameAt(p.x)));
        var ghost = {};
        if (inst.locked || (next && next.locked)) return;
        if (next) {
          var nextEnd = start + Math.max(1, inst.duration | 0) +
                        Math.max(1, next.duration | 0);
          var b = Math.max(start + 1, Math.min(frame, nextEnd - 1));
          ghost[inst.id] = b - start;
          ghost[next.id] = nextEnd - b;
        } else {
          ghost[inst.id] = Math.max(1, frame - start);
        }
        d.ghost = ghost;
        d.frame = frame;
        renderSeqStrip();
        return;
      }
      if (d.kind === "maybe-move" && Math.abs(p.x - d.x0) > 6) d.kind = "move";
      if (d.kind === "move") {
        var s2 = seqStarts();
        var f2 = seqFrameAt(p.x);
        var to = 0;
        for (var i = 0; i < s2.seq.length; i++) {
          if (s2.seq[i] === d.inst) continue;
          var mid = s2.starts[i] + Math.max(1, s2.seq[i].duration | 0) / 2;
          if (f2 > mid) to++;
        }
        d.to = to;
        // caret sits at the insertion boundary among the OTHER blocks
        var caret = 0, seen = 0;
        for (var j = 0; j < s2.seq.length && seen < to; j++) {
          if (s2.seq[j] === d.inst) continue;
          caret = s2.starts[j] + Math.max(1, s2.seq[j].duration | 0);
          seen++;
        }
        d.toFrame = to === 0 ? 0 : caret;
        renderSeqStrip();
      }
    });
    cvs.addEventListener("pointerup", function () {
      var d = seqView.drag;
      seqView.drag = null;
      if (!d) return;
      if (d.kind === "scrub") {
        // pin the landing scene + frame so replay agrees
        app.record({ op: "sceneSelect", index: app.project.cur.scene });
        app.exec({ op: "frameSelect", index: app.project.cur.frame });
        return;
      }
      if (d.kind === "boundary" && d.frame !== undefined) {
        app.exec({ op: "sceneBoundaryDrag", inst: d.inst.id,
                   edge: "right", frame: d.frame });
        return;
      }
      if (d.kind === "move" && d.to !== undefined && d.to !== d.index) {
        app.exec({ op: "sceneInstMove", id: d.inst.id, index: d.to });
        return;
      }
      renderSeqStrip();
    });
    cvs.addEventListener("pointercancel", function () {
      seqView.drag = null;
      renderSeqStrip();
    });
    cvs.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var p = local(ev);
      var fAt = seqFrameAt(p.x);
      seqView.userZoom = true;
      var factor = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
      seqView.pxf = Math.max(0.02, Math.min(12, seqView.pxf * factor));
      seqView.pan = fAt - p.x / seqView.pxf;
      renderSeqStrip();
    }, { passive: false });
    cvs.addEventListener("contextmenu", function (ev) {
      var p = local(ev);
      var at = instAt(p.x);
      seqMenu(ev, at ? at.inst : null);
    });
    cvs.addEventListener("dblclick", function (ev) {
      var p = local(ev);
      var at = instAt(p.x);
      if (!at) return;
      var sc = VB.sceneById(app.project, at.inst.scene);
      var n = prompt("Scene name", sc ? sc.scene.name : "");
      if (n && n.trim()) {
        app.exec({ op: "sceneRename", scene: at.inst.scene, name: n });
      }
    });
  }

  function refreshSequence() {
    ensureSeqStrip();
    if (!seqView.canvas) return;
    if (seqSel && !VB.sequenceInstById(app.project, seqSel)) seqSel = null;
    if (seqView.playBtn) {
      seqView.playBtn.textContent =
        (typeof seqPlay !== "undefined" && seqPlay.playing) ? "⏹" : "▶";
    }
    // editor navigation re-seeds the shared master clock (never while
    // something plays, and never from other tabs — an Audio-tab scrub
    // must survive edits made over there)
    if (!(VB.audioIsPlaying && VB.audioIsPlaying()) &&
        !(typeof seqPlay !== "undefined" && seqPlay.playing) &&
        !document.body.classList.contains("ws-mount-mode") &&
        !document.body.classList.contains("ws-stub-mode")) {
      seqSyncMasterToCur();
    }
    renderSeqStrip();
  }

  // Empty-space drags in the transform tool draw a fresh region band —
  // shaped like the selection tool the user came from.
  app.regionSelectStyle = function () {
    return returnTool === "lasso" ? "lasso" : "marquee";
  };

  // ---- timeline rail + playback + onion (Sequence/Roughs beat 2) ----------------
  // The rail shows the active layer's sub-timeline as columns (holds
  // ghosted past the layer's own frames). Playback advances the view
  // frame directly — no journal spam — and STOP pins the landing frame
  // with one frameSelect op so replay agrees with what the user sees.

  var playback = { playing: false, raf: 0, last: 0, acc: 0 };

  // ---- the STEP SEQUENCER (docs/StepSequencer.md) --------------------------------
  // Rows are GENERATED from the current scene's cast: the drawn-frames
  // rail first, then per instance a Visibility row and one row per
  // pose. Clips are painted timing regions; a drag paints ONE ranged
  // exposureSet op. The drawer's pull reveals more rows.

  var STEP_ROW_H = 24;
  var stepView = { scroll: 0, drag: null };

  function stepCellW() {
    return (app.shellState && app.shellState.step &&
            app.shellState.step.cellW) || 13;
  }

  function stepRows() {
    var project = app.project;
    var scene = project.scenes[project.cur.scene];
    var rows = [{ kind: "frames",
                  label: "Frames · " + (project.activeLayer().name || "") }];
    if (scene && !project.editTarget && VB.stepRefOf) {
      (scene.cast || []).forEach(function (inst) {
        var ref = VB.stepRefOf(project, inst);
        var nm = ref && ref.actor ? ref.actor.name
          : ref && ref.entry ? ref.entry.name : "?";
        rows.push({ kind: "vis", inst: inst, target: "vis:" + inst.id,
                    value: "1", label: nm + " · Visibility" });
        if (ref && ref.actor) {
          ref.actor.poses.forEach(function (pose) {
            rows.push({ kind: "pose", inst: inst, pose: pose,
                        target: "pose:" + inst.id, value: pose.id,
                        label: nm + " · " + pose.name });
          });
        }
      });
    }
    return { rows: rows, scene: scene };
  }

  function refreshTimeline() {
    var project = app.project;
    var total = project.sceneSpan ? project.sceneSpan() : project.frameCount();
    var cur = project.cur.frame || 0;
    document.getElementById("tl-counter").textContent =
      (cur + 1) + " / " + total;
    var fpsInput = document.getElementById("tl-fps");
    if (document.activeElement !== fpsInput) {
      fpsInput.value = String(project.fps || 24);
    }
    document.getElementById("tl-onion").classList.toggle("active", !!app.onion);
    // the names column
    var names = document.getElementById("step-names");
    if (names) {
      names.innerHTML = "";
      stepRows().rows.forEach(function (row) {
        var el = document.createElement("div");
        el.className = "stepname" + (row.kind === "frames" ? " head" : "");
        var nm = document.createElement("span");
        nm.className = "aname";
        nm.textContent = row.label;
        nm.title = row.label;
        el.appendChild(nm);
        if (row.kind === "vis") {
          el.appendChild(actorPanelBtn("✕",
            "Remove this instance from the scene", function () {
              if (!confirm("Remove this instance from the scene?")) return;
              app.exec({ op: "instanceRemove", id: row.inst.id });
            }));
        }
        names.appendChild(el);
      });
    }
    // playback keeps the playhead column in view
    if (seqPlay.playing || playback.playing) {
      var grid = document.getElementById("step-grid");
      if (grid) {
        var px = cur * stepCellW() - stepView.scroll;
        if (px < 0 || px > grid.clientWidth - stepCellW() - 4) {
          stepView.scroll = Math.max(0, cur * stepCellW() -
                                        grid.clientWidth / 2);
        }
      }
    }
    drawStepGrid();
    // the three.js stage follows the playing frame (every playback and
    // scrub path funnels through refreshTimeline; the signature check
    // makes held frames free)
    if (VB.CompositeView && VB.CompositeView.sync) VB.CompositeView.sync();
  }

  function drawStepGrid() {
    var cvs = document.getElementById("step-grid");
    if (!cvs) return;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    var ctx = cvs.getContext("2d");
    var project = app.project;
    var data = stepRows();
    var total = project.sceneSpan ? project.sceneSpan() : project.frameCount();
    var cur = project.cur.frame || 0;
    var cw = stepCellW();
    stepView.scroll = Math.max(0,
      Math.min(stepView.scroll, total * cw - w + 24));
    var css = getComputedStyle(document.body);
    var C = {
      panel: css.getPropertyValue("--panel").trim() || "#f2f3f5",
      bg: css.getPropertyValue("--bg").trim() || "#e4e6e9",
      edge: css.getPropertyValue("--panel-edge").trim() || "#c6cad0",
      field: css.getPropertyValue("--field").trim() || "#ffffff",
      filled: css.getPropertyValue("--cell-filled").trim() || "#b9c0c9",
      accent: css.getPropertyValue("--accent").trim() || "#2f7fd6"
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, w, h);
    var layer = project.activeLayer();
    function xOf(f) { return f * cw - stepView.scroll; }
    data.rows.forEach(function (row, ri) {
      var y = ri * STEP_ROW_H;
      if (y > h) return;
      ctx.fillStyle = ri % 2 ? C.bg : C.panel;
      ctx.fillRect(0, y, w, STEP_ROW_H);
      if (row.kind === "frames") {
        for (var f = 0; f < total; f++) {
          var fx = xOf(f);
          if (fx + cw < 0) continue;
          if (fx > w) break;
          var own = f < layer.frames.length;
          var filled = own && (layer.frames[f].edges.length ||
                               (layer.frames[f].texts || []).length);
          ctx.fillStyle = own ? (filled ? C.filled : C.field) : C.bg;
          ctx.strokeStyle = C.edge;
          ctx.beginPath();
          ctx.rect(fx + 1, y + 4, Math.max(1, cw - 2), STEP_ROW_H - 8);
          ctx.fill();
          ctx.stroke();
        }
      } else if (data.scene) {
        VB.stepClipsFor(data.scene, row.target).forEach(function (c) {
          if (row.kind === "pose" && c.label !== row.value) return;
          var x0 = xOf(c.start), x1 = xOf(c.start + c.duration);
          if (x1 < 0 || x0 > w) return;
          ctx.fillStyle = row.kind === "vis" ? "#6ea7df" : "#8fbf7f";
          ctx.strokeStyle = "#11161b";
          ctx.beginPath();
          ctx.rect(x0 + 1, y + 4, Math.max(2, x1 - x0 - 2), STEP_ROW_H - 8);
          ctx.fill();
          ctx.stroke();
          if (cw >= 7) { // the step-cell ticks inside a run
            ctx.strokeStyle = "rgba(0,0,0,0.22)";
            ctx.beginPath();
            for (var f2 = c.start + 1; f2 < c.start + c.duration; f2++) {
              var tx = Math.round(xOf(f2)) + 0.5;
              if (tx < 0 || tx > w) continue;
              ctx.moveTo(tx, y + 4);
              ctx.lineTo(tx, y + STEP_ROW_H - 4);
            }
            ctx.stroke();
          }
        });
      }
      var d = stepView.drag;
      if (d && d.kind === "paint" && d.row === ri) {
        var g0 = Math.min(d.from, d.to), g1 = Math.max(d.from, d.to);
        ctx.fillStyle = d.erase
          ? "rgba(208,48,48,0.35)" : "rgba(47,127,214,0.35)";
        ctx.fillRect(xOf(g0), y + 2, (g1 - g0 + 1) * cw, STEP_ROW_H - 4);
      }
    });
    // the playhead COLUMN (this view's distinct look)
    var px = Math.round(xOf(cur));
    ctx.fillStyle = "rgba(47,127,214,0.16)";
    ctx.fillRect(px, 0, cw, h);
    ctx.strokeStyle = C.accent;
    ctx.strokeRect(px + 0.5, 0.5, Math.max(1, cw - 1), h - 1);
  }

  (function wireStepGrid() {
    var cvs = document.getElementById("step-grid");
    if (!cvs) return;
    function frameAt(ev) {
      var r = cvs.getBoundingClientRect();
      return Math.floor((ev.clientX - r.left + stepView.scroll) /
                        stepCellW());
    }
    function rowAt(ev) {
      var r = cvs.getBoundingClientRect();
      return Math.floor((ev.clientY - r.top) / STEP_ROW_H);
    }
    function clampFrame(f) {
      var total = app.project.sceneSpan
        ? app.project.sceneSpan() : app.project.frameCount();
      return Math.max(0, Math.min(total - 1, f));
    }
    cvs.addEventListener("pointerdown", function (ev) {
      if (ev.button === 1) {
        ev.preventDefault();
        cvs.setPointerCapture(ev.pointerId);
        stepView.drag = { kind: "pan", x0: ev.clientX,
                          s0: stepView.scroll };
        return;
      }
      if (ev.button !== 0 && ev.button !== 2) return;
      stopPlay();
      stopSeqPlay();
      cvs.setPointerCapture(ev.pointerId);
      var data = stepRows();
      var row = data.rows[rowAt(ev)];
      var f = clampFrame(frameAt(ev));
      if (!row) return;
      if (row.kind === "frames") { // scrub, pin on release
        stepView.drag = { kind: "scrub" };
        app.project.cur.frame = f;
        requestRender();
        refreshTimeline();
        return;
      }
      stepView.drag = { kind: "paint", row: rowAt(ev), rowDef: row,
                        erase: ev.button === 2 || ev.altKey,
                        from: f, to: f, scene: data.scene };
      drawStepGrid();
    });
    cvs.addEventListener("pointermove", function (ev) {
      var d = stepView.drag;
      if (!d) return;
      if (d.kind === "pan") {
        stepView.scroll = Math.max(0, d.s0 - (ev.clientX - d.x0));
        drawStepGrid();
        return;
      }
      var f = clampFrame(frameAt(ev));
      if (d.kind === "scrub") {
        if (f !== app.project.cur.frame) {
          app.project.cur.frame = f;
          requestRender();
          refreshTimeline();
        }
        return;
      }
      if (f !== d.to) {
        d.to = f;
        drawStepGrid();
      }
    });
    cvs.addEventListener("pointerup", function () {
      var d = stepView.drag;
      stepView.drag = null;
      if (!d) return;
      if (d.kind === "scrub") { // pin the landing frame in the journal
        app.exec({ op: "frameSelect", index: app.project.cur.frame });
        return;
      }
      if (d.kind === "paint" && d.scene) {
        app.exec({ op: "exposureSet", id: VB.actorNewId("run"),
                   scene: d.scene.id,
                   lane: d.rowDef.kind,
                   target: d.rowDef.target,
                   from: Math.min(d.from, d.to),
                   to: Math.max(d.from, d.to),
                   value: d.erase ? null : d.rowDef.value });
      }
      drawStepGrid();
    });
    cvs.addEventListener("pointercancel", function () {
      stepView.drag = null;
      drawStepGrid();
    });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { drawStepGrid(); }).observe(cvs);
    }
  })();

  function startPlay() {
    stopSeqPlay(); // the scene loop and the sequence never play together
    if (playback.playing || app.project.editTarget) return;
    if (app.project.frameCount() <= 1) { setMsg("only one frame — add frames (＋ / F7)"); return; }
    flushSelections();
    playback.playing = true;
    playback.last = performance.now();
    playback.acc = 0;
    app.session.clock.playing = true;
    var btn = document.getElementById("tl-play");
    btn.textContent = "⏸";
    btn.classList.add("active");
    function tick(now) {
      if (!playback.playing) return;
      playback.acc += now - playback.last;
      playback.last = now;
      var msPerFrame = 1000 / (app.project.fps || 24);
      var advanced = false;
      while (playback.acc >= msPerFrame) {
        playback.acc -= msPerFrame;
        app.project.cur.frame =
          (app.project.cur.frame + 1) % app.project.frameCount();
        advanced = true;
      }
      if (advanced) {
        app.session.clock.frame = app.project.cur.frame;
        requestRender();
        refreshTimeline();
      }
      playback.raf = requestAnimationFrame(tick);
    }
    playback.raf = requestAnimationFrame(tick);
  }

  function stopPlay() {
    if (!playback.playing) return;
    playback.playing = false;
    cancelAnimationFrame(playback.raf);
    app.session.clock.playing = false;
    var btn = document.getElementById("tl-play");
    btn.textContent = "▶";
    btn.classList.remove("active");
    // pin the landing frame in the journal so replay agrees
    app.exec({ op: "frameSelect", index: app.project.cur.frame });
  }

  document.getElementById("tl-play").addEventListener("click", function () {
    if (playback.playing) stopPlay(); else startPlay();
  });
  document.getElementById("tl-add").addEventListener("click", function () {
    stopPlay();
    app.exec({ op: "frameAdd", layer: app.project.cur.layer });
  });
  document.getElementById("tl-del").addEventListener("click", function () {
    stopPlay();
    app.exec({ op: "frameRemove",
               layer: app.project.cur.layer, index: app.project.cur.frame });
  });
  document.getElementById("tl-onion").addEventListener("click", function () {
    app.onion = !app.onion;
    refreshTimeline();
    requestRender();
  });
  document.getElementById("tl-fps").addEventListener("change", function () {
    var fps = parseInt(this.value, 10);
    if (isFinite(fps)) app.exec({ op: "fpsSet", fps: fps });
  });
  // any canvas edit gesture stops playback first (capture phase)
  canvas.addEventListener("pointerdown", function () {
    stopPlay();
    stopSeqPlay();
  }, true);

  // ---- master playback: play ACROSS the sequence (sequence.js) ------------------
  // The reel walks scene instances via VB.sequenceAt; audio (when the
  // project has clips) IS the clock, exactly like the Boards animatic.
  // cur.scene/cur.frame advance directly — no journal spam — and STOP
  // pins the landing scene + frame with journaled ops so replay agrees
  // with what the user sees.

  var seqPlay = { playing: false, raf: 0, last: 0, ms: 0, frame: -1,
                  audio: false };

  function seqFrameMs() { return 1000 / (app.project.fps || 24); }

  function startSeqPlay() {
    if (seqPlay.playing) return;
    if (app.project.editTarget) {
      setMsg("leave symbol edit to play the sequence");
      return;
    }
    stopPlay();
    flushSelections();
    seqPlay.playing = true;
    // resume from the MASTER position (reference: current_frame)
    seqPlay.ms = seqMasterFrame() * seqFrameMs();
    if (seqPlay.ms >= VB.sequenceDuration(app.project) * seqFrameMs() - 1) {
      seqPlay.ms = 0;
    }
    seqPlay.frame = -1;
    seqPlay.last = performance.now();
    seqPlay.audio = false;
    app.session.clock.playing = true;
    refreshSequence();
    function startAudio() {
      if (!(VB.audioHasClips && VB.audioHasClips(app.project))) return;
      // past the last clip the reel runs silent — starting the
      // transport here would clamp to 0 and DRAG the reel back with it
      if (seqPlay.ms >= VB.audioEndMs(app.project)) return;
      seqPlay.audio = true;
      VB.audioPlay(app.project, Math.round(seqPlay.ms), function (ms) {
        if (seqPlay.playing) seqPlay.ms = ms; // audio drives the clock
      }, function () {
        seqPlay.audio = false;                // silent tail: raf resumes
      });
    }
    startAudio();
    function tick(now) {
      if (!seqPlay.playing) return;
      var dt = now - seqPlay.last;
      seqPlay.last = now;
      if (!seqPlay.audio) {
        seqPlay.ms += dt;
        VB.audioSeek(seqPlay.ms); // the master clock follows silent play
      }
      var total = VB.sequenceDuration(app.project) * seqFrameMs();
      if (seqPlay.ms >= total) { // loop; the audio restarts with the reel
        seqPlay.ms = 0;
        seqPlay.frame = -1;
        if (VB.audioStop) VB.audioStop();
        seqPlay.audio = false;
        startAudio();
      }
      var frame = Math.floor(seqPlay.ms / seqFrameMs());
      if (frame !== seqPlay.frame) {
        seqPlay.frame = frame;
        var at = VB.sequenceAt(app.project, frame);
        if (!at) { stopSeqPlay(); return; }
        var sc = VB.sceneById(app.project, at.inst.scene);
        if (sc && sc.index !== app.project.cur.scene) {
          app.project.selectScene(sc.index); // direct: no journal spam
          refreshLayers();
          refreshSequence();
        }
        app.project.cur.frame = Math.max(0, frame - at.start);
        app.session.clock.frame = app.project.cur.frame;
        requestRender();
        refreshTimeline();
        renderSeqStrip(); // the playhead sweeps the strip
      }
      seqPlay.raf = requestAnimationFrame(tick);
    }
    seqPlay.raf = requestAnimationFrame(tick);
  }

  function stopSeqPlay() {
    if (!seqPlay.playing) return;
    seqPlay.playing = false;
    seqPlay.audio = false;
    if (VB.audioStop) VB.audioStop();
    VB.audioSeek(seqPlay.ms); // the shared playhead lands with the reel
    cancelAnimationFrame(seqPlay.raf);
    app.session.clock.playing = false;
    // pin the landing scene + frame in the journal (selectScene already
    // applied live; frameSelect clamps identically live and in replay)
    app.record({ op: "sceneSelect", index: app.project.cur.scene });
    app.exec({ op: "frameSelect", index: app.project.cur.frame });
    refreshSequence();
  }

  ensureSeqStrip(); // build the strip at load — remounts never add canvases

  // SYNC AUDIT (user report): the global timeline is visible in EVERY
  // workspace now, so Space plays the SEQUENCE (picture + sound from
  // the master position) everywhere — including Composite/Grading,
  // whose three.js stage follows the frames. Stubs and symbol-edit
  // fall through to the raw transport; the Boards animatic and Pitch
  // present-mode interceptors keep their priority (registered first).
  VB.audioSpaceIntercept = VB.audioSpaceIntercept || [];
  VB.audioSpaceIntercept.push(function () {
    if (seqPlay.playing) { stopSeqPlay(); return true; }
    if (!document.body.classList.contains("ws-stub-mode") &&
        !app.project.editTarget) {
      startSeqPlay();
      return true;
    }
    return false;
  });

  // transport started elsewhere (Space in another tab, the Audio ▶):
  // the strip's playhead follows the shared master clock
  VB.audioTickHook = function () {
    // the strip is visible in EVERY workspace now — keep it sweeping
    if (!seqPlay.playing && seqView.canvas) renderSeqStrip();
  };

  // ---- Actors panel (actors.js; Architecture §6.6, step-2 beat 2) --------------
  // The library lists actors and their poses; clicking a pose enters the
  // journaled symbol-edit mode (editTargetSet) — the stage, the tools,
  // and every art op retarget to that pose's cell. The breadcrumb over
  // the canvas is the way back.

  function actorPanelBtn(label, title, fn) {
    var b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      fn();
    });
    return b;
  }

  // Windowed thumbnails (thumbs.js): only rows actually scrolled into
  // view render — the observer hands visible thumbs to the prefetcher,
  // most recently revealed first. Rebuilds blit fresh cache hits
  // synchronously, so scrolling and redraws stay cheap.
  var THUMB_W = 48, THUMB_H = 36;
  var thumbPriority = 0;
  var thumbIO = window.IntersectionObserver ? new IntersectionObserver(
    function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting || !en.target._vbThumb) return;
        thumbIO.unobserve(en.target);
        var req = en.target._vbThumb;
        VB.thumbRequest(req.key, req.cell, THUMB_W, THUMB_H, ++thumbPriority)
          .then(function (cv) {
            if (cv && en.target.isConnected) {
              en.target.getContext("2d").drawImage(cv, 0, 0);
            }
          });
      });
    }, { root: document.getElementById("actorlist"), rootMargin: "60px" }
  ) : null;

  function thumbCanvas(key, cell) {
    var tc = document.createElement("canvas");
    tc.className = "pthumb";
    tc.width = THUMB_W;
    tc.height = THUMB_H;
    var cached = VB.thumbGet(key, cell);
    if (cached) {
      tc.getContext("2d").drawImage(cached, 0, 0);
    } else if (thumbIO) {
      tc._vbThumb = { key: key, cell: cell };
      thumbIO.observe(tc);
    } else {
      VB.thumbRequest(key, cell, THUMB_W, THUMB_H, 0).then(function (cv) {
        if (cv && tc.isConnected) tc.getContext("2d").drawImage(cv, 0, 0);
      });
    }
    return tc;
  }

  function refreshActors() {
    var list = document.getElementById("actorlist");
    list.innerHTML = "";
    var t = app.project.editTarget;
    (app.project.actors || []).forEach(function (a) {
      var row = document.createElement("div");
      row.className = "actrow" + (t && t.actor === a.id ? " active" : "");
      if (a.poses[0]) { // drag the thumb onto the stage to PLACE
        var athumb = thumbCanvas("pose:" + a.poses[0].id, a.poses[0].cell);
        athumb.title = "Drag onto the stage to place this actor";
        wirePlaceDrag(athumb, "actor", a.id, row);
        row.appendChild(athumb);
      }
      var name = document.createElement("span");
      name.className = "aname";
      name.textContent = a.name;
      name.title = "Double-click to rename";
      name.addEventListener("dblclick", function () {
        var n = prompt("Actor name", a.name);
        if (n && n !== a.name) {
          app.exec({ op: "actorRename", actor: a.id, name: n });
        }
      });
      row.appendChild(name);
      row.appendChild(actorPanelBtn("＋", "New pose", function () {
        app.exec({ op: "poseAdd", actor: a.id, id: VB.actorNewId("pose") });
      }));
      row.appendChild(actorPanelBtn("⭳", "Export .y2kactor", function () {
        var bytes = VB.encodeY2KActor(a);
        var blob = new Blob([bytes], { type: "application/json" });
        var link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = a.name.replace(/[^\w\- ]+/g, "_") + ".y2kactor";
        link.click();
        URL.revokeObjectURL(link.href);
      }));
      row.appendChild(actorPanelBtn("✕", "Delete actor", function () {
        if (!confirm('Delete actor "' + a.name + '"?')) return;
        if (t && t.actor === a.id) app.exec({ op: "editTargetClear" });
        app.exec({ op: "actorRemove", actor: a.id });
      }));
      list.appendChild(row);
      a.poses.forEach(function (p) {
        var pr = document.createElement("div");
        var editing = t && t.actor === a.id && t.pose === p.id;
        pr.className = "actrow posesub" + (editing ? " editing" : "");
        pr.title = "Edit this pose's art";
        pr.appendChild(thumbCanvas("pose:" + p.id, p.cell));
        var pn = document.createElement("span");
        pn.className = "aname";
        pn.textContent = (editing ? "✎ " : "") + p.name;
        pr.appendChild(pn);
        pr.addEventListener("click", function () {
          if (editing) return;
          app.exec({ op: "editTargetSet", target: { actor: a.id, pose: p.id } });
          fitView();
        });
        list.appendChild(pr);
      });
    });
    // library objects: symbols (converted selections) and backgrounds
    (app.project.library || []).forEach(function (entry) {
      var row = document.createElement("div");
      var editing = t && t.librarySymbol === entry.id;
      row.className = "actrow" + (editing ? " active" : "");
      row.title = entry.kind + " — click to edit its art · drag the " +
        "thumbnail onto the stage to place it";
      var lthumb = thumbCanvas("lib:" + entry.id, entry.cell);
      wirePlaceDrag(lthumb,
        entry.kind === "background" ? "background" : "symbol",
        entry.id, row);
      row.appendChild(lthumb);
      var nm = document.createElement("span");
      nm.className = "aname";
      nm.textContent = (entry.kind === "background" ? "🖼 " : "◆ ") + entry.name;
      nm.title = "Double-click to rename";
      nm.addEventListener("dblclick", function (ev) {
        ev.stopPropagation();
        var n = prompt("Name", entry.name);
        if (n && n !== entry.name) {
          app.exec({ op: "symbolRename", id: entry.id, name: n });
        }
      });
      row.appendChild(nm);
      row.appendChild(actorPanelBtn("✕", "Delete from the library", function () {
        if (!confirm('Delete "' + entry.name + '" from the library?')) return;
        if (editing) app.exec({ op: "editTargetClear" });
        app.exec({ op: "symbolRemove", id: entry.id });
      }));
      row.addEventListener("click", function () {
        if (editing) return;
        app.exec({ op: "editTargetSet",
                   target: { librarySymbol: entry.id } });
        fitView();
      });
      list.appendChild(row);
    });
  }

  // Layer/scene structure ops make no sense inside an actor cell; the
  // crumb is the only way back so the mode is always visible.
  function syncEditCrumb() {
    var res = app.project.resolveEditCell ? app.project.resolveEditCell() : null;
    document.getElementById("editcrumb").classList.toggle("hidden", !res);
    if (res) document.getElementById("crumb-label").textContent = res.label;
    ["btn-layer-add", "btn-layer-del", "btn-layer-up", "btn-layer-down",
     "btn-scene-add", "scene-select",
     "tl-play", "tl-add", "tl-del"].forEach(function (id) {
      document.getElementById(id).disabled = !!res;
    });
  }

  document.getElementById("crumb-back").addEventListener("click", function () {
    app.exec({ op: "editTargetClear" });
    fitView();
  });

  document.getElementById("btn-actor-add").addEventListener("click", function () {
    app.exec({ op: "actorAdd", id: VB.actorNewId("actor"),
               poseId: VB.actorNewId("pose") });
  });

  document.getElementById("btn-bg-add").addEventListener("click", function () {
    app.exec({ op: "symbolCreate", id: VB.actorNewId("bg"),
               kind: "background" });
    setMsg("background added to the library — click it to paint");
  });

  var actorImportInput = document.getElementById("actor-import-file");
  document.getElementById("btn-actor-import").addEventListener("click", function () {
    actorImportInput.click();
  });
  actorImportInput.addEventListener("change", function () {
    var file = actorImportInput.files && actorImportInput.files[0];
    actorImportInput.value = "";
    if (!file) return;
    file.arrayBuffer().then(function (buf) {
      var actor = VB.decodeY2KActor(new Uint8Array(buf));
      app.exec({ op: "actorImport", actor: actor });
      toast("Imported actor “" + actor.name + "”");
    }, function () {
      toast("Import failed: unreadable file", 5000);
    }).catch(function (err) {
      toast("Import failed: " + err.message, 5000);
    });
  });

  // App-owned right-click (user directive): the browser context menu
  // never shows — right-click is reserved for app menus (the canvas
  // #ctxmenu today, per-workspace menus later). Editable text keeps the
  // native menu: paste and spellcheck are expected in a writing tool.
  document.addEventListener("contextmenu", function (ev) {
    var el = ev.target;
    var tag = el && el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" ||
        (el && el.isContentEditable)) return;
    ev.preventDefault();
  });

  // ---- app context menu ----------------------------------------------------------
  // One floating menu for every right-click action in the app; any
  // pointer-down elsewhere dismisses it.
  var appMenuEl = null;
  app.hideMenu = function () {
    if (appMenuEl && appMenuEl.parentElement) {
      appMenuEl.parentElement.removeChild(appMenuEl);
    }
    appMenuEl = null;
  };
  app.showMenu = function (x, y, items) {
    app.hideMenu();
    var menu = document.createElement("div");
    menu.id = "appmenu";
    items.forEach(function (it) {
      var row = document.createElement("div");
      row.className = "appmenuitem";
      row.textContent = it.label;
      row.addEventListener("pointerdown", function (ev) {
        ev.stopPropagation();
        app.hideMenu();
        it.fn();
      });
      menu.appendChild(row);
    });
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - 190)) + "px";
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - 30 * items.length - 10)) + "px";
    document.body.appendChild(menu);
    appMenuEl = menu;
  };
  window.addEventListener("pointerdown", function () { app.hideMenu(); }, true);

  // the editor canvas: right-click a selection → library actions
  canvas.addEventListener("contextmenu", function (ev) {
    var clip = app.currentSelectionClip();
    if (!clip) return;
    app.showMenu(ev.clientX, ev.clientY, [
      { label: "Convert to Symbol", fn: app.convertSelectionToSymbol }
    ]);
  });

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
    docChanged(); // panels (layers, materials) reflect the demo doc
    toggleDebug();
    app.debugPin = Math.min(9, d.edges.length - 1);
    refreshDebugEdge();
    fitView();
  }

  // Expose for debugging / tests.
  window.VBApp = app;
  window.VBAppLoad = loadArrayBuffer;
})();
