/* journal.js — deterministic action log.
 *
 * Every document-mutating user action is recorded with its exact inputs
 * (pointer trails in float twips, colors, radii, snap tolerances), so a
 * session can be exported as JSON and replayed bit-for-bit through the
 * same code paths. This is the bug-reporting backbone: a broken drawing
 * plus its journal is a deterministic reproduction.
 *
 * Ops:
 *   {op:"new", width, height}                          fresh document
 *   {op:"load", name, b64}                             open .swf/.vbd
 *   {op:"pencil", points, style:{width,color}, tolerance, snapTol}
 *   {op:"bucket", x, y, color}
 *   {op:"erase", points, radius}
 *   {op:"undo"} / {op:"redo"}
 */
(function () {
  "use strict";

  function bytesToB64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ---- the command registry --------------------------------------------------
  // Every journal op is a COMMAND: one named apply function, defined
  // once, dispatched identically by replay and by the live app
  // (app.exec). Live-vs-replay divergence — the whole journal-desync
  // bug class — is impossible for anything routed through here.
  //
  // A command receives (ctx, op) where ctx is
  //   { doc, project, history, sync() }
  // doc is the active layer's cell; commands that change which cell is
  // active (layer/scene/undo ops) mutate ctx.project and call
  // ctx.sync(). Commands manage their own history snapshots (most push
  // one; no-op commands pop it again — the bucket/eraser convention).
  var OPS = new Map();
  function defineOp(name, apply) { OPS.set(name, apply); }

  /** Dispatch one op against a context. May return a promise ("load"). */
  function applyOp(ctx, op) {
    var fn = OPS.get(op.op);
    if (!fn) throw new Error("unknown journal op: " + op.op);
    return fn(ctx, op);
  }

  defineOp("new", function (c, op) {
    c.project = new VB.Project(op.width, op.height);
    c.history.clear();
    c.sync();
  });
  defineOp("load", async function (c, op) {
    var bytes = b64ToBytes(op.b64);
    var result = VB.isY2KVector(bytes)
      ? await VB.decodeY2KVector(bytes)
      : await VB.parseSWF(bytes.buffer);
    c.project = result.project || VB.wrapDoc(result.doc);
    // files without a persisted library (SWF, older .vbd bodies)
    // rebuild theirs from the cells' non-solid fills
    VB.projectCollectMaterials(c.project);
    c.history.clear();
    c.sync();
  });
  defineOp("layerAdd", function (c, op) {
    c.history.push(c.project);
    c.project.addLayer(op.name);
    c.sync();
  });
  defineOp("layerDelete", function (c, op) {
    c.history.push(c.project);
    c.project.deleteLayer(op.index);
    c.sync();
  });
  defineOp("layerMove", function (c, op) {
    c.history.push(c.project);
    c.project.moveLayer(op.from, op.to);
    c.sync();
  });
  defineOp("layerRename", function (c, op) {
    c.history.push(c.project);
    c.project.scene().layers[op.index].name = op.name;
  });
  defineOp("layerSelect", function (c, op) {
    c.project.selectLayer(op.index);
    c.sync();
  });
  defineOp("layerVisible", function (c, op) {
    c.project.scene().layers[op.index].visible = !!op.on;
  });
  defineOp("layerLock", function (c, op) {
    c.project.scene().layers[op.index].locked = !!op.on;
  });
  defineOp("sceneAdd", function (c, op) {
    // ops CARRY their ids (recorder mints VB.actorNewId("scene")) — an
    // index-derived fallback could alias a deleted scene's id in
    // sequence/cast references, so a missing id is a recorder bug
    if (!op.id) throw new Error("sceneAdd op requires an id");
    c.history.push(c.project);
    c.project.addScene(op.name, op.id);
    c.sync();
  });
  defineOp("sceneSelect", function (c, op) {
    c.project.selectScene(op.index);
    c.sync();
  });
  // frames (Sequence/Roughs step 3): a layer's frames[] is its
  // sub-timeline; cur.frame is the shared playhead column. Layers
  // shorter than the playhead HOLD their last frame (Flash).
  defineOp("frameAdd", function (c, op) {
    c.history.push(c.project);
    c.project.addFrame(op.layer);
    c.sync();
  });
  defineOp("frameRemove", function (c, op) {
    c.history.push(c.project);
    c.project.removeFrame(op.layer, op.index);
    c.sync();
  });
  defineOp("frameSelect", function (c, op) {
    c.project.selectFrame(op.index);
    c.sync();
  });
  // The roughs timeline's boundary drag: a drawing's EXPOSURE
  // (layer.holds) changes and its right neighbor compensates — the
  // zone-preserving panelBoundary discipline, so downstream drawings
  // keep their audio sync. The last drawing's boundary moves freely.
  defineOp("frameBoundary", function (c, op) {
    if (c.project.editTarget) return; // actor cells have no timeline
    var layers = c.project.scene().layers;
    var l = layers[Math.min(op.layer || 0, layers.length - 1)];
    var spans = VB.frameSpans(l); // materializes holds
    var i = op.cell | 0;
    if (i < 0 || i >= l.frames.length) return;
    c.history.push(c.project);
    var want = Math.max(1, op.frames | 0);
    if (i < l.frames.length - 1) {
      var pair = spans[i].frames + spans[i + 1].frames;
      want = Math.min(want, pair - 1);
      l.holds[i + 1] = pair - want;
    }
    l.holds[i] = want;
    c.sync();
  });
  defineOp("fpsSet", function (c, op) {
    c.project.fps = Math.max(1, Math.min(120, op.fps | 0)) || 24;
  });
  defineOp("pencil", function (c, op) {
    c.history.push(c.project);
    VB.pencilCommit(c.doc, op.points, op.style,
      op.tolerance === null ? undefined : op.tolerance,
      op.snapTol);
  });
  defineOp("bucket", function (c, op) {
    c.history.push(c.project);
    var r = VB.bucketFill(c.doc, op.x, op.y,
                          { color: op.color, style: op.style });
    if (r.stamped === 0) c.history.undoStack.pop(); // nothing happened
  });
  defineOp("erase", function (c, op) {
    c.history.push(c.project);
    var re = VB.eraseStroke(c.doc, op.points, op.radius);
    if (re.removed === 0 && re.boundary === 0) c.history.undoStack.pop();
  });
  defineOp("brush", function (c, op) {
    c.history.push(c.project);
    VB.brushStroke(c.doc, op.points, op.radius, op.style || op.color);
  });
  defineOp("line", function (c, op) {
    c.history.push(c.project);
    VB.lineCommit(c.doc, op.a, op.b, op.style, op.snapTol);
  });
  defineOp("oval", function (c, op) {
    c.history.push(c.project);
    VB.shapeCommit(c.doc, VB.ellipseLoop(
      (op.x0 + op.x1) / 2, (op.y0 + op.y1) / 2,
      (op.x1 - op.x0) / 2, (op.y1 - op.y0) / 2), op.fill, op.line);
  });
  defineOp("rect", function (c, op) {
    c.history.push(c.project);
    VB.shapeCommit(c.doc, VB.rectLoop(op.x0, op.y0, op.x1, op.y1),
      op.fill, op.line);
  });
  defineOp("reshape", function (c, op) {
    c.history.push(c.project);
    VB.arrowReshape(c.doc, op.key, op.t, op.x, op.y);
  });
  defineOp("moveNode", function (c, op) {
    c.history.push(c.project);
    VB.arrowMoveNode(c.doc, op.x, op.y, op.nx, op.ny);
  });
  defineOp("moveFill", function (c, op) {
    c.history.push(c.project);
    VB.arrowMoveFill(c.doc, op.x, op.y, op.dx, op.dy);
  });
  defineOp("deleteFill", function (c, op) {
    c.history.push(c.project);
    VB.arrowDeleteFill(c.doc, op.x, op.y);
  });
  defineOp("deleteEdge", function (c, op) {
    c.history.push(c.project);
    VB.arrowDeleteEdge(c.doc, op.key);
  });
  defineOp("transformSel", function (c, op) {
    c.history.push(c.project);
    VB.arrowTransformSel(c.doc, op.fills, op.edgeKeys, op.m);
  });
  defineOp("deleteSel", function (c, op) {
    c.history.push(c.project);
    VB.arrowDeleteSel(c.doc, op.fills, op.edgeKeys);
  });
  defineOp("regionTransform", function (c, op) {
    c.history.push(c.project);
    VB.regionTransform(c.doc, op.points, op.m);
  });
  defineOp("regionDelete", function (c, op) {
    c.history.push(c.project);
    VB.regionDelete(c.doc, op.points);
  });
  // text ops are self-contained: they carry font subsets + baked
  // advances, so replay never depends on installed fonts
  defineOp("textCreate", function (c, op) {
    c.history.push(c.project);
    VB.textApplyOp(c.doc, op);
  });
  defineOp("textEdit", function (c, op) {
    c.history.push(c.project);
    VB.textEditApply(c.doc, op);
  });
  defineOp("textTransform", function (c, op) {
    c.history.push(c.project);
    VB.textTransformApply(c.doc, op.index, op.m);
  });
  defineOp("textDelete", function (c, op) {
    c.history.push(c.project);
    VB.textDeleteApply(c.doc, op.index);
  });
  defineOp("textBreak", function (c, op) {
    c.history.push(c.project);
    VB.textBreakApply(c.doc, op.index);
  });
  defineOp("textWrap", function (c, op) {
    c.history.push(c.project);
    VB.textWrapApply(c.doc, op.index, op.width, op.dx);
  });
  defineOp("textSize", function (c, op) {
    c.history.push(c.project);
    VB.textSizeApply(c.doc, op.index, op.height, op.dy);
  });
  defineOp("textBoxH", function (c, op) {
    c.history.push(c.project);
    VB.textBoxHApply(c.doc, op.index, op.height, op.dy);
  });
  // Replace a fill-style entry with a 2DMaterial definition. The op
  // carries the full style, so replay is self-contained; geometry and
  // claims are untouched — only what the style paints changes.
  defineOp("fillStyle", function (c, op) {
    if (op.index < 0 || op.index >= c.doc.fills.length) {
      throw new Error("fillStyle: no fill style " + op.index);
    }
    c.history.push(c.project);
    c.doc.fills[op.index] = VB.materialClone(op.style);
  });

  // The GLOBAL material library (project.materials — Flash's library,
  // not per-layer). materialEdit also rewrites every structurally-
  // matching fill in every cell, so editing a material updates all
  // its uses across layers and scenes.
  defineOp("materialAdd", function (c, op) {
    c.history.push(c.project);
    c.project.addMaterial(VB.materialClone(op.style));
  });
  defineOp("materialEdit", function (c, op) {
    if (op.index < 0 || op.index >= (c.project.materials || []).length) {
      throw new Error("materialEdit: no library material " + op.index);
    }
    c.history.push(c.project);
    c.project.editMaterial(op.index, VB.materialClone(op.style));
  });

  // Paste a shape clip (a standalone mini planar map captured at copy
  // time — self-contained like the text ops, so replay never depends
  // on clipboard state) under a placement matrix. Merging is the same
  // one-pass region merge a transform drop uses.
  defineOp("paste", function (c, op) {
    c.history.push(c.project);
    var clip = new VB.Y2KVectorDocument();
    clip.width = c.doc.width; clip.height = c.doc.height;
    clip.fills = op.clip.fills.map(function (f) {
      return { type: "solid", color: { r: f.color.r, g: f.color.g,
                                       b: f.color.b, a: f.color.a } };
    });
    clip.lines = op.clip.lines.map(function (l) {
      return { width: l.width, color: { r: l.color.r, g: l.color.g,
                                        b: l.color.b, a: l.color.a } };
    });
    clip.edges = op.clip.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by,
                     e.fill0, e.fill1, e.line);
    });
    VB.regionMergeLifted(c.doc, clip, op.m);
  });
  defineOp("undo", function (c) {
    c.history.undo(c.project);
    c.sync();
  });
  defineOp("redo", function (c) {
    c.history.redo(c.project);
    c.sync();
  });

  /**
   * Replays a journal through the real tool code paths — the SAME
   * command functions the live app dispatches through app.exec.
   *  ops:   the journal array
   *  hooks: optional { onOp(index, op, doc) } called AFTER each op —
   *         throw from it to abort (used by the replay harness to run
   *         integrity checks and pinpoint the corrupting op).
   * Returns { doc (the active layer's cell), project, history }.
   *
   * Geometry ops always target the ACTIVE layer's cell; layer and scene
   * switches are ops themselves, so replay is deterministic. Journals
   * from before the DOM existed have no layer ops and replay into a
   * single-layer project — identical behavior.
   */
  async function replayJournal(ops, hooks) {
    var ctx = {
      project: new VB.Project(),
      history: new VB.History(),
      doc: null,
      sync: function () { ctx.doc = ctx.project.activeCell(); }
    };
    ctx.sync();

    for (var i = 0; i < ops.length; i++) {
      await applyOp(ctx, ops[i]);
      if (hooks && hooks.onOp) hooks.onOp(i, ops[i], ctx.doc);
    }
    return { doc: ctx.project.activeCell(), project: ctx.project,
             history: ctx.history };
  }

  // Standard integrity sweep used by the replay harness and tests.
  // Open fill chains are graded by their gap chord: a wide gap renders
  // as a visible fill wedge (corruption); a gap of a few twips is a
  // cosmetic seam — the unavoidable cost of integer-twips editing next
  // to sub-probe slivers (Flash quantizes the same way).
  var SEAM_TOL = 30; // twips (1.5px)

  function integrityReport(doc) {
    var problems = [];
    var inv = doc.validate();
    if (inv.length) problems.push("invariant: " + inv[0]);
    var planar = VB.validatePlanar(doc, 10);
    if (planar.length) {
      problems.push("planarity: " + planar.length + " un-noded crossings, first at (" +
        planar[0].point.x.toFixed(1) + "," + planar[0].point.y.toFixed(1) + ")");
    }
    var perFill = VB.buildFillPaths(doc);
    var wide = 0, widest = 0;
    for (var f = 1; f < perFill.length; f++) {
      for (var c = 0; c < perFill[f].length; c++) {
        var ch = perFill[f][c];
        if (ch.closed) continue;
        var last = ch.pts[ch.pts.length - 1];
        var gap = Math.hypot(last.x - ch.sx, last.y - ch.sy);
        if (gap > SEAM_TOL) { wide++; widest = Math.max(widest, gap); }
      }
    }
    if (wide) {
      problems.push("fills: " + wide + " open boundary chains (widest gap " +
        Math.round(widest) + "tw)");
    }
    return problems;
  }

  window.VB = window.VB || {};
  VB.replayJournal = replayJournal;
  VB.integrityReport = integrityReport;
  VB.bytesToB64 = bytesToB64;
  VB.b64ToBytes = b64ToBytes;
  VB.defineOp = defineOp;
  VB.applyOp = applyOp;
})();
