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
      blocks: []
    });
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

  var view = { host: null, app: null, docId: null, docsEl: null, editorEl: null };

  function activeDoc() {
    if (!view.app) return null;
    var doc = view.docId ? docById(view.app.project, view.docId) : null;
    if (!doc) {
      var docs = writingOf(view.app.project).docs;
      doc = docs.length ? docs[0] : null;
      view.docId = doc ? doc.id : null;
    }
    return doc;
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

  function commitEditable(el, doc, block) {
    var val = el.textContent;
    if (block.kind === "text") {
      if (val !== (block.content || "")) {
        exec({ op: "blockEdit", doc: doc.id, block: block.id, content: val });
        return true;
      }
    } else if (el.classList.contains("wrchar")) {
      if (val !== (block.character || "")) {
        exec({ op: "blockEdit", doc: doc.id, block: block.id, character: val });
        return true;
      }
    } else {
      if (val !== lineText(block)) {
        exec({ op: "blockEdit", doc: doc.id, block: block.id,
               lang: LANG, text: val });
        return true;
      }
    }
    return false;
  }

  function focusBlock(blockId, cls) {
    var el = view.editorEl.querySelector(
      '[data-id="' + blockId + '"] .' + cls);
    if (el) {
      el.focus();
      var sel = window.getSelection();
      sel.selectAllChildren(el);
      sel.collapseToEnd();
    }
  }

  function addBlock(kind, afterBlockId, character) {
    var doc = activeDoc();
    if (!doc) { addDoc(); doc = activeDoc(); if (!doc) return; }
    var index = doc.blocks.length;
    if (afterBlockId) {
      var hit = blockById(doc, afterBlockId);
      if (hit) index = hit.index + 1;
    }
    var id = VB.actorNewId(kind === "line" ? "line" : "blk");
    exec({ op: "blockAdd", doc: doc.id, id: id, kind: kind, index: index,
           character: character || "" });
    focusBlock(id, kind === "line" ? (character ? "wrdial" : "wrchar") : "wrtext");
  }

  function addDoc() {
    exec({ op: "writingDocAdd", id: VB.actorNewId("wdoc") });
    var docs = writingOf(view.app.project).docs;
    view.docId = docs[docs.length - 1].id;
    refresh();
  }

  function editable(cls, text, placeholder, doc, block) {
    var el = document.createElement("div");
    el.className = "wredit " + cls;
    el.contentEditable = "true";
    el.textContent = text || "";
    el.dataset.ph = placeholder;
    el.addEventListener("blur", function () { commitEditable(el, doc, block); });
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        el.blur(); // commits
        // authoring flow: Enter continues with a new block of the kind
        addBlock(block.kind, block.id,
                 block.kind === "line" ? block.character : undefined);
      }
      if (ev.key === "Escape") el.blur();
      ev.stopPropagation();
    });
    return el;
  }

  function refresh() {
    if (!view.host || isEditing()) return;
    var project = view.app.project;
    var docs = writingOf(project).docs;
    var doc = activeDoc();

    view.docsEl.innerHTML = "";
    docs.forEach(function (d) {
      var row = document.createElement("div");
      row.className = "wrdoc" + (doc && d.id === doc.id ? " active" : "");
      var nm = document.createElement("span");
      nm.className = "aname";
      nm.textContent = d.name;
      nm.title = "Double-click to rename";
      nm.addEventListener("dblclick", function () {
        var n = prompt("Document name", d.name);
        if (n && n !== d.name) {
          exec({ op: "writingDocRename", doc: d.id, name: n });
        }
      });
      row.appendChild(nm);
      var del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Delete document";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (!confirm('Delete "' + d.name + '"?')) return;
        if (view.docId === d.id) view.docId = null;
        exec({ op: "writingDocRemove", doc: d.id });
      });
      row.appendChild(del);
      row.addEventListener("click", function () {
        view.docId = d.id;
        refresh();
      });
      view.docsEl.appendChild(row);
    });

    view.editorEl.innerHTML = "";
    if (!doc) {
      var empty = document.createElement("div");
      empty.className = "wrempty";
      empty.textContent = "No documents yet — create one.";
      view.editorEl.appendChild(empty);
      return;
    }
    var page = document.createElement("div");
    page.className = "wrpage";
    doc.blocks.forEach(function (block, bi) {
      var row = document.createElement("div");
      row.className = "wrblock wr-" + block.kind;
      row.dataset.id = block.id;
      if (block.kind === "text") {
        row.appendChild(editable("wrtext", block.content,
          "action / description…", doc, block));
      } else {
        row.title = "line id: " + block.id;
        row.appendChild(editable("wrchar", block.character,
          "CHARACTER", doc, block));
        row.appendChild(editable("wrdial", lineText(block),
          "dialogue…", doc, block));
      }
      var ctl = document.createElement("div");
      ctl.className = "wrctl";
      function ctlBtn(label, title, fn) {
        var b = document.createElement("button");
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", fn);
        return b;
      }
      ctl.appendChild(ctlBtn("↑", "Move up", function () {
        exec({ op: "blockMove", doc: doc.id, block: block.id, index: bi - 1 });
      }));
      ctl.appendChild(ctlBtn("↓", "Move down", function () {
        exec({ op: "blockMove", doc: doc.id, block: block.id, index: bi + 1 });
      }));
      ctl.appendChild(ctlBtn("✕", "Delete block", function () {
        exec({ op: "blockRemove", doc: doc.id, block: block.id });
      }));
      row.appendChild(ctl);
      page.appendChild(row);
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

    var bar = document.createElement("div");
    bar.id = "wr-tools";
    function toolBtn(label, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }
    bar.appendChild(toolBtn("＋ Document", "New writing document", addDoc));
    bar.appendChild(toolBtn("＋ ¶ Text", "Append an action/description block",
      function () { addBlock("text"); }));
    bar.appendChild(toolBtn("＋ 💬 Line", "Append a dialogue line",
      function () { addBlock("line"); }));
    var hint = document.createElement("span");
    hint.id = "wr-hint";
    hint.textContent = "Enter continues with a new block · line ids are what storyboards reference";
    bar.appendChild(hint);
    host.appendChild(bar);

    var body = document.createElement("div");
    body.id = "wr-body";
    var docsEl = document.createElement("div");
    docsEl.id = "wr-docs";
    var editorEl = document.createElement("div");
    editorEl.id = "wr-editor";
    body.appendChild(docsEl);
    body.appendChild(editorEl);
    host.appendChild(body);
    view.docsEl = docsEl;
    view.editorEl = editorEl;

    window.addEventListener("keydown", onKeyDown);
    refresh();
  }

  function unmount() {
    if (!view.host) return;
    window.removeEventListener("keydown", onKeyDown);
    view.host.innerHTML = "";
    view.host = null;
    view.docsEl = null;
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
