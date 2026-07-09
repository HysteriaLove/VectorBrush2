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
    this.background = { r: 255, g: 255, b: 255, a: 255 };
    this.scenes = [new Scene("Scene 1", this.newCell())];
    this.cur = { scene: 0, layer: 0 };
    // The GLOBAL 2DMaterial library (Flash's library, not per-layer):
    // crafted material definitions usable on any layer or scene. Cells
    // keep their own fills[] (the SWF wire grammar); painting with a
    // library material copies the definition into the target cell,
    // deduped by sameFill.
    this.materials = [];
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

  Project.prototype.scene = function () {
    return this.scenes[this.cur.scene];
  };
  Project.prototype.activeLayer = function () {
    return this.scene().layers[this.cur.layer];
  };
  Project.prototype.activeCell = function () {
    return this.activeLayer().frames[0];
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

  window.VB = window.VB || {};
  VB.Project = Project;
  VB.wrapDoc = wrapDoc;
  VB.projectCollectMaterials = collectMaterials;
})();
