/* project.js — the Flash-style document object model (docs/JSFL.pdf).
 *
 * Mirrors the authoring DOM's containment chain:
 *
 *   Project (fl Document)  stage size, background
 *     scenes[]  (document.timelines — one Timeline per scene)
 *       layers[]  (timeline.layers — layers[0] is the TOP layer,
 *                  JSFL's convention; render walks the array backwards)
 *         frames[]  (layer.frames — frame 1 only for now; the array
 *                    exists so animation can land without reshaping)
 *           cell = Y2KVectorDocument  (frame.elements: the merged-ink Shape
 *                  element IS the planar map, and cell.texts are the
 *                  Text elements stacked above it — Flash MX keeps a
 *                  layer's raw ink behind its objects)
 *
 * Every editing tool and the whole boolean core keep operating on a
 * single planar map: the app points them at the ACTIVE layer's cell.
 * Layer/scene switches are journal ops, so replay stays deterministic.
 */
(function () {
  "use strict";

  function Layer(name, cell) {
    this.name = name;
    this.visible = true;
    this.locked = false;
    this.frames = [cell];
  }

  function Scene(name, cell) {
    this.name = name;
    this.layers = [new Layer("Layer 1", cell)];
  }

  function Project(width, height) {
    this.width = width || 550 * 20;
    this.height = height || 400 * 20;
    this.fps = 24; // playback rate (reference default); journaled via fpsSet
    this.background = { r: 255, g: 255, b: 255, a: 255 };
    this.scenes = [new Scene("Scene 1", this.newCell())];
    this.cur = { scene: 0, layer: 0, frame: 0 };
    // The GLOBAL 2DMaterial library (Flash's library, not per-layer):
    // crafted material definitions usable on any layer or scene. Cells
    // keep their own fills[] (the SWF wire grammar); painting with a
    // library material copies the definition into the target cell,
    // deduped by sameFill.
    this.materials = [];
    // The Actors library (actors.js): poses → symbols → drawings, all
    // cells y2kvector documents. Rides the journal; not yet part of the
    // .y2kvector project-file body.
    this.actors = [];
    // The Brainstorm board (brainstorm.js): placeable note items,
    // z-order = array order. Rides the journal.
    this.notes = { items: [] };
    // Actor edit mode (Flash's symbol-edit): when set, scene()/stage()/
    // activeCell() resolve to the targeted actor cell, so every tool,
    // renderer, and journaled art op follows. Set ONLY through the
    // journaled editTargetSet/Clear ops — replay must agree.
    // { actor: id, pose: id } or { actor: id, symbol: id } (the
    // symbol's active drawing).
    this.editTarget = null;
  }

  function sameStyle(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** Add a material to the library (structural dedupe). Returns index. */
  Project.prototype.addMaterial = function (style) {
    for (var i = 0; i < this.materials.length; i++) {
      if (sameStyle(this.materials[i], style)) return i;
    }
    this.materials.push(JSON.parse(JSON.stringify(style)));
    return this.materials.length - 1;
  };

  /** Replace library entry `index` AND every structurally-matching
   *  fill in every cell — editing a material updates all its uses,
   *  on every layer and scene, deterministically. */
  Project.prototype.editMaterial = function (index, style) {
    if (index < 0 || index >= this.materials.length) return false;
    var old = this.materials[index];
    var next = JSON.parse(JSON.stringify(style));
    this.eachCell(function (cell) {
      for (var i = 0; i < cell.fills.length; i++) {
        if (sameStyle(cell.fills[i], old)) {
          cell.fills[i] = JSON.parse(JSON.stringify(next));
        }
      }
    });
    this.materials[index] = next;
    return true;
  };

  /** Union every cell's non-solid fills into the library — how
   *  documents without a persisted library (SWF imports, older .vbd
   *  bodies) rebuild theirs on load. */
  function collectMaterials(project) {
    project.materials = project.materials || [];
    project.eachCell(function (cell) {
      cell.fills.forEach(function (f) {
        if (f.type !== "solid") project.addMaterial(f);
      });
    });
    return project;
  }

  Project.prototype.newCell = function () {
    var d = new VB.Y2KVectorDocument();
    d.width = this.width;
    d.height = this.height;
    d.background = this.background;
    return d;
  };

  /** The Brainstorm board's shared vector canvas — created lazily on
   *  first touch (deterministic: live and replay create it on the same
   *  op). Its width/height are nominal; the board is unbounded and the
   *  planar map never clips. */
  Project.prototype.notesCanvas = function () {
    this.notes = this.notes || { items: [] };
    if (!this.notes.canvas) {
      var d = new VB.Y2KVectorDocument();
      d.width = 8000 * 20;
      d.height = 6000 * 20;
      this.notes.canvas = d;
    }
    return this.notes.canvas;
  };

  /** Resolves the actor-edit target to { cell, actor, label } or null.
   *  Symbol targets edit the symbol's ACTIVE drawing. */
  Project.prototype.resolveEditCell = function () {
    var t = this.editTarget;
    if (!t) return null;
    if (t.notes) {
      return { cell: this.notesCanvas(), actor: null,
               label: "brainstorm canvas" };
    }
    var actors = this.actors || [];
    var actor = null;
    for (var i = 0; i < actors.length; i++) {
      if (actors[i].id === t.actor) { actor = actors[i]; break; }
    }
    if (!actor) return null;
    if (t.pose) {
      for (var p = 0; p < actor.poses.length; p++) {
        if (actor.poses[p].id === t.pose) {
          return { cell: actor.poses[p].cell, actor: actor,
                   label: actor.name + " ▸ " + actor.poses[p].name };
        }
      }
      return null;
    }
    if (t.symbol) {
      var hit = null;
      var walk = function (list) {
        for (var s = 0; s < list.length && !hit; s++) {
          if (list[s].id === t.symbol) { hit = list[s]; return; }
          walk(list[s].symbols);
        }
      };
      for (var p2 = 0; p2 < actor.poses.length && !hit; p2++) {
        walk(actor.poses[p2].symbols);
      }
      if (!hit) return null;
      var d = hit.drawings[hit.cur.drawing];
      return d ? { cell: d.cell, actor: actor,
                   label: actor.name + " ▸ " + hit.name + " ▸ " + d.name }
               : null;
    }
    return null;
  };

  Project.prototype.scene = function () {
    var t = this.resolveEditCell();
    if (t) {
      // virtual single-layer scene: renderers, the layers panel, and
      // activeCell() all see the actor cell without special cases
      return { name: "(actor edit)", layers: [{
        name: t.label, visible: true, locked: false, frames: [t.cell]
      }] };
    }
    return this.scenes[this.cur.scene];
  };
  Project.prototype.activeLayer = function () {
    var layers = this.scene().layers;
    return layers[Math.min(this.cur.layer, layers.length - 1)];
  };
  Project.prototype.activeCell = function () {
    return VB.frameCell(this.activeLayer(), this.cur.frame || 0);
  };
  /** Longest sub-timeline in the active scene (≥ 1). */
  Project.prototype.frameCount = function () {
    return this.scene().layers.reduce(function (n, l) {
      return Math.max(n, l.frames.length);
    }, 1);
  };
  /** Appends a blank frame cell to a layer and moves the playhead to
   *  it. Shorter layers keep holding their last frame. */
  Project.prototype.addFrame = function (layerIndex) {
    if (this.editTarget) return this.cur.frame; // actor cells have no timeline yet
    var layers = this.scene().layers;
    var l = layers[Math.min(layerIndex || 0, layers.length - 1)];
    l.frames.push(this.newCell());
    this.cur.frame = l.frames.length - 1;
    return this.cur.frame;
  };
  Project.prototype.removeFrame = function (layerIndex, index) {
    if (this.editTarget) return false;
    var layers = this.scene().layers;
    var l = layers[Math.min(layerIndex || 0, layers.length - 1)];
    if (l.frames.length <= 1) return false; // a layer never goes frameless
    if (index < 0 || index >= l.frames.length) return false;
    l.frames.splice(index, 1);
    this.cur.frame = Math.min(this.cur.frame, this.frameCount() - 1);
    return true;
  };
  Project.prototype.selectFrame = function (index) {
    this.cur.frame = Math.max(0, Math.min(this.frameCount() - 1, index));
  };
  /** Stage rect for the renderers: the actor canvas in edit mode. */
  Project.prototype.stage = function () {
    var t = this.resolveEditCell();
    if (t) {
      return { width: t.cell.width, height: t.cell.height,
               background: t.cell.background };
    }
    return { width: this.width, height: this.height,
             background: this.background };
  };

  Project.prototype.resize = function (width, height) {
    this.width = width;
    this.height = height;
    var self = this;
    this.eachCell(function (cell) {
      cell.width = width; cell.height = height;
      cell.background = self.background;
    });
  };

  Project.prototype.eachCell = function (fn) {
    this.scenes.forEach(function (sc, si) {
      sc.layers.forEach(function (l, li) {
        l.frames.forEach(function (cell) { fn(cell, si, li); });
      });
    });
  };

  /** Insert a new layer ABOVE the active one and select it (Flash). */
  Project.prototype.addLayer = function (name) {
    var layers = this.scene().layers;
    if (!name) {
      var n = 0;
      this.scenes.forEach(function (sc) { n += sc.layers.length; });
      name = "Layer " + (n + 1);
    }
    layers.splice(this.cur.layer, 0, new Layer(name, this.newCell()));
    return this.cur.layer;
  };

  /** Remove a layer; the last layer of a scene cannot be deleted. */
  Project.prototype.deleteLayer = function (index) {
    var layers = this.scene().layers;
    if (layers.length <= 1) return false;
    if (index < 0 || index >= layers.length) return false;
    layers.splice(index, 1);
    if (this.cur.layer >= layers.length) this.cur.layer = layers.length - 1;
    else if (this.cur.layer > index) this.cur.layer--;
    return true;
  };

  Project.prototype.moveLayer = function (from, to) {
    var layers = this.scene().layers;
    if (from < 0 || from >= layers.length || to < 0 || to >= layers.length) return false;
    var l = layers.splice(from, 1)[0];
    layers.splice(to, 0, l);
    if (this.cur.layer === from) this.cur.layer = to;
    else if (from < this.cur.layer && to >= this.cur.layer) this.cur.layer--;
    else if (from > this.cur.layer && to <= this.cur.layer) this.cur.layer++;
    return true;
  };

  Project.prototype.selectLayer = function (index) {
    var layers = this.scene().layers;
    this.cur.layer = Math.max(0, Math.min(layers.length - 1, index));
  };

  Project.prototype.addScene = function (name) {
    this.scenes.push(new Scene(name || "Scene " + (this.scenes.length + 1),
                               this.newCell()));
    this.cur.scene = this.scenes.length - 1;
    this.cur.layer = 0;
  };

  Project.prototype.selectScene = function (index) {
    this.cur.scene = Math.max(0, Math.min(this.scenes.length - 1, index));
    this.cur.layer = Math.min(this.cur.layer,
                              this.scene().layers.length - 1);
  };

  /** Wrap a bare Y2KVectorDocument (a loaded .swf / v1-v2 .vbd) as a
   *  single-layer project adopting its stage. */
  function wrapDoc(doc) {
    var p = new Project(doc.width, doc.height);
    p.background = doc.background;
    p.scenes[0].layers[0].frames[0] = doc;
    collectMaterials(p);
    return p;
  }

  /** The cell a layer SHOWS at playhead `frame`: its own frame, or its
   *  last one held (Flash's frame-hold). */
  function frameCell(layer, frame) {
    return layer.frames[Math.min(frame || 0, layer.frames.length - 1)];
  }

  window.VB = window.VB || {};
  VB.Project = Project;
  VB.wrapDoc = wrapDoc;
  VB.frameCell = frameCell;
  VB.projectCollectMaterials = collectMaterials;
})();
