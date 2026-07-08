/* transform.js — the Free Transform tool (Q).
 *
 * Operates on a selection (adopted from the arrow tool on activation,
 * or picked directly): draws the transform box with eight scale
 * handles, rotates when grabbed just outside a corner, moves when
 * dragged from inside. The whole gesture accumulates one affine matrix
 * applied on release through arrowTransformSel — affine maps take quad
 * records to quad records exactly, and the re-merge runs the same
 * lift/paint-over pipeline as the arrow's move.
 */
(function () {
  "use strict";

  function FreeTransformTool(app) {
    var self = {
      app: app,
      items: null,   // {fills:[{x,y}], edgeKeys:[]}
      ghosts: null,  // pristine edge copies of the selection (for preview/bbox)
      box: null,     // {x0,y0,x1,y1} of ghosts
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

    self.adopt = function (items) {
      if (items && (items.fills.length || items.edgeKeys.length)) {
        self.items = items;
        self.ghosts = ghostsOf(items);
        self.box = bboxOf(self.ghosts);
      } else {
        self.items = null; self.ghosts = null; self.box = null;
      }
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
      if (!mFinal) { app.requestRender(); return; }
      // identity? skip
      if (Math.abs(mFinal[0] - 1) < 1e-6 && Math.abs(mFinal[1]) < 1e-6 &&
          Math.abs(mFinal[2]) < 1e-6 && Math.abs(mFinal[3] - 1) < 1e-6 &&
          Math.abs(mFinal[4]) < 1 && Math.abs(mFinal[5]) < 1) {
        app.requestRender();
        return;
      }
      app.record({ op: "transformSel", fills: self.items.fills,
                   edgeKeys: self.items.edgeKeys, m: mFinal });
      app.history.push(app.doc);
      VB.arrowTransformSel(app.doc, self.items.fills, self.items.edgeKeys, mFinal);
      self.adopt(null);
      app.docChanged();
      app.setMsg("selection transformed");
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
