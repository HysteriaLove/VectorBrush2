/* brainstorm.js — the Brainstorm workspace (Architecture §6.1): an
 * infinite board of placeable items (text notes, images, ink sketch
 * patches) OVER a shared vector canvas painted with the REAL editor
 * tools.
 *
 * Interaction model (user-specified): middle-mouse drags pan; the
 * wheel zooms around the cursor; left-drag on empty space is a marquee
 * that selects one or more items; drag moves the selection; Delete
 * removes it; double-click edits a text note in place. The "Draw"
 * toggle enters vector mode: pointer events route to the SAME tool
 * objects as the stage (pencil/line/oval/rect/brush/bucket/eraser,
 * with the topbar's colors, widths, and materials), committing
 * journaled art ops into the board's own y2kvector cell
 * (project.notesCanvas()) through the journaled editTarget — so board
 * ink replays byte-exact like everything else.
 *
 * Thin means thin UI, never thin model: every mutation is a journaled
 * op with the id carried in the op. Pan/zoom/selection are view state
 * and never journal. Snapshot contract (history.js): ops may mutate
 * item FIELDS in place after the history push, but item CONTENT values
 * are copy-on-write, so history shares content by reference.
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

  // group move: ONE undo step; the group comes to front preserving its
  // relative stacking order (moves are listed back-to-front)
  VB.defineOp("noteMoveMany", function (c, op) {
    c.history.push(c.project);
    var items = notesOf(c.project).items;
    op.moves.forEach(function (m) {
      var hit = noteById(c.project, m.id);
      if (!hit) return;
      hit.item.x = m.x;
      hit.item.y = m.y;
      items.splice(hit.index, 1);
      items.push(hit.item);
    });
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

  VB.defineOp("noteRemoveMany", function (c, op) {
    c.history.push(c.project);
    var drop = {};
    op.ids.forEach(function (id) { drop[id] = true; });
    var notes = notesOf(c.project);
    notes.items = notes.items.filter(function (it) { return !drop[it.id]; });
    c.sync();
  });

  // ---- board view (DOM; mounted by the shell into its workspace tab) -----------

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
    host: null, app: null, board: null, layer: null, ink: null,
    marquee: null, toolStrip: null, drawBtn: null,
    pan: { x: 60, y: 50 }, zoom: 1,
    drawMode: false, selected: {}
  };

  function boardPoint(ev) {
    var rect = view.board.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left - view.pan.x) / view.zoom,
      y: (ev.clientY - rect.top - view.pan.y) / view.zoom
    };
  }

  function toTwips(p) { return { x: p.x * VB.TWIPS, y: p.y * VB.TWIPS }; }

  function applyPanZoom() {
    view.layer.style.transform = "translate(" + view.pan.x + "px," +
      view.pan.y + "px) scale(" + view.zoom + ")";
    renderInk();
  }

  /** The vector layer: the notes canvas + (in draw mode) the live tool
   *  overlay, oracle-rendered under the note items. */
  function renderInk() {
    if (!view.ink) return;
    var cvs = view.ink;
    var w = view.board.clientWidth, h = view.board.clientHeight;
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    var ctx = cvs.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var s = view.zoom / VB.TWIPS;
    ctx.setTransform(s, 0, 0, s, view.pan.x, view.pan.y);
    var cell = view.app.project.notes && view.app.project.notes.canvas;
    if (cell) {
      VB.renderDocContent(ctx, cell, { zoom: view.zoom, dpr: 1 });
    }
    if (view.drawMode) {
      var tool = view.app.toolByName(view.app.tool);
      if (tool && tool.drawOverlay) {
        try { tool.drawOverlay(ctx); } catch (e) { /* overlay only */ }
      }
    }
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
    strokes.forEach(function (st) {
      if (!st.pts.length) return;
      ctx.strokeStyle = st.color || "#222";
      ctx.lineWidth = st.width || 2;
      ctx.beginPath();
      ctx.moveTo(st.pts[0].x, st.pts[0].y);
      for (var i = 1; i < st.pts.length; i++) ctx.lineTo(st.pts[i].x, st.pts[i].y);
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
    // prune stale selection
    Object.keys(view.selected).forEach(function (id) {
      if (!noteById(view.app.project, id)) delete view.selected[id];
    });
    view.layer.innerHTML = "";
    notesOf(view.app.project).items.forEach(function (item) {
      var el = document.createElement("div");
      el.className = "bbitem bb-" + item.kind +
        (view.selected[item.id] ? " selected" : "");
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
    view.layer.classList.toggle("nohit", view.drawMode);
    applyPanZoom();
  }

  function exec(op) {
    view.app.exec(op);
    refresh();
  }

  function selectedIds() { return Object.keys(view.selected); }

  function setDrawMode(on) {
    if (on === view.drawMode) return;
    view.drawMode = on;
    view.drawBtn.classList.toggle("active", on);
    view.toolStrip.style.display = on ? "inline-flex" : "none";
    view.selected = {};
    if (on) {
      view.app.exec({ op: "editTargetSet", target: { notes: true } });
      if (!DRAW_SET[view.app.tool]) view.app.switchTool("pencil");
      syncToolStrip();
    } else {
      var t = view.app.project.editTarget;
      if (t && t.notes) view.app.exec({ op: "editTargetClear" });
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

  function addTextAtCenter() {
    var rect = view.board.getBoundingClientRect();
    var cx = (rect.width / 2 - view.pan.x) / view.zoom;
    var cy = (rect.height / 2 - view.pan.y) / view.zoom;
    var id = VB.actorNewId("note");
    exec({ op: "noteAdd", id: id, kind: "text",
           x: Math.round(cx - 90), y: Math.round(cy - 60),
           w: 180, h: 120, content: "" });
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

  function onKeyDown(ev) {
    if (!view.host || !document.body.classList.contains("ws-board-mode")) return;
    if (isEditingText()) return;
    var tag = ev.target && ev.target.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
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
    if ((ev.key === "Delete" || ev.key === "Backspace") && !view.drawMode) {
      var ids = selectedIds();
      if (ids.length) {
        ev.preventDefault();
        view.selected = {};
        exec({ op: "noteRemoveMany", ids: ids });
      }
      return;
    }
    if (ev.key === "Escape") {
      if (view.drawMode) setDrawMode(false);
      else { view.selected = {}; refresh(); }
      return;
    }
    if (view.drawMode && !ev.ctrlKey && !ev.altKey) {
      var toolKeys = { p: "pencil", n: "line", o: "oval", r: "rect",
                       b: "brush", k: "bucket", e: "eraser" };
      var k = ev.key.toLowerCase();
      if (toolKeys[k]) {
        view.app.switchTool(toolKeys[k]);
        syncToolStrip();
        renderInk();
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

    view.drawBtn = toolBtn("✎ Draw", "Vector draw mode: paint on the board " +
      "with the stage tools", function () { setDrawMode(!view.drawMode); });
    bar.appendChild(view.drawBtn);

    var strip = document.createElement("span");
    strip.id = "bb-toolstrip";
    strip.style.display = "none";
    DRAW_TOOLS.forEach(function (t) {
      var b = document.createElement("button");
      b.dataset.tool = t[0];
      b.textContent = t[1];
      b.title = t[2];
      b.addEventListener("click", function () {
        view.app.switchTool(t[0]);
        syncToolStrip();
        renderInk();
      });
      strip.appendChild(b);
    });
    view.toolStrip = strip;
    bar.appendChild(strip);

    var hint = document.createElement("span");
    hint.id = "bb-hint";
    hint.textContent = "middle-drag pans · wheel zooms · left-drag selects · double-click text edits";
    bar.appendChild(hint);
    host.appendChild(bar);

    var board = document.createElement("div");
    board.id = "bb-canvas";
    var ink = document.createElement("canvas");
    ink.id = "bb-ink";
    board.appendChild(ink);
    var layer = document.createElement("div");
    layer.id = "bb-layer";
    board.appendChild(layer);
    var marquee = document.createElement("div");
    marquee.id = "bb-marquee";
    marquee.style.display = "none";
    board.appendChild(marquee);
    host.appendChild(board);
    view.board = board;
    view.layer = layer;
    view.ink = ink;
    view.marquee = marquee;

    var drag = null;
    var activeTool = null;

    function screenPoint(ev) {
      var rect = board.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    board.addEventListener("pointerdown", function (ev) {
      if (isEditingText()) return;
      // middle mouse ALWAYS pans
      if (ev.button === 1) {
        ev.preventDefault();
        board.setPointerCapture(ev.pointerId);
        drag = { kind: "pan", p0: { x: ev.clientX, y: ev.clientY },
                 pan0: { x: view.pan.x, y: view.pan.y } };
        return;
      }
      if (ev.button !== 0) return;
      board.setPointerCapture(ev.pointerId);
      // draw mode: route to the real stage tools, in twips
      if (view.drawMode) {
        activeTool = view.app.toolByName(view.app.tool);
        if (activeTool && activeTool.onDown) {
          activeTool.onDown(toTwips(boardPoint(ev)));
          renderInk();
        }
        drag = { kind: "tool" };
        return;
      }
      var itemEl = ev.target.closest ? ev.target.closest(".bbitem") : null;
      if (itemEl && ev.target.classList.contains("bbdel")) {
        delete view.selected[itemEl.dataset.id];
        exec({ op: "noteRemove", id: itemEl.dataset.id });
        return;
      }
      var p = boardPoint(ev);
      if (itemEl && ev.target.classList.contains("bbresize")) {
        var hitR = noteById(view.app.project, itemEl.dataset.id);
        drag = { kind: "resize", id: itemEl.dataset.id, el: itemEl,
                 w0: hitR.item.w, h0: hitR.item.h, p0: p };
      } else if (itemEl) {
        var id = itemEl.dataset.id;
        if (ev.shiftKey) {
          if (view.selected[id]) delete view.selected[id];
          else view.selected[id] = true;
          refresh();
          return;
        }
        if (!view.selected[id]) {
          view.selected = {};
          view.selected[id] = true;
          refresh();
          itemEl = view.layer.querySelector('[data-id="' + id + '"]');
        }
        // drag every selected item together
        var parts = selectedIds().map(function (sid) {
          var hit = noteById(view.app.project, sid);
          return { id: sid, x0: hit.item.x, y0: hit.item.y,
                   el: view.layer.querySelector('[data-id="' + sid + '"]') };
        });
        drag = { kind: "move", p0: p, parts: parts, moved: false };
      } else {
        // left-drag on empty board: marquee selection
        drag = { kind: "marquee", s0: screenPoint(ev), p0: p };
        if (!ev.shiftKey) { view.selected = {}; refresh(); }
      }
    });

    board.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      var p;
      if (drag.kind === "pan") {
        view.pan.x = drag.pan0.x + ev.clientX - drag.p0.x;
        view.pan.y = drag.pan0.y + ev.clientY - drag.p0.y;
        applyPanZoom();
      } else if (drag.kind === "tool") {
        if (activeTool && activeTool.onMove) {
          activeTool.onMove(toTwips(boardPoint(ev)));
          renderInk();
        }
      } else if (drag.kind === "move") {
        p = boardPoint(ev);
        drag.moved = true;
        drag.parts.forEach(function (part) {
          if (!part.el) return;
          part.el.style.left = (part.x0 + p.x - drag.p0.x) + "px";
          part.el.style.top = (part.y0 + p.y - drag.p0.y) + "px";
        });
      } else if (drag.kind === "resize") {
        p = boardPoint(ev);
        drag.el.style.width = Math.max(24, drag.w0 + p.x - drag.p0.x) + "px";
        drag.el.style.height = Math.max(24, drag.h0 + p.y - drag.p0.y) + "px";
      } else if (drag.kind === "marquee") {
        var s = screenPoint(ev);
        var x = Math.min(drag.s0.x, s.x), y = Math.min(drag.s0.y, s.y);
        view.marquee.style.display = "block";
        view.marquee.style.left = x + "px";
        view.marquee.style.top = y + "px";
        view.marquee.style.width = Math.abs(s.x - drag.s0.x) + "px";
        view.marquee.style.height = Math.abs(s.y - drag.s0.y) + "px";
      }
    });

    function endDrag(ev) {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (d.kind === "tool") {
        if (activeTool && activeTool.onUp) {
          activeTool.onUp(toTwips(boardPoint(ev)));
          activeTool = null;
          renderInk();
        }
        return;
      }
      if (d.kind === "move" && d.moved) {
        var p = boardPoint(ev);
        exec({ op: "noteMoveMany", moves: d.parts.map(function (part) {
          return { id: part.id,
                   x: Math.round(part.x0 + p.x - d.p0.x),
                   y: Math.round(part.y0 + p.y - d.p0.y) };
        }) });
      } else if (d.kind === "resize") {
        var q = boardPoint(ev);
        exec({ op: "noteResize", id: d.id,
               w: Math.round(Math.max(24, d.w0 + q.x - d.p0.x)),
               h: Math.round(Math.max(24, d.h0 + q.y - d.p0.y)) });
      } else if (d.kind === "marquee") {
        view.marquee.style.display = "none";
        var pEnd = boardPoint(ev);
        var rx0 = Math.min(d.p0.x, pEnd.x), rx1 = Math.max(d.p0.x, pEnd.x);
        var ry0 = Math.min(d.p0.y, pEnd.y), ry1 = Math.max(d.p0.y, pEnd.y);
        if (rx1 - rx0 > 3 || ry1 - ry0 > 3) {
          notesOf(view.app.project).items.forEach(function (it) {
            if (it.x < rx1 && it.x + it.w > rx0 &&
                it.y < ry1 && it.y + it.h > ry0) {
              view.selected[it.id] = true;
            }
          });
          refresh();
        }
      }
    }
    board.addEventListener("pointerup", endDrag);
    board.addEventListener("pointercancel", function () {
      if (drag && drag.kind === "tool" && activeTool && activeTool.cancel) {
        activeTool.cancel();
        activeTool = null;
      }
      drag = null;
      view.marquee.style.display = "none";
    });

    board.addEventListener("dblclick", function (ev) {
      if (view.drawMode) return;
      var tx = ev.target.closest ? ev.target.closest(".bbtext") : null;
      if (!tx) return;
      ev.preventDefault();
      ev.stopPropagation();
      var itemEl = tx.closest(".bbitem");
      beginTextEdit(tx, itemEl.dataset.id);
    });

    board.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var rect = board.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      var next = Math.max(0.15, Math.min(4, view.zoom * factor));
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

    window.addEventListener("keydown", onKeyDown);
    // the ink canvas sizes from its container: re-render when the
    // container settles or resizes (tab-in happens before layout — the
    // half-drawn-canvas bug)
    if (window.ResizeObserver) {
      view.ro = new ResizeObserver(function () { renderInk(); });
      view.ro.observe(board);
    }
    refresh();
  }

  function unmount() {
    if (!view.host) return;
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    window.removeEventListener("keydown", onKeyDown);
    // never leave the journal pointed at the board's canvas
    var t = view.app && view.app.project.editTarget;
    if (view.drawMode && t && t.notes) {
      view.app.exec({ op: "editTargetClear" });
    }
    view.drawMode = false;
    view.selected = {};
    view.host.innerHTML = "";
    view.host = null;
    view.board = null;
    view.layer = null;
    view.ink = null;
    view.marquee = null;
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
