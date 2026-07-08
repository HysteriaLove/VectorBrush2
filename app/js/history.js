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

  function snapshot(doc) {
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

  function restore(doc, snap) {
    doc.width = snap.width;
    doc.height = snap.height;
    doc.background = snap.background;
    doc.fills = snap.fills;
    doc.lines = snap.lines;
    doc.edges = snap.edges;
    doc.fonts = snap.fonts || [];
    doc.texts = snap.texts || [];
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
