/* history.js — snapshot undo/redo.
 *
 * Documents are a few KB of plain data, so full snapshots per operation
 * are cheap and immune to partial-mutation bugs. Push BEFORE mutating.
 */
(function () {
  "use strict";

  var LIMIT = 64;

  function History() {
    this.undoStack = [];
    this.redoStack = [];
  }

  function snapshotDoc(doc) {
    return {
      width: doc.width,
      height: doc.height,
      background: { r: doc.background.r, g: doc.background.g, b: doc.background.b, a: doc.background.a },
      fills: JSON.parse(JSON.stringify(doc.fills)),
      lines: JSON.parse(JSON.stringify(doc.lines)),
      edges: doc.edges.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
      }),
      // fonts are immutable once defined — share by reference; text
      // blocks are small, deep-copy them
      fonts: (doc.fonts || []).slice(),
      texts: JSON.parse(JSON.stringify(doc.texts || []))
    };
  }

  function restoreDoc(doc, snap) {
    doc.width = snap.width;
    doc.height = snap.height;
    doc.background = snap.background;
    doc.fills = snap.fills;
    doc.lines = snap.lines;
    doc.edges = snap.edges;
    doc.fonts = snap.fonts || [];
    doc.texts = snap.texts || [];
  }

  // A snapshot target is either a bare VBDocument or a whole VB.Project
  // (scenes -> layers -> frame cells). Undo/redo restores the entire
  // structure, so layer add/delete/reorder are single undo steps.
  function snapshot(target) {
    if (!target.scenes) return snapshotDoc(target);
    return {
      project: true,
      width: target.width, height: target.height,
      background: JSON.parse(JSON.stringify(target.background)),
      cur: { scene: target.cur.scene, layer: target.cur.layer },
      materials: JSON.parse(JSON.stringify(target.materials || [])),
      scenes: target.scenes.map(function (sc) {
        return {
          name: sc.name,
          layers: sc.layers.map(function (l) {
            return {
              name: l.name, visible: l.visible, locked: l.locked,
              frames: l.frames.map(snapshotDoc)
            };
          })
        };
      })
    };
  }

  function restore(target, snap) {
    if (!snap.project) { restoreDoc(target, snap); return; }
    target.width = snap.width;
    target.height = snap.height;
    target.background = snap.background;
    target.cur = { scene: snap.cur.scene, layer: snap.cur.layer };
    target.materials = JSON.parse(JSON.stringify(snap.materials || []));
    target.scenes = snap.scenes.map(function (sc) {
      return {
        name: sc.name,
        layers: sc.layers.map(function (l) {
          return {
            name: l.name, visible: l.visible, locked: l.locked,
            frames: l.frames.map(function (cellSnap) {
              var d = new VB.VBDocument();
              restoreDoc(d, cellSnap);
              return d;
            })
          };
        })
      };
    });
  }

  History.prototype.push = function (doc) {
    this.undoStack.push(snapshot(doc));
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  };

  History.prototype.undo = function (doc) {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(snapshot(doc));
    restore(doc, this.undoStack.pop());
    return true;
  };

  History.prototype.redo = function (doc) {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(snapshot(doc));
    restore(doc, this.redoStack.pop());
    return true;
  };

  History.prototype.canUndo = function () { return this.undoStack.length > 0; };
  History.prototype.canRedo = function () { return this.redoStack.length > 0; };
  History.prototype.clear = function () {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  };

  window.VB = window.VB || {};
  VB.History = History;
})();
