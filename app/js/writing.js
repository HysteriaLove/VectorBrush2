/* writing.js — the Writing workspace (Architecture §6.3): free-form
 * documents (the one-body Story editor) PLUS the script atoms — typed
 * BLOCKS living on the story spine's beats (spine.js,
 * PreProductionSpine.md). Dialogue LINE blocks are the app-wide
 * language backbone: a Line's id is the stable reference everything
 * downstream uses (frames show line chips; subtitles and lip-sync
 * resolve them later) and its text is a per-language map — switching
 * project language later is a re-resolution, never a data change.
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

  /** A dialogue Line anywhere on the story spine:
   *  { beat, block, index }. Blocks live on spine beats (spine.js) —
   *  the script is the beats' block stacks, rendered as prose here and
   *  as frame text in Boards. */
  function lineById(project, id) {
    var hit = VB.spineBeatOfBlock(project, id);
    return hit && hit.block.kind === "line" ? hit : null;
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

  // Blocks are the script atoms and live on SPINE BEATS (spine.js):
  // kind "action"/"note": { content } · kind "line": { character,
  // text: {lang: str} }. Story owns the content; Boards edits it
  // through these same ops (op routing — one script, rendered twice).
  VB.defineOp("blockAdd", function (c, op) {
    var hit = VB.spineBeatById(c.project, op.beat);
    if (!hit) return;
    c.history.push(c.project);
    var block = op.kind === "line"
      ? { id: op.id, kind: "line",
          character: op.character || "",
          text: {} }
      : { id: op.id, kind: op.kind === "note" ? "note" : "action",
          content: op.content || "" };
    if (op.kind === "line") block.text[LANG] = op.text || "";
    var blocks = hit.beat.blocks;
    var at = op.index === undefined ? blocks.length
      : Math.max(0, Math.min(blocks.length, op.index));
    blocks.splice(at, 0, block);
    c.sync();
  });

  VB.defineOp("blockEdit", function (c, op) {
    var hit = VB.spineBeatOfBlock(c.project, op.block);
    if (!hit) return;
    c.history.push(c.project);
    var b = hit.block;
    if (b.kind === "line") {
      if (op.character !== undefined) b.character = op.character;
      if (op.text !== undefined) {
        // per-language, copy-on-write (history shares the old map)
        var next = {};
        Object.keys(b.text || {}).forEach(function (k) { next[k] = b.text[k]; });
        next[op.lang || LANG] = op.text;
        b.text = next;
      }
    } else if (op.content !== undefined) {
      b.content = op.content;
    }
    c.sync();
  });

  // within a beat or across beats (the writer restructuring a moment)
  VB.defineOp("blockMove", function (c, op) {
    var hit = VB.spineBeatOfBlock(c.project, op.block);
    if (!hit) return;
    var dest = op.beat ? VB.spineBeatById(c.project, op.beat) : null;
    var beat = dest ? dest.beat : hit.beat;
    if (!beat) return;
    c.history.push(c.project);
    hit.beat.blocks.splice(hit.index, 1);
    var to = Math.max(0, Math.min(beat.blocks.length, op.index | 0));
    beat.blocks.splice(to, 0, hit.block);
    c.sync();
  });

  VB.defineOp("blockRemove", function (c, op) {
    var hit = VB.spineBeatOfBlock(c.project, op.block);
    if (!hit) return;
    c.history.push(c.project);
    hit.beat.blocks.splice(hit.index, 1);
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
