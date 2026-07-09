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

  // Actor snapshots: poses → nested symbols → drawings, each cell via
  // snapshotDoc — actor structure ops are single undo steps like layers.
  function snapshotSymbol(s) {
    return {
      id: s.id, name: s.name,
      symbols: s.symbols.map(snapshotSymbol),
      drawings: s.drawings.map(function (d) {
        return { id: d.id, name: d.name, cell: snapshotDoc(d.cell) };
      }),
      cur: { drawing: s.cur.drawing }
    };
  }

  function restoreSymbol(s) {
    return {
      id: s.id, name: s.name,
      symbols: s.symbols.map(restoreSymbol),
      drawings: s.drawings.map(function (d) {
        var cell = new VB.Y2KVectorDocument();
        restoreDoc(cell, d.cell);
        return { id: d.id, name: d.name, cell: cell };
      }),
      cur: { drawing: s.cur.drawing }
    };
  }

  function snapshotActor(a) {
    return {
      id: a.id, name: a.name, width: a.width, height: a.height,
      poses: a.poses.map(function (p) {
        return { id: p.id, name: p.name, cell: snapshotDoc(p.cell),
                 symbols: p.symbols.map(snapshotSymbol) };
      }),
      cur: { pose: a.cur.pose }
    };
  }

  function restoreActor(a) {
    return {
      id: a.id, name: a.name, width: a.width, height: a.height,
      poses: a.poses.map(function (p) {
        var cell = new VB.Y2KVectorDocument();
        restoreDoc(cell, p.cell);
        return { id: p.id, name: p.name, cell: cell,
                 symbols: p.symbols.map(restoreSymbol) };
      }),
      cur: { pose: a.cur.pose }
    };
  }

  // A snapshot target is either a bare Y2KVectorDocument or a whole VB.Project
  // (scenes -> layers -> frame cells). Undo/redo restores the entire
  // structure, so layer add/delete/reorder are single undo steps.
  function snapshot(target) {
    if (!target.scenes) return snapshotDoc(target);
    return {
      project: true,
      width: target.width, height: target.height,
      fps: target.fps || 24,
      background: JSON.parse(JSON.stringify(target.background)),
      cur: { scene: target.cur.scene, layer: target.cur.layer,
             frame: target.cur.frame || 0 },
      materials: JSON.parse(JSON.stringify(target.materials || [])),
      editTarget: JSON.parse(JSON.stringify(target.editTarget || null)),
      actors: (target.actors || []).map(snapshotActor),
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
    target.fps = snap.fps || 24;
    target.background = snap.background;
    target.cur = { scene: snap.cur.scene, layer: snap.cur.layer,
                   frame: snap.cur.frame || 0 };
    target.materials = JSON.parse(JSON.stringify(snap.materials || []));
    target.editTarget = JSON.parse(JSON.stringify(snap.editTarget || null));
    target.actors = (snap.actors || []).map(restoreActor);
    target.scenes = snap.scenes.map(function (sc) {
      return {
        name: sc.name,
        layers: sc.layers.map(function (l) {
          return {
            name: l.name, visible: l.visible, locked: l.locked,
            frames: l.frames.map(function (cellSnap) {
              var d = new VB.Y2KVectorDocument();
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
