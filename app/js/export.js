/* export.js — the VIDEO EXPORT menu (Architecture §6.10). CapCut-style
 * settings (user spec): name, resolution presets, frame rate, quality
 * (bitrate), format (MP4/WebM with support detection), audio, source —
 * plus an estimated file size.
 *
 * Rendering steps the MASTER SEQUENCE by export time (t · project fps),
 * so any export frame rate keeps real duration. Recording rides
 * MediaRecorder (canvas captureStream + requestFrame) at playback
 * pace; the project's audio joins as a real audio track
 * (VB.audioExportStream). View-only: never journals; the playhead is
 * restored when the run ends.
 */
(function () {
  "use strict";

  var RES = { "480p": 480, "720p": 720, "1080p": 1080,
              "2K": 1440, "4K": 2160 };
  // recommended video bitrates (Mbps) per resolution, CapCut-ish
  var RECOMMENDED = { "480p": 2.5, "720p": 5, "1080p": 8,
                      "2K": 16, "4K": 35 };
  var QUALITY = { Low: 0.5, Recommended: 1, High: 2 };

  var ui = null;
  var run = null;

  function app() { return window.VBApp; }

  function mimeFor(format) {
    var candidates = format === "mp4"
      ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"]
      : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus",
         "video/webm"];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder &&
          MediaRecorder.isTypeSupported(candidates[i])) {
        return candidates[i];
      }
    }
    return null;
  }

  function aspect() {
    var cam = VB.CompositeView && VB.CompositeView.camConfig
      ? VB.CompositeView.camConfig() : null;
    return cam ? cam.aw / cam.ah : 16 / 9;
  }

  function field(id) { return document.getElementById(id); }

  function build() {
    if (ui) return ui;
    var wrap = document.createElement("div");
    wrap.id = "exportmenu";
    wrap.innerHTML =
      '<div id="exp-panel">' +
      '<h3>Export</h3>' +
      '<label>Name <input type="text" id="exp-name" value="vectorbrush-export"></label>' +
      '<label>Resolution <select id="exp-res">' +
      Object.keys(RES).map(function (k) {
        return '<option' + (k === "1080p" ? " selected" : "") + ">" +
               k + "</option>";
      }).join("") + '</select></label>' +
      '<label>Frame rate <select id="exp-fps">' +
      [24, 25, 30, 50, 60].map(function (f) {
        return "<option" + (f === 30 ? " selected" : "") + ">" + f +
               "</option>";
      }).join("") + '</select></label>' +
      '<label>Quality <select id="exp-q">' +
      Object.keys(QUALITY).map(function (k) {
        return '<option' + (k === "Recommended" ? " selected" : "") + ">" +
               k + "</option>";
      }).join("") + '</select></label>' +
      '<label>Format <select id="exp-fmt">' +
      '<option value="mp4">MP4</option>' +
      '<option value="webm">WebM</option>' +
      '</select></label>' +
      '<label>Audio <input type="checkbox" id="exp-audio" checked></label>' +
      '<label>Source <select id="exp-src">' +
      '<option value="flat">Flat (oracle)</option>' +
      '<option value="composite">Composite camera (three.js)</option>' +
      '</select></label>' +
      '<div id="exp-note"></div>' +
      '<div id="exp-actions">' +
      '<button id="exp-go">Export</button>' +
      '<button id="exp-close">Close</button>' +
      '</div>' +
      '<div id="exp-progress"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    ui = wrap;
    wrap.addEventListener("pointerdown", function (ev) {
      if (ev.target === wrap && !run) close();
    });
    field("exp-close").addEventListener("click", function () {
      if (run) { run.cancel = true; return; }
      close();
    });
    field("exp-go").addEventListener("click", start);
    ["exp-res", "exp-fps", "exp-q", "exp-fmt", "exp-audio", "exp-src"]
      .forEach(function (id) {
        field(id).addEventListener("change", updateNote);
      });
    return wrap;
  }

  function dims() {
    var h = RES[field("exp-res").value] || 1080;
    var w = Math.max(16, Math.round(h * aspect() / 2) * 2);
    return { w: w, h: h };
  }

  function bitrate() {
    var mbps = (RECOMMENDED[field("exp-res").value] || 8) *
               (QUALITY[field("exp-q").value] || 1);
    return Math.round(mbps * 1000000);
  }

  function updateNote() {
    var a = app();
    if (!a || !ui) return;
    var d = dims();
    var fmt = field("exp-fmt").value;
    var mime = mimeFor(fmt);
    var durS = VB.sequenceDuration(a.project) / (a.project.fps || 24);
    var estMB = (bitrate() * durS / 8 +
                 (field("exp-audio").checked ? 16000 * durS : 0)) / 1e6;
    field("exp-note").textContent =
      d.w + "×" + d.h + " · " + durS.toFixed(1) + "s · est. " +
      estMB.toFixed(1) + " MB" +
      (mime ? "" : " · " + fmt.toUpperCase() +
        " is not supported by this browser");
    field("exp-go").disabled = !mime && !run;
  }

  function open() {
    build();
    var a = app();
    if (a) {
      var srcSel = field("exp-src");
      var compReady = VB.CompositeView && VB.CompositeView.isMounted();
      srcSel.options[1].disabled = !compReady;
      if (!compReady) srcSel.value = "flat";
      if (!mimeFor("mp4")) {
        field("exp-fmt").value = "webm";
        field("exp-fmt").options[0].disabled = true;
      }
    }
    ui.style.display = "flex";
    progress("");
    updateNote();
  }

  function close() {
    if (ui) ui.style.display = "none";
  }

  function progress(text) {
    var el = field("exp-progress");
    if (el) el.textContent = text;
  }

  function start() {
    var a = app();
    if (!a || run) return;
    var project = a.project;
    var d = dims();
    var fps = parseInt(field("exp-fps").value, 10) || 30;
    var fmt = field("exp-fmt").value;
    var mime = mimeFor(fmt);
    if (!mime) { progress(fmt + " is unsupported here"); return; }
    var src = field("exp-src").value;
    if (src === "composite" &&
        !(VB.CompositeView && VB.CompositeView.isMounted())) {
      progress("open the Composite tab first for the camera source");
      return;
    }
    var wantAudio = field("exp-audio").checked &&
      VB.audioHasClips && VB.audioHasClips(project);
    var name = (field("exp-name").value || "vectorbrush-export")
      .replace(/[^\w\- ]+/g, "_");
    var projectFps = project.fps || 24;
    var totalMaster = VB.sequenceDuration(project);
    var durS = totalMaster / projectFps;
    var totalFrames = Math.max(1, Math.ceil(durS * fps));

    var cvs = document.createElement("canvas");
    cvs.width = d.w;
    cvs.height = d.h;
    var ctx = src === "flat" ? cvs.getContext("2d") : null;
    var stream = cvs.captureStream(0);
    var track = stream.getVideoTracks()[0];
    var saved = { scene: project.cur.scene, frame: project.cur.frame };
    run = { cancel: false };
    field("exp-go").disabled = true;

    function setMasterFrame(mf) {
      var at = VB.sequenceAt(project, mf);
      if (!at) return;
      var sc = VB.sceneById(project, at.inst.scene);
      if (sc && sc.index !== project.cur.scene) project.selectScene(sc.index);
      project.cur.frame = Math.max(0, mf - at.start);
      if (VB.CompositeView && VB.CompositeView.sync) VB.CompositeView.sync();
    }

    function drawFlat() {
      var st = project.stage ? project.stage() : project;
      var sw = st.width / VB.TWIPS, sh = st.height / VB.TWIPS;
      var zoom = Math.min(d.w / sw, d.h / sh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, d.w, d.h);
      VB.renderProject(ctx, project, {
        zoom: zoom,
        panX: (d.w - sw * zoom) / 2,
        panY: (d.h - sh * zoom) / 2,
        dpr: 1
      });
    }

    function begin(audioHandle) {
      var recStream = stream;
      if (audioHandle) {
        var tracks = [track].concat(audioHandle.stream.getAudioTracks());
        recStream = new MediaStream(tracks);
      }
      var rec;
      try {
        rec = new MediaRecorder(recStream, {
          mimeType: mime,
          videoBitsPerSecond: bitrate(),
          audioBitsPerSecond: 128000
        });
      } catch (e) {
        progress("recording unavailable: " + e.message);
        run = null;
        field("exp-go").disabled = false;
        if (audioHandle) audioHandle.stop();
        return;
      }
      var chunks = [];
      rec.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };

      function finish(note) {
        clearInterval(timer);
        if (audioHandle) audioHandle.stop();
        project.selectScene(saved.scene);
        project.cur.frame = saved.frame;
        if (VB.CompositeView && VB.CompositeView.sync) VB.CompositeView.sync();
        if (a.requestRender) a.requestRender();
        rec.onstop = function () {
          run = null;
          field("exp-go").disabled = false;
          if (!chunks.length) { progress(note || "nothing recorded"); return; }
          var blob = new Blob(chunks, { type: mime.split(";")[0] });
          var link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = name + (fmt === "mp4" ? ".mp4" : ".webm");
          link.click();
          URL.revokeObjectURL(link.href);
          progress(note ||
            ("done — " + (blob.size / 1e6).toFixed(1) + " MB"));
        };
        rec.stop();
      }

      rec.start();
      var f = 0;
      var timer = setInterval(function () {
        if (run.cancel) { finish("cancelled"); return; }
        if (f >= totalFrames) { finish(); return; }
        // export time -> master frame (real duration at ANY export fps)
        setMasterFrame(Math.min(totalMaster - 1,
          Math.floor(f / fps * projectFps)));
        if (src === "flat") {
          drawFlat();
        } else if (!VB.CompositeView.renderInto(cvs, d.w, d.h)) {
          finish("the composite renderer went away");
          return;
        }
        track.requestFrame();
        progress("frame " + (f + 1) + " / " + totalFrames);
        f++;
      }, Math.max(8, Math.round(1000 / fps)));
    }

    if (wantAudio) {
      progress("preparing audio…");
      VB.audioExportStream(project, 0).then(begin, function () {
        begin(null); // audio failed: export silent rather than not at all
      });
    } else {
      begin(null);
    }
  }

  // the menu opens from the top File toolpanel
  var btn = document.getElementById("btn-export-video");
  if (btn) btn.addEventListener("click", open);

  window.VB = window.VB || {};
  VB.exportMenuOpen = open;
})();
