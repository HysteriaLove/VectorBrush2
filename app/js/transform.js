/* transform.js — the Free Transform tool (Q).
 *
 * Operates on a selection (adopted from the arrow tool on activation,
 * or picked directly): draws the transform box with eight scale
 * handles, rotates when grabbed just outside a corner, moves when
 * dragged from inside. The tool stays live between gestures: each
 * release accumulates its matrix and the box follows, so the user can
 * scale, rotate and move in any order. On the first gesture the
 * selection LIFTS out of the document into a floating clip (same
 * un-journaled lift as the arrow's float, history snapshot taken
 * here), which renders with its real fills under the composed matrix —
 * the drawing updates live, not just on commit. Clicking away (or
 * switching tools) merges the clip back as ONE transform op through
 * the boolean-mask pipeline. Affine maps take quad records to quad
 * records exactly, so records stay records.
 */
(function () {
  "use strict";

  // Rotation cursor: circular arrow (no native CSS equivalent).
  var ROTATE_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22">' +
    '<path d="M11 3 a8 8 0 1 1 -7.4 4.9" fill="none" stroke="white" stroke-width="4.5"/>' +
    '<path d="M11 3 a8 8 0 1 1 -7.4 4.9" fill="none" stroke="black" stroke-width="2"/>' +
    '<path d="M10 0 L16 3 L10 6.5 Z" fill="black" stroke="white" stroke-width="0.8"/>' +
    '</svg>') + '") 11 11, crosshair';

  function FreeTransformTool(app) {
    var self = {
      app: app,
      items: null,    // {fills,edgeKeys} | {region:[pts]} | {textIndex}
      pristine: null, // untransformed edge copies of the selection
      gestures: [],   // accumulated per-gesture matrices (uncommitted)
      base: [1, 0, 0, 1, 0, 0], // a text block's own matrix (else identity)
      ghosts: null,   // pristine mapped through the composed matrix
      box: null,      // {x0,y0,x1,y1} in pristine space
      float: null,    // lifted clip {doc, paths} or {textBlock, textIndex}
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
    // World matrices of the accumulated gestures only (what commits).
    function gestureM() {
      var m = [1, 0, 0, 1, 0, 0];
      self.gestures.forEach(function (g) { m = matMul(g, m); });
      return m;
    }
    // Pristine-space -> world. For shape sessions base is identity; a
    // TEXT session's pristine space is the block's local space, so its
    // own placement matrix sits under the gestures — every piece of
    // frame math (handles, knob, rotate zones, axis-aligned scaling)
    // then works on text blocks unchanged.
    function composedM() {
      return matMul(gestureM(), self.base || [1, 0, 0, 1, 0, 0]);
    }
    function isIdentity(m) {
      return Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 &&
             Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 &&
             Math.abs(m[4]) < 1 && Math.abs(m[5]) < 1;
    }
    function applyPt(m, x, y) {
      return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
    }
    function invert(m) {
      var det = m[0] * m[3] - m[1] * m[2];
      if (Math.abs(det) < 1e-9) return null;
      var a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
      return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
    }
    function refreshGhosts() {
      if (!self.pristine) { self.ghosts = null; return; }
      var m = composedM();
      self.ghosts = self.pristine.map(function (e) {
        var a = applyPt(m, e.ax, e.ay), b = applyPt(m, e.bx, e.by);
        var c = e.cx === null ? null : applyPt(m, e.cx, e.cy);
        return VB.edge(a.x, a.y, c === null ? null : c.x,
                       c === null ? null : c.y, b.x, b.y, 0, 0, 0);
      });
    }

    /** The frame's CURRENT box + pristine->world map. During a text
     *  box-tab drag the frame follows the reflowing working block LIVE
     *  (the session box only rebases on release). */
    function liveFrame() {
      if (self.drag && self.drag.kind === "boxtab" &&
          self.float && self.float.textBlock) {
        var wb = VB.textBoxBounds(app.doc, self.float.textBlock);
        if (wb) {
          var tm = matMul(gestureM(), self.float.textBlock.matrix);
          return { box: wb, m: tm };
        }
      }
      return self.box ? { box: self.box, m: composedM() } : null;
    }

    /** The frame's world-space corners: the pristine box mapped through
     *  the session — the box ROTATES WITH the content and keeps that
     *  orientation until the selection is dropped (Flash's behavior),
     *  instead of refitting to an upright bbox after every gesture. */
    self.frameQuad = function (total) {
      var lf = liveFrame();
      if (!lf) return null;
      var b = lf.box;
      var m = total || lf.m;
      return [applyPt(m, b.x0, b.y0), applyPt(m, b.x1, b.y0),
              applyPt(m, b.x1, b.y1), applyPt(m, b.x0, b.y1)];
    };

    /** First gesture: lift the selection out of the live document into
     *  a floating clip (un-journaled, exactly the arrow float's lift).
     *  The history snapshot taken here is the session's ONE undo step;
     *  the drawing then renders the truth — originals gone, clip
     *  floating under the composed matrix. */
    function ensureLifted() {
      if (self.float || !self.items) return;
      if (self.items.textIndex != null) {
        // a text block lifts by leaving the texts array — no masking;
        // its fonts stay in the doc so the preview can draw it. orig is
        // what commit reinserts (ops re-derive the working state).
        var idx = self.items.textIndex;
        if (!app.doc.texts[idx]) return;
        app.history.push(app.doc);
        self.float = { textBlock: app.doc.texts[idx],
                       orig: app.doc.texts[idx], textIndex: idx };
        app.doc.texts.splice(idx, 1);
        return;
      }
      // the clip builders only READ the doc — build first, snapshot,
      // then remove the originals
      var clip = self.items.region
        ? VB.regionLift(app.doc, self.items.region)
        : VB.arrowLiftSelDoc(app.doc, self.items.fills, self.items.edgeKeys);
      if (clip.edges.length === 0) return;
      app.history.push(app.doc);
      if (self.items.region) VB.regionDelete(app.doc, self.items.region);
      else VB.arrowRemoveSel(app.doc, self.items.fills, self.items.edgeKeys);
      self.float = { doc: clip, paths: null };
    }

    /** Put a lifted clip back untouched: the lift was never journaled,
     *  so restore the snapshot directly and record nothing. An EXTERNAL
     *  clip (clipboard paste) never entered the document at all —
     *  dropping the float cancels the paste outright. */
    function unlift() {
      if (!self.float) return;
      if (self.float.external) {
        self.float = null;
        self.boxOps = [];
        self.discard();
        app.setMsg("paste cancelled");
        app.requestRender();
        return;
      }
      self.float = null;
      self.boxOps = [];
      app.history.undo(app.doc);
    }

    /** Land the accumulated session on the document as ONE journal op.
     *  No history push here — the lift-time snapshot IS the undo step. */
    self.commitPending = function () {
      var boxOps = self.boxOps || [];
      if (!self.items || (!self.gestures.length && !boxOps.length)) {
        self.gestures = []; unlift(); return false;
      }
      var m = gestureM();
      var fl = self.float;
      self.gestures = []; // before mutating: docChanged() discards us
      self.boxOps = [];
      if (fl && fl.external) {
        // an external clip (paste) lands NOW, as ONE registered op at
        // its final placement — the document was untouched until here
        var clipJSON = fl.clipJSON;
        self.float = null;
        self.discard();
        app.exec({ op: "paste", clip: clipJSON, m: m });
        app.setMsg("pasted");
        return true;
      }
      if (!fl || (isIdentity(m) && !boxOps.length)) { unlift(); return false; }
      self.float = null;
      if (fl.textBlock) {
        // put the ORIGINAL back, then replay the session as ops: box
        // tabs first (wrap/size), then the transform — the live doc
        // ends exactly where a replay ends
        app.doc.texts.splice(fl.textIndex, 0, fl.orig);
        boxOps.forEach(function (bop) {
          if (bop.op === "textWrap") {
            app.record({ op: "textWrap", index: fl.textIndex,
                         width: bop.width, dx: bop.dx });
            VB.textWrapApply(app.doc, fl.textIndex, bop.width, bop.dx);
          } else {
            app.record({ op: "textBoxH", index: fl.textIndex,
                         height: bop.height, dy: bop.dy });
            VB.textBoxHApply(app.doc, fl.textIndex, bop.height, bop.dy);
          }
        });
        if (!isIdentity(m)) {
          app.record({ op: "textTransform", index: fl.textIndex, m: m });
          VB.textTransformApply(app.doc, fl.textIndex, m);
        }
        app.docChanged();
        app.setMsg("text transformed");
        return true;
      }
      if (self.items.region) {
        app.record({ op: "regionTransform", points: self.items.region, m: m });
      } else {
        app.record({ op: "transformSel", fills: self.items.fills,
                     edgeKeys: self.items.edgeKeys, m: m });
      }
      VB.regionMergeLifted(app.doc, fl.doc, m);
      app.docChanged();
      app.setMsg("selection transformed");
      return true;
    };

    /** Clipboard payload for the session's selection (Ctrl+C), as it
     *  currently stands — pending gestures are baked into the copy. */
    self.copySelection = function () {
      if (!self.items) return null;
      var m = gestureM();
      if (self.items.textIndex != null) {
        var blk = self.float && self.float.textBlock
          ? self.float.textBlock
          : app.doc.texts[self.items.textIndex];
        if (!blk) return null;
        var snap = {
          matrix: matMul(m, blk.matrix), records: blk.records,
          wrapWidth: blk.wrapWidth, pitch: blk.pitch, align: blk.align,
          spacing: blk.spacing, boxHeight: blk.boxHeight
        };
        var parts = VB.textCopyOps(app.doc, snap);
        return parts.length ? { kind: "text", parts: parts } : null;
      }
      var clip = self.float ? self.float.doc
        : self.items.region
          ? VB.regionLift(app.doc, self.items.region)
          : VB.arrowLiftSelDoc(app.doc, self.items.fills, self.items.edgeKeys);
      if (!clip || clip.edges.length === 0) return null;
      return { kind: "shape", clip: VB.clipFromLifted(clip, m) };
    };

    /** Delete the session's selection (Delete key / toolbar button):
     *  an un-journaled lift is put back first, then ONE registered
     *  delete op lands through app.exec — replay-identical. */
    self.deleteSelection = function () {
      if (!self.items) return false;
      var it = self.items;
      self.gestures = [];
      self.boxOps = [];
      if (self.float) unlift();
      self.discard();
      if (it.external) {
        // an uncommitted paste: dropping the float WAS the deletion —
        // nothing ever entered the document, nothing to journal
        app.requestRender();
        return true;
      }
      if (it.textIndex != null) {
        if (!app.doc.texts[it.textIndex]) return false;
        app.exec({ op: "textDelete", index: it.textIndex });
        app.setMsg("text deleted");
      } else if (it.region) {
        app.exec({ op: "regionDelete", points: it.region });
        app.setMsg("region erased");
      } else {
        app.exec({ op: "deleteSel", fills: it.fills, edgeKeys: it.edgeKeys });
        app.setMsg("selection deleted");
      }
      if (app.transformDone) app.transformDone();
      return true;
    };

    /** Drop the session without committing — the document changed under
     *  us (load, undo/redo, another tool), so the picks are stale. The
     *  float is NOT restored: the change replaced the doc wholesale. */
    self.discard = function () {
      self.items = null; self.pristine = null; self.gestures = [];
      self.base = [1, 0, 0, 1, 0, 0];
      self.boxOps = [];
      self.ghosts = null; self.box = null; self.float = null; self.drag = null;
    };

    /** Ctrl+Z during a session: step back ONE gesture (nothing was
     *  journaled, so nothing reaches the history). Back at zero the
     *  clip un-lifts and the selection stays adopted. */
    self.undoPending = function () {
      if (!self.gestures.length) {
        // an untouched lift (selection picked, nothing transformed):
        // put it back exactly, record nothing — like the arrow float
        if (!self.float) return false;
        unlift();
        refreshGhosts();
        app.requestRender();
        app.setMsg("selection put back");
        return true;
      }
      self.gestures.pop();
      if (!self.gestures.length) unlift();
      refreshGhosts();
      app.requestRender();
      app.setMsg(self.gestures.length ? "transform step undone" : "transform reverted");
      return true;
    };

    /** Escape: abandon ALL pending gestures, keep the selection. */
    self.revertPending = function () {
      if (!self.gestures.length) return false;
      self.gestures = [];
      unlift();
      refreshGhosts();
      app.requestRender();
      app.setMsg("transform reverted");
      return true;
    };

    self.adopt = function (items) {
      self.commitPending();
      self.gestures = [];
      self.base = [1, 0, 0, 1, 0, 0];
      if (items && items.textIndex != null && app.doc.texts[items.textIndex]) {
        // a text block: pristine space is the block's LOCAL space and
        // its placement matrix becomes the session base, so the frame
        // appears already rotated/scaled the way the block is
        var blk = app.doc.texts[items.textIndex];
        self.items = { textIndex: items.textIndex };
        self.base = blk.matrix.slice();
        var bb = VB.textBoxBounds(app.doc, blk);
        self.pristine = bb ? [
          VB.edge(bb.x0, bb.y0, null, null, bb.x1, bb.y0, 0, 0, 0),
          VB.edge(bb.x1, bb.y0, null, null, bb.x1, bb.y1, 0, 0, 0),
          VB.edge(bb.x1, bb.y1, null, null, bb.x0, bb.y1, 0, 0, 0),
          VB.edge(bb.x0, bb.y1, null, null, bb.x0, bb.y0, 0, 0, 0)
        ] : null;
      } else if (items && items.region) {
        self.items = { region: items.region };
        self.pristine = VB.regionPolyLoop(items.region);
      } else if (items && items.fills && (items.fills.length || items.edgeKeys.length)) {
        self.items = items;
        self.pristine = ghostsOf(items);
      } else {
        self.items = null; self.pristine = null;
      }
      self.box = self.pristine ? bboxOf(self.pristine) : null;
      refreshGhosts();
      // lift RIGHT AWAY: the selection floats from the moment it is
      // picked, so the very first gesture (rotate, scale, move) renders
      // the content live instead of a hollow outline
      ensureLifted();
      app.requestRender();
    };

    /** Adopt an EXTERNAL clip (clipboard paste) as an UNCOMMITTED
     *  floating object: every prior selection is dropped, the document
     *  stays untouched while the user places the paste, and click-away
     *  lands the whole session as ONE {op:"paste"} at the final
     *  matrix. Cancelling (undo to zero, Escape, Delete) just drops
     *  the float. seedM (optional) pre-places the float, e.g. the
     *  10px paste offset. */
    self.adoptClip = function (clipJSON, seedM) {
      self.commitPending();
      var clip = new VB.VBDocument();
      clip.width = app.doc.width; clip.height = app.doc.height;
      clip.fills = clipJSON.fills.map(function (f) {
        return { type: "solid", color: { r: f.color.r, g: f.color.g,
                                         b: f.color.b, a: f.color.a } };
      });
      clip.lines = clipJSON.lines.map(function (l) {
        return { width: l.width, color: { r: l.color.r, g: l.color.g,
                                          b: l.color.b, a: l.color.a } };
      });
      clip.edges = clipJSON.edges.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by,
                       e.fill0, e.fill1, e.line);
      });
      if (clip.edges.length === 0) { self.discard(); return false; }
      self.gestures = seedM ? [seedM.slice()] : [];
      self.base = [1, 0, 0, 1, 0, 0];
      self.boxOps = [];
      self.items = { external: true };
      self.float = { doc: clip, paths: null, external: true,
                     clipJSON: clipJSON };
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      clip.edges.forEach(function (e) {
        [[e.ax, e.ay], [e.bx, e.by]].concat(
          e.cx === null ? [] : [[e.cx, e.cy]]).forEach(function (p) {
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
          y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
        });
      });
      self.pristine = [
        VB.edge(x0, y0, null, null, x1, y0, 0, 0, 0),
        VB.edge(x1, y0, null, null, x1, y1, 0, 0, 0),
        VB.edge(x1, y1, null, null, x0, y1, 0, 0, 0),
        VB.edge(x0, y1, null, null, x0, y0, 0, 0, 0)
      ];
      self.box = bboxOf(self.pristine);
      refreshGhosts();
      app.requestRender();
      return true;
    };

    // Handles live in PRISTINE space (ax/ay say which frame axes the
    // handle scales); their world positions come from the session
    // matrix, so they ride the rotated frame.
    function handles(bOpt) {
      var b = bOpt || self.box;
      if (!b) return [];
      var mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
      return [
        { x: b.x0, y: b.y0, ax: 1, ay: 1 }, { x: mx, y: b.y0, ax: 0, ay: 1 },
        { x: b.x1, y: b.y0, ax: 1, ay: 1 }, { x: b.x1, y: my, ax: 1, ay: 0 },
        { x: b.x1, y: b.y1, ax: 1, ay: 1 }, { x: mx, y: b.y1, ax: 0, ay: 1 },
        { x: b.x0, y: b.y1, ax: 1, ay: 1 }, { x: b.x0, y: my, ax: 1, ay: 0 }
      ];
    }

    function pickHandle(pos, tol, acc) {
      var hs = handles();
      for (var i = 0; i < hs.length; i++) {
        var p = applyPt(acc, hs[i].x, hs[i].y);
        if (Math.abs(pos.x - p.x) <= tol && Math.abs(pos.y - p.y) <= tol) {
          return { index: i, h: hs[i] };
        }
      }
      return null;
    }

    /** The rotation handle: a knob floating a fixed screen distance
     *  outward from the frame's mid-top edge (it rides the rotation). */
    function rotKnob(m, bOpt) {
      var b = bOpt || self.box;
      if (!b) return null;
      var mx = (b.x0 + b.x1) / 2;
      var P = applyPt(m, mx, b.y0);
      var C = applyPt(m, mx, (b.y0 + b.y1) / 2);
      var dx = P.x - C.x, dy = P.y - C.y;
      var len = Math.hypot(dx, dy) || 1;
      var off = 26 * VB.TWIPS / app.view.zoom;
      return { x: P.x + dx / len * off, y: P.y + dy / len * off,
               sx: P.x, sy: P.y };
    }

    function armRotate(pos, acc) {
      var b = self.box;
      var c0 = applyPt(acc, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      self.drag = { kind: "rotate", center: c0,
                    a0: Math.atan2(pos.y - c0.y, pos.x - c0.x),
                    cur: pos, m: null };
    }

    /** What a press/drag at pos would do: "knob"/"scale"/"move"/
     *  "rotate" (near-corner) or null (nothing under the pointer). */
    function hitTest(pos, tol, acc, accInv) {
      var knob = rotKnob(acc);
      if (knob && Math.hypot(pos.x - knob.x, pos.y - knob.y) <= tol * 1.2) {
        return { kind: "knob" };
      }
      var hit = accInv && pickHandle(pos, tol, acc);
      if (hit) return { kind: "scale", hit: hit };
      if (!accInv) return null;
      // inside/near tests run in pristine space (map the pointer back
      // through the session) so they respect the rotated frame
      var b = self.box;
      var q = applyPt(accInv, pos.x, pos.y);
      // pointer tolerance in pristine units: undo the average scale
      var s = (Math.hypot(acc[0], acc[1]) + Math.hypot(acc[2], acc[3])) / 2 || 1;
      var margin = 3 * tol / s;
      if (q.x > b.x0 && q.x < b.x1 && q.y > b.y0 && q.y < b.y1) {
        return { kind: "move" };
      }
      if (q.x > b.x0 - margin && q.x < b.x1 + margin &&
          q.y > b.y0 - margin && q.y < b.y1 + margin) {
        return { kind: "rotate" };
      }
      return null;
    }

    self.onDown = function (pos, ev) {
      var tol = 8 * VB.TWIPS / app.view.zoom;
      if (self.box) {
        var acc = composedM();
        var accInv = invert(acc);
        var what = hitTest(pos, tol, acc, accInv);
        if (what) {
          // a press that manipulates re-lifts if needed (the selection
          // can sit adopted-but-unlifted after an undo-to-zero)
          ensureLifted();
          var isTextSel = self.items && self.items.textIndex != null;
          if (what.kind === "knob" || what.kind === "rotate") {
            armRotate(pos, acc);
          } else if (what.kind === "scale" &&
                     isTextSel && what.hit.index % 2 === 1) {
            // TEXT mid-edge = BOX TAB: sides re-wrap the width,
            // top/bottom change the point size — glyphs never distort
            var b0 = self.box;
            var work = self.float && self.float.textBlock;
            if (work) {
              self.drag = {
                kind: "boxtab", hi: what.hit.index,
                acc: acc, accInv: accInv, cur: pos,
                stashJson: JSON.stringify(work),
                baseHeight: work.records[0].height,
                right: work.wrapWidth || b0.x1,
                box0: { x0: b0.x0, y0: b0.y0, x1: b0.x1, y1: b0.y1 },
                pending: null, m: null
              };
            }
          } else if (what.kind === "scale") {
            // anchor = opposite handle, held fixed in pristine space
            var hs = handles();
            var opp = hs[(what.hit.index + 4) % 8];
            self.drag = { kind: "scale", h: what.hit.h, anchor: opp,
                          acc: acc, accInv: accInv, cur: pos, m: null };
          } else {
            self.drag = { kind: "move", from: pos, cur: pos, m: null };
          }
          return;
        }
      }
      // clicked away from the selection: the accumulated session lands
      // as ONE op FIRST, so the pick below sees the post-commit document
      // (the originals only now leave their old location)
      self.commitPending();
      // (re)pick a selection: text block, fill, or attached-stroke chain
      // under the cursor. The press keeps going as a MOVE — pick up and
      // drag in one motion, like the arrow tool.
      var ti = VB.textHit(app.doc, pos.x, pos.y);
      if (ti >= 0) {
        self.adopt({ textIndex: ti });
        if (self.box) self.drag = { kind: "move", from: pos, cur: pos, m: null };
        return;
      }
      var fillIdx = VB.geom.fillAt(app.doc, pos.x, pos.y);
      if (fillIdx > 0) {
        self.adopt({ fills: [{ x: pos.x, y: pos.y }], edgeKeys: [] });
        if (self.box) self.drag = { kind: "move", from: pos, cur: pos, m: null };
        return;
      }
      var tol2 = 6 * VB.TWIPS / app.view.zoom;
      for (var i = 0; i < app.doc.edges.length; i++) {
        if (VB.geom.distToEdge(app.doc.edges[i], pos.x, pos.y) < tol2 &&
            app.doc.edges[i].line > 0) {
          self.adopt({ fills: [], edgeKeys: VB.connectedStrokeKeys(app.doc, i) });
          if (self.box) self.drag = { kind: "move", from: pos, cur: pos, m: null };
          return;
        }
      }
      // nothing here: start a NEW region selection right away — marquee
      // or lasso, matching the tool the user came from. A plain click
      // (no drag) instead ends the session and returns to that tool.
      self.adopt(null);
      var style = app.regionSelectStyle ? app.regionSelectStyle() : "marquee";
      self.drag = { kind: "band", style: style, from: pos, cur: pos,
                    moved: false, points: [{ x: pos.x, y: pos.y }] };
    };

    /** A pending, uncommitted session exists (anything adopted). */
    self.hasSession = function () { return !!self.items; };

    /** Pristine->world matrix of the whole session (for the toolbar's
     *  rotation readout). */
    self.sessionMatrix = function () { return composedM(); };

    /** Set the session's ABSOLUTE rotation (degrees) about the frame
     *  center — the toolbar field; 0 snaps upright. */
    self.rotateTo = function (deg) {
      if (!self.items || !self.box) return false;
      ensureLifted();
      var m = composedM();
      var cur = Math.atan2(m[1], m[0]);
      var a = deg * Math.PI / 180 - cur;
      if (Math.abs(a) < 1e-6) return true;
      var b = self.box;
      var c = applyPt(m, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      var cos = Math.cos(a), sin = Math.sin(a);
      self.gestures.push([cos, sin, -sin, cos,
        c.x - cos * c.x + sin * c.y, c.y - sin * c.x - cos * c.y]);
      refreshGhosts();
      app.requestRender();
      app.setMsg("rotation " + deg + "° — click away to apply");
      return true;
    };

    /** Double-click while transforming a TEXT block: land the session
     *  and reopen the block in the text editor. */
    self.onDblClick = function (pos) {
      var wasText = self.items && self.items.textIndex != null;
      var idx = wasText ? self.items.textIndex : -1;
      self.commitPending();
      if (!wasText) {
        idx = VB.textHit(app.doc, pos.x, pos.y);
        if (idx < 0) return;
      }
      if (app.editText) app.editText(idx);
    };

    /** Would a press at pos grab the frame (handle/knob/move/rotate)? */
    self.hitsFrame = function (pos) {
      if (!self.box) return false;
      var tol = 8 * VB.TWIPS / app.view.zoom;
      var acc = composedM();
      return !!hitTest(pos, tol, acc, invert(acc));
    };

    self.onHover = function (pos) {
      if (!app.setCursor) return;
      // over empty space a drag starts a fresh marquee/lasso
      if (!self.box) { app.setCursor("crosshair"); return; }
      var tol = 8 * VB.TWIPS / app.view.zoom;
      var acc = composedM();
      var what = hitTest(pos, tol, acc, invert(acc));
      if (!what) { app.setCursor("crosshair"); return; }
      if (what.kind === "knob" || what.kind === "rotate") {
        app.setCursor(ROTATE_CURSOR);
      } else if (what.kind === "move") {
        app.setCursor("move");
      } else {
        // resize arrows follow the handle's WORLD direction (they ride
        // the rotated frame): quantize handle->anchor to 4 axes
        var hs = handles();
        var opp = hs[(what.hit.index + 4) % 8];
        var hw = applyPt(acc, what.hit.h.x, what.hit.h.y);
        var aw = applyPt(acc, opp.x, opp.y);
        var ang = Math.atan2(hw.y - aw.y, hw.x - aw.x) * 180 / Math.PI;
        ang = ((ang % 180) + 180) % 180;
        app.setCursor(ang < 22.5 || ang >= 157.5 ? "ew-resize" :
                      ang < 67.5 ? "nwse-resize" :
                      ang < 112.5 ? "ns-resize" : "nesw-resize");
      }
    };

    function currentMatrix() {
      var d = self.drag;
      if (!d) return null;
      if (d.kind === "move") {
        return [1, 0, 0, 1, d.cur.x - d.from.x, d.cur.y - d.from.y];
      }
      if (d.kind === "scale") {
        // scaling happens ALONG THE FRAME'S AXES: pull the pointer back
        // to pristine space, scale about the pristine anchor, and wrap
        // the result as a world gesture (acc . S . accInv) — dragging a
        // rotated frame's edge handle stretches along that rotated edge
        var p = applyPt(d.accInv, d.cur.x, d.cur.y);
        var ax = d.anchor.x, ay = d.anchor.y;
        var sx = d.h.ax ? (p.x - ax) / (d.h.x - ax || 1) : 1;
        var sy = d.h.ay ? (p.y - ay) / (d.h.y - ay || 1) : 1;
        if (!isFinite(sx) || Math.abs(sx) < 0.02) sx = 0.02;
        if (!isFinite(sy) || Math.abs(sy) < 0.02) sy = 0.02;
        var S = [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay];
        return matMul(d.acc, matMul(S, d.accInv));
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

    // Pointer -> the pending box op (wrap or size) for a tab drag, in
    // block-local units; applies it live to the floating block.
    function applyBoxTab(d, pos) {
      var lx = d.accInv[0] * pos.x + d.accInv[2] * pos.y + d.accInv[4];
      var ly = d.accInv[1] * pos.x + d.accInv[3] * pos.y + d.accInv[5];
      var b = d.box0;
      var MIN = 200;
      if (d.hi === 3) {                       // right: wrap width
        d.pending = { op: "textWrap", width: Math.max(MIN, Math.round(lx)), dx: 0 };
      } else if (d.hi === 7) {                // left: wrap, right edge planted
        var width = Math.max(MIN, Math.round(d.right - lx));
        d.pending = { op: "textWrap", width: width, dx: d.right - width };
      } else {                                // top/bottom: BOX HEIGHT
        if (d.hi === 5) {                     // bottom tab grows down
          d.pending = { op: "textBoxH",
                        height: Math.max(MIN, Math.round(ly - b.y0)), dy: 0 };
        } else {                              // top tab, bottom planted
          var height = Math.max(MIN, Math.round(b.y1 - ly));
          d.pending = { op: "textBoxH", height: height,
                        dy: b.y1 - height - b.y0 };
        }
      }
      // live-apply to the floating block via a scratch doc
      var work = JSON.parse(d.stashJson);
      var scratch = { fonts: app.doc.fonts, texts: [work] };
      if (d.pending.op === "textWrap") {
        VB.textWrapApply(scratch, 0, d.pending.width, d.pending.dx);
      } else {
        VB.textBoxHApply(scratch, 0, d.pending.height, d.pending.dy);
      }
      self.float.textBlock = work;
    }

    self.onMove = function (pos) {
      var d = self.drag;
      if (!d) return;
      d.cur = pos;
      if (d.kind === "boxtab") {
        applyBoxTab(d, pos);
        app.requestRender();
        return;
      }
      if (d.kind === "band") {
        if (Math.hypot(pos.x - d.from.x, pos.y - d.from.y) > 8) d.moved = true;
        if (d.style === "lasso") {
          var last = d.points[d.points.length - 1];
          if (Math.hypot(pos.x - last.x, pos.y - last.y) >= 60) {
            d.points.push({ x: pos.x, y: pos.y });
          }
        }
      } else {
        d.m = currentMatrix();
      }
      app.requestRender();
    };

    self.onUp = function (pos) {
      var d = self.drag;
      if (d && d.kind === "boxtab") {
        self.drag = null;
        if (d.pending && self.float && self.float.textBlock) {
          // queue the op and rebase the frame on the reshaped block so
          // handles, knob and later gestures track the new box
          self.boxOps = self.boxOps || [];
          self.boxOps.push(d.pending);
          self.base = self.float.textBlock.matrix.slice();
          var bb = VB.textBoxBounds(app.doc, self.float.textBlock);
          if (bb) {
            self.box = bb;
            self.pristine = [
              VB.edge(bb.x0, bb.y0, null, null, bb.x1, bb.y0, 0, 0, 0),
              VB.edge(bb.x1, bb.y0, null, null, bb.x1, bb.y1, 0, 0, 0),
              VB.edge(bb.x1, bb.y1, null, null, bb.x0, bb.y1, 0, 0, 0),
              VB.edge(bb.x0, bb.y1, null, null, bb.x0, bb.y0, 0, 0, 0)
            ];
            refreshGhosts();
          }
          app.setMsg("text box adjusted — click away to apply");
        }
        app.requestRender();
        return;
      }
      if (d && d.kind === "band") {
        self.drag = null;
        if (pos) d.cur = pos;
        if (!d.moved) {
          // plain click on empty: session over — hand control back to
          // the tool the user came from (lasso, arrow, ...)
          if (app.transformDone) app.transformDone();
          app.requestRender();
          return;
        }
        var pts;
        if (d.style === "lasso" && d.points.length >= 3) {
          pts = d.points.concat([{ x: d.cur.x, y: d.cur.y }]);
        } else {
          var x0 = Math.min(d.from.x, d.cur.x), x1 = Math.max(d.from.x, d.cur.x);
          var y0 = Math.min(d.from.y, d.cur.y), y1 = Math.max(d.from.y, d.cur.y);
          pts = [{ x: x0, y: y0 }, { x: x1, y: y0 },
                 { x: x1, y: y1 }, { x: x0, y: y1 }];
        }
        self.adopt({ region: pts.map(function (p) {
          return { x: Math.round(p.x), y: Math.round(p.y) };
        }) });
        app.setMsg("region lifted — transform it; click away to apply");
        return;
      }
      if (!d || !self.items) { self.drag = null; app.requestRender(); return; }
      if (pos) d.cur = pos;
      var mFinal = currentMatrix();
      self.drag = null;
      if (!mFinal || isIdentity(mFinal)) { app.requestRender(); return; }
      // first gesture lifts the selection into the floating clip; then
      // accumulate — the box stays live for the next gesture, and the
      // clip renders transformed until the selection is clicked away
      ensureLifted();
      self.gestures.push(mFinal);
      refreshGhosts();
      app.requestRender();
      app.setMsg("transform pending — click away to apply");
    };

    self.cancel = function () { self.drag = null; app.requestRender(); };

    // Flash-style selection hatch (dot pattern), built once.
    var hatch = null;
    function hatchPattern(ctx) {
      if (hatch) return hatch;
      var cv = document.createElement("canvas");
      cv.width = 4; cv.height = 4;
      var c2 = cv.getContext("2d");
      c2.fillStyle = "rgba(0,0,0,0.45)";
      c2.fillRect(0, 0, 1, 1);
      c2.fillRect(2, 2, 1, 1);
      hatch = ctx.createPattern(cv, "repeat");
      return hatch;
    }

    self.drawOverlay = function (ctx) {
      var hair = VB.TWIPS / app.view.zoom;
      // an in-progress marquee/lasso band (started on empty space)
      var bd = self.drag && self.drag.kind === "band" ? self.drag : null;
      if (bd && bd.moved) {
        ctx.strokeStyle = "rgba(0,160,255,0.9)";
        ctx.lineWidth = 1.5 * hair;
        ctx.setLineDash([6 * hair, 4 * hair]);
        ctx.beginPath();
        if (bd.style === "lasso") {
          bd.points.forEach(function (p, i) {
            if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          });
          ctx.lineTo(bd.cur.x, bd.cur.y);
        } else {
          ctx.rect(Math.min(bd.from.x, bd.cur.x), Math.min(bd.from.y, bd.cur.y),
                   Math.abs(bd.cur.x - bd.from.x), Math.abs(bd.cur.y - bd.from.y));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (!self.box) return;
      var m = self.drag && self.drag.m;
      function tx(x, y) {
        if (!m) return { x: x, y: y };
        return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
      }
      // the whole session: live drag on top of the accumulated gestures
      var total = m ? matMul(m, composedM()) : composedM();
      function mp(x, y) {
        return { x: total[0] * x + total[2] * y + total[4],
                 y: total[1] * x + total[3] * y + total[5] };
      }
      if (self.float && self.float.textBlock) {
        // a floating TEXT block: gestures over the block's OWN matrix
        // (box tabs shift it mid-drag before the frame rebases)
        var tg = m ? matMul(m, gestureM()) : gestureM();
        VB.drawTextBlock(ctx, app.doc, {
          matrix: matMul(tg, self.float.textBlock.matrix),
          records: self.float.textBlock.records
        });
      } else if (self.float) {
        // the lifted clip renders here with its REAL fills (it no longer
        // exists in the doc) — the untransformed clip mapped through the
        // whole session
        var fl = self.float;
        if (!fl.paths) fl.paths = VB.buildFillPaths(fl.doc);
        function traceChains(chains) {
          ctx.beginPath();
          chains.forEach(function (chain) {
            var s = mp(chain.sx, chain.sy);
            ctx.moveTo(s.x, s.y);
            chain.pts.forEach(function (q) {
              var p = mp(q.x, q.y);
              if (q.cx === null || q.cx === undefined) ctx.lineTo(p.x, p.y);
              else {
                var c = mp(q.cx, q.cy);
                ctx.quadraticCurveTo(c.x, c.y, p.x, p.y);
              }
            });
            ctx.closePath();
          });
        }
        for (var fi = 1; fi < fl.paths.length; fi++) {
          var st = fl.doc.fills[fi - 1];
          if (!st || !fl.paths[fi].length) continue;
          traceChains(fl.paths[fi]);
          ctx.fillStyle = "rgba(" + st.color.r + "," + st.color.g + "," +
            st.color.b + "," + (st.color.a / 255) + ")";
          ctx.fill("evenodd");
          // dotted hatch: this content is not committed yet
          ctx.fillStyle = hatchPattern(ctx);
          ctx.fill("evenodd");
          // selection outline follows the ACTUAL shape, not a box
          traceChains(fl.paths[fi]);
          ctx.strokeStyle = "rgba(255,120,0,0.95)";
          ctx.lineWidth = 2 * hair;
          ctx.stroke();
        }
        fl.doc.edges.forEach(function (e) {
          if (e.line === 0) return;
          var ls = fl.doc.lines[e.line - 1];
          if (!ls) return;
          var a2 = mp(e.ax, e.ay), b3 = mp(e.bx, e.by);
          ctx.beginPath();
          ctx.moveTo(a2.x, a2.y);
          if (e.cx === null) ctx.lineTo(b3.x, b3.y);
          else {
            var c3 = mp(e.cx, e.cy);
            ctx.quadraticCurveTo(c3.x, c3.y, b3.x, b3.y);
          }
          ctx.strokeStyle = "rgba(" + ls.color.r + "," + ls.color.g + "," +
            ls.color.b + "," + (ls.color.a / 255) + ")";
          ctx.lineWidth = Math.max(ls.width, hair);
          ctx.lineCap = "round";
          ctx.stroke();
          // floating strokes get the orange marker too
          ctx.strokeStyle = "rgba(255,120,0,0.95)";
          ctx.lineWidth = 2 * hair;
          ctx.stroke();
        });
      } else {
        // pre-lift: ghost outline over the still-in-place originals
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
      }
      // box + handles: the frame mapped through the session — glued to
      // the content, rotation and all; during a text box-tab drag it
      // follows the reflowing block LIVE (liveFrame), so the input area
      // resizes in realtime, not just on release
      var lf = liveFrame();
      if (!lf) return;
      var b2 = lf.box;
      var bmp = function (x, y) {
        var lm = m ? matMul(m, lf.m) : lf.m;
        return applyPt(lm, x, y);
      };
      var corners = [[b2.x0, b2.y0], [b2.x1, b2.y0], [b2.x1, b2.y1], [b2.x0, b2.y1]];
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = hair;
      ctx.beginPath();
      corners.forEach(function (c, i) {
        var p = bmp(c[0], c[1]);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
      var hs = handles(b2);
      var r = 4 * hair;
      // text sessions: corners free-transform, mid-edges are BOX TABS
      // (flat bars — sides re-wrap the width, top/bottom set the size)
      var isText = self.items && self.items.textIndex != null;
      hs.forEach(function (h, hi) {
        var p = bmp(h.x, h.y);
        if (isText && hi % 2 === 1) {
          var ci = (hi - 1) / 2;
          var ca = bmp(corners[ci][0], corners[ci][1]);
          var cb = bmp(corners[(ci + 1) % 4][0], corners[(ci + 1) % 4][1]);
          var dx = cb.x - ca.x, dy = cb.y - ca.y;
          var len = Math.hypot(dx, dy) || 1;
          var ux = dx / len * 8 * hair, uy = dy / len * 8 * hair;
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 4 * hair;
          ctx.beginPath();
          ctx.moveTo(p.x - ux, p.y - uy);
          ctx.lineTo(p.x + ux, p.y + uy);
          ctx.stroke();
        } else {
          ctx.fillStyle = "#000";
          ctx.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
        }
      });
      // rotation knob on a stem off the mid-top edge
      var knob = rotKnob(m ? matMul(m, lf.m) : lf.m, b2);
      if (knob) {
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.lineWidth = hair;
        ctx.beginPath();
        ctx.moveTo(knob.sx, knob.sy);
        ctx.lineTo(knob.x, knob.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(knob.x, knob.y, 4.5 * hair, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.stroke();
      }
    };

    return self;
  }

  window.VB = window.VB || {};
  VB.FreeTransformTool = FreeTransformTool;
})();
