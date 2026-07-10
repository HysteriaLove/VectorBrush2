/* composite.js — the Composite workspace (Architecture §6.8), the
 * first three.js surface (vendored r159, app/vendor/three.min.js).
 *
 * Rung-0 slice: a 3D stage hosting the CURRENT scene as a live
 * canvas-textured plane — the oracle renders the scene (cast
 * instances included) into an offscreen canvas that becomes the
 * texture, refreshed on every docChanged. Camera: left-drag orbits,
 * middle-drag pans, wheel dollies. Placements/camera tracks/multi-
 * scene rigs arrive in later slices; this is the seed that proves the
 * pipeline (vector engine → texture → three.js scene) end to end.
 *
 * View-only: nothing here journals. WebGL may be unavailable
 * (headless gates) — the view degrades to a note.
 */
(function () {
  "use strict";

  var TEX_W = 1100; // texture resolution for the stage plane

  var view = {
    host: null, app: null,
    renderer: null, scene: null, camera: null,
    plane: null, texCanvas: null, texture: null,
    raf: 0, drag: null,
    orbit: { theta: 0, phi: 0, dist: 900, target: null }
  };

  function three() { return window.THREE || null; }

  function stageSize(app) {
    var st = app.project.stage ? app.project.stage() : app.project;
    return { w: st.width / VB.TWIPS, h: st.height / VB.TWIPS };
  }

  /** The oracle renders the current scene (cast included) into the
   *  texture canvas — the stage exactly fills it. */
  function paintTexture() {
    if (!view.texCanvas || !view.app) return;
    var s = stageSize(view.app);
    var h = Math.max(2, Math.round(TEX_W * s.h / s.w));
    if (view.texCanvas.width !== TEX_W || view.texCanvas.height !== h) {
      view.texCanvas.width = TEX_W;
      view.texCanvas.height = h;
    }
    var ctx = view.texCanvas.getContext("2d");
    VB.renderProject(ctx, view.app.project, {
      zoom: TEX_W / s.w, panX: 0, panY: 0, dpr: 1
    });
    if (view.texture) view.texture.needsUpdate = true;
  }

  function applyCamera() {
    var T = three();
    if (!T || !view.camera) return;
    var o = view.orbit;
    var cp = Math.max(-1.45, Math.min(1.45, o.phi));
    var x = o.target.x + o.dist * Math.sin(o.theta) * Math.cos(cp);
    var y = o.target.y + o.dist * Math.sin(cp);
    var z = o.target.z + o.dist * Math.cos(o.theta) * Math.cos(cp);
    view.camera.position.set(x, y, z);
    view.camera.lookAt(o.target);
  }

  function renderLoop() {
    if (!view.host || !view.renderer) return;
    view.renderer.render(view.scene, view.camera);
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
        "stage needs WebGL (vendor/three.min.js).";
      host.appendChild(note);
      return;
    }
    try {
      view.renderer = new T.WebGLRenderer({ antialias: true });
    } catch (e) { // headless / no GPU: degrade quietly
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

    var hint = document.createElement("div");
    hint.id = "cp-hint";
    hint.textContent = "Composite (three.js) — drag orbits · middle-drag " +
      "pans · wheel dollies · the plane is the live scene";
    host.appendChild(hint);

    view.scene = new T.Scene();
    view.scene.background = new T.Color(0x3a4048);
    var s = stageSize(app);
    view.orbit = { theta: 0, phi: 0, dist: Math.max(s.w, s.h) * 1.4,
                   target: new T.Vector3(0, 0, 0) };
    view.camera = new T.PerspectiveCamera(45, 1, 1, 100000);

    view.texCanvas = document.createElement("canvas");
    view.texture = new T.CanvasTexture(view.texCanvas);
    view.texture.colorSpace = T.SRGBColorSpace;
    var geo = new T.PlaneGeometry(s.w, s.h);
    var mat = new T.MeshBasicMaterial({ map: view.texture });
    view.plane = new T.Mesh(geo, mat);
    view.scene.add(view.plane);

    var grid = new T.GridHelper(Math.max(s.w, s.h) * 4, 40,
                                0x777d86, 0x4d535c);
    grid.position.y = -s.h / 2 - 20;
    view.scene.add(grid);

    // camera gestures
    var dom = view.renderer.domElement;
    dom.style.touchAction = "none";
    dom.addEventListener("pointerdown", function (ev) {
      dom.setPointerCapture(ev.pointerId);
      view.drag = { btn: ev.button, x: ev.clientX, y: ev.clientY };
    });
    dom.addEventListener("pointermove", function (ev) {
      var d = view.drag;
      if (!d) return;
      var dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      d.x = ev.clientX;
      d.y = ev.clientY;
      if (d.btn === 1) { // pan the target in camera space
        var k = view.orbit.dist / 700;
        var T2 = three();
        var right = new T2.Vector3();
        view.camera.getWorldDirection(right);
        var up = view.camera.up.clone();
        right.cross(up).normalize();
        view.orbit.target.addScaledVector(right, -dx * k);
        view.orbit.target.addScaledVector(up, dy * k);
      } else { // orbit
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
      view.orbit.dist = Math.max(60, Math.min(20000,
        view.orbit.dist * (ev.deltaY > 0 ? 1.12 : 1 / 1.12)));
      applyCamera();
    }, { passive: false });

    function size() {
      var w = host.clientWidth, h = host.clientHeight - 0;
      if (!w || !h || !view.renderer) return;
      view.renderer.setSize(w, h, false);
      view.camera.aspect = w / h;
      view.camera.updateProjectionMatrix();
    }
    if (window.ResizeObserver) {
      view.ro = new ResizeObserver(size);
      view.ro.observe(host);
    }
    size();
    applyCamera();
    paintTexture();
    renderLoop();
  }

  function refresh() {
    if (!view.host) return;
    paintTexture();
  }

  function unmount() {
    if (!view.host) return;
    cancelAnimationFrame(view.raf);
    if (view.ro) { view.ro.disconnect(); view.ro = null; }
    if (view.texture) view.texture.dispose();
    if (view.renderer) {
      view.renderer.dispose();
      view.renderer = null;
    }
    view.host.innerHTML = "";
    view.host = null;
    view.scene = null;
    view.camera = null;
    view.plane = null;
    view.texCanvas = null;
    view.texture = null;
  }

  window.VB = window.VB || {};
  VB.CompositeView = {
    mount: mount, unmount: unmount, refresh: refresh,
    isMounted: function () { return !!view.host; }
  };
})();
