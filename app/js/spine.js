/* spine.js — the pre-production STORY SPINE (docs/PreProductionSpine.md,
 * revised 2026-07-10 to the PANEL-DRIVEN model): ONE flat, ordered list
 * of PANELS — scene, shot, and panel are the same container. A panel is
 * a story moment: its ROWS are the script (action / dialogue / note —
 * Story-owned content), its CELL is the drawing (Boards-owned art), its
 * SETTING references the settings registry. Panel numbering is
 * presentation (index + 1, live-renumbered); identity is the stable id.
 *
 * SCENES ARE DERIVED, never stored: a run of consecutive panels sharing
 * a setting is a scene (film grammar — continuous action in one
 * setting). CHARACTERS and SETTINGS are the first registries — the
 * casting sheets that later link to Actors and Backgrounds.
 *
 * Structure ops are issuable from either workspace; every op carries
 * its ids (adds throw without one). Timing: per-panel duration in
 * frames is the stored truth; the audio-backed timeline lane EDITS it
 * (never absolute audio ms — re-cutting audio must not re-time the
 * board).
 */
(function () {
  "use strict";

  // FIXED RESOLUTIONS (user decision): storyboards are exactly HALF
  // the main canvas (1600×1200 default) — 800×600. The 2:1 ratio is
  // what keeps stroke weights consistent when boards are referenced
  // over the rough canvas or drawn at card scale.
  var PANEL_W = 800 * 20, PANEL_H = 600 * 20;
  var DEFAULT_DURATION = 24; // frames

  function spineOf(project) {
    project.spine = project.spine ||
      { panels: [], characters: [], settings: [] };
    return project.spine;
  }

  function panelById(project, id) {
    var panels = spineOf(project).panels;
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].id === id) return { panel: panels[i], index: i };
    }
    return null;
  }

  function panelOfRow(project, rowId) {
    var panels = spineOf(project).panels;
    for (var i = 0; i < panels.length; i++) {
      for (var r = 0; r < panels[i].rows.length; r++) {
        if (panels[i].rows[r].id === rowId) {
          return { panel: panels[i], panelIndex: i,
                   row: panels[i].rows[r], index: r };
        }
      }
    }
    return null;
  }

  function entryById(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function characterById(project, id) {
    return entryById(spineOf(project).characters, id);
  }

  function settingById(project, id) {
    return entryById(spineOf(project).settings, id);
  }

  function findByName(list, name) {
    var want = String(name || "").trim().toLowerCase();
    if (!want) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].name.trim().toLowerCase() === want) return list[i];
    }
    return null;
  }

  /** SCENES, derived: runs of consecutive panels sharing a setting —
   *  [{ setting: id|null, from, to }] over panel indices (inclusive). */
  function sceneRuns(project) {
    var panels = spineOf(project).panels;
    var runs = [];
    panels.forEach(function (p, i) {
      var last = runs[runs.length - 1];
      var s = p.setting || null;
      if (last && last.setting === s) last.to = i;
      else runs.push({ setting: s, from: i, to: i });
    });
    return runs;
  }

  /** The panel's story text as display lines — action/note content plus
   *  "CHARACTER: dialogue" — for animatic subtitles and frame text. */
  function panelText(project, panel, lang) {
    var out = [];
    (panel.rows || []).forEach(function (r) {
      if (r.kind === "line") {
        var t = VB.lineTextOf ? VB.lineTextOf(r, lang) : "";
        var who = r.character &&
          (characterById(project, r.character) || {}).name;
        if (t) out.push((who ? who + ": " : "") + t);
      } else if (r.content) {
        out.push(r.content);
      }
    });
    return out.join("\n");
  }

  function newPanelCell() {
    var d = new VB.Y2KVectorDocument();
    d.width = PANEL_W;
    d.height = PANEL_H;
    return d;
  }

  /** Panel spans on the T1 audio-ms axis (frames × 1000/fps from 0):
   *  [{ panel, index, startMs, endMs }] — the shared ruler the Audio
   *  sync area and the Roughs timeline both draw against. */
  function panelSpans(project) {
    var fm = 1000 / (project.fps || 24);
    var out = [];
    var at = 0;
    spineOf(project).panels.forEach(function (p, i) {
      var len = Math.max(1, p.duration | 0) * fm;
      out.push({ panel: p, index: i, startMs: at, endMs: at + len });
      at += len;
    });
    return out;
  }

  function panelAtMs(project, ms) {
    var spans = panelSpans(project);
    for (var i = 0; i < spans.length; i++) {
      if (ms < spans[i].endMs || i === spans.length - 1) return spans[i];
    }
    return null;
  }

  // ---- panel ops (the one container — both workspaces record these) ---------------

  VB.defineOp("panelAdd", function (c, op) {
    if (!op.id) throw new Error("panelAdd op requires an id");
    c.history.push(c.project);
    var panels = spineOf(c.project).panels;
    var at = op.index === undefined ? panels.length
      : Math.max(0, Math.min(panels.length, op.index));
    panels.splice(at, 0, {
      id: op.id,
      rows: [],
      setting: op.setting || null,
      cell: newPanelCell(),
      duration: op.duration || DEFAULT_DURATION
    });
    c.sync();
  });

  VB.defineOp("panelMove", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    var panels = spineOf(c.project).panels;
    var to = Math.max(0, Math.min(panels.length - 1, op.index | 0));
    if (to === hit.index) return;
    c.history.push(c.project);
    panels.splice(hit.index, 1);
    panels.splice(to, 0, hit.panel);
    c.sync();
  });

  VB.defineOp("panelRemove", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    spineOf(c.project).panels.splice(hit.index, 1);
    c.sync();
  });

  VB.defineOp("panelDuration", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.panel.duration = Math.max(1, Math.min(9999, op.frames | 0));
    c.sync();
  });

  /** Drag the boundary AFTER a panel on the sync timeline: the panel's
   *  duration changes and its right neighbor compensates, so every
   *  downstream panel stays on its audio hit (the sceneBoundaryDrag
   *  discipline — zone-preserving). The last panel's boundary just
   *  extends or shortens the reel. */
  VB.defineOp("panelBoundary", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    var next = spineOf(c.project).panels[hit.index + 1];
    var want = Math.max(1, Math.min(9999, op.frames | 0));
    c.history.push(c.project);
    if (next) {
      var pair = Math.max(1, hit.panel.duration | 0) +
                 Math.max(1, next.duration | 0);
      want = Math.min(want, pair - 1);
      next.duration = pair - want;
    }
    hit.panel.duration = want;
    c.sync();
  });

  /** Assign/clear the panel's setting — scene boundaries move with it
   *  (scenes are derived from setting runs, never stored). */
  VB.defineOp("panelSetting", function (c, op) {
    var hit = panelById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.panel.setting = op.setting || null;
    c.sync();
  });

  // ---- the registries (characters, settings — the casting sheets) -----------------
  // entries auto-create on first use from the editors (the recorder
  // mints the op); later they LINK to actors and backgrounds

  VB.defineOp("characterAdd", function (c, op) {
    if (!op.id) throw new Error("characterAdd op requires an id");
    c.history.push(c.project);
    spineOf(c.project).characters.push(
      { id: op.id, name: op.name || "" });
    c.sync();
  });

  VB.defineOp("characterRename", function (c, op) {
    var e = characterById(c.project, op.id);
    if (!e) return;
    c.history.push(c.project);
    e.name = op.name;
    c.sync();
  });

  VB.defineOp("characterRemove", function (c, op) {
    var list = spineOf(c.project).characters;
    var e = entryById(list, op.id);
    if (!e) return;
    c.history.push(c.project);
    list.splice(list.indexOf(e), 1);
    c.sync();
  });

  VB.defineOp("settingAdd", function (c, op) {
    if (!op.id) throw new Error("settingAdd op requires an id");
    c.history.push(c.project);
    spineOf(c.project).settings.push({ id: op.id, name: op.name || "" });
    c.sync();
  });

  VB.defineOp("settingRename", function (c, op) {
    var e = settingById(c.project, op.id);
    if (!e) return;
    c.history.push(c.project);
    e.name = op.name;
    c.sync();
  });

  VB.defineOp("settingRemove", function (c, op) {
    var list = spineOf(c.project).settings;
    var e = entryById(list, op.id);
    if (!e) return;
    c.history.push(c.project);
    list.splice(list.indexOf(e), 1);
    c.sync();
  });

  window.VB = window.VB || {};
  VB.spineOf = spineOf;
  VB.spinePanelById = panelById;
  VB.spinePanelOfRow = panelOfRow;
  VB.spineCharacterById = characterById;
  VB.spineSettingById = settingById;
  VB.spineFindByName = findByName;
  VB.spineSceneRuns = sceneRuns;
  VB.spinePanelText = panelText;
  VB.spinePanelSpans = panelSpans;
  VB.spinePanelAtMs = panelAtMs;
})();
