/* shell.js — the application shell (Implementation.md phase 5;
 * Architecture §2): hash routes, the homescreen project index, and the
 * session registry.
 *
 * Routes: #home (default) · #project/<id>/sketch · #demo / #sketch
 * (editor with the boot session — #demo is the headless boot gate).
 *
 * The editor is the mounted "Sketch" section: entering a project binds
 * its session (main.js app.bindSession) and mounts the renderer;
 * leaving unmounts the renderer, which releases its AssetCache claims.
 * Sessions are held per project for this page load; package
 * persistence is phase 6.
 */
(function () {
  "use strict";

  var app = window.VBApp;
  if (!app || !document.getElementById("home-screen")) return;

  var overlay = document.getElementById("home-screen");
  var listEl = document.getElementById("home-projects");

  var sessions = new Map(); // project id -> Session (this page load)
  var bootSession = app.session; // #demo/#sketch keep the boot session

  // ---- workspaces (Architecture §2: the nine sections as tabs) -----------------
  // Sections marked editor:true show the current editor (the
  // DrawingSurface hosts — Roughs and Actors per the architecture);
  // the rest are stub workspaces their build-order steps mount into.
  // Mounted workspace views: sections with `mount` show their own DOM
  // container over the editor; each container/view pair registers here.
  var MOUNTS = {
    brainstorm: { el: "brainstorm-board",
                  view: function () { return VB.BrainstormView; } },
    pitch: { el: "pitch-view",
             view: function () { return VB.PitchView; } },
    writing: { el: "writing-view",
               view: function () { return VB.WritingView; } },
    storyboards: { el: "boards-view",
                   view: function () { return VB.BoardsView; } },
    audio: { el: "audio-view",
             view: function () { return VB.AudioView; } },
    compositing: { el: "composite-view",
                   view: function () { return VB.CompositeView; } },
    // Grading IS the compositing view for now (user decision) — the
    // post-process pass stack will grow inside the same three.js scene
    post: { el: "composite-view",
            view: function () { return VB.CompositeView; } }
  };

  // Tab names decided 2026-07-10 (Architecture §2); internal ids stay
  // stable so routes and packages never break on a rename.
  var SECTIONS = [
    { id: "brainstorm", label: "Sketchbook", mount: "brainstorm", note: "" },
    { id: "pitch", label: "Pitch", mount: "pitch", note: "" },
    { id: "writing", label: "Story", mount: "writing", note: "" },
    { id: "storyboards", label: "Boards", mount: "storyboards", note: "" },
    { id: "audio", label: "Audio", mount: "audio", note: "" },
    { id: "roughs", label: "Roughs", editor: true, note: "" },
    { id: "actors", label: "Actors", editor: true, note: "" },
    { id: "compositing", label: "Composite", mount: "compositing", note: "" },
    { id: "post", label: "Grading", mount: "post", note: "" },
    { id: "export", label: "Export",
      note: "Use 🎞 Export… on the top toolbar (WebM — flat or through " +
            "the Composite camera). Reproducible renders from journal " +
            "revisions arrive here — Architecture §6.10." }
  ];
  var activeSection = "roughs";

  function sectionById(id) {
    if (id === "sketch") id = "roughs"; // legacy route alias
    for (var i = 0; i < SECTIONS.length; i++) {
      if (SECTIONS[i].id === id) return SECTIONS[i];
    }
    return null;
  }

  function unmountAllViews() {
    Object.keys(MOUNTS).forEach(function (k) {
      var v = MOUNTS[k].view();
      if (v) v.unmount();
      var el = document.getElementById(MOUNTS[k].el);
      if (el) el.classList.remove("wsactive");
    });
  }

  function setSection(id) {
    var sec = sectionById(id) || sectionById("roughs");
    activeSection = sec.id;
    var tabs = document.getElementById("ws-tabs").children;
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].dataset.sec === sec.id);
    }
    var mount = sec.mount ? MOUNTS[sec.mount] : null;
    document.body.classList.toggle("ws-stub-mode", !sec.editor && !mount);
    document.body.classList.toggle("ws-mount-mode", !!mount);
    if (!sec.editor && !mount) {
      document.getElementById("ws-stub-title").textContent = sec.label;
      document.getElementById("ws-stub-note").textContent = sec.note;
    }
    Object.keys(MOUNTS).forEach(function (k) {
      var m = MOUNTS[k];
      var v = m.view();
      var el = document.getElementById(m.el);
      // mounts may SHARE an element/view (Composite and Grading are
      // one surface for now) — a sibling entry must not tear down the
      // active one
      var active = !!mount && (m === mount || m.el === mount.el);
      if (el) el.classList.toggle("wsactive", active);
      if (!v) return;
      if (active) v.mount(el, app);
      else v.unmount();
    });
    // editor input (keyboard/tools) only while an editor section shows
    app.uiActive = !!sec.editor && overlay.style.display !== "flex";
    if (sec.editor) app.requestRender();
  }

  (function renderTabs() {
    var wrap = document.getElementById("ws-tabs");
    SECTIONS.forEach(function (sec) {
      var tab = document.createElement("div");
      tab.className = "wstab";
      tab.dataset.sec = sec.id;
      tab.textContent = sec.label;
      tab.addEventListener("click", function () {
        if (activeProjectId) {
          location.hash = "#project/" + activeProjectId + "/" + sec.id;
        } else {
          setSection(sec.id); // scratch/demo: no package behind the route
        }
      });
      wrap.appendChild(tab);
    });
  })();

  document.getElementById("ws-home").addEventListener("click", function () {
    location.hash = "#home"; // route-away flush persists the project
  });
  document.getElementById("ws-save").addEventListener("click", async function () {
    if (!activeProjectId) { app.setMsg("scratch sketches have no package — create a project"); return; }
    await flushProject(activeProjectId);
    app.setMsg("project saved");
  });

  var store = null;
  var storeReady = VB.PackageStore
    ? VB.PackageStore.open().then(
        function (s) { store = s; return s; },
        function () { return null; })
    : Promise.resolve(null);

  // Binary asset I/O for the ACTIVE package (audio stems etc. — bytes
  // never ride the journal). Scratch sessions fall back to an
  // in-memory map so imports still play; they simply don't persist
  // until the work lives in a real project package.
  var scratchAssets = new Map();
  VB.projectAssets = {
    put: async function (path, bytes) {
      scratchAssets.set(path, bytes);
      if (activeProjectId && store) {
        await store.open(activeProjectId).writeUnit(path, bytes);
      }
    },
    get: async function (path) {
      if (scratchAssets.has(path)) return scratchAssets.get(path);
      if (activeProjectId && store) {
        return store.open(activeProjectId).readUnit(path);
      }
      return null;
    }
  };

  // ---- persistence (Implementation.md phase 6) ---------------------------------
  // The journal IS the project: a debounced flush writes the journal's
  // tail segments + manifest into the package after every mutation, and
  // opening a project replays its segments — which is also crash
  // recovery by construction. Undo/redo are journaled ops, so replay is
  // always faithful to the live document.

  var SEG_OPS = 256;
  var FLUSH_MS = 600;
  var flushTimer = null;
  var activeProjectId = null;

  function persistState(sess) {
    if (!sess._persist) {
      sess._persist = { flushedOps: 0, segCount: 0, chain: Promise.resolve() };
    }
    return sess._persist;
  }

  function flushProject(id) {
    var sess = sessions.get(id);
    if (!sess || !store) return Promise.resolve();
    var st = persistState(sess);
    st.chain = st.chain.then(async function () {
      var ops = sess.journal;
      if (st.flushedOps === ops.length && st.segCount) return; // clean
      var handle = store.open(id);
      var segs = VB.segmentJournal(ops, SEG_OPS);
      // only the tail changed — unless the journal shrank (a load op
      // resets it), which forces a full rewrite
      var firstDirty = ops.length < st.flushedOps
        ? 0 : Math.floor(st.flushedOps / SEG_OPS);
      for (var i = firstDirty; i < segs.length; i++) {
        await handle.writeUnit(segs[i].path, segs[i].json);
      }
      for (var j = segs.length; j < st.segCount; j++) { // stale segments
        await handle.deleteUnit(
          "journal/seg-" + String(j + 1).padStart(5, "0") + ".json");
      }
      await handle.flushManifest({
        format: "y2kproj", version: 1, ops: ops.length, saved: Date.now()
      });
      st.flushedOps = ops.length;
      st.segCount = segs.length;
    });
    return st.chain;
  }

  window.VBApp.onDocChanged = function () {
    if (!activeProjectId) return;
    if (flushTimer) clearTimeout(flushTimer);
    var id = activeProjectId;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flushProject(id);
    }, FLUSH_MS);
  };
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && activeProjectId) {
      flushProject(activeProjectId);
    }
  });
  window.addEventListener("beforeunload", function () {
    if (activeProjectId) flushProject(activeProjectId); // best effort
  });

  async function loadSessionFromPackage(id) {
    var handle = store.open(id);
    var segPaths = await handle.listUnits("journal/");
    if (!segPaths.length) {
      var fresh = new VB.Session({ width: 550 * VB.TWIPS, height: 400 * VB.TWIPS });
      persistState(fresh);
      return fresh;
    }
    var jsons = [];
    for (var i = 0; i < segPaths.length; i++) {
      jsons.push(await handle.readUnitText(segPaths[i]));
    }
    var ops = VB.joinJournalSegments(jsons);
    var res = await VB.replayJournal(JSON.parse(JSON.stringify(ops)));
    var sess = new VB.Session({});
    ops.forEach(function (op) { sess.journal.push(op); });
    sess.project = res.project;
    var st = persistState(sess);
    st.flushedOps = ops.length;
    st.segCount = Math.ceil(ops.length / SEG_OPS);
    return sess;
  }

  // ---- homescreen --------------------------------------------------------------

  function fmtWhen(t) {
    try { return new Date(t).toLocaleString(); } catch (e) { return ""; }
  }

  function row(rec) {
    var div = document.createElement("div");
    div.className = "home-row";
    var nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = rec.name;
    nm.title = "Open";
    nm.addEventListener("click", function () {
      location.hash = "#project/" + rec.id + "/sketch";
    });
    var when = document.createElement("span");
    when.className = "when";
    when.textContent = fmtWhen(rec.modified);
    function btn(label, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }
    div.appendChild(nm);
    div.appendChild(when);
    div.appendChild(btn("Open", "Open project", function () {
      location.hash = "#project/" + rec.id + "/sketch";
    }));
    div.appendChild(btn("Rename", "Rename project", async function () {
      var name = prompt("Project name", rec.name);
      if (!name || name === rec.name) return;
      await store.rename(rec.id, name);
      renderHome();
    }));
    div.appendChild(btn("Duplicate", "Duplicate project (package copy)", async function () {
      await flushProject(rec.id); // unsaved session ops join the copy
      var zip = await store.open(rec.id).exportZip();
      await store.importZip(zip, { name: rec.name + " copy" });
      renderHome();
    }));
    div.appendChild(btn("Export", "Download as a .y2kproj package", async function () {
      await flushProject(rec.id);
      var zip = await store.open(rec.id).exportZip();
      var a = document.createElement("a");
      a.href = URL.createObjectURL(zip);
      a.download = rec.name.replace(/[^\w\- ]+/g, "_") + ".y2kproj";
      a.click();
      URL.revokeObjectURL(a.href);
    }));
    div.appendChild(btn("Delete", "Delete project", async function () {
      if (!confirm('Delete "' + rec.name + '"?')) return;
      await store.remove(rec.id);
      sessions.delete(rec.id);
      renderHome();
    }));
    return div;
  }

  var renderSeq = 0;
  async function renderHome() {
    var seq = ++renderSeq;
    await storeReady;
    if (seq !== renderSeq) return; // a newer render superseded this one
    listEl.innerHTML = "";
    if (!store) {
      listEl.textContent = "package store unavailable in this browser";
      return;
    }
    var rows = await store.list();
    if (seq !== renderSeq) return;
    if (!rows.length) {
      var empty = document.createElement("div");
      empty.id = "home-empty";
      empty.textContent = "No projects yet — create one.";
      listEl.appendChild(empty);
      return;
    }
    rows.forEach(function (rec) { listEl.appendChild(row(rec)); });
  }

  document.getElementById("home-new").addEventListener("click", async function () {
    await storeReady;
    if (!store) return;
    var rec = await store.create({ name: "Untitled project" });
    location.hash = "#project/" + rec.id + "/sketch";
  });

  var importInput = document.getElementById("home-import-file");
  document.getElementById("home-import").addEventListener("click", function () {
    importInput.click();
  });
  importInput.addEventListener("change", async function () {
    var file = importInput.files && importInput.files[0];
    importInput.value = "";
    if (!file) return;
    await storeReady;
    if (!store) return;
    try {
      await store.importZip(file, {
        name: file.name.replace(/\.(y2kproj|zip)$/i, "")
      });
      renderHome();
    } catch (err) {
      alert("Import failed: " + (err && err.message));
    }
  });

  // ---- routing ------------------------------------------------------------------

  function showHome() {
    app.uiActive = false;
    app.unmountRenderer();
    unmountAllViews();
    overlay.style.display = "flex";
    renderHome();
  }

  /** Leaves the homescreen and shows a workspace: editor sections mount
   *  the renderer; stub sections cover the editor until their step. */
  function showWorkspace(sectionId) {
    overlay.style.display = "none";
    app.mountRenderer();
    setSection(sectionId);
  }

  async function doApplyRoute() {
    var h = location.hash || "#home";
    // leaving a project flushes it before anything else routes
    if (activeProjectId && h !== "#project/" + activeProjectId + "/sketch") {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      var leaving = activeProjectId;
      activeProjectId = null;
      await flushProject(leaving);
    }
    if (h === "#demo" || h === "#sketch" || h === "#canvas2d") {
      // the boot session: demo fixture (built by main.js) or a scratch
      // sketch with no package behind it
      app.bindSession(bootSession);
      document.getElementById("ws-name").textContent = "scratch";
      showWorkspace("roughs");
      return;
    }
    if (h.indexOf("#project/") === 0) {
      var parts = h.slice(1).split("/");
      var id = parts[1];
      var section = sectionById(parts[2] || "roughs") ? (parts[2] || "roughs") : "roughs";
      await storeReady;
      var rec = null;
      if (store) {
        var rows = await store.list();
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].id === id) { rec = rows[i]; break; }
        }
      }
      if (!rec) { location.hash = "#home"; return; }
      var sess = sessions.get(id);
      if (!sess) {
        try {
          sess = await loadSessionFromPackage(id);
        } catch (err) {
          // a corrupt package must not be overwritten by a fresh session
          alert("Project failed to load: " + (err && err.message));
          location.hash = "#home";
          return;
        }
        sessions.set(id, sess);
      }
      app.bindSession(sess);
      app.fileName = rec.name;
      activeProjectId = id;
      document.getElementById("ws-name").textContent = rec.name;
      showWorkspace(section);
      return;
    }
    showHome();
  }

  // routes serialize: a slow store lookup can never interleave with the
  // next navigation's apply
  var routing = Promise.resolve();
  function applyRoute() {
    routing = routing.then(doApplyRoute, doApplyRoute);
    return routing;
  }

  window.addEventListener("hashchange", applyRoute);
  applyRoute();

  // Exposed for the shell tripwire gate (test/shell.html) and debugging.
  window.VBShell = {
    sessions: sessions,
    applyRoute: applyRoute,
    goto: function (h) {
      if (location.hash !== h) location.hash = h;
      return applyRoute();
    },
    flush: flushProject,
    section: function () { return activeSection; },
    storeReady: function () { return storeReady; },
    store: function () { return store; }
  };
})();
