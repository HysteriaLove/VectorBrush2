/* main.js — GUI shell: canvas viewport, toolbar, file I/O.
 *
 * Tools other than Select are palette placeholders for the next
 * milestones (pencil, bucket, eraser); the document/view plumbing they
 * will need (twips<->screen mapping, re-render loop) is all here.
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
    view: { zoom: 1, panX: 40, panY: 40, dpr: window.devicePixelRatio || 1 }
  };

  // ---- rendering loop ------------------------------------------------------

  var renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      VB.render(ctx, app.doc, app.view);
    });
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

  function setZoom(zoom, cx, cy) {
    zoom = Math.min(64, Math.max(0.02, zoom));
    if (cx === undefined) {
      var r = canvas.getBoundingClientRect();
      cx = r.width / 2; cy = r.height / 2;
    }
    var v = app.view;
    var sx = (cx - v.panX) / v.zoom;   // stage px under the anchor
    var sy = (cy - v.panY) / v.zoom;
    v.zoom = zoom;
    v.panX = cx - sx * zoom;
    v.panY = cy - sy * zoom;
    updateStatus();
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
    updateStatus();
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
      "zoom " + Math.round(app.view.zoom * 100) + "%";
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
      document.getElementById("drophint").classList.add("hidden");
      document.getElementById("fileinfo").textContent =
        name + " · " + kind + " · " + bytes.length.toLocaleString() + " B";
      var warn = (result.info.warnings || []);
      setMsg(warn.length ? warn[0] : "");
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

  // Drag & drop.
  var wrap = document.getElementById("canvaswrap");
  wrap.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  wrap.addEventListener("drop", function (ev) {
    ev.preventDefault();
    if (ev.dataTransfer.files.length) openFile(ev.dataTransfer.files[0]);
  });

  // ---- zoom / pan ----------------------------------------------------------

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

  canvas.addEventListener("pointerdown", function (ev) {
    if (ev.button === 1 || (ev.button === 0 && spaceDown)) {
      panning = { x: ev.clientX, y: ev.clientY };
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  });
  canvas.addEventListener("pointermove", function (ev) {
    if (panning) {
      app.view.panX += ev.clientX - panning.x;
      app.view.panY += ev.clientY - panning.y;
      panning = { x: ev.clientX, y: ev.clientY };
      requestRender();
    }
    var p = clientToStagePx(ev);
    document.getElementById("status-pos").textContent =
      p.x.toFixed(1) + ", " + p.y.toFixed(1) + " px (" +
      Math.round(p.x * VB.TWIPS) + ", " + Math.round(p.y * VB.TWIPS) + " twips)";
  });
  canvas.addEventListener("pointerup", function () { panning = null; });

  window.addEventListener("keydown", function (ev) {
    if (ev.code === "Space") { spaceDown = true; }
    if (ev.ctrlKey && ev.key.toLowerCase() === "o") {
      ev.preventDefault();
      fileInput.click();
    }
    var toolKeys = { v: "select", p: "pencil", b: "bucket", e: "eraser" };
    if (!ev.ctrlKey && !ev.altKey && toolKeys[ev.key.toLowerCase()]) {
      selectTool(toolKeys[ev.key.toLowerCase()]);
    }
  });
  window.addEventListener("keyup", function (ev) {
    if (ev.code === "Space") spaceDown = false;
  });

  // ---- tool palette (placeholders for the tool milestones) ------------------

  function selectTool(tool) {
    app.tool = tool;
    document.querySelectorAll("#tools button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tool === tool);
    });
    if (tool !== "select") {
      setMsg(tool + " tool is scheduled for the next milestone");
    } else {
      setMsg("");
    }
  }
  document.querySelectorAll("#tools button").forEach(function (b) {
    b.addEventListener("click", function () { selectTool(b.dataset.tool); });
  });

  // ---- boot ----------------------------------------------------------------

  resizeCanvas();
  fitView();
  updateStatus();

  // Expose for debugging / tests.
  window.VBApp = app;
  window.VBAppLoad = loadArrayBuffer;
})();
