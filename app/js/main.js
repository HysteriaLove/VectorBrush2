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
    doc: new VB.VBDocument(),
    fileName: null,
    sourceBytes: 0,
    tool: "select",
    view: { zoom: 1, panX: 40, panY: 40, dpr: window.devicePixelRatio || 1 },
    history: new VB.History(),
    strokeColor: { r: 0, g: 0, b: 0, a: 255 },
    strokeWidth: 20,          // twips (1 px), Flash's default pencil width
    fillColor: { r: 102, g: 204, b: 255, a: 255 },
    eraserWidth: 20,          // eraser diameter, px
    debug: false,
    debugHover: -1,
    debugPin: -1,
    journal: [{ op: "new", width: 550 * VB.TWIPS, height: 400 * VB.TWIPS }],
    record: function (op) { app.journal.push(op); },
    requestRender: requestRender,
    setMsg: setMsg,
    docChanged: docChanged
  };

  var tools = {
    pencil: new VB.PencilTool(app),
    bucket: new VB.BucketTool(app),
    eraser: new VB.EraserTool(app)
  };

  // ---- rendering loop ------------------------------------------------------

  var renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      VB.render(ctx, app.doc, app.view);
      var tool = tools[app.tool];
      if (tool && tool.drawOverlay) tool.drawOverlay(ctx);
      if (app.debug) {
        VB.renderDebug(ctx, app.doc, app.view,
          app.debugPin >= 0 ? app.debugPin : app.debugHover);
      }
      updateStatus();
    });
  }

  // Called after any document mutation (draw, undo, load): refreshes the
  // debug panel's style tables and record-stream stats, which are too
  // costly to rebuild on every pointer move.
  function docChanged() {
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
    document.getElementById("status-doc").textContent =
      (app.doc.width / VB.TWIPS) + "×" + (app.doc.height / VB.TWIPS) + " px · " +
      s.edges + " edges (" + s.straight + " straight, " + s.curved + " curved) · " +
      s.fills + " fills · " + s.lines + " line styles";
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
      var result, kind;
      if (VB.isVBD(bytes)) {
        result = await VB.decodeVBD(bytes);
        kind = "VBD";
      } else {
        result = await VB.parseSWF(buf);
        kind = "SWF v" + result.info.version;
      }
      app.doc = result.doc;
      app.fileName = name;
      app.sourceBytes = bytes.length;
      app.history.clear();
      app.journal.length = 0;
      app.journal.push({ op: "load", name: name, b64: VB.bytesToB64(bytes) });
      document.getElementById("drophint").classList.add("hidden");
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

  document.getElementById("btn-log").addEventListener("click", function () {
    var blob = new Blob(
      [JSON.stringify({ version: 1, ops: app.journal })],
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
      var bytes = await VB.encodeVBD(app.doc, { compress: true });
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

  var wrap = document.getElementById("canvaswrap");
  wrap.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  wrap.addEventListener("drop", function (ev) {
    ev.preventDefault();
    if (ev.dataTransfer.files.length) openFile(ev.dataTransfer.files[0]);
  });

  // ---- undo / redo -----------------------------------------------------------

  function doUndo() {
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
    if (ev.button === 0 && app.debug && app.tool === "select") {
      // debug pin: click an edge to lock the inspector on it
      var pt = clientToTwips(ev);
      var idx = VB.debugPickEdge(app.doc, pt.x, pt.y, 5 * VB.TWIPS / app.view.zoom);
      app.debugPin = idx;
      setMsg(idx >= 0 ? VB.debugDescribeEdge(app.doc, idx) : "");
      refreshDebugEdge();
      requestRender();
      return;
    }
    if (ev.button === 0) {
      var tool = tools[app.tool];
      if (tool && tool.onDown) {
        activePointerTool = tool;
        canvas.setPointerCapture(ev.pointerId);
        tool.onDown(clientToTwips(ev));
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
    } else if (tools[app.tool] && tools[app.tool].onHover) {
      tools[app.tool].onHover(clientToTwips(ev));
    } else if (app.debug) {
      // hover inspector (pin wins)
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
    var p = clientToStagePx(ev);
    document.getElementById("status-pos").textContent =
      "(" + Math.round(p.x * VB.TWIPS) + ", " + Math.round(p.y * VB.TWIPS) + ") tw · " +
      p.x.toFixed(1) + ", " + p.y.toFixed(1) + " px";
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
    if (ev.code === "Space") { spaceDown = true; }
    if (ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === "z") { ev.preventDefault(); doUndo(); return; }
    if ((ev.ctrlKey && ev.key.toLowerCase() === "y") ||
        (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "z")) { ev.preventDefault(); doRedo(); return; }
    if (ev.ctrlKey && ev.key.toLowerCase() === "o") { ev.preventDefault(); fileInput.click(); return; }
    if (ev.key === "Escape") {
      if (activePointerTool && activePointerTool.cancel) {
        activePointerTool.cancel();
        activePointerTool = null;
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
    var toolKeys = { v: "select", p: "pencil", b: "bucket", e: "eraser" };
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

  function selectTool(tool) {
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

  // ---- boot ------------------------------------------------------------------------

  resizeCanvas();
  fitView();

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
    document.getElementById("drophint").classList.add("hidden");
    toggleDebug();
    app.debugPin = Math.min(9, d.edges.length - 1);
    refreshDebugEdge();
    fitView();
  }

  // Expose for debugging / tests.
  window.VBApp = app;
  window.VBAppLoad = loadArrayBuffer;
})();
