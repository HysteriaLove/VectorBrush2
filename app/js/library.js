/* library.js — the object LIBRARY (user decision 2026-07-10).
 *
 * Scenes and actors are data containers (reference: the Animation
 * Program V2 model); this adds the third container type: SYMBOLS —
 * global reusable objects. A marquee/lasso selection anywhere can be
 * right-clicked and converted to a symbol: the selection's clip
 * (the same self-contained payload the clipboard uses) materializes
 * into a library cell, ready for instantiation later. BACKGROUNDS are
 * the fourth object kind: stage-sized backdrop containers for the
 * compositor.
 *
 * Deleting removes the library entry; the instance-management system
 * (delete-all-instances etc.) is future work. Thin UI, real model:
 * ops carry ids, everything replays byte-exact.
 */
(function () {
  "use strict";

  function libraryOf(project) {
    project.library = project.library || [];
    return project.library;
  }

  function entryById(project, id) {
    var lib = libraryOf(project);
    for (var i = 0; i < lib.length; i++) {
      if (lib[i].id === id) return { entry: lib[i], index: i };
    }
    return null;
  }

  VB.defineOp("symbolCreate", function (c, op) {
    c.history.push(c.project);
    var lib = libraryOf(c.project);
    var kind = op.kind === "background" ? "background" : "symbol";
    var cell = new VB.Y2KVectorDocument();
    if (op.clip) {
      // materialize the selection clip — the same mapping the paste op
      // uses, so a symbol IS what the clipboard would have carried
      cell.fills = op.clip.fills.map(function (f) {
        return { type: "solid", color: { r: f.color.r, g: f.color.g,
                                         b: f.color.b, a: f.color.a } };
      });
      cell.lines = op.clip.lines.map(function (l) {
        return { width: l.width, color: { r: l.color.r, g: l.color.g,
                                          b: l.color.b, a: l.color.a } };
      });
      cell.edges = op.clip.edges.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by,
                       e.fill0, e.fill1, e.line);
      });
    }
    if (kind === "background" || !op.clip) {
      cell.width = c.project.width;
      cell.height = c.project.height;
    } else {
      // size the container to its art (nominal — planar maps never clip)
      var xmax = 0, ymax = 0;
      cell.edges.forEach(function (e) {
        xmax = Math.max(xmax, e.ax, e.bx);
        ymax = Math.max(ymax, e.ay, e.by);
      });
      cell.width = Math.max(2000, xmax + 200);
      cell.height = Math.max(2000, ymax + 200);
    }
    var count = lib.filter(function (e) { return e.kind === kind; }).length;
    lib.push({
      id: op.id, kind: kind,
      name: op.name || (kind === "background" ? "background " : "symbol ") +
        String(count + 1).padStart(2, "0"),
      cell: cell
    });
    c.sync();
  });

  VB.defineOp("symbolRename", function (c, op) {
    var hit = entryById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    hit.entry.name = op.name;
    c.sync();
  });

  // removes the LIBRARY entry; instance management is a future system
  VB.defineOp("symbolRemove", function (c, op) {
    var hit = entryById(c.project, op.id);
    if (!hit) return;
    c.history.push(c.project);
    libraryOf(c.project).splice(hit.index, 1);
    c.sync();
  });

  window.VB = window.VB || {};
  VB.libraryEntryById = entryById;
})();
