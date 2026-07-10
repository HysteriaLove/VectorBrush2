/* stepseq.js — actor instances in scenes + the step sequencer
 * (docs/StepSequencer.md, reference: Animation Program V2).
 *
 * Model, faithful to the reference:
 *   scene.cast   — placed INSTANCES { id, ref, kind, x, y, scale,
 *                  rotation }: the prototype/instance discipline
 *                  (SceneActorRef). ref points at an actor or a
 *                  library entry; edits to the prototype flow to
 *                  every placement.
 *   scene.tracks — generic timing clips { id, lane, target, start,
 *                  duration, label } (the reference's TimelineClip).
 *                  Rows are GENERATED from structure; clips exist only
 *                  as painted timing regions.
 * Exposure painting (pose cells, visibility spans) maintains RUNS of
 * clips per target: one ranged op per gesture, never per-cell journal
 * spam. Split fragments derive deterministic ids so replay is
 * byte-exact.
 */
(function () {
  "use strict";

  // ---- lookups -------------------------------------------------------------------

  function sceneByIdOf(project, id) {
    for (var i = 0; i < project.scenes.length; i++) {
      if (project.scenes[i].id === id) return project.scenes[i];
    }
    return null;
  }

  function castOf(scene) {
    scene.cast = scene.cast || [];
    return scene.cast;
  }

  function tracksOf(scene) {
    scene.tracks = scene.tracks || [];
    return scene.tracks;
  }

  function instById(project, id) {
    for (var s = 0; s < project.scenes.length; s++) {
      var cast = project.scenes[s].cast || [];
      for (var i = 0; i < cast.length; i++) {
        if (cast[i].id === id) {
          return { scene: project.scenes[s], inst: cast[i], index: i };
        }
      }
    }
    return null;
  }

  /** The prototype behind an instance: actor or library entry. */
  function refOf(project, inst) {
    if (inst.kind === "actor") {
      for (var a = 0; a < project.actors.length; a++) {
        if (project.actors[a].id === inst.ref) {
          return { actor: project.actors[a] };
        }
      }
      return null;
    }
    var lib = project.library || [];
    for (var i = 0; i < lib.length; i++) {
      if (lib[i].id === inst.ref) return { entry: lib[i] };
    }
    return null;
  }

  /** The scene's playable span in frames (longest sequence instance,
   *  at least its drawn frames). */
  function sceneSpanFor(project, scene) {
    var span = 1;
    (scene.layers || []).forEach(function (l) {
      span = Math.max(span, l.frames.length);
    });
    (project.sequence || []).forEach(function (si) {
      if (si.scene === scene.id) {
        span = Math.max(span, Math.max(1, si.duration | 0));
      }
    });
    return span;
  }

  // ---- run maintenance (exposure + visibility clips) ------------------------------

  function clipsFor(scene, target) {
    return tracksOf(scene).filter(function (c) {
      return c.target === target;
    }).sort(function (a, b) { return a.start - b.start; });
  }

  /** Rewrite the runs on one target so [from..to] carries `value`
   *  (null erases). Fragment ids derive from the source clip so live
   *  and replay build identical structures. */
  function setRun(scene, target, lane, from, to, value, opId) {
    var tracks = tracksOf(scene);
    var keep = [];
    tracks.forEach(function (c) {
      if (c.target !== target) { keep.push(c); return; }
      var cEnd = c.start + c.duration - 1;
      if (cEnd < from || c.start > to) { keep.push(c); return; }
      if (c.start < from) { // left remainder
        keep.push({ id: c.id + ":l" + from, lane: c.lane, target: target,
                    start: c.start, duration: from - c.start,
                    label: c.label });
      }
      if (cEnd > to) { // right remainder
        keep.push({ id: c.id + ":r" + to, lane: c.lane, target: target,
                    start: to + 1, duration: cEnd - to,
                    label: c.label });
      }
    });
    if (value !== null && value !== undefined) {
      keep.push({ id: opId, lane: lane, target: target,
                  start: from, duration: to - from + 1, label: value });
    }
    // merge adjacent same-label runs on this target (stable ids: the
    // earlier run absorbs the later one)
    var mine = keep.filter(function (c) { return c.target === target; })
      .sort(function (a, b) { return a.start - b.start; });
    var rest = keep.filter(function (c) { return c.target !== target; });
    var merged = [];
    mine.forEach(function (c) {
      var last = merged[merged.length - 1];
      if (last && last.label === c.label &&
          last.start + last.duration === c.start) {
        last.duration += c.duration;
      } else {
        merged.push({ id: c.id, lane: c.lane, target: c.target,
                      start: c.start, duration: c.duration,
                      label: c.label });
      }
    });
    scene.tracks = rest.concat(merged);
  }

  /** The run value on a target at a frame (null when uncovered). */
  function runAt(scene, target, frame) {
    var tracks = scene.tracks || [];
    for (var i = 0; i < tracks.length; i++) {
      var c = tracks[i];
      if (c.target === target && frame >= c.start &&
          frame < c.start + c.duration) {
        return c.label;
      }
    }
    return null;
  }

  /** Visible unless visibility runs exist and none covers the frame
   *  (the reference places a default whole-scene Visible span). */
  function instVisibleAt(scene, instId, frame) {
    var any = false;
    var tracks = scene.tracks || [];
    for (var i = 0; i < tracks.length; i++) {
      var c = tracks[i];
      if (c.target === "vis:" + instId) {
        any = true;
        if (frame >= c.start && frame < c.start + c.duration) return true;
      }
    }
    return !any;
  }

  /** The pose an actor instance exposes at a frame. */
  function instPoseAt(project, scene, inst, frame) {
    var painted = runAt(scene, "pose:" + inst.id, frame);
    var ref = refOf(project, inst);
    if (!ref || !ref.actor) return null;
    var poses = ref.actor.poses;
    if (painted) {
      for (var i = 0; i < poses.length; i++) {
        if (poses[i].id === painted) return poses[i];
      }
    }
    return poses[0] || null;
  }

  /** The cell an instance draws at a frame (null hides it). */
  function instCellAt(project, scene, inst, frame) {
    if (!instVisibleAt(scene, inst.id, frame)) return null;
    var ref = refOf(project, inst);
    if (!ref) return null;
    if (ref.actor) {
      var pose = instPoseAt(project, scene, inst, frame);
      return pose ? pose.cell : null;
    }
    return ref.entry.cell || null;
  }

  // ---- ops -------------------------------------------------------------------------

  VB.defineOp("instancePlace", function (c, op) {
    var scene = sceneByIdOf(c.project, op.scene);
    if (!scene) return;
    // the prototype must exist
    var probe = refOf(c.project, { kind: op.kind, ref: op.ref });
    if (!probe) return;
    c.history.push(c.project);
    castOf(scene).push({
      id: op.id, ref: op.ref, kind: op.kind,
      x: op.x | 0, y: op.y | 0,
      scale: op.scale === undefined ? 1 : +op.scale,
      rotation: op.rotation === undefined ? 0 : +op.rotation
    });
    // the reference drops a whole-scene Visible span on placement
    setRun(scene, "vis:" + op.id, "vis",
           0, sceneSpanFor(c.project, scene) - 1, "1", op.id + ":vis");
    c.sync();
  });

  VB.defineOp("instanceMove", function (c, op) {
    var hit = instById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.inst.x = op.x | 0;
    hit.inst.y = op.y | 0;
    c.sync();
  });

  VB.defineOp("instanceTransform", function (c, op) {
    var hit = instById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    if (op.x !== undefined) hit.inst.x = op.x | 0;
    if (op.y !== undefined) hit.inst.y = op.y | 0;
    if (op.scale !== undefined) {
      var sc = +op.scale;
      hit.inst.scale = Math.max(0.01, isFinite(sc) ? sc : 1);
    }
    if (op.rotation !== undefined) hit.inst.rotation = +op.rotation || 0;
    c.sync();
  });

  // removing an instance removes every clip that targets it
  VB.defineOp("instanceRemove", function (c, op) {
    var hit = instById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.scene.cast.splice(hit.index, 1);
    hit.scene.tracks = (hit.scene.tracks || []).filter(function (cl) {
      return cl.target !== "vis:" + op.id &&
             cl.target !== "pose:" + op.id;
    });
    c.sync();
  });

  /** Paint (or erase, value null) a run over [from..to] — ONE op per
   *  drag gesture. lane "vis" paints visibility, "pose" paints pose
   *  exposure with the pose id as the value. */
  VB.defineOp("exposureSet", function (c, op) {
    var scene = sceneByIdOf(c.project, op.scene);
    if (!scene) return;
    var from = Math.max(0, op.from | 0);
    var to = Math.max(from, op.to | 0);
    c.history.push(c.project);
    setRun(scene, op.target, op.lane || "exposure",
           from, to, op.value === undefined ? null : op.value, op.id);
    c.sync();
  });

  window.VB = window.VB || {};
  VB.stepCastOf = castOf;
  VB.stepTracksOf = tracksOf;
  VB.stepInstById = instById;
  VB.stepRefOf = refOf;
  VB.stepClipsFor = clipsFor;
  VB.stepRunAt = runAt;
  VB.stepVisibleAt = instVisibleAt;
  VB.stepPoseAt = instPoseAt;
  VB.stepCellAt = instCellAt;
  VB.stepSceneSpan = sceneSpanFor;
})();
