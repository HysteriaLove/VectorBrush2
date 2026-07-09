/* brainstorm.js — the Brainstorm workspace (Architecture §6.1, thin
 * slice): an infinite pannable board of placeable items — text notes,
 * dropped images, and ink sketch patches. No layers (decided): z-order
 * is array order, and moving an item brings it to front.
 *
 * Thin means thin UI, never thin model: every mutation is a journaled
 * op with the id carried in the op, so live and replay build identical
 * boards, undo/redo ride project history, and .y2kproj persistence is
 * free. Pan/zoom is view state and never journals.
 *
 * Snapshot contract (history.js): ops may mutate item FIELDS in place
 * (x, y, w, h) after the history push, but item CONTENT values are
 * copy-on-write — noteEdit replaces the string, noteInk replaces the
 * strokes array — so history can share content by reference.
 */
(function () {
  "use strict";

  // ---- model + ops -----------------------------------------------------------

  function notesOf(project) {
    project.notes = project.notes || { items: [] };
    return project.notes;
  }

  function noteById(project, id) {
    var items = notesOf(project).items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return { item: items[i], index: i };
    }
    return null;
  }

  VB.defineOp("noteAdd", function (c, op) {
    c.history.push(c.project);
    notesOf(c.project).items.push({
      id: op.id, kind: op.kind,
      x: op.x, y: op.y, w: op.w, h: op.h,
      content: op.content === undefined ? null
        : JSON.parse(JSON.stringify(op.content))
    });
    c.sync();
  });

  // move also brings the item to FRONT (z = array order)
  VB.defineOp("noteMove", function (c, op) {
    var hit = noteById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.item.x = op.x;
    hit.item.y = op.y;
    var items = notesOf(c.project).items;
    items.splice(hit.index, 1);
    items.push(hit.item);
    c.sync();
  });

  VB.defineOp("noteResize", function (c, op) {
    var hit = noteById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.item.w = Math.max(24, op.w);
    hit.item.h = Math.max(24, op.h);
    c.sync();
  });

  VB.defineOp("noteEdit", function (c, op) {
    var hit = noteById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.item.content = op.content;
    c.sync();
  });

  // append one ink stroke to a sketch patch (copy-on-write)
  VB.defineOp("noteInk", function (c, op) {
    var hit = noteById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    var old = hit.item.content && hit.item.content.strokes
      ? hit.item.content.strokes : [];
    hit.item.content = {
      strokes: old.concat([JSON.parse(JSON.stringify(op.stroke))])
    };
    c.sync();
  });

  VB.defineOp("noteRemove", function (c, op) {
    var hit = noteById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    notesOf(c.project).items.splice(hit.index, 1);
    c.sync();
  });

  // ---- board view (DOM; mounted by the shell into its workspace tab) -----------

  var view = {
    host: null, app: null, board: null, layer: null,
    pan: { x: 60, y: 50 }, zoom: 1, inkMode: false
  };

  function boardPoint(ev) {
    var rect = view.board.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left - view.pan.x) / view.zoom,
      y: (ev.clientY - rect.top - view.pan.y) / view.zoom
    };
  }

  function applyPanZoom() {
    view.layer.style.transform = "translate(" + view.pan.x + "px," +
      view.pan.y + "px) scale(" + view.zoom + ")";
  }

  function drawSketch(cv, item) {
    cv.width = item.w;
    cv.height = item.h;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#fffef2";
    ctx.fillRect(0, 0, item.w, item.h);
    var strokes = item.content && item.content.strokes
      ? item.content.strokes : [];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    strokes.forEach(function (s) {
      if (!s.pts.length) return;
      ctx.strokeStyle = s.color || "#222";
      ctx.lineWidth = s.width || 2;
      ctx.beginPath();
      ctx.moveTo(s.pts[0].x, s.pts[0].y);
      for (var i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
      ctx.stroke();
    });
  }

  function isEditingText() {
    var el = document.activeElement;
    return !!(el && view.host && view.host.contains(el) &&
              el.classList && el.classList.contains("bbtext"));
  }

  function refresh() {
    if (!view.host || isEditingText()) return;
    view.layer.innerHTML = "";
    notesOf(view.app.project).items.forEach(function (item) {
      var el = document.createElement("div");
      el.className = "bbitem bb-" + item.kind;
      el.dataset.id = item.id;
      el.style.left = item.x + "px";
      el.style.top = item.y + "px";
      el.style.width = item.w + "px";
      el.style.height = item.h + "px";
      if (item.kind === "text") {
        var tx = document.createElement("div");
        tx.className = "bbtext";
        tx.textContent = item.content || "";
        tx.title = "Double-click to edit";
        el.appendChild(tx);
      } else if (item.kind === "image") {
        var img = document.createElement("img");
        img.src = item.content;
        img.draggable = false;
        el.appendChild(img);
      } else if (item.kind === "sketch") {
        var cv = document.createElement("canvas");
        drawSketch(cv, item);
        el.appendChild(cv);
      }
      var del = document.createElement("div");
      del.className = "bbdel";
      del.textContent = "✕";
      del.title = "Delete";
      el.appendChild(del);
      var rs = document.createElement("div");
      rs.className = "bbresize";
      rs.title = "Drag to resize";
      el.appendChild(rs);
      view.layer.appendChild(el);
    });
    applyPanZoom();
  }

  function exec(op) {
    view.app.exec(op);
    refresh();
  }

  function addTextAtCenter() {
    var rect = view.board.getBoundingClientRect();
    var cx = (rect.width / 2 - view.pan.x) / view.zoom;
    var cy = (rect.height / 2 - view.pan.y) / view.zoom;
    var id = VB.actorNewId("note");
    exec({ op: "noteAdd", id: id, kind: "text",
           x: Math.round(cx - 90), y: Math.round(cy - 60),
           w: 180, h: 120, content: "" });
    // open the fresh note for typing
    var el = view.layer.querySelector('[data-id="' + id + '"] .bbtext');
    if (el) beginTextEdit(el, id);
  }

  function addSketchAtCenter() {
    var rect = view.board.getBoundingClientRect();
    var cx = (rect.width / 2 - view.pan.x) / view.zoom;
    var cy = (rect.height / 2 - view.pan.y) / view.zoom;
    exec({ op: "noteAdd", id: VB.actorNewId("note"), kind: "sketch",
           x: Math.round(cx - 120), y: Math.round(cy - 80),
           w: 240, h: 160, content: { strokes: [] } });
  }

  function addImageFile(file, at) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 320 / Math.max(img.width, img.height));
        exec({ op: "noteAdd", id: VB.actorNewId("note"), kind: "image",
               x: Math.round(at.x), y: Math.round(at.y),
               w: Math.max(24, Math.round(img.width * scale)),
               h: Math.max(24, Math.round(img.height * scale)),
               content: reader.result });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function beginTextEdit(tx, id) {
    tx.contentEditable = "true";
    tx.focus();
    var sel = window.getSelection();
    sel.selectAllChildren(tx);
    sel.collapseToEnd();
    tx.addEventListener("blur", function onBlur() {
      tx.removeEventListener("blur", onBlur);
      tx.contentEditable = "false";
      var hit = noteById(view.app.project, id);
      var next = tx.textContent;
      if (hit && next !== (hit.item.content || "")) {
        exec({ op: "noteEdit", id: id, content: next });
      } else {
        refresh();
      }
    });
  }

  function mount(host, app) {
    if (view.host === host) { view.app = app; refresh(); return; }
    unmount();
    view.host = host;
    view.app = app;
    host.innerHTML = "";

    var bar = document.createElement("div");
    bar.id = "bb-tools";
    function toolBtn(label, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }
    bar.appendChild(toolBtn("＋ Note", "Add a text note", addTextAtCenter));
    var imgInput = document.createElement("input");
    imgInput.type = "file";
    imgInput.accept = "image/*";
    imgInput.style.display = "none";
    imgInput.addEventListener("change", function () {
      var f = imgInput.files && imgInput.files[0];
      imgInput.value = "";
      if (!f) return;
      var rect = view.board.getBoundingClientRect();
      addImageFile(f, {
        x: (rect.width / 2 - view.pan.x) / view.zoom - 120,
        y: (rect.height / 2 - view.pan.y) / view.zoom - 80
      });
    });
    bar.appendChild(toolBtn("＋ Image", "Add an image (or drop one on the board)",
      function () { imgInput.click(); }));
    bar.appendChild(imgInput);
    bar.appendChild(toolBtn("＋ Sketch", "Add an ink sketch patch", addSketchAtCenter));
    var inkBtn = toolBtn("✏ Ink", "Ink mode: draw on sketch patches", function () {
      view.inkMode = !view.inkMode;
      inkBtn.classList.toggle("active", view.inkMode);
    });
    bar.appendChild(inkBtn);
    var hint = document.createElement("span");
    hint.id = "bb-hint";
    hint.textContent = "drag items · drag empty space to pan · wheel zooms · double-click text to edit";
    bar.appendChild(hint);
    host.appendChild(bar);

    var board = document.createElement("div");
    board.id = "bb-canvas";
    var layer = document.createElement("div");
    layer.id = "bb-layer";
    board.appendChild(layer);
    host.appendChild(board);
    view.board = board;
    view.layer = layer;

    var drag = null;
    board.addEventListener("pointerdown", function (ev) {
      if (isEditingText()) return;
      var itemEl = ev.target.closest ? ev.target.closest(".bbitem") : null;
      if (itemEl && ev.target.classList.contains("bbdel")) {
        exec({ op: "noteRemove", id: itemEl.dataset.id });
        return;
      }
      board.setPointerCapture(ev.pointerId);
      var p = boardPoint(ev);
      if (itemEl && ev.target.classList.contains("bbresize")) {
        var hitR = noteById(view.app.project, itemEl.dataset.id);
        drag = { kind: "resize", id: itemEl.dataset.id, el: itemEl,
                 w0: hitR.item.w, h0: hitR.item.h, p0: p };
      } else if (itemEl) {
        var id = itemEl.dataset.id;
        var hit = noteById(view.app.project, id);
        if (view.inkMode && hit && hit.item.kind === "sketch") {
          drag = { kind: "ink", id: id, el: itemEl, item: hit.item,
                   pts: [{ x: p.x - hit.item.x, y: p.y - hit.item.y }] };
        } else {
          drag = { kind: "move", id: id, el: itemEl,
                   x0: hit.item.x, y0: hit.item.y, p0: p, moved: false };
        }
      } else {
        drag = { kind: "pan", p0: { x: ev.clientX, y: ev.clientY },
                 pan0: { x: view.pan.x, y: view.pan.y } };
      }
    });
    board.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      var p;
      if (drag.kind === "pan") {
        view.pan.x = drag.pan0.x + ev.clientX - drag.p0.x;
        view.pan.y = drag.pan0.y + ev.clientY - drag.p0.y;
        applyPanZoom();
      } else if (drag.kind === "move") {
        p = boardPoint(ev);
        drag.moved = true;
        drag.el.style.left = (drag.x0 + p.x - drag.p0.x) + "px";
        drag.el.style.top = (drag.y0 + p.y - drag.p0.y) + "px";
      } else if (drag.kind === "resize") {
        p = boardPoint(ev);
        drag.el.style.width = Math.max(24, drag.w0 + p.x - drag.p0.x) + "px";
        drag.el.style.height = Math.max(24, drag.h0 + p.y - drag.p0.y) + "px";
      } else if (drag.kind === "ink") {
        p = boardPoint(ev);
        drag.pts.push({ x: p.x - drag.item.x, y: p.y - drag.item.y });
        var cv = drag.el.querySelector("canvas");
        var ctx = cv.getContext("2d");
        var a = drag.pts[drag.pts.length - 2], b = drag.pts[drag.pts.length - 1];
        ctx.strokeStyle = "#222";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    });
    function endDrag(ev) {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (d.kind === "move" && d.moved) {
        var p = boardPoint(ev);
        exec({ op: "noteMove", id: d.id,
               x: Math.round(d.x0 + p.x - d.p0.x),
               y: Math.round(d.y0 + p.y - d.p0.y) });
      } else if (d.kind === "resize") {
        var q = boardPoint(ev);
        exec({ op: "noteResize", id: d.id,
               w: Math.round(Math.max(24, d.w0 + q.x - d.p0.x)),
               h: Math.round(Math.max(24, d.h0 + q.y - d.p0.y)) });
      } else if (d.kind === "ink" && d.pts.length > 1) {
        exec({ op: "noteInk", id: d.id, stroke: {
          color: "#222", width: 2,
          pts: d.pts.map(function (pt) {
            return { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 };
          })
        } });
      }
    }
    board.addEventListener("pointerup", endDrag);
    board.addEventListener("pointercancel", function () { drag = null; });

    board.addEventListener("dblclick", function (ev) {
      var tx = ev.target.closest ? ev.target.closest(".bbtext") : null;
      if (!tx) return;
      var itemEl = tx.closest(".bbitem");
      beginTextEdit(tx, itemEl.dataset.id);
    });

    board.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var rect = board.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      var next = Math.max(0.15, Math.min(4, view.zoom * factor));
      // zoom around the cursor
      view.pan.x = mx - (mx - view.pan.x) * (next / view.zoom);
      view.pan.y = my - (my - view.pan.y) * (next / view.zoom);
      view.zoom = next;
      applyPanZoom();
    }, { passive: false });

    board.addEventListener("dragover", function (ev) { ev.preventDefault(); });
    board.addEventListener("drop", function (ev) {
      ev.preventDefault();
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (!files || !files.length) return;
      var p = boardPoint(ev);
      for (var i = 0; i < files.length; i++) {
        if (/^image\//.test(files[i].type)) {
          addImageFile(files[i], { x: p.x + i * 24, y: p.y + i * 24 });
        }
      }
    });

    refresh();
  }

  function unmount() {
    if (!view.host) return;
    view.host.innerHTML = "";
    view.host = null;
    view.board = null;
    view.layer = null;
  }

  window.VB = window.VB || {};
  VB.noteById = noteById;
  VB.BrainstormView = {
    mount: mount,
    unmount: unmount,
    refresh: refresh,
    isMounted: function () { return !!view.host; }
  };
})();
