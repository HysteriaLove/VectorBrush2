/* writing.js — the Writing workspace (Architecture §6.2, thin slice):
 * documents made of blocks, where dialogue LINE blocks are the app-wide
 * language backbone. A Line's id is the stable reference everything
 * downstream uses (storyboard panels attach line ids; subtitles and
 * lip-sync resolve them later) and its text is a per-language map —
 * switching project language later is a re-resolution, never a data
 * change.
 *
 * Thin means thin UI, never thin model: every mutation is a journaled
 * op with ids carried in the op; docs and blocks replay byte-exact and
 * ride project history/persistence like everything else.
 */
(function () {
  "use strict";

  var LANG = "default"; // the only language until the language system lands

  // ---- model + ops -----------------------------------------------------------

  function writingOf(project) {
    project.writing = project.writing || { docs: [] };
    return project.writing;
  }

  function docById(project, id) {
    var docs = writingOf(project).docs;
    for (var i = 0; i < docs.length; i++) {
      if (docs[i].id === id) return docs[i];
    }
    return null;
  }

  function blockById(doc, id) {
    for (var i = 0; i < doc.blocks.length; i++) {
      if (doc.blocks[i].id === id) return { block: doc.blocks[i], index: i };
    }
    return null;
  }

  /** A dialogue Line anywhere in the project: { doc, block, index }. */
  function lineById(project, id) {
    var docs = writingOf(project).docs;
    for (var d = 0; d < docs.length; d++) {
      var hit = blockById(docs[d], id);
      if (hit && hit.block.kind === "line") {
        return { doc: docs[d], block: hit.block, index: hit.index };
      }
    }
    return null;
  }

  function lineText(block, lang) {
    var t = block.text || {};
    return t[lang || LANG] !== undefined ? t[lang || LANG] : (t[LANG] || "");
  }

  VB.defineOp("writingDocAdd", function (c, op) {
    c.history.push(c.project);
    var docs = writingOf(c.project).docs;
    docs.push({
      id: op.id,
      name: op.name || "Document " + String(docs.length + 1).padStart(2, "0"),
      text: "",   // the infinite document body (the authoring surface)
      blocks: []  // dormant dialogue-Line store — ids get assigned to
                  // stretches of the text when the dialogue system lands
    });
    c.sync();
  });

  /** The whole document body as one text (Google-Docs-style editing;
   *  user decision 2026-07-10). One op per editing session (blur). */
  VB.defineOp("writingDocEdit", function (c, op) {
    var doc = docById(c.project, op.doc);
    if (!doc) return;
    c.history.push(c.project);
    doc.text = op.text;
    c.sync();
  });

  VB.defineOp("writingDocRename", function (c, op) {
    var doc = docById(c.project, op.doc);
    if (!doc) return;
    c.history.push(c.project);
    doc.name = op.name;
    c.sync();
  });

  VB.defineOp("writingDocRemove", function (c, op) {
    var docs = writingOf(c.project).docs;
    for (var i = 0; i < docs.length; i++) {
      if (docs[i].id === op.doc) {
        c.history.push(c.project);
        docs.splice(i, 1);
        c.sync();
        return;
      }
    }
  });

  // kind "text": { content } · kind "line": { character, text: {lang: str} }
  VB.defineOp("blockAdd", function (c, op) {
    var doc = docById(c.project, op.doc);
    if (!doc) return;
    c.history.push(c.project);
    var block = op.kind === "line"
      ? { id: op.id, kind: "line",
          character: op.character || "",
          text: {} }
      : { id: op.id, kind: "text", content: op.content || "" };
    if (op.kind === "line") block.text[LANG] = op.text || "";
    var at = op.index === undefined ? doc.blocks.length
      : Math.max(0, Math.min(doc.blocks.length, op.index));
    doc.blocks.splice(at, 0, block);
    c.sync();
  });

  VB.defineOp("blockEdit", function (c, op) {
    var doc = docById(c.project, op.doc);
    var hit = doc && blockById(doc, op.block);
    if (!hit) return;
    c.history.push(c.project);
    var b = hit.block;
    if (b.kind === "text") {
      if (op.content !== undefined) b.content = op.content;
    } else {
      if (op.character !== undefined) b.character = op.character;
      if (op.text !== undefined) {
        // per-language, copy-on-write (history shares the old map)
        var next = {};
        Object.keys(b.text || {}).forEach(function (k) { next[k] = b.text[k]; });
        next[op.lang || LANG] = op.text;
        b.text = next;
      }
    }
    c.sync();
  });

  VB.defineOp("blockMove", function (c, op) {
    var doc = docById(c.project, op.doc);
    var hit = doc && blockById(doc, op.block);
    if (!hit) return;
    var to = Math.max(0, Math.min(doc.blocks.length - 1, op.index));
    if (to === hit.index) return;
    c.history.push(c.project);
    doc.blocks.splice(hit.index, 1);
    doc.blocks.splice(to, 0, hit.block);
    c.sync();
  });

  VB.defineOp("blockRemove", function (c, op) {
    var doc = docById(c.project, op.doc);
    var hit = doc && blockById(doc, op.block);
    if (!hit) return;
    c.history.push(c.project);
    doc.blocks.splice(hit.index, 1);
    c.sync();
  });

  // ---- workspace view (DOM; mounted by the shell) -------------------------------

  var view = { host: null, app: null, editorEl: null };

  // ONE document, ever (user decision 2026-07-10): the project has a
  // single story; it is created lazily on the first committed edit.
  function activeDoc() {
    if (!view.app) return null;
    var docs = writingOf(view.app.project).docs;
    return docs.length ? docs[0] : null;
  }

  function isEditing() {
    var el = document.activeElement;
    return !!(el && view.host && view.host.contains(el) &&
              el.classList && el.classList.contains("wredit"));
  }

  function exec(op) {
    view.app.exec(op);
    refresh();
  }

  function commitBody() {
    var body = view.editorEl && view.editorEl.querySelector(".wrbody");
    if (!body) return;
    var val = body.innerText.replace(/\n$/, "");
    var doc = activeDoc();
    if (!doc) {
      if (val.trim() === "") return; // nothing typed, nothing created
      view.app.exec({ op: "writingDocAdd", id: VB.actorNewId("wdoc"),
                      name: "Story" });
      doc = activeDoc();
    }
    if (doc && val !== (doc.text || "")) {
      exec({ op: "writingDocEdit", doc: doc.id, text: val });
    }
  }

  function refresh() {
    if (!view.host || isEditing()) return;
    var doc = activeDoc();
    view.editorEl.innerHTML = "";
    // ONE infinite document: a single flowing editable page, Google-Docs
    // style. The body commits as one op per editing session (blur).
    var page = document.createElement("div");
    page.className = "wrpage";
    var body = document.createElement("div");
    body.className = "wredit wrbody wrtext";
    body.contentEditable = "true";
    body.innerText = doc ? (doc.text || "") : "";
    body.dataset.ph = "write the story…";
    body.addEventListener("blur", commitBody);
    body.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") body.blur();
      ev.stopPropagation(); // typing never triggers app shortcuts
    });
    page.appendChild(body);
    page.addEventListener("click", function (ev) {
      if (ev.target === page) body.focus(); // click the margin, type anyway
    });
    view.editorEl.appendChild(page);
  }

  function onKeyDown(ev) {
    if (!view.host) return;
    if (isEditing()) return;
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
    }
  }

  function mount(host, app) {
    if (view.host === host) { view.app = app; refresh(); return; }
    unmount();
    view.host = host;
    view.app = app;
    host.innerHTML = "";


    var body = document.createElement("div");
    body.id = "wr-body";
    var editorEl = document.createElement("div");
    editorEl.id = "wr-editor";
    body.appendChild(editorEl);
    host.appendChild(body);
    view.editorEl = editorEl;

    window.addEventListener("keydown", onKeyDown);
    refresh();
  }

  function unmount() {
    if (!view.host) return;
    commitBody(); // leaving the tab never loses an uncommitted edit
    window.removeEventListener("keydown", onKeyDown);
    view.host.innerHTML = "";
    view.host = null;
    view.editorEl = null;
  }

  window.VB = window.VB || {};
  VB.writingDocById = docById;
  VB.lineById = lineById;
  VB.lineTextOf = lineText;
  VB.WritingView = {
    mount: mount,
    unmount: unmount,
    refresh: refresh,
    isMounted: function () { return !!view.host; }
  };
})();
