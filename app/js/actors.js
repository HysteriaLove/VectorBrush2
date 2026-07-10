/* actors.js — the Actors library: poses → symbols → drawings
 * (Architecture §6.6; build-order step 2, beat 1: model + ops, no UI).
 *
 * Mirrors the Animation Program V2 reference (Actor/Pose/Symbol/
 * SymbolDrawing dataclasses; ACTOR_FILE_FORMAT.txt v3), adapted to our
 * engine: every piece of art is a y2kvector document (the planar map),
 * so the whole tool suite, the boolean core, and the material library
 * apply to actor art unchanged. Symbols nest (eyes → pupils, mouth →
 * phoneme set — Architecture §6.6).
 *
 * Prototype/instance discipline (Architecture §3): every definition
 * carries a stable id. Ops CARRY their ids — generated at record time
 * by the caller, never inside a handler — so live dispatch and journal
 * replay construct identical structures. Auto-names derive from state
 * (actor001, pose_01…), which is equally deterministic.
 *
 * Persistence: actors ride the journal (.y2kproj replays actor.* ops).
 * The .y2kvector project-file save does NOT carry actors yet — the
 * interchange format for one actor is .y2kactor (below).
 */
(function () {
  "use strict";

  var DEFAULT_W = 512 * 20; // reference default actor canvas, in twips
  var DEFAULT_H = 512 * 20;

  function pad3(n) { return String(n).padStart(3, "0"); }
  function pad2(n) { return String(n).padStart(2, "0"); }

  function newCell(actor) {
    var d = new VB.Y2KVectorDocument();
    d.width = actor.width;
    d.height = actor.height;
    d.background = { r: 255, g: 255, b: 255, a: 255 };
    return d;
  }

  // ---- lookups ---------------------------------------------------------------

  function actorById(project, id) {
    var actors = project.actors || [];
    for (var i = 0; i < actors.length; i++) {
      if (actors[i].id === id) return actors[i];
    }
    return null;
  }

  function poseById(actor, id) {
    for (var i = 0; i < actor.poses.length; i++) {
      if (actor.poses[i].id === id) return actor.poses[i];
    }
    return null;
  }

  /** Depth-first symbol search across every pose (symbols nest).
   *  Returns { symbol, list, index } — list is the owning array. */
  function findSymbol(actor, id) {
    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return { symbol: list[i], list: list, index: i };
        var hit = walk(list[i].symbols);
        if (hit) return hit;
      }
      return null;
    }
    for (var p = 0; p < actor.poses.length; p++) {
      var hit = walk(actor.poses[p].symbols);
      if (hit) return hit;
    }
    return null;
  }

  function eachActorCell(actor, fn) {
    function walkSymbols(list) {
      list.forEach(function (s) {
        s.drawings.forEach(function (d) { fn(d.cell); });
        walkSymbols(s.symbols);
      });
    }
    actor.poses.forEach(function (p) {
      fn(p.cell);
      walkSymbols(p.symbols);
    });
  }

  // ---- ops (command registry — journaled, replay-identical) --------------------

  VB.defineOp("actorAdd", function (c, op) {
    c.history.push(c.project);
    c.project.actors = c.project.actors || [];
    var actor = {
      id: op.id,
      name: op.name || "actor" + pad3(c.project.actors.length + 1),
      width: op.width || DEFAULT_W,
      height: op.height || DEFAULT_H,
      poses: [],
      cur: { pose: 0 }
    };
    // every actor starts with a pose (reference: pose_01)
    actor.poses.push({ id: op.poseId, name: "pose_01",
                       cell: newCell(actor), symbols: [] });
    c.project.actors.push(actor);
    c.sync();
  });

  VB.defineOp("actorRename", function (c, op) {
    var a = actorById(c.project, op.actor);
    if (!a) return;
    c.history.push(c.project);
    a.name = op.name;
    c.sync();
  });

  VB.defineOp("actorRemove", function (c, op) {
    var actors = c.project.actors || [];
    for (var i = 0; i < actors.length; i++) {
      if (actors[i].id === op.actor) {
        c.history.push(c.project);
        actors.splice(i, 1);
        c.sync();
        return;
      }
    }
  });

  VB.defineOp("actorCanvas", function (c, op) {
    var a = actorById(c.project, op.actor);
    if (!a) return;
    c.history.push(c.project);
    a.width = op.width;
    a.height = op.height;
    eachActorCell(a, function (cell) {
      cell.width = op.width;
      cell.height = op.height;
    });
    c.sync();
  });

  VB.defineOp("poseAdd", function (c, op) {
    var a = actorById(c.project, op.actor);
    if (!a) return;
    c.history.push(c.project);
    a.poses.push({ id: op.id,
                   name: op.name || "pose_" + pad2(a.poses.length + 1),
                   cell: newCell(a), symbols: [] });
    a.cur.pose = a.poses.length - 1;
    c.sync();
  });

  VB.defineOp("poseRename", function (c, op) {
    var a = actorById(c.project, op.actor);
    var p = a && poseById(a, op.pose);
    if (!p) return;
    c.history.push(c.project);
    p.name = op.name;
    c.sync();
  });

  VB.defineOp("poseRemove", function (c, op) {
    var a = actorById(c.project, op.actor);
    if (!a || a.poses.length <= 1) return; // the last pose stays (like layers)
    for (var i = 0; i < a.poses.length; i++) {
      if (a.poses[i].id === op.pose) {
        c.history.push(c.project);
        a.poses.splice(i, 1);
        if (a.cur.pose >= a.poses.length) a.cur.pose = a.poses.length - 1;
        else if (a.cur.pose > i) a.cur.pose--;
        c.sync();
        return;
      }
    }
  });

  VB.defineOp("poseSelect", function (c, op) {
    var a = actorById(c.project, op.actor);
    if (!a) return;
    a.cur.pose = Math.max(0, Math.min(a.poses.length - 1, op.index));
    c.sync();
  });

  VB.defineOp("symbolAdd", function (c, op) {
    var a = actorById(c.project, op.actor);
    if (!a) return;
    var list = null;
    if (op.parent) {
      var parent = findSymbol(a, op.parent);
      list = parent && parent.symbol.symbols;
    } else {
      var pose = poseById(a, op.pose);
      list = pose && pose.symbols;
    }
    if (!list) return;
    c.history.push(c.project);
    var symbol = {
      id: op.id,
      name: op.name || "symbol_" + pad2(list.length + 1),
      symbols: [],
      drawings: [{ id: op.drawingId, name: "drawing_01", cell: newCell(a) }],
      cur: { drawing: 0 }
    };
    list.push(symbol);
    c.sync();
  });

  // "actorSymbol*" — NOT "symbol*": the object library owns the bare
  // symbolRename/symbolRemove names (library.js), and defineOp is
  // last-writer-wins, so sharing names would silently shadow one family
  VB.defineOp("actorSymbolRename", function (c, op) {
    var a = actorById(c.project, op.actor);
    var hit = a && findSymbol(a, op.symbol);
    if (!hit) return;
    c.history.push(c.project);
    hit.symbol.name = op.name;
    c.sync();
  });

  VB.defineOp("actorSymbolRemove", function (c, op) {
    var a = actorById(c.project, op.actor);
    var hit = a && findSymbol(a, op.symbol);
    if (!hit) return;
    c.history.push(c.project);
    hit.list.splice(hit.index, 1);
    c.sync();
  });

  VB.defineOp("drawingAdd", function (c, op) {
    var a = actorById(c.project, op.actor);
    var hit = a && findSymbol(a, op.symbol);
    if (!hit) return;
    c.history.push(c.project);
    var s = hit.symbol;
    s.drawings.push({ id: op.id,
                      name: op.name || "drawing_" + pad2(s.drawings.length + 1),
                      cell: newCell(a) });
    s.cur.drawing = s.drawings.length - 1;
    c.sync();
  });

  VB.defineOp("drawingRename", function (c, op) {
    var a = actorById(c.project, op.actor);
    var hit = a && findSymbol(a, op.symbol);
    if (!hit) return;
    for (var i = 0; i < hit.symbol.drawings.length; i++) {
      if (hit.symbol.drawings[i].id === op.drawing) {
        c.history.push(c.project);
        hit.symbol.drawings[i].name = op.name;
        c.sync();
        return;
      }
    }
  });

  VB.defineOp("drawingRemove", function (c, op) {
    var a = actorById(c.project, op.actor);
    var hit = a && findSymbol(a, op.symbol);
    if (!hit || hit.symbol.drawings.length <= 1) return; // keep one drawing
    var s = hit.symbol;
    for (var i = 0; i < s.drawings.length; i++) {
      if (s.drawings[i].id === op.drawing) {
        c.history.push(c.project);
        s.drawings.splice(i, 1);
        if (s.cur.drawing >= s.drawings.length) s.cur.drawing = s.drawings.length - 1;
        else if (s.cur.drawing > i) s.cur.drawing--;
        c.sync();
        return;
      }
    }
  });

  VB.defineOp("drawingSelect", function (c, op) {
    var a = actorById(c.project, op.actor);
    var hit = a && findSymbol(a, op.symbol);
    if (!hit) return;
    hit.symbol.cur.drawing =
      Math.max(0, Math.min(hit.symbol.drawings.length - 1, op.index));
    c.sync();
  });

  // Actor edit mode — Flash's symbol-edit. Selection-class ops (no
  // history snapshot, like sceneSelect); project.scene()/stage()/
  // activeCell() resolve through the target, so tools, renderers, and
  // every journaled art op follow — live and replay agree because the
  // mode switch itself is journaled.
  VB.defineOp("editTargetSet", function (c, op) {
    c.project.editTarget = JSON.parse(JSON.stringify(op.target));
    c.sync();
  });

  VB.defineOp("editTargetClear", function (c) {
    c.project.editTarget = null;
    c.sync();
  });

  // The import op carries the WHOLE actor as plain JSON (cells included)
  // — self-contained, so replay never depends on a file. Ids must be
  // regenerated BEFORE recording (decodeY2KActor does it).
  VB.defineOp("actorImport", function (c, op) {
    c.history.push(c.project);
    c.project.actors = c.project.actors || [];
    c.project.actors.push(plainToActor(op.actor));
    c.sync();
  });

  // ---- plain-JSON round trip (journal ops + .y2kactor) --------------------------

  function cellToPlain(cell) {
    return {
      width: cell.width, height: cell.height,
      background: JSON.parse(JSON.stringify(cell.background)),
      fills: JSON.parse(JSON.stringify(cell.fills)),
      lines: JSON.parse(JSON.stringify(cell.lines)),
      edges: cell.edges.map(function (e) {
        return [e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line];
      }),
      fonts: JSON.parse(JSON.stringify(cell.fonts || [])),
      texts: JSON.parse(JSON.stringify(cell.texts || []))
    };
  }

  function plainToCell(p) {
    var d = new VB.Y2KVectorDocument();
    d.width = p.width; d.height = p.height;
    d.background = JSON.parse(JSON.stringify(p.background));
    d.fills = JSON.parse(JSON.stringify(p.fills));
    d.lines = JSON.parse(JSON.stringify(p.lines));
    d.edges = p.edges.map(function (e) {
      return VB.edge(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]);
    });
    d.fonts = JSON.parse(JSON.stringify(p.fonts || []));
    d.texts = JSON.parse(JSON.stringify(p.texts || []));
    return d;
  }

  function symbolToPlain(s) {
    return {
      id: s.id, name: s.name,
      symbols: s.symbols.map(symbolToPlain),
      drawings: s.drawings.map(function (d) {
        return { id: d.id, name: d.name, cell: cellToPlain(d.cell) };
      }),
      cur: { drawing: s.cur.drawing }
    };
  }

  function plainToSymbol(p) {
    return {
      id: p.id, name: p.name,
      symbols: p.symbols.map(plainToSymbol),
      drawings: p.drawings.map(function (d) {
        return { id: d.id, name: d.name, cell: plainToCell(d.cell) };
      }),
      cur: { drawing: p.cur.drawing }
    };
  }

  function actorToPlain(a) {
    return {
      id: a.id, name: a.name, width: a.width, height: a.height,
      poses: a.poses.map(function (p) {
        return { id: p.id, name: p.name, cell: cellToPlain(p.cell),
                 symbols: p.symbols.map(symbolToPlain) };
      }),
      cur: { pose: a.cur.pose }
    };
  }

  function plainToActor(p) {
    return {
      id: p.id, name: p.name, width: p.width, height: p.height,
      poses: p.poses.map(function (ps) {
        return { id: ps.id, name: ps.name, cell: plainToCell(ps.cell),
                 symbols: ps.symbols.map(plainToSymbol) };
      }),
      cur: { pose: p.cur.pose }
    };
  }

  // ---- .y2kactor interchange -----------------------------------------------------
  // Uncompressed UTF-8 JSON, like the reference .actor v3 ("no gzip
  // layer"): { format, version, actor } with plain cells. On import,
  // ids regenerate (reference spec: actor/poses/symbols/drawings) —
  // selections are indices, so no reference remapping is needed.

  function newId(prefix) {
    var a = new Uint8Array(8);
    if (self.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0;
    var hex = "";
    for (var j = 0; j < a.length; j++) hex += (a[j] & 255).toString(16).padStart(2, "0");
    return prefix + "_" + hex;
  }

  function encodeY2KActor(actor) {
    var json = JSON.stringify({ format: "y2kactor", version: 1,
                                actor: actorToPlain(actor) });
    return new TextEncoder().encode(json);
  }

  /** bytes → plain actor JSON with FRESH ids, ready for the actorImport
   *  op. Throws on wrong format/version. */
  function decodeY2KActor(bytes) {
    var parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed.format !== "y2kactor") throw new Error("Not a y2kactor file");
    if (parsed.version !== 1) {
      throw new Error("Unsupported y2kactor version " + parsed.version);
    }
    var actor = parsed.actor;
    actor.id = newId("actor");
    function regenSymbol(s) {
      s.id = newId("sym");
      s.drawings.forEach(function (d) { d.id = newId("drw"); });
      s.symbols.forEach(regenSymbol);
    }
    actor.poses.forEach(function (p) {
      p.id = newId("pose");
      p.symbols.forEach(regenSymbol);
    });
    return actor;
  }

  window.VB = window.VB || {};
  VB.actorById = actorById;
  VB.actorPoseById = poseById;
  VB.actorFindSymbol = findSymbol;
  VB.actorToPlain = actorToPlain;
  VB.plainToActor = plainToActor;
  VB.encodeY2KActor = encodeY2KActor;
  VB.decodeY2KActor = decodeY2KActor;
  VB.actorNewId = newId;
})();
