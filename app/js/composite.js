/* composite.js — the Composite workspace (Architecture §6.8) on
 * three.js (vendored r159). Grading mounts THIS SAME view for now
 * (user decision: the grading view IS the compositing view).
 *
 * COMPOSITIONAL, per the user's spec: the three.js scene pulls the
 * current scene's arrangement — background instances behind, the
 * scene's drawn layers as one plane, and every actor/symbol instance
 * as its OWN textured plane under its placement transform. Textures
 * render from the prototypes' cells (transparent, hash-cached), so
 * editing an actor updates every plane on the next docChanged.
 *
 * Two control modes (user spec): the 3D CAMERA (drag orbits,
 * middle-drag pans, wheel dollies) and a 2D mode (orthographic front
 * view: drag pans, wheel zooms) — one toggle switches them.
 *
 * View-only: nothing here journals. Degrades to a note without WebGL.
 */
(function () {
  "use strict";

  var TEX_ZOOM = 1.5; // texture px per stage px

  var view = {
    host: null, app: null,
    renderer: null, scene: null, group: null,
    camP: null, camO: null, mode: "3d",
    texCache: new Map(), // cell -> { hash, tex }
    raf: 0, drag: null, ro: null,
    orbit: { theta: 0, phi: 0, dist: 900, target: null },
    pan2d: { x: 0, y: 0, zoom: 1 }
  };

  function three() { return window.THREE || null; }

  // the FRAMING camera settings (fov + export aspect) — adjustable
  // from the view, persisted per user; the journaled per-scene camera
  // abstraction supersedes this later
  var camCfg = { fov: 45, aw: 16, ah: 9 };
  try {
    var savedCam = JSON.parse(localStorage.getItem("vb-cpcam") || "{}");
    if (savedCam.fov > 0) camCfg.fov = savedCam.fov;
    if (savedCam.aw > 0) camCfg.aw = savedCam.aw;
    if (savedCam.ah > 0) camCfg.ah = savedCam.ah;
  } catch (e) { /* defaults */ }
  function saveCam() {
    try { localStorage.setItem("vb-cpcam", JSON.stringify(camCfg)); }
    catch (e) { /* storage unavailable */ }
  }

  function stagePx(app) {
    var st = app.project.stage ? app.project.stage() : app.project;
    return { w: st.width / VB.TWIPS, h: st.height / VB.TWIPS };
  }

  function camera() { return view.mode === "3d" ? view.camP : view.camO; }

  /** A transparent texture of one cell, cached by content hash. */
  function cellTexture(T, cell) {
    var hash = VB.pixiHashCell ? VB.pixiHashCell(cell) : Math.random();
    var got = view.texCache.get(cell);
    if (got && got.hash === hash) return got.tex;
    if (got) got.tex.dispose();
    var w = Math.max(2, Math.round(cell.width / VB.TWIPS * TEX_ZOOM));
    var h = Math.max(2, Math.round(cell.height / VB.TWIPS * TEX_ZOOM));
    var cvs = document.createElement("canvas");
    cvs.width = w;
    cvs.height = h;
    var ctx = cvs.getContext("2d");
    var s = TEX_ZOOM / VB.TWIPS;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    VB.renderDocContent(ctx, cell, { zoom: TEX_ZOOM, dpr: 1 });
    var tex = new T.CanvasTexture(cvs);
    tex.colorSpace = T.SRGBColorSpace;
    view.texCache.set(cell, { hash: hash, tex: tex });
    return tex;
  }

  function clearGroup() {
    if (!view.group) return;
    for (var i = view.group.children.length - 1; i >= 0; i--) {
      var m = view.group.children[i];
      view.group.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose(); // textures stay cached
    }
  }

  /** Rebuild the composition from the scene arrangement. */
  function rebuildScene() {
    var T = three();
    if (!T || !view.group || !view.app) return;
    clearGroup();
    var project = view.app.project;
    var scene = project.scenes[project.cur.scene];
    if (!scene) return;
    var st = stagePx(view.app);
    var frame = project.cur.frame || 0;

    function addPlane(cell, x, y, scale, rotation, z) {
      var w = cell.width / VB.TWIPS, h = cell.height / VB.TWIPS;
      var geo = new T.PlaneGeometry(w, h);
      var mat = new T.MeshBasicMaterial({
        map: cellTexture(T, cell), transparent: true
      });
      var mesh = new T.Mesh(geo, mat);
      var sc = scale === undefined ? 1 : scale;
      // canvas space (y down, top-left origin) -> world (y up, centered)
      mesh.position.set(
        x / VB.TWIPS + (w * sc) / 2 - st.w / 2,
        st.h / 2 - y / VB.TWIPS - (h * sc) / 2,
        z);
      mesh.rotation.z = -(rotation || 0) * Math.PI / 180;
      mesh.scale.set(sc, sc, 1);
      view.group.add(mesh);
      return mesh;
    }

    var cast = scene.cast || [];
    var zi = 0;
    cast.forEach(function (inst) { // backgrounds sit behind the art
      if (inst.kind !== "background") return;
      var cell = VB.stepCellAt(project, scene, inst, frame);
      if (cell) addPlane(cell, inst.x, inst.y, inst.scale,
                         inst.rotation, -40 - (zi++) * 4);
    });

    // the scene's DRAWN layers (cast excluded) as one plane — the
    // texture is CACHED by content (scene + per-layer cell hashes):
    // uploading a fresh stage-sized texture every rebuild churned GPU
    // memory hard enough to risk context loss during playback + drag
    var artKey = project.cur.scene + "|";
    for (var ki = 0; ki < scene.layers.length; ki++) {
      var kl = scene.layers[ki];
      artKey += (kl.visible
        ? (VB.pixiHashCell
            ? VB.pixiHashCell(VB.frameCell(kl, frame)) : frame)
        : "x") + ",";
    }
    if (!view.artCache || view.artCache.key !== artKey) {
      var art = document.createElement("canvas");
      art.width = Math.max(2, Math.round(st.w * TEX_ZOOM));
      art.height = Math.max(2, Math.round(st.h * TEX_ZOOM));
      var actx = art.getContext("2d");
      var as = TEX_ZOOM / VB.TWIPS;
      actx.setTransform(as, 0, 0, as, 0, 0);
      for (var li = scene.layers.length - 1; li >= 0; li--) {
        if (!scene.layers[li].visible) continue;
        VB.renderDocContent(actx, VB.frameCell(scene.layers[li], frame),
                            { zoom: TEX_ZOOM, dpr: 1 });
      }
      var artTex = new T.CanvasTexture(art);
      artTex.colorSpace = T.SRGBColorSpace;
      if (view.artCache) view.artCache.tex.dispose();
      view.artCache = { key: artKey, tex: artTex };
    }
    var artMesh = new T.Mesh(
      new T.PlaneGeometry(st.w, st.h),
      new T.MeshBasicMaterial({ map: view.artCache.tex,
                                transparent: true }));
    artMesh.position.set(0, 0, 0);
    view.group.add(artMesh);

    zi = 0;
    cast.forEach(function (inst) { // actors and symbols float in front
      if (inst.kind === "background") return;
      var cell = VB.stepCellAt(project, scene, inst, frame);
      if (cell) addPlane(cell, inst.x, inst.y, inst.scale,
                         inst.rotation, 4 + (zi++) * 4);
    });
  }

  /** What the current frame SHOWS — cheap identity signature (no
   *  content hashing): playback ticks compare this and rebuild only
   *  when a held frame gives way to new cells, a pose switches, a
   *  visibility span starts/ends, or a transform moves. */
  function frameSignature() {
    var project = view.app.project;
    var scene = project.scenes[project.cur.scene];
    if (!scene) return "none";
    var frame = project.cur.frame || 0;
    var sig = project.cur.scene + "|";
    scene.layers.forEach(function (l) {
      sig += (l.visible
        ? Math.min(frame, l.frames.length - 1) : "x") + ",";
    });
    sig += "|";
    (scene.cast || []).forEach(function (inst) {
      sig += inst.id + ":" + inst.x + ":" + inst.y + ":" +
        inst.scale + ":" + inst.rotation + ":" +
        (VB.stepVisibleAt(scene, inst.id, frame) ? "v" : "h") + ":" +
        (VB.stepRunAt(scene, "pose:" + inst.id, frame) || "-") + ";";
    });
    return sig;
  }

  /** Frame-sync entry: playback and scrubbing call this every frame;
   *  docChanged calls refresh() which forces the rebuild. */
  function syncFrame() {
    if (!view.host || !view.renderer) return;
    var sig = frameSignature();
    if (!view.dirty && sig === view.sig) return;
    view.sig = sig;
    view.dirty = false;
    rebuildScene();
  }

  function applyCamera() {
    var T = three();
    if (!T) return;
    if (view.mode === "3d") {
      var o = view.orbit;
      var cp = Math.max(-1.45, Math.min(1.45, o.phi));
      view.camP.position.set(
        o.target.x + o.dist * Math.sin(o.theta) * Math.cos(cp),
        o.target.y + o.dist * Math.sin(cp),
        o.target.z + o.dist * Math.cos(o.theta) * Math.cos(cp));
      view.camP.lookAt(o.target);
    } else {
      view.camO.position.set(view.pan2d.x, view.pan2d.y, 1000);
      view.camO.lookAt(view.pan2d.x, view.pan2d.y, 0);
      view.camO.zoom = view.pan2d.zoom;
      view.camO.updateProjectionMatrix();
    }
  }

  function setMode(mode) {
    view.mode = mode;
    if (view.modeBtn) {
      view.modeBtn.textContent = mode === "3d" ? "3D" : "2D";
      view.modeBtn.title = mode === "3d"
        ? "Camera mode: 3D orbit — click for flat 2D"
        : "Camera mode: flat 2D — click for 3D orbit";
    }
    applyCamera();
  }

  /** The letterbox overlay: what the EXPORT camera frames at the
   *  chosen aspect (same vertical fov as the view). Measures the
   *  CANVAS box — the host's client size includes the workspace
   *  paddings (dock/toolpanel clearance) and would skew the frame. */
  function layoutFrame() {
    if (!view.frameEl || !view.host || !view.renderer) return;
    var cvs = view.renderer.domElement;
    var w = cvs.clientWidth, h = cvs.clientHeight;
    if (!w || !h) return;
    var ar = camCfg.aw / camCfg.ah;
    var fw, fh;
    if (ar <= w / h) { fh = h; fw = h * ar; }
    else { fw = w; fh = w / ar; }
    view.frameEl.style.width = Math.round(fw) + "px";
    view.frameEl.style.height = Math.round(fh) + "px";
    view.frameEl.style.left =
      Math.round(cvs.offsetLeft + (w - fw) / 2) + "px";
    view.frameEl.style.top =
      Math.round(cvs.offsetTop + (h - fh) / 2) + "px";
  }

  /** Render the composition into ANY canvas at w×h through the export
   *  camera — the video export steps the sequence through this. */
  function renderInto(cvs, w, h) {
    var T = three();
    if (!T || !view.scene) return false;
    if (!view.expRenderer || view.expRenderer.domElement !== cvs) {
      if (view.expRenderer) view.expRenderer.dispose();
      try {
        view.expRenderer = new T.WebGLRenderer({
          canvas: cvs, antialias: true, preserveDrawingBuffer: true
        });
      } catch (e) { return false; }
    }
    view.expRenderer.setSize(w, h, false);
    var cam;
    if (view.mode === "2d") {
      cam = view.camO.clone();
      var half = (view.camO.top - view.camO.bottom) / 2;
      cam.left = -half * (w / h);
      cam.right = half * (w / h);
      cam.top = half;
      cam.bottom = -half;
    } else {
      cam = view.camP.clone();
      cam.fov = camCfg.fov;
      cam.aspect = w / h;
    }
    cam.updateProjectionMatrix();
    view.expRenderer.render(view.scene, cam);
    return true;
  }

  function renderLoop() {
    if (!view.host || !view.renderer) return;
    // never die silently: a throw here used to kill the loop and the
    // view sat blank with no message
    if (!view.ctxLost) {
      try {
        view.renderer.render(view.scene, camera());
      } catch (e) {
        if (!view.renderErr) {
          view.renderErr = true;
          if (view.app && view.app.setMsg) {
            view.app.setMsg("3D render error: " +
                            (e && e.message || e));
          }
        }
      }
    }
    view.raf = requestAnimationFrame(renderLoop);
  }

  function mount(host, app) {
    if (view.host === host) { view.app = app; refresh(); return; }
    unmount();
    view.host = host;
    view.app = app;
    host.innerHTML = "";
    var T = three();
    if (!T) {
      var note = document.createElement("div");
      note.className = "cp-note";
      note.textContent = "three.js is unavailable — the Composite " +
        "stage needs vendor/three.min.js.";
      host.appendChild(note);
      return;
    }
    try {
      view.renderer = new T.WebGLRenderer({ antialias: true });
    } catch (e) {
      view.renderer = null;
      var no = document.createElement("div");
      no.className = "cp-note";
      no.textContent = "WebGL is unavailable in this environment.";
      host.appendChild(no);
      return;
    }
    view.renderer.setPixelRatio(window.devicePixelRatio || 1);
    view.renderer.domElement.id = "cp-canvas";
    host.appendChild(view.renderer.domElement);

    view.modeBtn = document.createElement("button");
    view.modeBtn.id = "cp-mode";
    view.modeBtn.addEventListener("click", function () {
      setMode(view.mode === "3d" ? "2d" : "3d");
    });
    host.appendChild(view.modeBtn);

    // the CAMERA settings cluster: fov + export aspect
    var camPanel = document.createElement("div");
    camPanel.id = "cp-cam";
    function camField(label, key, min, max) {
      var lab = document.createElement("label");
      lab.textContent = label + " ";
      var input = document.createElement("input");
      input.type = "number";
      input.min = min;
      input.max = max;
      input.step = key === "fov" ? 1 : 0.1;
      input.value = camCfg[key];
      input.addEventListener("change", function () {
        var v = parseFloat(input.value);
        if (!(v > 0)) return;
        camCfg[key] = Math.max(min, Math.min(max, v));
        input.value = camCfg[key];
        saveCam();
        if (view.camP) {
          view.camP.fov = camCfg.fov;
          view.camP.updateProjectionMatrix();
        }
        layoutFrame();
      });
      lab.appendChild(input);
      camPanel.appendChild(lab);
    }
    camField("fov", "fov", 10, 120);
    camField("aspect", "aw", 0.1, 64);
    camField(":", "ah", 0.1, 64);
    host.appendChild(camPanel);

    view.frameEl = document.createElement("div");
    view.frameEl.id = "cp-frame";
    view.frameEl.title = "The export frame at the chosen aspect";
    host.appendChild(view.frameEl);

    var hint = document.createElement("div");
    hint.id = "cp-hint";
    hint.textContent = "Composite — every placement is its own plane · " +
      "drag orbits (3D) or pans (2D) · wheel dollies/zooms";
    host.appendChild(hint);

    view.scene = new T.Scene();
    // the stage matches the app chrome (user spec) — sample the theme
    // token so a future theme switch carries the 3D view with it
    var bgTok = getComputedStyle(document.body)
      .getPropertyValue("--bg").trim() || "#e4e6e9";
    view.scene.background = new T.Color(bgTok);
    view.group = new T.Group();
    view.scene.add(view.group);
    var st = stagePx(app);
    view.orbit = { theta: 0, phi: 0, dist: Math.max(st.w, st.h) * 1.4,
                   target: new T.Vector3(0, 0, 0) };
    view.pan2d = { x: 0, y: 0, zoom: 1 };
    view.camP = new T.PerspectiveCamera(camCfg.fov, 1, 1, 100000);
    view.camO = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);

    var grid = new T.GridHelper(Math.max(st.w, st.h) * 4, 40,
                                0x9aa1aa, 0xc7ccd2);
    grid.position.y = -st.h / 2 - 20;
    view.scene.add(grid);

    var dom = view.renderer.domElement;
    dom.style.touchAction = "none";
    // a GPU hiccup (driver reset, memory pressure — pen drags during
    // playback were enough) LOSES the WebGL context; three.js never
    // recovers on its own and the canvas sits transparent — "the
    // background goes white". preventDefault allows the restore, then
    // every GPU-side object rebuilds from our records (the model is
    // the truth, so nothing is lost).
    dom.addEventListener("webglcontextlost", function (ev) {
      ev.preventDefault();
      view.ctxLost = true;
      if (view.app && view.app.setMsg) {
        view.app.setMsg("3D context lost — recovering…");
      }
    });
    dom.addEventListener("webglcontextrestored", function () {
      view.ctxLost = false;
      view.renderErr = false;
      view.texCache.forEach(function (e) { e.tex.dispose(); });
      view.texCache = new Map();
      if (view.artCache) {
        view.artCache.tex.dispose();
        view.artCache = null;
      }
      view.dirty = true;
      syncFrame();
      if (view.app && view.app.setMsg) view.app.setMsg("3D view recovered");
    });
    dom.addEventListener("pointerdown", function (ev) {
      try { dom.setPointerCapture(ev.pointerId); }
      catch (e) { /* a pen can drop its pointer between events */ }
      view.drag = { btn: ev.button, x: ev.clientX, y: ev.clientY };
    });
    dom.addEventListener("pointermove", function (ev) {
      var d = view.drag;
      if (!d) return;
      var dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      d.x = ev.clientX;
      d.y = ev.clientY;
      if (view.mode === "2d" || d.btn === 1) { // pan
        if (view.mode === "2d") {
          var k2 = 1 / view.pan2d.zoom;
          view.pan2d.x -= dx * k2;
          view.pan2d.y += dy * k2;
        } else {
          var k = view.orbit.dist / 700;
          var right = new T.Vector3();
          view.camP.getWorldDirection(right);
          var up = view.camP.up.clone();
          right.cross(up).normalize();
          view.orbit.target.addScaledVector(right, -dx * k);
          view.orbit.target.addScaledVector(up, dy * k);
        }
      } else { // 3D orbit
        view.orbit.theta -= dx * 0.006;
        view.orbit.phi += dy * 0.006;
      }
      applyCamera();
    });
    function endDrag() { view.drag = null; }
    dom.addEventListener("pointerup", endDrag);
    dom.addEventListener("pointercancel", endDrag);
    dom.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      if (view.mode === "2d") {
        view.pan2d.zoom = Math.max(0.05, Math.min(20,
          view.pan2d.zoom * (ev.deltaY > 0 ? 1 / 1.12 : 1.12)));
      } else {
        view.orbit.dist = Math.max(60, Math.min(20000,
          view.orbit.dist * (ev.deltaY > 0 ? 1.12 : 1 / 1.12)));
      }
      applyCamera();
    }, { passive: false });

    function size() {
      if (!view.renderer) return;
      // the CANVAS box, never the host: the host's client size
      // includes the workspace paddings (dock/toolpanel clearance),
      // and a buffer sized to it gets CSS-squeezed into the content
      // box — the "squished 3D view" bug
      var cvs = view.renderer.domElement;
      var w = cvs.clientWidth, h = cvs.clientHeight;
      if (!w || !h) return;
      view.renderer.setSize(w, h, false);
      view.camP.aspect = w / h;
      view.camP.updateProjectionMatrix();
      var half = Math.max(st.w, st.h) * 0.75;
      view.camO.left = -half * (w / h);
      view.camO.right = half * (w / h);
      view.camO.top = half;
      view.camO.bottom = -half;
      view.camO.updateProjectionMatrix();
      layoutFrame();
    }
    if (window.ResizeObserver) {
      view.ro = new ResizeObserver(size);
      view.ro.observe(host);
    }
    size();
    setMode(view.mode);
    view.dirty = true;
    syncFrame();
    renderLoop();
  }

  function refresh() {
    if (!view.host || !view.renderer) return;
    view.dirty = true; // journaled change: content may differ
    syncFrame();
  }

  function unmount() {
    if (!view.host) return;
    cancelAnimationFrame(view.raf);
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    clearGroup();
    view.texCache.forEach(function (e) { e.tex.dispose(); });
    view.texCache = new Map();
    if (view.artCache) {
      view.artCache.tex.dispose();
      view.artCache = null;
    }
    view.ctxLost = false;
    view.renderErr = false;
    if (view.renderer) {
      view.renderer.dispose();
      view.renderer = null;
    }
    if (view.expRenderer) {
      view.expRenderer.dispose();
      view.expRenderer = null;
    }
    view.host.innerHTML = "";
    view.host = null;
    view.scene = null;
    view.group = null;
    view.camP = null;
    view.camO = null;
    view.modeBtn = null;
    view.frameEl = null;
  }

  window.VB = window.VB || {};
  VB.CompositeView = {
    mount: mount, unmount: unmount, refresh: refresh,
    sync: syncFrame, // playback frame ticks land here
    renderInto: renderInto, // the video export renders through this
    camConfig: function () { return camCfg; },
    isMounted: function () { return !!view.host; }
  };
})();
