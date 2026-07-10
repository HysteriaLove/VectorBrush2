/* spine.js — the pre-production STORY SPINE (docs/PreProductionSpine.md):
 * slugs (story scenes) → BEATS → each beat's block stack (Story-owned
 * prose and dialogue) and panel group (Boards-owned art). The beat is
 * the story⟷boards interchange unit — one discrete story moment. The
 * spine owns STRUCTURE (scene and beat order, membership); block
 * content stays with writing.js and panel content with boards.js, so
 * "one script, rendered twice" holds: the Writing editor and the
 * Boards deck are two views of these same beats.
 *
 * Structure ops are issuable from either workspace; every op carries
 * its ids (adds throw without one — an index-derived fallback could
 * alias references, the sceneAdd lesson). Story slugs are NOT
 * production scenes: Roughs establishes those later, consuming beat
 * durations with provenance (the ladder's T1→T2 promotion).
 */
(function () {
  "use strict";

  function spineOf(project) {
    project.spine = project.spine || { scenes: [] };
    return project.spine;
  }

  function sceneById(project, id) {
    var scenes = spineOf(project).scenes;
    for (var i = 0; i < scenes.length; i++) {
      if (scenes[i].id === id) return { scene: scenes[i], index: i };
    }
    return null;
  }

  /** A beat anywhere on the spine: { scene, sceneIndex, beat, index }. */
  function beatById(project, id) {
    var scenes = spineOf(project).scenes;
    for (var s = 0; s < scenes.length; s++) {
      for (var b = 0; b < scenes[s].beats.length; b++) {
        if (scenes[s].beats[b].id === id) {
          return { scene: scenes[s], sceneIndex: s,
                   beat: scenes[s].beats[b], index: b };
        }
      }
    }
    return null;
  }

  /** Every beat in story order with its scene: [{ scene, beat }]. */
  function flatBeats(project) {
    var out = [];
    spineOf(project).scenes.forEach(function (scene) {
      scene.beats.forEach(function (beat) {
        out.push({ scene: scene, beat: beat });
      });
    });
    return out;
  }

  function beatOfBlock(project, blockId) {
    var flat = flatBeats(project);
    for (var i = 0; i < flat.length; i++) {
      var blocks = flat[i].beat.blocks;
      for (var b = 0; b < blocks.length; b++) {
        if (blocks[b].id === blockId) {
          return { beat: flat[i].beat, scene: flat[i].scene,
                   block: blocks[b], index: b };
        }
      }
    }
    return null;
  }

  function beatOfPanel(project, panelId) {
    var flat = flatBeats(project);
    for (var i = 0; i < flat.length; i++) {
      var panels = flat[i].beat.panels;
      for (var p = 0; p < panels.length; p++) {
        if (panels[p].id === panelId) {
          return { beat: flat[i].beat, scene: flat[i].scene,
                   panel: panels[p], index: p };
        }
      }
    }
    return null;
  }

  /** The beat's story text as display lines — action/note content plus
   *  "CHARACTER: dialogue" — for animatic subtitles and frame text. */
  function beatText(beat, lang) {
    var out = [];
    (beat.blocks || []).forEach(function (b) {
      if (b.kind === "line") {
        var t = VB.lineTextOf ? VB.lineTextOf(b, lang) : "";
        if (t) out.push((b.character ? b.character + ": " : "") + t);
      } else if (b.content) {
        out.push(b.content);
      }
    });
    return out.join("\n");
  }

  // ---- structure ops (both workspaces record these) --------------------------------

  VB.defineOp("spineSceneAdd", function (c, op) {
    if (!op.id) throw new Error("spineSceneAdd op requires an id");
    c.history.push(c.project);
    var scenes = spineOf(c.project).scenes;
    var at = op.index === undefined ? scenes.length
      : Math.max(0, Math.min(scenes.length, op.index));
    scenes.splice(at, 0, {
      id: op.id,
      title: op.title ||
        "Scene " + String(scenes.length + 1).padStart(2, "0"),
      beats: []
    });
    c.sync();
  });

  VB.defineOp("spineSceneRename", function (c, op) {
    var hit = sceneById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.scene.title = op.title;
    c.sync();
  });

  VB.defineOp("spineSceneMove", function (c, op) {
    var hit = sceneById(c.project, op.id);
    if (!hit) return;
    var scenes = spineOf(c.project).scenes;
    var to = Math.max(0, Math.min(scenes.length - 1, op.index));
    if (to === hit.index) return;
    c.history.push(c.project);
    scenes.splice(hit.index, 1);
    scenes.splice(to, 0, hit.scene);
    c.sync();
  });

  VB.defineOp("spineSceneRemove", function (c, op) {
    var hit = sceneById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    spineOf(c.project).scenes.splice(hit.index, 1);
    c.sync();
  });

  VB.defineOp("spineBeatAdd", function (c, op) {
    if (!op.id) throw new Error("spineBeatAdd op requires an id");
    var hit = sceneById(c.project, op.scene);
    if (!hit) return;
    c.history.push(c.project);
    var beats = hit.scene.beats;
    var at = op.index === undefined ? beats.length
      : Math.max(0, Math.min(beats.length, op.index));
    beats.splice(at, 0, {
      id: op.id, title: op.title || "", blocks: [], panels: []
    });
    c.sync();
  });

  VB.defineOp("spineBeatRename", function (c, op) {
    var hit = beatById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.beat.title = op.title;
    c.sync();
  });

  // beats move within or across scenes; order is the spine's alone
  VB.defineOp("spineBeatMove", function (c, op) {
    var hit = beatById(c.project, op.id);
    if (!hit) return;
    var dest = op.scene ? sceneById(c.project, op.scene) : null;
    var scene = dest ? dest.scene : hit.scene;
    if (!scene) return;
    c.history.push(c.project);
    hit.scene.beats.splice(hit.index, 1);
    var to = Math.max(0, Math.min(scene.beats.length, op.index | 0));
    scene.beats.splice(to, 0, hit.beat);
    c.sync();
  });

  /** Split at block index `at`: blocks[at..] move to the new beat
   *  placed immediately after; PANELS STAY WITH THE FIRST HALF (the
   *  deterministic default — the artist redistributes afterwards). */
  VB.defineOp("spineBeatSplit", function (c, op) {
    if (!op.newId) throw new Error("spineBeatSplit op requires newId");
    var hit = beatById(c.project, op.beat);
    if (!hit) return;
    c.history.push(c.project);
    var at = Math.max(0, Math.min(hit.beat.blocks.length, op.at | 0));
    var moved = hit.beat.blocks.splice(at);
    hit.scene.beats.splice(hit.index + 1, 0, {
      id: op.newId, title: op.title || "", blocks: moved, panels: []
    });
    c.sync();
  });

  /** Merge the beat immediately AFTER `beat` (same scene) into it —
   *  blocks and panels concatenate in order. */
  VB.defineOp("spineBeatMerge", function (c, op) {
    var hit = beatById(c.project, op.beat);
    if (!hit) return;
    var next = hit.scene.beats[hit.index + 1];
    if (!next || (op.from && next.id !== op.from)) return;
    c.history.push(c.project);
    hit.beat.blocks = hit.beat.blocks.concat(next.blocks);
    hit.beat.panels = hit.beat.panels.concat(next.panels);
    hit.scene.beats.splice(hit.index + 1, 1);
    c.sync();
  });

  VB.defineOp("spineBeatRemove", function (c, op) {
    var hit = beatById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.scene.beats.splice(hit.index, 1);
    c.sync();
  });

  window.VB = window.VB || {};
  VB.spineOf = spineOf;
  VB.spineSceneById = sceneById;
  VB.spineBeatById = beatById;
  VB.spineFlatBeats = flatBeats;
  VB.spineBeatOfBlock = beatOfBlock;
  VB.spineBeatOfPanel = beatOfPanel;
  VB.spineBeatText = beatText;
})();
