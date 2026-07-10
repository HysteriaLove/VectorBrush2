/* sequence.js — the master timeline (Architecture step 3): scene
 * DEFINITIONS (project.scenes, now with stable ids) sequenced as
 * INSTANCES (project.sequence) — the prototype/instance discipline at
 * the sequence level.
 *
 * Behaviors ported from the Animation Program V2 reference
 * (Managment.py — add_scene / add_scene_instance /
 * delete_scene_instance / rename_scene / set_active_scene_instance_
 * start|end), improved where our architecture demands:
 *   - every mutation is a journaled op with ids carried IN the op
 *     (the reference persists whole state; we replay byte-exact);
 *   - instances get a direct reorder op (the reference can only
 *     add/delete at positions);
 *   - instance labels derive from the scene definition at render time
 *     (the reference stores label copies and relabels on rename).
 * Kept faithful:
 *   - new instances inherit their duration from the nearest same-scene
 *     instance (backward from the insertion point, then forward), then
 *     the after-instance, then the tail instance, else 144 (6s @ 24);
 *   - at least ONE instance always remains; deleting selects the
 *     instance that lands at the removed index;
 *   - boundary trims STEAL frames from the neighbor and both sides
 *     keep >= 1 frame; locked instances freeze their boundaries.
 */
(function () {
  "use strict";

  var DEFAULT_DURATION = 144; // frames — the reference's new-project instance

  function sequenceOf(project) {
    project.sequence = project.sequence || [];
    return project.sequence;
  }

  function sceneById(project, id) {
    for (var i = 0; i < project.scenes.length; i++) {
      if (project.scenes[i].id === id) {
        return { scene: project.scenes[i], index: i };
      }
    }
    return null;
  }

  function instById(project, id) {
    var seq = sequenceOf(project);
    for (var i = 0; i < seq.length; i++) {
      if (seq[i].id === id) return { inst: seq[i], index: i };
    }
    return null;
  }

  function sequenceDuration(project) {
    return sequenceOf(project).reduce(function (n, inst) {
      return n + Math.max(1, inst.duration | 0);
    }, 0);
  }

  /** The instance under a master-clock frame: { inst, start, index }. */
  function sequenceAt(project, frame) {
    var seq = sequenceOf(project);
    var start = 0;
    for (var i = 0; i < seq.length; i++) {
      var d = Math.max(1, seq[i].duration | 0);
      if (frame < start + d || i === seq.length - 1) {
        return { inst: seq[i], start: start, index: i };
      }
      start += d;
    }
    return null;
  }

  function instStart(project, index) {
    var seq = sequenceOf(project), start = 0;
    for (var i = 0; i < index; i++) start += Math.max(1, seq[i].duration | 0);
    return start;
  }

  /** Reference clone-source rule: the nearest instance of the same
   *  scene, searching BACKWARD from the insertion point, then forward. */
  function cloneSource(project, sceneId, afterIndex) {
    var seq = sequenceOf(project);
    for (var b = afterIndex; b >= 0; b--) {
      if (seq[b] && seq[b].scene === sceneId) return seq[b];
    }
    for (var f = afterIndex + 1; f < seq.length; f++) {
      if (seq[f].scene === sceneId) return seq[f];
    }
    return null;
  }

  /** Reference rename rule: unique among scene names, ignoring self —
   *  collisions take the next " N" suffix. */
  function uniqueSceneName(project, want, selfScene) {
    var taken = {};
    project.scenes.forEach(function (sc) {
      if (sc !== selfScene) taken[sc.name] = true;
    });
    if (!taken[want]) return want;
    for (var n = 2; ; n++) {
      if (!taken[want + " " + n]) return want + " " + n;
    }
  }

  VB.defineOp("sceneRename", function (c, op) {
    var hit = sceneById(c.project, op.scene);
    if (!hit || !op.name || !String(op.name).trim()) return;
    c.history.push(c.project);
    hit.scene.name = uniqueSceneName(c.project,
      String(op.name).trim(), hit.scene);
    c.sync();
  });

  VB.defineOp("sceneInstAdd", function (c, op) {
    var sc = sceneById(c.project, op.scene);
    if (!sc) return;
    c.history.push(c.project);
    var seq = sequenceOf(c.project);
    var afterIndex = seq.length - 1;
    if (op.after !== undefined) {
      var af = instById(c.project, op.after);
      if (af) afterIndex = af.index;
    }
    var duration = op.duration;
    if (duration === undefined) {
      var src = cloneSource(c.project, op.scene, afterIndex) ||
                seq[afterIndex] || seq[seq.length - 1];
      duration = src ? src.duration : DEFAULT_DURATION;
    }
    seq.splice(afterIndex + 1, 0, {
      id: op.id, scene: op.scene,
      duration: Math.max(1, duration | 0), locked: false
    });
    // the reference follows the new instance with the cursor
    c.project.selectScene(sc.index);
    c.sync();
  });

  VB.defineOp("sceneInstRemove", function (c, op) {
    var seq = sequenceOf(c.project);
    if (seq.length <= 1) return; // at least one instance is required
    var hit = instById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    seq.splice(hit.index, 1);
    var next = seq[Math.max(0, Math.min(hit.index, seq.length - 1))];
    var sc = sceneById(c.project, next.scene);
    if (sc) c.project.selectScene(sc.index);
    c.sync();
  });

  VB.defineOp("sceneInstMove", function (c, op) {
    var hit = instById(c.project, op.id);
    if (!hit) return;
    var seq = sequenceOf(c.project);
    var to = Math.max(0, Math.min(seq.length - 1, op.index | 0));
    if (to === hit.index) return;
    c.history.push(c.project);
    seq.splice(hit.index, 1);
    seq.splice(to, 0, hit.inst);
    c.sync();
  });

  VB.defineOp("sceneInstDuration", function (c, op) {
    var hit = instById(c.project, op.id);
    if (!hit || hit.inst.locked) return;
    c.history.push(c.project);
    hit.inst.duration = Math.max(1, Math.min(99999, op.frames | 0));
    c.sync();
  });

  VB.defineOp("sceneInstLock", function (c, op) {
    var hit = instById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.inst.locked = !!op.on;
    c.sync();
  });

  // Boundary trims (reference "Set Scene Start/End Here"). Faithful
  // asymmetry: the END edge resizes the instance and everything after
  // it SLIDES (guarded by the next instance's lock, since its start
  // would move); the START edge steals frames from the previous
  // instance so this instance's end stays put — both keep >= 1 frame.
  VB.defineOp("sceneBoundarySet", function (c, op) {
    var hit = instById(c.project, op.inst);
    if (!hit) return;
    var seq = sequenceOf(c.project);
    var start = instStart(c.project, hit.index);
    var dur = Math.max(1, hit.inst.duration | 0);
    if (op.edge === "end") {
      var next = seq[hit.index + 1];
      if (hit.inst.locked || (next && next.locked)) return;
      var frame = Math.max(start + 1, op.frame | 0);
      c.history.push(c.project);
      hit.inst.duration = frame - start;
      c.sync();
      return;
    }
    if (op.edge === "start") {
      if (hit.index <= 0) return;
      var prev = seq[hit.index - 1];
      if (hit.inst.locked || prev.locked) return;
      var prevStart = start - Math.max(1, prev.duration | 0);
      var oldEnd = start + dur;
      var newStart = Math.max(prevStart + 1,
        Math.min(op.frame | 0, oldEnd - 1));
      c.history.push(c.project);
      prev.duration = Math.max(1, newStart - prevStart);
      hit.inst.duration = Math.max(1, oldEnd - newStart);
      c.sync();
    }
  });

  // The reference's DRAG rebalance (set_scene_instance_boundary):
  // moving the boundary between two instances keeps their combined
  // zone fixed — the neighbor absorbs what this edge gives or takes,
  // so scenes resize to fit a region. Only the LAST instance's right
  // edge extends the sequence total. Locked instances freeze their
  // edges; both sides always keep >= 1 frame.
  VB.defineOp("sceneBoundaryDrag", function (c, op) {
    var hit = instById(c.project, op.inst);
    if (!hit) return;
    var seq = sequenceOf(c.project);
    var frame = Math.max(0, op.frame | 0);
    if (op.edge === "right") {
      if (hit.inst.locked) return;
      var start = instStart(c.project, hit.index);
      var next = seq[hit.index + 1];
      if (next) {
        if (next.locked) return;
        var nextEnd = start + Math.max(1, hit.inst.duration | 0) +
                      Math.max(1, next.duration | 0);
        var b = Math.max(start + 1, Math.min(frame, nextEnd - 1));
        c.history.push(c.project);
        hit.inst.duration = b - start;
        next.duration = nextEnd - b;
      } else {
        c.history.push(c.project);
        hit.inst.duration = Math.max(1, frame - start);
      }
      c.sync();
      return;
    }
    if (op.edge === "left") {
      if (hit.index <= 0) return;
      var prev = seq[hit.index - 1];
      if (prev.locked || hit.inst.locked) return;
      var myStart = instStart(c.project, hit.index);
      var prevStart = myStart - Math.max(1, prev.duration | 0);
      var myEnd = myStart + Math.max(1, hit.inst.duration | 0);
      var b2 = Math.max(prevStart + 1, Math.min(frame, myEnd - 1));
      c.history.push(c.project);
      prev.duration = b2 - prevStart;
      hit.inst.duration = myEnd - b2;
      c.sync();
    }
  });

  window.VB = window.VB || {};
  VB.sequenceOf = sequenceOf;
  VB.sequenceDuration = sequenceDuration;
  VB.sequenceAt = sequenceAt;
  VB.sequenceInstStart = instStart;
  VB.sequenceInstById = instById;
  VB.sceneById = sceneById;
})();
