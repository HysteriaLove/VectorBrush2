/* arrow.js — the Flash Arrow tool (V): select, move, reshape, delete.
 *
 * Semantics extracted from the Arrow001 reference series (record-level
 * diffs of MX 2004 before/after snapshots):
 *   - dragging the MIDDLE of an edge reshapes it with both endpoints
 *     pinned: a straight record becomes a quad whose curve passes
 *     through the drag point (Arrow002->003 is exactly L->Q with
 *     identical endpoints); quads re-solve their control the same way;
 *   - dragging an ANCHOR moves the shared node — every incident record
 *     follows;
 *   - reshaped geometry that crosses other art is re-noded into the
 *     planar map (the reference shows Flash re-merging after drags);
 *   - clicking a fill selects that FACE; dragging lifts it and drops it
 *     with paint-over semantics (the moved region replaces what it
 *     lands on); Delete erases the face (stamp its sides empty — the
 *     lineless borders to emptiness dissolve).
 *
 * Every operation is journaled and deterministic: edges are identified
 * by their full record key, faces by a containing point.
 */
(function () {
  "use strict";

  // ---- edge identity ---------------------------------------------------------

  function edgeKey(e) {
    return [e.ax, e.ay, e.cx === null ? "n" : e.cx, e.cy === null ? "n" : e.cy,
            e.bx, e.by, e.fill0, e.fill1, e.line].join(",");
  }
  function findByKey(doc, key) {
    for (var i = 0; i < doc.edges.length; i++) {
      if (edgeKey(doc.edges[i]) === key) return i;
    }
    return -1;
  }

  // ---- core operations (journal-replayable) -----------------------------------

  /**
   * Reshape one record: endpoints pinned, control solved so the curve
   * passes through (tx,ty) at parameter t. Straight records become
   * quads (Arrow002->003). The result is re-noded into the map.
   */
  function arrowReshape(doc, key, t, tx, ty) {
    var idx = findByKey(doc, key);
    if (idx < 0) return false;
    var e = doc.edges[idx];
    doc.edges.splice(idx, 1);
    t = Math.min(0.8, Math.max(0.2, t));
    var u = 1 - t;
    var cx = Math.round((tx - u * u * e.ax - t * t * e.bx) / (2 * t * u));
    var cy = Math.round((ty - u * u * e.ay - t * t * e.by) / (2 * t * u));
    var ne = VB.edge(e.ax, e.ay, cx, cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    if (VB.edgeIsDegenerate(ne)) { doc.edges.push(e); return false; }
    var pieces = VB.nodeEdges(doc, [ne]);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
    VB.repairPlanar(doc);
    return true;
  }

  /** Move the shared node at (x,y) to (nx,ny); incident records follow. */
  function arrowMoveNode(doc, x, y, nx, ny) {
    nx = Math.round(nx); ny = Math.round(ny);
    var moved = [];
    doc.edges = doc.edges.filter(function (e) {
      var hit = (e.ax === x && e.ay === y) || (e.bx === x && e.by === y);
      if (hit) moved.push(e);
      return !hit;
    });
    if (moved.length === 0) return false;
    var updated = [];
    moved.forEach(function (e) {
      var ax = (e.ax === x && e.ay === y) ? nx : e.ax;
      var ay = (e.ax === x && e.ay === y) ? ny : e.ay;
      var bx = (e.bx === x && e.by === y) ? nx : e.bx;
      var by = (e.by === x && e.by === y) ? ny : e.by;
      var ne = VB.edge(ax, ay, e.cx, e.cy, bx, by, e.fill0, e.fill1, e.line);
      if (!VB.edgeIsDegenerate(ne)) updated.push(ne);
    });
    var pieces = VB.nodeEdges(doc, updated);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
    VB.repairPlanar(doc);
    return true;
  }

  // Directed boundary loops (face-on-right) of the face containing (x,y),
  // as pristine edge copies, plus the fill index there. Null if empty.
  function faceLoopsAt(doc, x, y) {
    var fillIdx = VB.geom.fillAt(doc, x, y);
    if (fillIdx === 0) return null;
    var face = VB.faceAt(doc, x, y);
    if (!face) return null;
    var loops = [];
    [face.outer].concat(face.holes).forEach(function (cyc) {
      var loop = [];
      cyc.forEach(function (h) {
        var e = doc.edges[h.edge];
        loop.push(h.forward
          ? VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0)
          : VB.edge(e.bx, e.by, e.cx, e.cy, e.ax, e.ay, 0, 0, 0));
      });
      loops.push(loop);
    });
    return { fillIdx: fillIdx, face: face, loops: loops };
  }

  /**
   * Delete the fill face at (x,y): stamp the face's own sides empty and
   * cull the lineless borders that end up 0|0 — exact, probe-free.
   */
  function arrowDeleteFill(doc, x, y) {
    var fillIdx = VB.geom.fillAt(doc, x, y);
    if (fillIdx === 0) return false;
    var face = VB.faceAt(doc, x, y);
    if (!face) return false;
    [face.outer].concat(face.holes).forEach(function (cyc) {
      cyc.forEach(function (h) {
        var e = doc.edges[h.edge];
        if (h.forward) e.fill1 = 0; else e.fill0 = 0;
      });
    });
    doc.edges = doc.edges.filter(function (e) {
      return !(e.fill0 === e.fill1 && e.line === 0);
    });
    return true;
  }

  /**
   * Move the fill face at (x,y) by (dx,dy): Flash's lift-and-drop —
   * the face is deleted at the source and painted at the destination
   * with paint-over semantics (the brush's boolean-mask pipeline).
   */
  function arrowMoveFill(doc, x, y, dx, dy) {
    var picked = faceLoopsAt(doc, x, y);
    if (!picked) return false;
    dx = Math.round(dx); dy = Math.round(dy);
    if (dx === 0 && dy === 0) return false;
    var fillIdx = picked.fillIdx;

    arrowDeleteFill(doc, x, y);

    var fitted = [];
    picked.loops.forEach(function (loop) {
      loop.forEach(function (e) {
        var ne = VB.edge(e.ax + dx, e.ay + dy,
          e.cx === null ? null : e.cx + dx, e.cy === null ? null : e.cy + dy,
          e.bx + dx, e.by + dy, 0, 0, 0);
        if (!VB.edgeIsDegenerate(ne)) fitted.push(ne);
      });
    });
    if (fitted.length === 0) return false;
    var windingLoops = fitted.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    function insideMoved(px, py) {
      return VB.geom.windingNumber(windingLoops, px, py) !== 0;
    }
    var preOp = new VB.VBDocument();
    preOp.width = doc.width; preOp.height = doc.height;
    preOp.fills = doc.fills; preOp.lines = doc.lines;
    preOp.edges = doc.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    });
    var adopted = VB.adoptIdenticalEdges(doc, fitted);
    var pieces = VB.nodeEdges(doc, adopted.fresh);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
    VB.applyRegionMask(doc, preOp, insideMoved, fillIdx,
                       pieces.concat(adopted.twins));
    return true;
  }

  /** Delete a stroke record: strip the line style; cull if claim-free. */
  function arrowDeleteEdge(doc, key) {
    var idx = findByKey(doc, key);
    if (idx < 0) return false;
    var e = doc.edges[idx];
    if (e.line === 0) return false; // lineless borders belong to their fills
    e.line = 0;
    if (e.fill0 === e.fill1) doc.edges.splice(idx, 1);
    return true;
  }

  // ---- interactive tool ---------------------------------------------------------

  function ArrowTool(app) {
    var self = {
      app: app,
      sel: null,       // {kind:"fill",x,y,loops} | {kind:"edge",idx} | null
      drag: null,      // active drag state
      hoverPos: null
    };

    function pickTol() { return 6 * VB.TWIPS / app.view.zoom; }

    function pickAnchor(pos) {
      var tol = pickTol();
      var best = null, bestD = tol;
      app.doc.edges.forEach(function (e) {
        [[e.ax, e.ay], [e.bx, e.by]].forEach(function (p) {
          var d = Math.hypot(p[0] - pos.x, p[1] - pos.y);
          if (d < bestD) { bestD = d; best = { x: p[0], y: p[1] }; }
        });
      });
      return best;
    }
    function pickEdge(pos) {
      var tol = pickTol();
      var best = -1, bestD = tol;
      app.doc.edges.forEach(function (e, i) {
        var d = VB.geom.distToEdge(e, pos.x, pos.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }

    self.onDown = function (pos) {
      var anchor = pickAnchor(pos);
      if (anchor) {
        self.drag = { kind: "node", from: anchor, cur: pos };
        return;
      }
      var ei = pickEdge(pos);
      if (ei >= 0) {
        var e = app.doc.edges[ei];
        var q = VB.geom.nearestOnEdge(e, pos.x, pos.y);
        self.drag = { kind: "edge", key: edgeKey(e), edge: e, t: q.t, cur: pos, moved: false };
        return;
      }
      var fillIdx = VB.geom.fillAt(app.doc, pos.x, pos.y);
      if (fillIdx > 0) {
        var picked = faceLoopsAt(app.doc, pos.x, pos.y);
        if (picked) {
          self.drag = { kind: "fill", from: pos, cur: pos, loops: picked.loops, moved: false };
          self.sel = { kind: "fill", x: pos.x, y: pos.y, loops: picked.loops };
          app.requestRender();
          return;
        }
      }
      self.sel = null;
      app.requestRender();
    };

    self.onMove = function (pos) {
      if (!self.drag) return;
      self.drag.cur = pos;
      var d0 = self.drag.from || VB.geom.evalEdge(self.drag.edge, self.drag.t);
      if (Math.hypot(pos.x - d0.x, pos.y - d0.y) > 8) self.drag.moved = true;
      app.requestRender();
    };

    self.onUp = function (pos) {
      var drag = self.drag;
      self.drag = null;
      if (!drag) return;
      pos = pos || drag.cur;

      if (drag.kind === "node" && drag.cur &&
          Math.hypot(pos.x - drag.from.x, pos.y - drag.from.y) > 8) {
        app.record({ op: "moveNode", x: drag.from.x, y: drag.from.y,
                     nx: Math.round(pos.x), ny: Math.round(pos.y) });
        app.history.push(app.doc);
        arrowMoveNode(app.doc, drag.from.x, drag.from.y, pos.x, pos.y);
        app.docChanged();
        app.setMsg("node moved");
        return;
      }
      if (drag.kind === "edge") {
        if (drag.moved) {
          app.record({ op: "reshape", key: drag.key, t: drag.t,
                       x: Math.round(pos.x), y: Math.round(pos.y) });
          app.history.push(app.doc);
          arrowReshape(app.doc, drag.key, drag.t, pos.x, pos.y);
          app.docChanged();
          app.setMsg("edge reshaped");
        } else {
          var idx = findByKey(app.doc, drag.key);
          self.sel = idx >= 0 ? { kind: "edge", idx: idx } : null;
          app.requestRender();
        }
        return;
      }
      if (drag.kind === "fill" && drag.moved) {
        var dx = Math.round(pos.x - drag.from.x);
        var dy = Math.round(pos.y - drag.from.y);
        app.record({ op: "moveFill", x: Math.round(drag.from.x),
                     y: Math.round(drag.from.y), dx: dx, dy: dy });
        app.history.push(app.doc);
        arrowMoveFill(app.doc, drag.from.x, drag.from.y, dx, dy);
        self.sel = null;
        app.docChanged();
        app.setMsg("fill moved");
      }
    };

    self.onDeleteKey = function () {
      if (!self.sel) return false;
      if (self.sel.kind === "fill") {
        app.record({ op: "deleteFill", x: Math.round(self.sel.x), y: Math.round(self.sel.y) });
        app.history.push(app.doc);
        arrowDeleteFill(app.doc, self.sel.x, self.sel.y);
        app.setMsg("fill deleted");
      } else {
        var e = app.doc.edges[self.sel.idx];
        if (!e) { self.sel = null; return false; }
        app.record({ op: "deleteEdge", key: edgeKey(e) });
        app.history.push(app.doc);
        arrowDeleteEdge(app.doc, edgeKey(e));
        app.setMsg("stroke deleted");
      }
      self.sel = null;
      app.docChanged();
      return true;
    };

    self.cancel = function () { self.drag = null; app.requestRender(); };

    function strokeLoop(ctx, loop, dx, dy) {
      ctx.beginPath();
      loop.forEach(function (e) {
        ctx.moveTo(e.ax + dx, e.ay + dy);
        if (e.cx === null) ctx.lineTo(e.bx + dx, e.by + dy);
        else ctx.quadraticCurveTo(e.cx + dx, e.cy + dy, e.bx + dx, e.by + dy);
      });
      ctx.stroke();
    }

    self.drawOverlay = function (ctx) {
      var hair = VB.TWIPS / app.view.zoom;
      if (self.sel && self.sel.kind === "fill") {
        ctx.strokeStyle = "rgba(0,160,255,0.9)";
        ctx.lineWidth = 2 * hair;
        ctx.setLineDash([6 * hair, 4 * hair]);
        self.sel.loops.forEach(function (l) { strokeLoop(ctx, l, 0, 0); });
        ctx.setLineDash([]);
      }
      if (self.sel && self.sel.kind === "edge") {
        var e = app.doc.edges[self.sel.idx];
        if (e) {
          ctx.strokeStyle = "rgba(0,160,255,0.9)";
          ctx.lineWidth = 3 * hair;
          strokeLoop(ctx, [e], 0, 0);
        }
      }
      if (!self.drag || !self.drag.moved) return;
      ctx.strokeStyle = "rgba(255,120,0,0.9)";
      ctx.lineWidth = 2 * hair;
      if (self.drag.kind === "fill") {
        var dx = self.drag.cur.x - self.drag.from.x;
        var dy = self.drag.cur.y - self.drag.from.y;
        self.drag.loops.forEach(function (l) { strokeLoop(ctx, l, dx, dy); });
      } else if (self.drag.kind === "edge") {
        var e2 = self.drag.edge;
        var t = Math.min(0.8, Math.max(0.2, self.drag.t));
        var u = 1 - t;
        var cx = (self.drag.cur.x - u * u * e2.ax - t * t * e2.bx) / (2 * t * u);
        var cy = (self.drag.cur.y - u * u * e2.ay - t * t * e2.by) / (2 * t * u);
        ctx.beginPath();
        ctx.moveTo(e2.ax, e2.ay);
        ctx.quadraticCurveTo(cx, cy, e2.bx, e2.by);
        ctx.stroke();
      } else if (self.drag.kind === "node") {
        ctx.beginPath();
        ctx.arc(self.drag.cur.x, self.drag.cur.y, 4 * hair, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    return self;
  }

  window.VB = window.VB || {};
  VB.ArrowTool = ArrowTool;
  VB.arrowReshape = arrowReshape;
  VB.arrowMoveNode = arrowMoveNode;
  VB.arrowMoveFill = arrowMoveFill;
  VB.arrowDeleteFill = arrowDeleteFill;
  VB.arrowDeleteEdge = arrowDeleteEdge;
  VB.arrowEdgeKey = edgeKey;
})();
