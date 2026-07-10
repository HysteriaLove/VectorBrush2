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
  // Two editors behind one tab: SCRIPT (the spine screenplay — slugs →
  // beats, the interchange surface Boards renders as frames) and NOTES
  // (the free one-body document, kept from the earlier slice).

  var view = { host: null, app: null, editorEl: null,
               mode: "script", xpanels: [], focusBeat: null };

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

  // ---- the script editor (the spine, rendered as prose) ---------------------------

  function firstAction(beat) {
    for (var i = 0; i < beat.blocks.length; i++) {
      if (beat.blocks[i].kind === "action") return beat.blocks[i];
    }
    return null;
  }

  function commitAction(beat, el) {
    var val = el.innerText.replace(/\n+$/, "");
    var block = firstAction(beat);
    if (block) {
      if (val !== (block.content || "")) {
        exec({ op: "blockEdit", block: block.id, content: val });
      }
    } else if (val.trim() !== "") {
      exec({ op: "blockAdd", id: VB.actorNewId("blk"), beat: beat.id,
             index: 0, kind: "action", content: val });
    }
  }

  function editable(className, text, placeholder, commit) {
    var el = document.createElement("div");
    el.className = "wredit " + className;
    el.contentEditable = "true";
    el.innerText = text || "";
    if (placeholder) el.dataset.ph = placeholder;
    el.addEventListener("blur", function () { commit(el); });
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") el.blur();
      ev.stopPropagation(); // typing never triggers app shortcuts
    });
    return el;
  }

  function renderBeat(scene, beat) {
    var project = view.app.project;
    var row = document.createElement("div");
    row.className = "wrbeat";
    row.dataset.beat = beat.id;

    // the beat rail: the visible seam between prose and frames
    var rail = document.createElement("div");
    rail.className = "wrrail";
    rail.title = beat.panels.length
      ? beat.panels.length + " frame(s) in Boards"
      : "no frames yet — Boards shows this beat as an empty slot";
    rail.textContent = beat.panels.length ? "▣" + beat.panels.length : "▢";
    row.appendChild(rail);

    var body = document.createElement("div");
    body.className = "wrbeatbody";

    // action text — Enter starts the NEXT beat (paragraph = beat, the
    // membrane's editor default); Backspace on an empty beat merges up
    var action = editable("wraction",
      (firstAction(beat) || {}).content || "",
      "action…", function (el) { commitAction(beat, el); });
    action.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        var hit = VB.spineBeatById(project, beat.id);
        if (!hit) return;
        action.blur(); // commits through the blur handler, frees refresh
        var nid = VB.actorNewId("beat");
        view.focusBeat = nid;
        exec({ op: "spineBeatAdd", id: nid, scene: scene.id,
               index: hit.index + 1 });
      } else if (ev.key === "Backspace" && action.innerText.trim() === "" &&
                 beat.blocks.length <= (firstAction(beat) ? 1 : 0) &&
                 beat.panels.length === 0) {
        var hit2 = VB.spineBeatById(project, beat.id);
        if (!hit2 || hit2.index === 0) return;
        ev.preventDefault();
        var prevId = hit2.scene.beats[hit2.index - 1].id;
        view.focusBeat = prevId;
        action.blur(); // an empty commit is a no-op
        view.focusBeat = prevId; // re-arm if the blur consumed it
        exec({ op: "spineBeatRemove", id: beat.id });
      }
    });
    body.appendChild(action);

    // dialogue + notes, each row op-routed to its own block
    beat.blocks.forEach(function (b) {
      if (b.kind === "line") {
        var lr = document.createElement("div");
        lr.className = "wrline";
        lr.appendChild(editable("wrchar", b.character, "WHO",
          function (el) {
            var v = el.innerText.trim();
            if (v !== (b.character || "")) {
              exec({ op: "blockEdit", block: b.id, character: v });
            }
          }));
        lr.appendChild(editable("wrsay", lineText(b), "dialogue…",
          function (el) {
            var v = el.innerText.replace(/\n+$/, "");
            if (v !== lineText(b)) {
              exec({ op: "blockEdit", block: b.id, text: v });
            }
          }));
        body.appendChild(lr);
      } else if (b.kind === "note") {
        body.appendChild(editable("wrnote", b.content, "note…",
          function (el) {
            var v = el.innerText.replace(/\n+$/, "");
            if (v !== (b.content || "")) {
              exec({ op: "blockEdit", block: b.id, content: v });
            }
          }));
      }
    });

    var addLine = document.createElement("button");
    addLine.className = "wradd";
    addLine.textContent = "＋ dialogue";
    addLine.title = "Add a dialogue line to this beat";
    addLine.addEventListener("click", function () {
      view.focusBeat = beat.id;
      exec({ op: "blockAdd", id: VB.actorNewId("line"), beat: beat.id,
             kind: "line", character: "", text: "" });
    });
    body.appendChild(addLine);

    row.appendChild(body);
    return row;
  }

  function renderScript() {
    var project = view.app.project;
    var spine = VB.spineOf(project);
    var page = document.createElement("div");
    page.className = "wrpage wrscript";

    spine.scenes.forEach(function (scene) {
      var slug = editable("wrslug", scene.title, "SCENE HEADING…",
        function (el) {
          var v = el.innerText.trim();
          if (v && v !== scene.title) {
            exec({ op: "spineSceneRename", id: scene.id, title: v });
          }
        });
      page.appendChild(slug);
      scene.beats.forEach(function (beat) {
        page.appendChild(renderBeat(scene, beat));
      });
      var addBeat = document.createElement("button");
      addBeat.className = "wradd";
      addBeat.textContent = "＋ beat";
      addBeat.title = "New story moment — Boards shows it as a new frame";
      addBeat.addEventListener("click", function () {
        var nid = VB.actorNewId("beat");
        view.focusBeat = nid;
        exec({ op: "spineBeatAdd", id: nid, scene: scene.id });
      });
      page.appendChild(addBeat);
    });

    var addScene = document.createElement("button");
    addScene.className = "wradd wraddscene";
    addScene.textContent = "＋ scene";
    addScene.addEventListener("click", function () {
      var sid = VB.actorNewId("slug");
      var nid = VB.actorNewId("beat");
      view.app.exec({ op: "spineSceneAdd", id: sid });
      view.focusBeat = nid;
      exec({ op: "spineBeatAdd", id: nid, scene: sid });
    });
    page.appendChild(addScene);

    if (!spine.scenes.length) {
      var hint = document.createElement("div");
      hint.className = "wrhint";
      hint.textContent = "start the script — every beat you write " +
        "becomes a storyboard frame, and vice-versa";
      page.insertBefore(hint, addScene);
    }
    view.editorEl.appendChild(page);

    if (view.focusBeat) { // land the caret where the writer is going
      var target = view.editorEl.querySelector(
        '.wrbeat[data-beat="' + view.focusBeat + '"] .wraction');
      view.focusBeat = null;
      if (target) target.focus();
    }
  }

  function refresh() {
    if (!view.host) return;
    // never clobber live typing — unless a handler queued a rebuild
    // WITH a focus target (Enter's new beat, Backspace's merge-up)
    if (isEditing() && !view.focusBeat) return;
    view.editorEl.innerHTML = "";
    if (view.mode === "script") { renderScript(); return; }
    var doc = activeDoc();
    // NOTES: one infinite document, a single flowing editable page
    // (Google-Docs style). Commits as one op per editing session.
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

    // Script (the spine screenplay) vs Notes (the free document)
    view.xpanels = [];
    if (app.xpanel) {
      var modePanel = app.xpanel(null, "wr-mode");
      view.xpanels.push(modePanel);
      ["script", "notes"].forEach(function (m) {
        var b = document.createElement("button");
        b.textContent = m === "script" ? "Script" : "Notes";
        b.title = m === "script"
          ? "The screenplay — beats shared live with Boards"
          : "Free story notes (one flowing document)";
        b.dataset.wrmode = m;
        b.classList.toggle("active", view.mode === m);
        b.addEventListener("click", function () {
          if (view.mode === "notes") commitBody();
          view.mode = m;
          modePanel.querySelectorAll("button").forEach(function (k) {
            k.classList.toggle("active", k.dataset.wrmode === m);
          });
          refresh();
        });
        modePanel.appendChild(b);
      });
    }

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
    if (view.mode === "notes") {
      commitBody(); // leaving the tab never loses an uncommitted edit
    }
    window.removeEventListener("keydown", onKeyDown);
    (view.xpanels || []).forEach(function (p) { p.remove(); });
    view.xpanels = [];
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
