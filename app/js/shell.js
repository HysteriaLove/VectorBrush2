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

  var store = null;
  var storeReady = VB.PackageStore
    ? VB.PackageStore.open().then(
        function (s) { store = s; return s; },
        function () { return null; })
    : Promise.resolve(null);

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
      var zip = await store.open(rec.id).exportZip();
      await store.importZip(zip, { name: rec.name + " copy" });
      renderHome();
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

  // ---- routing ------------------------------------------------------------------

  function showHome() {
    app.uiActive = false;
    app.unmountRenderer();
    overlay.style.display = "flex";
    renderHome();
  }

  function showEditor() {
    overlay.style.display = "none";
    app.uiActive = true;
    app.mountRenderer();
  }

  async function doApplyRoute() {
    var h = location.hash || "#home";
    if (h === "#demo" || h === "#sketch" || h === "#canvas2d") {
      // the boot session: demo fixture (built by main.js) or a scratch
      // sketch with no package behind it
      app.bindSession(bootSession);
      showEditor();
      return;
    }
    if (h.indexOf("#project/") === 0) {
      var id = h.split("/")[1];
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
        sess = new VB.Session({ width: 550 * VB.TWIPS, height: 400 * VB.TWIPS });
        sessions.set(id, sess);
      }
      app.bindSession(sess);
      app.fileName = rec.name;
      showEditor();
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
    storeReady: function () { return storeReady; },
    store: function () { return store; }
  };
})();
