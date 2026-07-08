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

  /**
   * Replays a journal through the real tool code paths.
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
    var project = new VB.Project();
    var history = new VB.History();
    var doc = project.activeCell();

    function sync() { doc = project.activeCell(); }

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      switch (op.op) {
        case "new":
          project = new VB.Project(op.width, op.height);
          history.clear();
          sync();
          break;
        case "load": {
          var bytes = b64ToBytes(op.b64);
          var result = VB.isVBD(bytes)
            ? await VB.decodeVBD(bytes)
            : await VB.parseSWF(bytes.buffer);
          project = result.project || VB.wrapDoc(result.doc);
          history.clear();
          sync();
          break;
        }
        case "layerAdd":
          history.push(project);
          project.addLayer(op.name);
          sync();
          break;
        case "layerDelete":
          history.push(project);
          project.deleteLayer(op.index);
          sync();
          break;
        case "layerMove":
          history.push(project);
          project.moveLayer(op.from, op.to);
          sync();
          break;
        case "layerRename":
          history.push(project);
          project.scene().layers[op.index].name = op.name;
          break;
        case "layerSelect":
          project.selectLayer(op.index);
          sync();
          break;
        case "layerVisible":
          project.scene().layers[op.index].visible = !!op.on;
          break;
        case "layerLock":
          project.scene().layers[op.index].locked = !!op.on;
          break;
        case "sceneAdd":
          history.push(project);
          project.addScene(op.name);
          sync();
          break;
        case "sceneSelect":
          project.selectScene(op.index);
          sync();
          break;
        case "pencil":
          history.push(project);
          VB.pencilCommit(doc, op.points, op.style,
            op.tolerance === null ? undefined : op.tolerance,
            op.snapTol);
          break;
        case "bucket": {
          history.push(project);
          var r = VB.bucketFill(doc, op.x, op.y, { color: op.color });
          if (r.stamped === 0) history.undoStack.pop(); // mirror the tool
          break;
        }
        case "erase": {
          history.push(project);
          var re = VB.eraseStroke(doc, op.points, op.radius);
          if (re.removed === 0 && re.boundary === 0) history.undoStack.pop();
          break;
        }
        case "brush":
          history.push(project);
          VB.brushStroke(doc, op.points, op.radius, op.color);
          break;
        case "line":
          history.push(project);
          VB.lineCommit(doc, op.a, op.b, op.style, op.snapTol);
          break;
        case "oval":
          history.push(project);
          VB.shapeCommit(doc, VB.ellipseLoop(
            (op.x0 + op.x1) / 2, (op.y0 + op.y1) / 2,
            (op.x1 - op.x0) / 2, (op.y1 - op.y0) / 2), op.fill, op.line);
          break;
        case "rect":
          history.push(project);
          VB.shapeCommit(doc, VB.rectLoop(op.x0, op.y0, op.x1, op.y1),
            op.fill, op.line);
          break;
        case "reshape":
          history.push(project);
          VB.arrowReshape(doc, op.key, op.t, op.x, op.y);
          break;
        case "moveNode":
          history.push(project);
          VB.arrowMoveNode(doc, op.x, op.y, op.nx, op.ny);
          break;
        case "moveFill":
          history.push(project);
          VB.arrowMoveFill(doc, op.x, op.y, op.dx, op.dy);
          break;
        case "deleteFill":
          history.push(project);
          VB.arrowDeleteFill(doc, op.x, op.y);
          break;
        case "deleteEdge":
          history.push(project);
          VB.arrowDeleteEdge(doc, op.key);
          break;
        case "transformSel":
          history.push(project);
          VB.arrowTransformSel(doc, op.fills, op.edgeKeys, op.m);
          break;
        case "deleteSel":
          history.push(project);
          VB.arrowDeleteSel(doc, op.fills, op.edgeKeys);
          break;
        case "regionTransform":
          history.push(project);
          VB.regionTransform(doc, op.points, op.m);
          break;
        case "regionDelete":
          history.push(project);
          VB.regionDelete(doc, op.points);
          break;
        case "textCreate":
          // self-contained: the op carries its font subset + baked
          // advances, so replay never depends on installed fonts
          history.push(project);
          VB.textApplyOp(doc, op);
          break;
        case "undo":
          history.undo(project);
          sync();
          break;
        case "redo":
          history.redo(project);
          sync();
          break;
        default:
          throw new Error("unknown journal op: " + op.op);
      }
      if (hooks && hooks.onOp) hooks.onOp(i, op, doc);
    }
    return { doc: project.activeCell(), project: project, history: history };
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
})();
