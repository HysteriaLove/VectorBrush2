/* export.js — the rudimentary VIDEO EXPORT menu (Architecture §6.10,
 * first slice). Steps the master sequence frame by frame and records
 * a WebM through MediaRecorder + captureStream(0)/requestFrame().
 *
 * Two sources:
 *   flat      — the oracle renders each frame (always available);
 *   composite — the three.js stage through the export camera
 *               (available while Composite/Grading is mounted).
 * No audio in the container yet (the baked master pairs with it in a
 * later slice), and encoding runs at playback pace so the recorder's
 * timestamps stay honest. View-only: the export never journals; the
 * playhead is restored when the run ends.
 */
(function () {
  "use strict";

  var ui = null;
  var run = null;

  function app() { return window.VBApp; }

  function build() {
    if (ui) return ui;
    var wrap = document.createElement("div");
    wrap.id = "exportmenu";
    wrap.innerHTML =
      '<div id="exp-panel">' +
      '<h3>Export video</h3>' +
      '<label>Width <input type="number" id="exp-w" value="1920" min="16" max="7680" step="2"></label>' +
      '<label>Height <input type="number" id="exp-h" value="1080" min="16" max="4320" step="2"></label>' +
      '<label>fps <input type="number" id="exp-fps" value="24" min="1" max="60"></label>' +
      '<label>Source <select id="exp-src">' +
      '<option value="flat">Flat (oracle)</option>' +
      '<option value="composite">Composite camera (three.js)</option>' +
      '</select></label>' +
      '<div id="exp-note">WebM · no audio yet · frames render at playback pace</div>' +
      '<div id="exp-actions">' +
      '<button id="exp-go">Export WebM</button>' +
      '<button id="exp-close">Close</button>' +
      '</div>' +
      '<div id="exp-progress"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    ui = wrap;
    wrap.addEventListener("pointerdown", function (ev) {
      if (ev.target === wrap && !run) close();
    });
    document.getElementById("exp-close").addEventListener("click", function () {
      if (run) { run.cancel = true; return; }
      close();
    });
    document.getElementById("exp-go").addEventListener("click", start);
    return wrap;
  }

  function open() {
    build();
    var a = app();
    if (a) {
      document.getElementById("exp-fps").value = a.project.fps || 24;
      var cam = VB.CompositeView && VB.CompositeView.camConfig
        ? VB.CompositeView.camConfig() : null;
      if (cam) { // default the size to the camera aspect
        var w = parseInt(document.getElementById("exp-w").value, 10) || 1920;
        document.getElementById("exp-h").value =
          Math.max(16, Math.round(w * cam.ah / cam.aw / 2) * 2);
      }
      var srcSel = document.getElementById("exp-src");
      var compReady = VB.CompositeView && VB.CompositeView.isMounted();
      srcSel.options[1].disabled = !compReady;
      srcSel.value = compReady ? "composite" : "flat";
    }
    ui.style.display = "flex";
    progress("");
  }

  function close() {
    if (ui) ui.style.display = "none";
  }

  function progress(text) {
    var el = document.getElementById("exp-progress");
    if (el) el.textContent = text;
  }

  function start() {
    var a = app();
    if (!a || run) return;
    var w = Math.max(16, parseInt(document.getElementById("exp-w").value, 10) | 0);
    var h = Math.max(16, parseInt(document.getElementById("exp-h").value, 10) | 0);
    var fps = Math.max(1, Math.min(60,
      parseInt(document.getElementById("exp-fps").value, 10) | 0));
    var src = document.getElementById("exp-src").value;
    if (src === "composite" &&
        !(VB.CompositeView && VB.CompositeView.isMounted())) {
      progress("open the Composite tab first for the camera source");
      return;
    }
    var project = a.project;
    var total = VB.sequenceDuration(project);
    var cvs = document.createElement("canvas");
    cvs.width = w;
    cvs.height = h;
    var ctx = src === "flat" ? cvs.getContext("2d") : null;
    var stream = cvs.captureStream(0);
    var track = stream.getVideoTracks()[0];
    var mime = "video/webm;codecs=vp9";
    if (!window.MediaRecorder) { progress("MediaRecorder unavailable"); return; }
    if (!MediaRecorder.isTypeSupported(mime)) mime = "video/webm";
    var rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime });
    } catch (e) {
      progress("recording unavailable: " + e.message);
      return;
    }
    var chunks = [];
    rec.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    var saved = { scene: project.cur.scene, frame: project.cur.frame };
    run = { cancel: false };
    document.getElementById("exp-go").disabled = true;

    function setMasterFrame(f) {
      var at = VB.sequenceAt(project, f);
      if (!at) return;
      var sc = VB.sceneById(project, at.inst.scene);
      if (sc && sc.index !== project.cur.scene) project.selectScene(sc.index);
      project.cur.frame = Math.max(0, f - at.start);
      if (VB.CompositeView && VB.CompositeView.sync) VB.CompositeView.sync();
    }

    function drawFlat() {
      var st = project.stage ? project.stage() : project;
      var sw = st.width / VB.TWIPS, sh = st.height / VB.TWIPS;
      var zoom = Math.min(w / sw, h / sh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      VB.renderProject(ctx, project, {
        zoom: zoom,
        panX: (w - sw * zoom) / 2,
        panY: (h - sh * zoom) / 2,
        dpr: 1
      });
    }

    function finish(note) {
      clearInterval(timer);
      project.selectScene(saved.scene); // restore the playhead
      project.cur.frame = saved.frame;
      if (VB.CompositeView && VB.CompositeView.sync) VB.CompositeView.sync();
      if (a.requestRender) a.requestRender();
      rec.onstop = function () {
        run = null;
        document.getElementById("exp-go").disabled = false;
        if (!chunks.length) { progress(note || "nothing recorded"); return; }
        var blob = new Blob(chunks, { type: "video/webm" });
        var link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "vectorbrush-export.webm";
        link.click();
        URL.revokeObjectURL(link.href);
        progress(note || ("done — " + Math.round(blob.size / 1024) + " KB"));
      };
      rec.stop();
    }

    rec.start();
    var f = 0;
    var timer = setInterval(function () {
      if (run.cancel) { finish("cancelled"); return; }
      if (f >= total) { finish(); return; }
      setMasterFrame(f);
      if (src === "flat") {
        drawFlat();
      } else if (!VB.CompositeView.renderInto(cvs, w, h)) {
        finish("the composite renderer went away");
        return;
      }
      track.requestFrame();
      progress("frame " + (f + 1) + " / " + total);
      f++;
    }, Math.max(8, Math.round(1000 / fps)));
  }

  // the menu opens from the top toolbar's File panel
  var btn = document.getElementById("btn-export-video");
  if (btn) btn.addEventListener("click", open);

  window.VB = window.VB || {};
  VB.exportMenuOpen = open;
})();
