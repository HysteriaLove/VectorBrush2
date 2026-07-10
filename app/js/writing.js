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
   *  { panel, row, index }. Rows live on spine panels (spine.js) —
   *  the script is the panels' row stacks, rendered as prose here and
   *  as frame text in Boards. */
  function lineById(project, id) {
    var hit = VB.spinePanelOfRow(project, id);
    return hit && hit.row.kind === "line"
      ? { panel: hit.panel, block: hit.row, row: hit.row,
          index: hit.index }
      : null;
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

  // Rows are the script atoms and live on SPINE PANELS (spine.js):
  // kind "action"/"note": { content } · kind "line": { character:
  // <registry id>, text: {lang: str} }. Story owns the content; Boards
  // edits it through these same ops (op routing — one script, two
  // views).
  VB.defineOp("blockAdd", function (c, op) {
    var hit = VB.spinePanelById(c.project, op.panel);
    if (!hit) return;
    c.history.push(c.project);
    var row = op.kind === "line"
      ? { id: op.id, kind: "line",
          character: op.character || "",
          text: {} }
      : { id: op.id, kind: op.kind === "note" ? "note" : "action",
          content: op.content || "" };
    if (op.kind === "line") row.text[LANG] = op.text || "";
    var rows = hit.panel.rows;
    var at = op.index === undefined ? rows.length
      : Math.max(0, Math.min(rows.length, op.index));
    rows.splice(at, 0, row);
    c.sync();
  });

  VB.defineOp("blockEdit", function (c, op) {
    var hit = VB.spinePanelOfRow(c.project, op.block);
    if (!hit) return;
    c.history.push(c.project);
    var b = hit.row;
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

  // within a panel or across panels (the writer restructuring)
  VB.defineOp("blockMove", function (c, op) {
    var hit = VB.spinePanelOfRow(c.project, op.block);
    if (!hit) return;
    var dest = op.panel ? VB.spinePanelById(c.project, op.panel) : null;
    var panel = dest ? dest.panel : hit.panel;
    if (!panel) return;
    c.history.push(c.project);
    hit.panel.rows.splice(hit.index, 1);
    var to = Math.max(0, Math.min(panel.rows.length, op.index | 0));
    panel.rows.splice(to, 0, hit.row);
    c.sync();
  });

  VB.defineOp("blockRemove", function (c, op) {
    var hit = VB.spinePanelOfRow(c.project, op.block);
    if (!hit) return;
    c.history.push(c.project);
    hit.panel.rows.splice(hit.index, 1);
    c.sync();
  });

  // ---- workspace view (DOM; mounted by the shell) -------------------------------
  // ONE script (user decision, panel-driven revision): the spine's flat
  // panel list rendered as prose, with scene headings DERIVED from
  // setting runs. The Notes split is gone.

  var view = { host: null, app: null, editorEl: null, focusPanel: null };

  function isEditing() {
    var el = document.activeElement;
    return !!(el && view.host && view.host.contains(el) &&
              el.classList && el.classList.contains("wredit"));
  }

  function exec(op) {
    view.app.exec(op);
    refresh();
  }

  // ---- the script editor (the spine, rendered as prose) ---------------------------

  function firstAction(panel) {
    for (var i = 0; i < panel.rows.length; i++) {
      if (panel.rows[i].kind === "action") return panel.rows[i];
    }
    return null;
  }

  function commitAction(panel, el) {
    var val = el.innerText.replace(/\n+$/, "");
    var row = firstAction(panel);
    if (row) {
      if (val !== (row.content || "")) {
        exec({ op: "blockEdit", block: row.id, content: val });
      }
    } else if (val.trim() !== "") {
      exec({ op: "blockAdd", id: VB.actorNewId("blk"), panel: panel.id,
             index: 0, kind: "action", content: val });
    }
  }

  /** Resolve a typed character name to a registry id, minting the
   *  entry on first use (the recorder journals the add). */
  function characterIdFor(name) {
    var project = view.app.project;
    var v = String(name || "").trim();
    if (!v) return "";
    var hit = VB.spineFindByName(VB.spineOf(project).characters, v);
    if (hit) return hit.id;
    var id = VB.actorNewId("char");
    view.app.exec({ op: "characterAdd", id: id, name: v });
    return id;
  }

  function settingIdFor(name) {
    var project = view.app.project;
    var v = String(name || "").trim();
    if (!v) return null;
    var hit = VB.spineFindByName(VB.spineOf(project).settings, v);
    if (hit) return hit.id;
    var id = VB.actorNewId("set");
    view.app.exec({ op: "settingAdd", id: id, name: v });
    return id;
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

  function panelHasArt(panel) {
    return panel.cell.edges.length > 0 || panel.cell.texts.length > 0;
  }

  function renderPanel(panel, number) {
    var project = view.app.project;
    var row = document.createElement("div");
    row.className = "wrbeat";
    row.dataset.panel = panel.id;

    // the rail: the panel's NUMBER (presentation — index+1) and its
    // Boards art state; the visible seam between prose and frames
    var rail = document.createElement("div");
    rail.className = "wrrail";
    rail.title = panelHasArt(panel)
      ? "panel " + number + " — drawn in Boards"
      : "panel " + number + " — no drawing yet";
    rail.textContent = number + (panelHasArt(panel) ? " ▣" : " ▢");
    row.appendChild(rail);

    var body = document.createElement("div");
    body.className = "wrbeatbody";

    // action text — Enter starts the NEXT panel (paragraph = panel);
    // Backspace on an empty, art-less panel removes it (merge up)
    var action = editable("wraction",
      (firstAction(panel) || {}).content || "",
      "action…", function (el) { commitAction(panel, el); });
    action.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        var hit = VB.spinePanelById(project, panel.id);
        if (!hit) return;
        action.blur(); // commits through the blur handler, frees refresh
        var nid = VB.actorNewId("panel");
        view.focusPanel = nid;
        exec({ op: "panelAdd", id: nid, index: hit.index + 1,
               setting: panel.setting || null });
      } else if (ev.key === "Backspace" && action.innerText.trim() === "" &&
                 panel.rows.length <= (firstAction(panel) ? 1 : 0) &&
                 !panelHasArt(panel)) {
        var hit2 = VB.spinePanelById(project, panel.id);
        if (!hit2 || hit2.index === 0) return;
        ev.preventDefault();
        var prevId = VB.spineOf(project).panels[hit2.index - 1].id;
        view.focusPanel = prevId;
        action.blur(); // an empty commit is a no-op
        view.focusPanel = prevId; // re-arm if the blur consumed it
        exec({ op: "panelRemove", id: panel.id });
      }
    });
    body.appendChild(action);

    // dialogue + notes, each row op-routed to its own block op
    panel.rows.forEach(function (b) {
      if (b.kind === "line") {
        var who = VB.spineCharacterById(project, b.character);
        var lr = document.createElement("div");
        lr.className = "wrline";
        lr.appendChild(editable("wrchar", who ? who.name : "", "WHO",
          function (el) {
            var v = el.innerText.trim();
            var cur = VB.spineCharacterById(project, b.character);
            if (v !== ((cur && cur.name) || "")) {
              exec({ op: "blockEdit", block: b.id,
                     character: characterIdFor(v) });
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

    var tools = document.createElement("div");
    tools.className = "wrtools";
    var addLine = document.createElement("button");
    addLine.className = "wradd";
    addLine.textContent = "＋ dialogue";
    addLine.title = "Add a dialogue line to this panel";
    addLine.addEventListener("click", function () {
      view.focusPanel = panel.id;
      exec({ op: "blockAdd", id: VB.actorNewId("line"), panel: panel.id,
             kind: "line", character: "", text: "" });
    });
    tools.appendChild(addLine);

    // the setting chip: scenes are DERIVED from runs of this value
    var setEntry = VB.spineSettingById(project, panel.setting);
    var chip = editable("wrsetchip", setEntry ? setEntry.name : "",
      "setting…", function (el) {
        var v = el.innerText.trim();
        var cur = VB.spineSettingById(project, panel.setting);
        if (v === ((cur && cur.name) || "")) return;
        exec({ op: "panelSetting", id: panel.id,
               setting: settingIdFor(v) });
      });
    chip.title = "This panel's setting — consecutive panels sharing a " +
      "setting form a SCENE";
    tools.appendChild(chip);
    body.appendChild(tools);

    row.appendChild(body);
    return row;
  }

  function renderScript() {
    var project = view.app.project;
    var spine = VB.spineOf(project);
    var page = document.createElement("div");
    page.className = "wrpage wrscript";

    // scene headings are DERIVED: one per setting run
    var runs = VB.spineSceneRuns(project);
    runs.forEach(function (run, ri) {
      var setEntry = VB.spineSettingById(project, run.setting);
      var head = document.createElement("div");
      head.className = "wrslug";
      head.textContent = "SCENE " + (ri + 1) +
        (setEntry ? " · " + setEntry.name : "");
      head.title = "Derived from the panels' settings — change a " +
        "panel's setting chip to move the boundary";
      page.appendChild(head);
      for (var i = run.from; i <= run.to; i++) {
        page.appendChild(renderPanel(spine.panels[i], i + 1));
      }
    });

    var addPanel = document.createElement("button");
    addPanel.className = "wradd wraddscene";
    addPanel.textContent = "＋ panel";
    addPanel.title = "New story moment — one panel, one script row";
    addPanel.addEventListener("click", function () {
      var last = spine.panels[spine.panels.length - 1];
      var nid = VB.actorNewId("panel");
      view.focusPanel = nid;
      exec({ op: "panelAdd", id: nid,
             setting: (last && last.setting) || null });
    });
    page.appendChild(addPanel);

    if (!spine.panels.length) {
      var hint = document.createElement("div");
      hint.className = "wrhint";
      hint.textContent = "start the script — every panel you write " +
        "is a storyboard frame, and vice-versa";
      page.insertBefore(hint, addPanel);
    }
    view.editorEl.appendChild(page);

    if (view.focusPanel) { // land the caret where the writer is going
      var target = view.editorEl.querySelector(
        '.wrbeat[data-panel="' + view.focusPanel + '"] .wraction');
      view.focusPanel = null;
      if (target) target.focus();
    }
  }

  function refresh() {
    if (!view.host) return;
    // never clobber live typing — unless a handler queued a rebuild
    // WITH a focus target (Enter's new panel, Backspace's merge-up)
    if (isEditing() && !view.focusPanel) return;
    view.editorEl.innerHTML = "";
    renderScript();
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
