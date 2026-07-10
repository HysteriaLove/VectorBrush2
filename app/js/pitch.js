/* pitch.js — the Pitch workspace (Architecture §6.2): a simple
 * SEQUENTIAL deck of slides used to demonstrate the idea to team
 * members. Each slide is a y2kvector cell (960×540 px) drawn with the
 * REAL stage tools through the journaled editTarget — the same
 * mechanism as actor cells and the Notepad canvas — so decks are
 * vector-native, undo through project history, and replay byte-exact.
 *
 * Present mode plays the deck full-frame with arrow-key navigation.
 * Thin UI, real model.
 */
(function () {
  "use strict";

  var SLIDE_W = 960 * 20, SLIDE_H = 540 * 20; // twips (16:9)

  // ---- model + ops -----------------------------------------------------------

  function pitchOf(project) {
    project.pitch = project.pitch || { slides: [], cur: 0 };
    return project.pitch;
  }

  function slideById(project, id) {
    var slides = pitchOf(project).slides;
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].id === id) return { slide: slides[i], index: i };
    }
    return null;
  }

  function newSlideCell() {
    var d = new VB.Y2KVectorDocument();
    d.width = SLIDE_W;
    d.height = SLIDE_H;
    return d;
  }

  VB.defineOp("pitchSlideAdd", function (c, op) {
    c.history.push(c.project);
    var pitch = pitchOf(c.project);
    var at = op.index === undefined ? pitch.slides.length
      : Math.max(0, Math.min(pitch.slides.length, op.index));
    pitch.slides.splice(at, 0, { id: op.id, cell: newSlideCell(), texts: [] });
    pitch.cur = at;
    c.sync();
  });

  // slide TEXT boxes (double-click authoring; coordinates in slide px)
  function slideTexts(slide) {
    slide.texts = slide.texts || [];
    return slide.texts;
  }

  function slideTextById(slide, id) {
    var texts = slideTexts(slide);
    for (var i = 0; i < texts.length; i++) {
      if (texts[i].id === id) return { text: texts[i], index: i };
    }
    return null;
  }

  VB.defineOp("pitchTextAdd", function (c, op) {
    var hit = slideById(c.project, op.slide);
    if (!hit) return;
    c.history.push(c.project);
    slideTexts(hit.slide).push({
      id: op.id, x: op.x, y: op.y,
      size: op.size || 28,
      content: op.text || ""
    });
    c.sync();
  });

  VB.defineOp("pitchTextEdit", function (c, op) {
    var hit = slideById(c.project, op.slide);
    var t = hit && slideTextById(hit.slide, op.id);
    if (!t) return;
    c.history.push(c.project);
    t.text.content = op.text;
    c.sync();
  });

  VB.defineOp("pitchTextMove", function (c, op) {
    var hit = slideById(c.project, op.slide);
    var t = hit && slideTextById(hit.slide, op.id);
    if (!t) return;
    c.history.push(c.project);
    t.text.x = op.x;
    t.text.y = op.y;
    c.sync();
  });

  VB.defineOp("pitchTextRemove", function (c, op) {
    var hit = slideById(c.project, op.slide);
    var t = hit && slideTextById(hit.slide, op.id);
    if (!t) return;
    c.history.push(c.project);
    slideTexts(hit.slide).splice(t.index, 1);
    c.sync();
  });

  VB.defineOp("pitchSlideMove", function (c, op) {
    var hit = slideById(c.project, op.id);
    if (!hit) return;
    var pitch = pitchOf(c.project);
    var to = Math.max(0, Math.min(pitch.slides.length - 1, op.index));
    if (to === hit.index) return;
    c.history.push(c.project);
    pitch.slides.splice(hit.index, 1);
    pitch.slides.splice(to, 0, hit.slide);
    pitch.cur = to;
    c.sync();
  });

  VB.defineOp("pitchSlideRemove", function (c, op) {
    var hit = slideById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    var pitch = pitchOf(c.project);
    pitch.slides.splice(hit.index, 1);
    pitch.cur = Math.max(0, Math.min(pitch.cur, pitch.slides.length - 1));
    c.sync();
  });

  VB.defineOp("pitchSelect", function (c, op) {
    var pitch = pitchOf(c.project);
    pitch.cur = Math.max(0, Math.min(pitch.slides.length - 1, op.index | 0));
    c.sync();
  });

  function currentSlide(project) {
    var pitch = pitchOf(project);
    return pitch.slides[pitch.cur] || null;
  }

  // ---- workspace view -----------------------------------------------------------

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
    host: null, app: null, stage: null, strip: null, texts: null,
    drawBtn: null, toolStrip: null, presentBtn: null,
    drawMode: false, present: false
  };

  function stageMetrics() {
    var w = view.stage.clientWidth, h = view.stage.clientHeight;
    var zoom = Math.min(w / (SLIDE_W / VB.TWIPS), h / (SLIDE_H / VB.TWIPS)) * 0.94;
    return {
      zoom: zoom,
      panX: (w - (SLIDE_W / VB.TWIPS) * zoom) / 2,
      panY: (h - (SLIDE_H / VB.TWIPS) * zoom) / 2
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

  function slidePx(ev) {
    var rect = view.stage.getBoundingClientRect();
    var m = stageMetrics();
    return {
      x: (ev.clientX - rect.left - m.panX) / m.zoom,
      y: (ev.clientY - rect.top - m.panY) / m.zoom
    };
  }

  function isEditingText() {
    var el = document.activeElement;
    return !!(el && view.host && view.host.contains(el) &&
              el.classList && el.classList.contains("pttext"));
  }

  /** Lay the current slide's text boxes over the stage as DOM (crisp,
   *  editable in place — double-click authoring, drag to move). */
  function layoutTexts() {
    if (!view.texts) return;
    if (isEditingText()) return;
    view.texts.innerHTML = "";
    var slide = currentSlide(view.app.project);
    if (!slide) return;
    var m = stageMetrics();
    (slide.texts || []).forEach(function (t) {
      var el = document.createElement("div");
      el.className = "pttext";
      el.dataset.id = t.id;
      el.style.left = (m.panX + t.x * m.zoom) + "px";
      el.style.top = (m.panY + t.y * m.zoom) + "px";
      el.style.fontSize = (t.size * m.zoom) + "px";
      el.textContent = t.content;
      el.title = "Double-click to edit · drag to move";
      view.texts.appendChild(el);
    });
    view.texts.classList.toggle("nohit", view.drawMode || view.present);
  }

  function beginSlideTextEdit(el, textId) {
    var slide = currentSlide(view.app.project);
    if (!slide) return;
    el.contentEditable = "true";
    el.classList.add("editing");
    el.focus();
    var sel = window.getSelection();
    sel.selectAllChildren(el);
    sel.collapseToEnd();
    el.addEventListener("blur", function onBlur() {
      el.removeEventListener("blur", onBlur);
      el.contentEditable = "false";
      el.classList.remove("editing");
      var hit = slideTextById(slide, textId);
      var next = el.innerText.replace(/\n$/, "");
      if (!hit) { layoutTexts(); return; }
      if (next.trim() === "") {
        view.app.exec({ op: "pitchTextRemove", slide: slide.id, id: textId });
      } else if (next !== hit.text.content) {
        view.app.exec({ op: "pitchTextEdit", slide: slide.id,
                        id: textId, text: next });
      }
      refresh();
    });
  }

  function renderStage() {
    if (!view.stage) return;
    var cvs = view.stage;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    var ctx = cvs.getContext("2d");
    var slide = currentSlide(view.app.project);
    if (!slide) {
      var theme = getComputedStyle(document.body);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = theme.getPropertyValue("--bg").trim() || "#e4e6e9";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = theme.getPropertyValue("--text-dim").trim() || "#6b7079";
      ctx.font = "13px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("No slides yet — add one.", w / 2, h / 2);
      return;
    }
    var m = stageMetrics();
    VB.render(ctx, slide.cell, {
      zoom: m.zoom, panX: m.panX, panY: m.panY, dpr: 1
    });
    if (view.drawMode) {
      var tool = view.app.toolByName(view.app.tool);
      if (tool && tool.drawOverlay) {
        var s = m.zoom / VB.TWIPS;
        ctx.setTransform(s, 0, 0, s, m.panX, m.panY);
        try { tool.drawOverlay(ctx); } catch (e) { /* overlay only */ }
      }
    }
  }

  function refresh() {
    if (!view.host) return;
    var pitch = pitchOf(view.app.project);
    view.strip.innerHTML = "";
    pitch.slides.forEach(function (slide, i) {
      var cellEl = document.createElement("div");
      cellEl.className = "ptthumb" + (i === pitch.cur ? " cur" : "");
      cellEl.title = "Slide " + (i + 1);
      var tc = document.createElement("canvas");
      tc.width = 96;
      tc.height = 54;
      cellEl.appendChild(tc);
      var paintThumb = function (cv) {
        if (!cv || !tc.isConnected) return;
        var tctx = tc.getContext("2d");
        tctx.drawImage(cv, 0, 0);
        // text boxes ride on top at thumb scale
        var s = 96 / (SLIDE_W / VB.TWIPS);
        tctx.fillStyle = "#222";
        (slide.texts || []).forEach(function (t) {
          tctx.font = Math.max(2, t.size * s) + "px system-ui";
          tctx.fillText(t.content.split("\n")[0], t.x * s, t.y * s + t.size * s);
        });
      };
      var cached = VB.thumbGet("pitch:" + slide.id, slide.cell);
      if (cached) {
        paintThumb(cached);
      } else {
        VB.thumbRequest("pitch:" + slide.id, slide.cell, 96, 54, i)
          .then(paintThumb);
      }
      var num = document.createElement("span");
      num.textContent = String(i + 1);
      cellEl.appendChild(num);
      cellEl.addEventListener("click", function () {
        selectSlide(i);
      });
      view.strip.appendChild(cellEl);
    });
    if (view.drawBtn) view.drawBtn.classList.toggle("active", view.drawMode);
    syncToolStrip();
    renderStage();
    layoutTexts();
  }

  function selectSlide(index) {
    var pitch = pitchOf(view.app.project);
    if (index === pitch.cur || !pitch.slides.length) { renderStage(); return; }
    view.app.exec({ op: "pitchSelect", index: index });
    if (view.drawMode) retargetDraw();
    refresh();
  }

  function retargetDraw() {
    var slide = currentSlide(view.app.project);
    if (slide) {
      view.app.exec({ op: "editTargetSet", target: { pitchSlide: slide.id } });
    }
  }

  function setDrawMode(on) {
    if (on === view.drawMode) return;
    if (on && !currentSlide(view.app.project)) return;
    view.drawMode = on;
    view.toolStrip.style.display = on ? "inline-flex" : "none";
    if (on) {
      retargetDraw();
      if (!DRAW_SET[view.app.tool]) view.app.switchTool("pencil");
    } else {
      var t = view.app.project.editTarget;
      if (t && t.pitchSlide) view.app.exec({ op: "editTargetClear" });
    }
    refresh();
  }

  function setPresent(on) {
    view.present = on;
    view.host.classList.toggle("presenting", on);
    if (on && view.drawMode) setDrawMode(false);
    renderStage();
    layoutTexts();
  }

  function syncToolStrip() {
    if (!view.toolStrip) return;
    var kids = view.toolStrip.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle("active", kids[i].dataset.tool === view.app.tool);
    }
  }

  function onKeyDown(ev) {
    if (!view.host) return;
    var tag = ev.target && ev.target.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    var pitch = pitchOf(view.app.project);
    if (view.present) {
      if (ev.key === "ArrowRight" || ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        selectSlide(Math.min(pitch.slides.length - 1, pitch.cur + 1));
      } else if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        selectSlide(Math.max(0, pitch.cur - 1));
      } else if (ev.key === "Escape") {
        setPresent(false);
      }
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
    if (ev.key === "ArrowRight" && !view.drawMode) {
      selectSlide(Math.min(pitch.slides.length - 1, pitch.cur + 1));
      return;
    }
    if (ev.key === "ArrowLeft" && !view.drawMode) {
      selectSlide(Math.max(0, pitch.cur - 1));
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

  function mount(host, app) {
    if (view.host === host) { view.app = app; refresh(); return; }
    unmount();
    view.host = host;
    view.app = app;
    host.innerHTML = "";

    var bar = document.createElement("div");
    bar.id = "pt-tools";
    function toolBtn(label, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }
    bar.appendChild(toolBtn("＋ Slide", "Add a slide after the current one",
      function () {
        var pitch = pitchOf(app.project);
        var id = VB.actorNewId("slide");
        app.exec({ op: "pitchSlideAdd", id: id,
                   index: pitch.slides.length ? pitch.cur + 1 : 0 });
        if (view.drawMode) retargetDraw();
        refresh();
      }));
    bar.appendChild(toolBtn("⇤", "Move slide left", function () {
      var pitch = pitchOf(app.project);
      var s = pitch.slides[pitch.cur];
      if (s) { app.exec({ op: "pitchSlideMove", id: s.id, index: pitch.cur - 1 }); refresh(); }
    }));
    bar.appendChild(toolBtn("⇥", "Move slide right", function () {
      var pitch = pitchOf(app.project);
      var s = pitch.slides[pitch.cur];
      if (s) { app.exec({ op: "pitchSlideMove", id: s.id, index: pitch.cur + 1 }); refresh(); }
    }));
    bar.appendChild(toolBtn("🗑", "Remove the current slide", function () {
      var pitch = pitchOf(app.project);
      var s = pitch.slides[pitch.cur];
      if (!s) return;
      if (!confirm("Remove slide " + (pitch.cur + 1) + "?")) return;
      if (view.drawMode) setDrawMode(false);
      app.exec({ op: "pitchSlideRemove", id: s.id });
      refresh();
    }));

    view.drawBtn = toolBtn("✎ Draw", "Draw on the slide with the stage tools",
      function () { setDrawMode(!view.drawMode); });
    bar.appendChild(view.drawBtn);

    var strip = document.createElement("span");
    strip.id = "pt-toolstrip";
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

    view.presentBtn = toolBtn("▶ Present", "Present the deck (arrows navigate, Esc exits)",
      function () { setPresent(!view.present); });
    bar.appendChild(view.presentBtn);

    var hint = document.createElement("span");
    hint.id = "pt-hint";
    hint.textContent = "←/→ change slides · Draw paints with the stage tools";
    bar.appendChild(hint);
    host.appendChild(bar);

    var body = document.createElement("div");
    body.id = "pt-body";
    var stage = document.createElement("canvas");
    stage.id = "pt-stage";
    body.appendChild(stage);
    var texts = document.createElement("div");
    texts.id = "pt-texts";
    body.appendChild(texts);
    host.appendChild(body);
    var stripEl = document.createElement("div");
    stripEl.id = "pt-strip";
    host.appendChild(stripEl);
    view.stage = stage;
    view.strip = stripEl;
    view.texts = texts;

    // text boxes: double-click empty slide → new box; double-click a
    // box → edit in place; drag a box → move
    var textDrag = null;
    texts.addEventListener("dblclick", function (ev) {
      if (view.drawMode || view.present) return;
      var slide = currentSlide(app.project);
      if (!slide) return;
      var box = ev.target.closest ? ev.target.closest(".pttext") : null;
      if (box) {
        ev.preventDefault();
        beginSlideTextEdit(box, box.dataset.id);
        return;
      }
      var p = slidePx(ev);
      if (p.x < 0 || p.y < 0 || p.x > SLIDE_W / VB.TWIPS ||
          p.y > SLIDE_H / VB.TWIPS) return;
      var id = VB.actorNewId("ptext");
      app.exec({ op: "pitchTextAdd", slide: slide.id, id: id,
                 x: Math.round(p.x), y: Math.round(p.y) });
      layoutTexts();
      var el = texts.querySelector('[data-id="' + id + '"]');
      if (el) beginSlideTextEdit(el, id);
    });
    texts.addEventListener("pointerdown", function (ev) {
      if (view.drawMode || view.present || ev.button !== 0) return;
      var box = ev.target.closest ? ev.target.closest(".pttext") : null;
      if (!box || box.isContentEditable) return;
      texts.setPointerCapture(ev.pointerId);
      var slide = currentSlide(app.project);
      var hit = slide && slideTextById(slide, box.dataset.id);
      if (!hit) return;
      textDrag = { el: box, id: box.dataset.id, slide: slide,
                   x0: hit.text.x, y0: hit.text.y,
                   p0: slidePx(ev), moved: false };
    });
    texts.addEventListener("pointermove", function (ev) {
      if (!textDrag) return;
      var p = slidePx(ev);
      textDrag.moved = true;
      var m = stageMetrics();
      textDrag.el.style.left =
        (m.panX + (textDrag.x0 + p.x - textDrag.p0.x) * m.zoom) + "px";
      textDrag.el.style.top =
        (m.panY + (textDrag.y0 + p.y - textDrag.p0.y) * m.zoom) + "px";
    });
    texts.addEventListener("pointerup", function (ev) {
      if (!textDrag) return;
      var d = textDrag;
      textDrag = null;
      if (!d.moved) return;
      var p = slidePx(ev);
      app.exec({ op: "pitchTextMove", slide: d.slide.id, id: d.id,
                 x: Math.round(d.x0 + p.x - d.p0.x),
                 y: Math.round(d.y0 + p.y - d.p0.y) });
      refresh();
    });
    texts.addEventListener("pointercancel", function () { textDrag = null; });

    var activeTool = null;
    stage.addEventListener("pointerdown", function (ev) {
      if (!view.drawMode || view.present || ev.button !== 0) return;
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
      if (!view.drawMode || view.present) return;
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
    // the stage canvas must re-fit whenever its CONTAINER settles or
    // resizes (tab-in happens before layout; the window listener alone
    // let the bitmap stretch — the aspect-ratio bug)
    if (window.ResizeObserver) {
      view.ro = new ResizeObserver(onViewResize);
      view.ro.observe(body);
    }
    refresh();
  }

  function onViewResize() {
    renderStage();
    layoutTexts();
  }

  function unmount() {
    if (!view.host) return;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onViewResize);
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    var t = view.app && view.app.project.editTarget;
    if (view.drawMode && t && t.pitchSlide) {
      view.app.exec({ op: "editTargetClear" });
    }
    view.drawMode = false;
    view.present = false;
    view.host.classList.remove("presenting");
    view.host.innerHTML = "";
    view.host = null;
    view.stage = null;
    view.strip = null;
    view.texts = null;
  }

  window.VB = window.VB || {};
  VB.pitchSlideById = slideById;
  VB.PitchView = {
    mount: mount,
    unmount: unmount,
    refresh: refresh,
    isMounted: function () { return !!view.host; }
  };
})();
