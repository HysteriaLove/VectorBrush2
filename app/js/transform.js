/* transform.js — the Free Transform tool (Q).
 *
 * Operates on a selection (adopted from the arrow tool on activation,
 * or picked directly): draws the transform box with eight scale
 * handles, rotates when grabbed just outside a corner, moves when
 * dragged from inside. The tool stays live between gestures: each
 * release accumulates its matrix and the box follows, so the user can
 * scale, rotate and move in any order. Nothing touches the document
 * until the selection is clicked away (or the tool switches) — then
 * the composed matrix lands as ONE transform op through the same
 * lift/paint-over pipeline as the arrow's move. Affine maps take quad
 * records to quad records exactly, so records stay records.
 */
(function () {
  "use strict";

  function FreeTransformTool(app) {
    var self = {
      app: app,
      items: null,    // {fills:[{x,y}], edgeKeys:[]} or {region:[pts]}
      pristine: null, // untransformed edge copies of the selection
      gestures: [],   // accumulated per-gesture matrices (uncommitted)
      ghosts: null,   // pristine mapped through the composed matrix
      box: null,      // {x0,y0,x1,y1} of ghosts
      drag: null
    };

    function ghostsOf(items) {
      var out = [];
      items.fills.forEach(function (p) {
        var fillIdx = VB.geom.fillAt(app.doc, p.x, p.y);
        if (fillIdx === 0) return;
        var face = VB.faceAt(app.doc, p.x, p.y);
        if (!face) return;
        [face.outer].concat(face.holes).forEach(function (cyc) {
          cyc.forEach(function (h) {
            var e = app.doc.edges[h.edge];
            out.push(VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0));
          });
        });
      });
      items.edgeKeys.forEach(function (k) {
        for (var i = 0; i < app.doc.edges.length; i++) {
          if (VB.arrowEdgeKey(app.doc.edges[i]) === k) {
            var e = app.doc.edges[i];
            out.push(VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0));
            break;
          }
        }
      });
      return out;
    }

    function bboxOf(edges) {
      if (!edges.length) return null;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      edges.forEach(function (e) {
        [[e.ax, e.ay], [e.bx, e.by]].concat(
          e.cx === null ? [] : [[e.cx, e.cy]]).forEach(function (p) {
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
          y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
        });
      });
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    function matMul(m2, m1) { // apply m1 first, then m2
      return [
        m2[0] * m1[0] + m2[2] * m1[1],
        m2[1] * m1[0] + m2[3] * m1[1],
        m2[0] * m1[2] + m2[2] * m1[3],
        m2[1] * m1[2] + m2[3] * m1[3],
        m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
        m2[1] * m1[4] + m2[3] * m1[5] + m2[5]
      ];
    }
    function composedM() {
      var m = [1, 0, 0, 1, 0, 0];
      self.gestures.forEach(function (g) { m = matMul(g, m); });
      return m;
    }
    function isIdentity(m) {
      return Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 &&
             Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 &&
             Math.abs(m[4]) < 1 && Math.abs(m[5]) < 1;
    }
    function applyPt(m, x, y) {
      return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
    }
    function refreshGhosts() {
      if (!self.pristine) { self.ghosts = null; self.box = null; return; }
      var m = composedM();
      self.ghosts = self.pristine.map(function (e) {
        var a = applyPt(m, e.ax, e.ay), b = applyPt(m, e.bx, e.by);
        var c = e.cx === null ? null : applyPt(m, e.cx, e.cy);
        return VB.edge(a.x, a.y, c === null ? null : c.x,
                       c === null ? null : c.y, b.x, b.y, 0, 0, 0);
      });
      self.box = bboxOf(self.ghosts);
    }

    /** Land the accumulated session on the document as ONE journal op. */
    self.commitPending = function () {
      if (!self.items || !self.gestures.length) { self.gestures = []; return false; }
      var m = composedM();
      self.gestures = []; // before mutating: docChanged() discards us
      if (isIdentity(m)) return false;
      if (self.items.region) {
        app.record({ op: "regionTransform", points: self.items.region, m: m });
        app.history.push(app.doc);
        VB.regionTransform(app.doc, self.items.region, m);
      } else {
        app.record({ op: "transformSel", fills: self.items.fills,
                     edgeKeys: self.items.edgeKeys, m: m });
        app.history.push(app.doc);
        VB.arrowTransformSel(app.doc, self.items.fills, self.items.edgeKeys, m);
      }
      app.docChanged();
      app.setMsg("selection transformed");
      return true;
    };

    /** Drop the session without committing — the document changed under
     *  us (load, undo/redo, another tool), so the picks are stale. */
    self.discard = function () {
      self.items = null; self.pristine = null; self.gestures = [];
      self.ghosts = null; self.box = null; self.drag = null;
    };

    /** Ctrl+Z during a session: step back ONE gesture (nothing was
     *  journaled, so nothing reaches the history). */
    self.undoPending = function () {
      if (!self.gestures.length) return false;
      self.gestures.pop();
      refreshGhosts();
      app.requestRender();
      app.setMsg(self.gestures.length ? "transform step undone" : "transform reverted");
      return true;
    };

    /** Escape: abandon ALL pending gestures, keep the selection. */
    self.revertPending = function () {
      if (!self.gestures.length) return false;
      self.gestures = [];
      refreshGhosts();
      app.requestRender();
      app.setMsg("transform reverted");
      return true;
    };

    self.adopt = function (items) {
      self.commitPending();
      self.gestures = [];
      if (items && items.region) {
        self.items = { region: items.region };
        self.pristine = VB.regionPolyLoop(items.region);
      } else if (items && (items.fills.length || items.edgeKeys.length)) {
        self.items = items;
        self.pristine = ghostsOf(items);
      } else {
        self.items = null; self.pristine = null;
      }
      refreshGhosts();
      app.requestRender();
    };

    function handles() {
      var b = self.box;
      if (!b) return [];
      var mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
      return [
        { x: b.x0, y: b.y0, ax: 1, ay: 1 }, { x: mx, y: b.y0, ax: 0, ay: 1 },
        { x: b.x1, y: b.y0, ax: 1, ay: 1 }, { x: b.x1, y: my, ax: 1, ay: 0 },
        { x: b.x1, y: b.y1, ax: 1, ay: 1 }, { x: mx, y: b.y1, ax: 0, ay: 1 },
        { x: b.x0, y: b.y1, ax: 1, ay: 1 }, { x: b.x0, y: my, ax: 1, ay: 0 }
      ];
    }

    function pickHandle(pos, tol) {
      var hs = handles();
      for (var i = 0; i < hs.length; i++) {
        if (Math.abs(pos.x - hs[i].x) <= tol && Math.abs(pos.y - hs[i].y) <= tol) {
          return { index: i, h: hs[i] };
        }
      }
      return null;
    }

    self.onDown = function (pos, ev) {
      var tol = 8 * VB.TWIPS / app.view.zoom;
      if (self.box) {
        var hit = pickHandle(pos, tol);
        if (hit) {
          // anchor = opposite handle
          var hs = handles();
          var opp = hs[(hit.index + 4) % 8];
          self.drag = { kind: "scale", h: hit.h, anchor: opp, cur: pos, m: null };
          return;
        }
        var b = self.box;
        var inside = pos.x > b.x0 && pos.x < b.x1 && pos.y > b.y0 && pos.y < b.y1;
        var nearBox = pos.x > b.x0 - 3 * tol && pos.x < b.x1 + 3 * tol &&
                      pos.y > b.y0 - 3 * tol && pos.y < b.y1 + 3 * tol;
        if (inside) {
          self.drag = { kind: "move", from: pos, cur: pos, m: null };
          return;
        }
        if (nearBox) {
          var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
          self.drag = { kind: "rotate", center: { x: cx, y: cy },
                        a0: Math.atan2(pos.y - cy, pos.x - cx), cur: pos, m: null };
          return;
        }
      }
      // clicked away from the selection: the accumulated session lands
      // as ONE op FIRST, so the pick below sees the post-commit document
      // (the originals only now leave their old location)
      self.commitPending();
      // (re)pick a selection: fill or attached-stroke chain under cursor
      var fillIdx = VB.geom.fillAt(app.doc, pos.x, pos.y);
      if (fillIdx > 0) {
        self.adopt({ fills: [{ x: pos.x, y: pos.y }], edgeKeys: [] });
        return;
      }
      var tol2 = 6 * VB.TWIPS / app.view.zoom;
      for (var i = 0; i < app.doc.edges.length; i++) {
        if (VB.geom.distToEdge(app.doc.edges[i], pos.x, pos.y) < tol2 &&
            app.doc.edges[i].line > 0) {
          self.adopt({ fills: [], edgeKeys: VB.connectedStrokeKeys(app.doc, i) });
          return;
        }
      }
      self.adopt(null);
    };

    function currentMatrix() {
      var d = self.drag;
      if (!d) return null;
      if (d.kind === "move") {
        return [1, 0, 0, 1, d.cur.x - d.from.x, d.cur.y - d.from.y];
      }
      if (d.kind === "scale") {
        var ax = d.anchor.x, ay = d.anchor.y;
        var sx = d.h.ax ? (d.cur.x - ax) / (d.h.x - ax || 1) : 1;
        var sy = d.h.ay ? (d.cur.y - ay) / (d.h.y - ay || 1) : 1;
        if (!isFinite(sx) || Math.abs(sx) < 0.02) sx = 0.02;
        if (!isFinite(sy) || Math.abs(sy) < 0.02) sy = 0.02;
        // scale about the anchor
        return [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay];
      }
      if (d.kind === "rotate") {
        var a = Math.atan2(d.cur.y - d.center.y, d.cur.x - d.center.x) - d.a0;
        var cos = Math.cos(a), sin = Math.sin(a);
        var cx = d.center.x, cy = d.center.y;
        return [cos, sin, -sin, cos,
                cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
      }
      return null;
    }

    self.onMove = function (pos) {
      if (!self.drag) return;
      self.drag.cur = pos;
      self.drag.m = currentMatrix();
      app.requestRender();
    };

    self.onUp = function (pos) {
      var d = self.drag;
      if (!d || !self.items) { self.drag = null; app.requestRender(); return; }
      if (pos) d.cur = pos;
      var mFinal = currentMatrix();
      self.drag = null;
      if (!mFinal || isIdentity(mFinal)) { app.requestRender(); return; }
      // accumulate — the box stays live for the next gesture; the doc
      // is untouched until the selection is clicked away
      self.gestures.push(mFinal);
      refreshGhosts();
      app.requestRender();
      app.setMsg("transform pending — click away to apply");
    };

    self.cancel = function () { self.drag = null; app.requestRender(); };

    self.drawOverlay = function (ctx) {
      if (!self.box) return;
      var hair = VB.TWIPS / app.view.zoom;
      var m = self.drag && self.drag.m;
      function tx(x, y) {
        if (!m) return { x: x, y: y };
        return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
      }
      // ghost geometry
      ctx.strokeStyle = "rgba(255,120,0,0.9)";
      ctx.lineWidth = 2 * hair;
      ctx.beginPath();
      (self.ghosts || []).forEach(function (e) {
        var a = tx(e.ax, e.ay), b = tx(e.bx, e.by);
        ctx.moveTo(a.x, a.y);
        if (e.cx === null) ctx.lineTo(b.x, b.y);
        else { var c = tx(e.cx, e.cy); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); }
      });
      ctx.stroke();
      // box + handles
      var b2 = self.box;
      var corners = [[b2.x0, b2.y0], [b2.x1, b2.y0], [b2.x1, b2.y1], [b2.x0, b2.y1]];
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = hair;
      ctx.beginPath();
      corners.forEach(function (c, i) {
        var p = tx(c[0], c[1]);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
      var hs = handles();
      var r = 4 * hair;
      ctx.fillStyle = "#000";
      hs.forEach(function (h) {
        var p = tx(h.x, h.y);
        ctx.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
      });
    };

    return self;
  }

  window.VB = window.VB || {};
  VB.FreeTransformTool = FreeTransformTool;
})();
