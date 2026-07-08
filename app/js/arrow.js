/* arrow.js — the Flash Arrow tool (V): select, move, reshape, delete.
 *
 * Semantics extracted from the Arrow001 reference series (record-level
 * diffs of MX 2004 before/after snapshots):
 *   - dragging the MIDDLE of an edge reshapes it with both endpoints
 *     pinned: a straight record becomes a quad whose curve passes
 *     through the drag point (Arrow002->003 is exactly L->Q with
 *     identical endpoints); quads re-solve their control the same way;
 *   - dragging an ANCHOR moves the shared node — every incident record
 *     follows;
 *   - reshaped geometry that crosses other art is re-noded into the
 *     planar map (the reference shows Flash re-merging after drags);
 *   - clicking a fill selects that FACE; dragging lifts it and drops it
 *     with paint-over semantics (the moved region replaces what it
 *     lands on); Delete erases the face (stamp its sides empty — the
 *     lineless borders to emptiness dissolve).
 *
 * Every operation is journaled and deterministic: edges are identified
 * by their full record key, faces by a containing point.
 */
(function () {
  "use strict";

  // ---- edge identity ---------------------------------------------------------

  function edgeKey(e) {
    return [e.ax, e.ay, e.cx === null ? "n" : e.cx, e.cy === null ? "n" : e.cy,
            e.bx, e.by, e.fill0, e.fill1, e.line].join(",");
  }
  function findByKey(doc, key) {
    for (var i = 0; i < doc.edges.length; i++) {
      if (edgeKey(doc.edges[i]) === key) return i;
    }
    return -1;
  }

  // ---- core operations (journal-replayable) -----------------------------------

  /**
   * Reshape one record: endpoints pinned, control solved so the curve
   * passes through (tx,ty) at parameter t. Straight records become
   * quads (Arrow002->003). The result is re-noded into the map.
   */
  function arrowReshape(doc, key, t, tx, ty) {
    var idx = findByKey(doc, key);
    if (idx < 0) return false;
    var e = doc.edges[idx];
    // snapshot BEFORE any mutation — mask ground truth for faces outside
    // the swept lens
    var preOp = new VB.VBDocument();
    preOp.width = doc.width; preOp.height = doc.height;
    preOp.fills = doc.fills; preOp.lines = doc.lines;
    preOp.edges = doc.edges.map(function (pe) {
      return VB.edge(pe.ax, pe.ay, pe.cx, pe.cy, pe.bx, pe.by, pe.fill0, pe.fill1, pe.line);
    });

    doc.edges.splice(idx, 1);
    t = Math.min(0.8, Math.max(0.2, t));
    var u = 1 - t;
    var cx = Math.round((tx - u * u * e.ax - t * t * e.bx) / (2 * t * u));
    var cy = Math.round((ty - u * u * e.ay - t * t * e.by) / (2 * t * u));
    var ne = VB.edge(e.ax, e.ay, cx, cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    if (VB.edgeIsDegenerate(ne)) { doc.edges.push(e); return false; }
    var pieces = VB.nodeEdges(doc, [ne]);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
    VB.repairPlanar(doc);

    // Reshaping a REGION BOUNDARY drags its fill with it: the lens swept
    // between the old and new curve changes owner. Each lobe of the lens
    // (old curve forward + new curve reversed = closed loop; an S-drag
    // gives lobes of opposite winding) now belongs to the fill on ITS
    // side of the new curve. Reconciling the lens through the region
    // mask paints/erases everything the sweep covered — including fill
    // islands, which used to keep stale claims and render as invisible
    // overlap regions.
    if (e.fill0 !== e.fill1) {
      var lens = [
        VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0),
        VB.edge(ne.bx, ne.by, ne.cx, ne.cy, ne.ax, ne.ay, 0, 0, 0)
      ];
      [1, -1].forEach(function (sign) {
        // find a probe inside this lobe
        var probe = null;
        for (var s5 = 0.08; s5 < 1 && !probe; s5 += 0.07) {
          var p1 = VB.geom.evalEdge(e, s5);
          var p2 = VB.geom.evalEdge(ne, s5);
          var q5 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          if (VB.geom.windingNumber(lens, q5.x, q5.y) * sign > 0) probe = q5;
        }
        if (!probe) return;
        // which side of the NEW curve does this lobe lie on?
        var near = VB.geom.nearestOnEdge(ne, probe.x, probe.y);
        var t5 = Math.min(0.97, Math.max(0.03, near.t));
        var ah = VB.geom.evalEdge(ne, Math.min(1, t5 + 0.03));
        var bh = VB.geom.evalEdge(ne, Math.max(0, t5 - 0.03));
        var dx5 = ah.x - bh.x, dy5 = ah.y - bh.y;
        var crossZ = dx5 * (probe.y - near.y) - dy5 * (probe.x - near.x);
        var growFill = crossZ > 0 ? ne.fill1 : ne.fill0; // right : left
        VB.applyRegionMask(doc, preOp, function (x5, y5) {
          var w5 = VB.geom.windingNumber(lens, x5, y5);
          return sign > 0 ? w5 > 0 : w5 < 0;
        }, growFill, pieces);
      });
    }
    return true;
  }

  /** Move the shared node at (x,y) to (nx,ny); incident records follow. */
  function arrowMoveNode(doc, x, y, nx, ny) {
    nx = Math.round(nx); ny = Math.round(ny);
    var moved = [];
    doc.edges = doc.edges.filter(function (e) {
      var hit = (e.ax === x && e.ay === y) || (e.bx === x && e.by === y);
      if (hit) moved.push(e);
      return !hit;
    });
    if (moved.length === 0) return false;
    var updated = [];
    moved.forEach(function (e) {
      var aHit = e.ax === x && e.ay === y;
      var bHit = e.bx === x && e.by === y;
      var ne = VB.edge(aHit ? nx : e.ax, aHit ? ny : e.ay, e.cx, e.cy,
                       bHit ? nx : e.bx, bHit ? ny : e.by,
                       e.fill0, e.fill1, e.line);
      if (!VB.edgeIsDegenerate(ne)) updated.push(ne);
    });
    var pieces = VB.nodeEdges(doc, updated);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
    VB.repairPlanar(doc);
    return true;
  }

  // Directed boundary loops (face-on-right) of the face containing (x,y),
  // as pristine edge copies, plus the fill index there. Null if empty.
  function faceLoopsAt(doc, x, y) {
    var fillIdx = VB.geom.fillAt(doc, x, y);
    if (fillIdx === 0) return null;
    var face = VB.faceAt(doc, x, y);
    if (!face) return null;
    var loops = [];
    [face.outer].concat(face.holes).forEach(function (cyc) {
      var loop = [];
      cyc.forEach(function (h) {
        var e = doc.edges[h.edge];
        loop.push(h.forward
          ? VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0)
          : VB.edge(e.bx, e.by, e.cx, e.cy, e.ax, e.ay, 0, 0, 0));
      });
      loops.push(loop);
    });
    return { fillIdx: fillIdx, face: face, loops: loops };
  }

  /**
   * Delete the fill face at (x,y): stamp the face's own sides empty and
   * cull the lineless borders that end up 0|0 — exact, probe-free.
   */
  function arrowDeleteFill(doc, x, y) {
    var fillIdx = VB.geom.fillAt(doc, x, y);
    if (fillIdx === 0) return false;
    var face = VB.faceAt(doc, x, y);
    if (!face) return false;
    [face.outer].concat(face.holes).forEach(function (cyc) {
      cyc.forEach(function (h) {
        var e = doc.edges[h.edge];
        if (h.forward) e.fill1 = 0; else e.fill0 = 0;
      });
    });
    doc.edges = doc.edges.filter(function (e) {
      return !(e.fill0 === e.fill1 && e.line === 0);
    });
    return true;
  }

  /**
   * Move the fill face at (x,y) by (dx,dy): Flash's lift-and-drop —
   * the face is deleted at the source and painted at the destination
   * with paint-over semantics (the brush's boolean-mask pipeline).
   */
  function arrowMoveFill(doc, x, y, dx, dy) {
    var picked = faceLoopsAt(doc, x, y);
    if (!picked) return false;
    dx = Math.round(dx); dy = Math.round(dy);
    if (dx === 0 && dy === 0) return false;
    var fillIdx = picked.fillIdx;

    arrowDeleteFill(doc, x, y);

    var fitted = [];
    picked.loops.forEach(function (loop) {
      loop.forEach(function (e) {
        var ne = VB.edge(e.ax + dx, e.ay + dy,
          e.cx === null ? null : e.cx + dx, e.cy === null ? null : e.cy + dy,
          e.bx + dx, e.by + dy, 0, 0, 0);
        if (!VB.edgeIsDegenerate(ne)) fitted.push(ne);
      });
    });
    if (fitted.length === 0) return false;
    var windingLoops = fitted.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    function insideMoved(px, py) {
      return VB.geom.windingNumber(windingLoops, px, py) !== 0;
    }
    var preOp = new VB.VBDocument();
    preOp.width = doc.width; preOp.height = doc.height;
    preOp.fills = doc.fills; preOp.lines = doc.lines;
    preOp.edges = doc.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    });
    var adopted = VB.adoptIdenticalEdges(doc, fitted);
    var pieces = VB.nodeEdges(doc, adopted.fresh);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
    VB.applyRegionMask(doc, preOp, insideMoved, fillIdx,
                       pieces.concat(adopted.twins));
    return true;
  }

  /** Delete a stroke record: strip the line style; cull if claim-free.
   *  Interior strokes vanish leaving the fills they crossed intact; a
   *  stroke between two SAME-fill regions dissolves entirely so the
   *  fills collapse into one; a border between DIFFERENT fills keeps
   *  separating them (lineless). */
  function arrowDeleteEdge(doc, key) {
    var idx = findByKey(doc, key);
    if (idx < 0) return false;
    var e = doc.edges[idx];
    if (e.line === 0) return false; // lineless borders belong to their fills
    e.line = 0;
    if (e.fill0 === e.fill1) doc.edges.splice(idx, 1);
    return true;
  }

  /** All stroke records connected to edges[startIdx] through shared
   *  nodes ("attached strokes" — Flash's double-click selection).
   *  Returns edge keys. */
  function connectedStrokeKeys(doc, startIdx) {
    var start = doc.edges[startIdx];
    if (!start || start.line === 0) return [];
    var byNode = new Map();
    doc.edges.forEach(function (e, i) {
      if (e.line === 0) return;
      [e.ax + "," + e.ay, e.bx + "," + e.by].forEach(function (k) {
        var arr = byNode.get(k);
        if (!arr) { arr = []; byNode.set(k, arr); }
        arr.push(i);
      });
    });
    var seen = new Set([startIdx]);
    var queue = [startIdx];
    while (queue.length) {
      var i = queue.pop();
      var e = doc.edges[i];
      [e.ax + "," + e.ay, e.bx + "," + e.by].forEach(function (k) {
        (byNode.get(k) || []).forEach(function (j) {
          if (!seen.has(j)) { seen.add(j); queue.push(j); }
        });
      });
    }
    var keys = [];
    seen.forEach(function (i) { keys.push(edgeKey(doc.edges[i])); });
    return keys;
  }

  /** Delete a whole selection: fill faces + stroke records. */
  function arrowDeleteSel(doc, fillPicks, edgeKeys) {
    (edgeKeys || []).forEach(function (k) { arrowDeleteEdge(doc, k); });
    (fillPicks || []).forEach(function (p) { arrowDeleteFill(doc, p.x, p.y); });
    return true;
  }

  function applyM(m, x, y) {
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  }

  /**
   * Affine-transform a selection (free transform / multi-move). Affine
   * maps take quads to quads exactly, so records stay records.
   *  fillPicks: [{x,y}] — face pick points (resolved against the doc
   *             BEFORE any mutation)
   *  edgeKeys:  stroke record keys
   *  m:         [a,b,c,d,tx,ty] — SWF-style 2x3 matrix
   * Originals are lifted (faces deleted, strokes removed), transformed,
   * and re-merged: fills paint over what they land on (the boolean-mask
   * pipeline), strokes re-node and inherit destination fills.
   */
  function arrowTransformSel(doc, fillPicks, edgeKeys, m) {
    fillPicks = fillPicks || [];
    edgeKeys = edgeKeys || [];
    // resolve everything against the pre-op document
    var fills = [];
    fillPicks.forEach(function (p) {
      var got = faceLoopsAt(doc, p.x, p.y);
      if (got) fills.push(got);
    });
    var strokes = [];
    edgeKeys.forEach(function (k) {
      var i = findByKey(doc, k);
      if (i >= 0) strokes.push(doc.edges[i]);
    });
    if (fills.length === 0 && strokes.length === 0) return false;

    // lift originals. Lifting a stroke OFF a fill boundary leaves the
    // fill intact behind a lineless edge (Flash: fills don't follow
    // their outline strokes) — only claim-free strokes vanish entirely.
    fillPicks.forEach(function (p) { arrowDeleteFill(doc, p.x, p.y); });
    var strokeSet = new Set(strokes);
    var rebuilt = [];
    doc.edges.forEach(function (e) {
      if (!strokeSet.has(e)) { rebuilt.push(e); return; }
      if (e.fill0 !== e.fill1) {
        rebuilt.push(VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by,
                             e.fill0, e.fill1, 0));
      }
    });
    doc.edges = rebuilt;

    function txEdge(e, f0, f1, ln) {
      var a = applyM(m, e.ax, e.ay);
      var b = applyM(m, e.bx, e.by);
      var c = e.cx === null ? null : applyM(m, e.cx, e.cy);
      return VB.edge(Math.round(a.x), Math.round(a.y),
        c === null ? null : Math.round(c.x), c === null ? null : Math.round(c.y),
        Math.round(b.x), Math.round(b.y), f0, f1, ln);
    }

    // re-merge fills, each through the mask pipeline
    fills.forEach(function (f) {
      var fitted = [];
      f.loops.forEach(function (loop) {
        loop.forEach(function (e) {
          var ne = txEdge(e, 0, 0, 0);
          if (!VB.edgeIsDegenerate(ne)) fitted.push(ne);
        });
      });
      if (fitted.length === 0) return;
      var windingLoops = fitted.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
      });
      function insideMoved(px, py) {
        return VB.geom.windingNumber(windingLoops, px, py) !== 0;
      }
      var preOp = new VB.VBDocument();
      preOp.width = doc.width; preOp.height = doc.height;
      preOp.fills = doc.fills; preOp.lines = doc.lines;
      preOp.edges = doc.edges.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
      });
      var adopted = VB.adoptIdenticalEdges(doc, fitted);
      var pieces = VB.nodeEdges(doc, adopted.fresh);
      for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
      VB.applyRegionMask(doc, preOp, insideMoved, f.fillIdx,
                         pieces.concat(adopted.twins));
    });

    // re-merge strokes: node in, inherit destination fills
    var newStrokes = [];
    strokes.forEach(function (e) {
      var ne = txEdge(e, 0, 0, e.line);
      if (!VB.edgeIsDegenerate(ne)) newStrokes.push(ne);
    });
    if (newStrokes.length) {
      var pieces2 = VB.nodeEdges(doc, newStrokes);
      pieces2.forEach(function (pc) {
        var mid = VB.geom.evalEdge(pc, 0.5);
        var f = VB.geom.fillAt(doc, mid.x, mid.y);
        pc.fill0 = f; pc.fill1 = f;
        doc.edges.push(pc);
      });
      VB.repairPlanar(doc);
    }
    return true;
  }

  // ---- region selection (marquee / lasso) -------------------------------------
  // Flash's rubber-band and lasso selections CUT through geometry: the
  // selected content is the drawing clipped to the region. Lifting is a
  // mask that erases the complement on a working copy; deleting is a
  // mask that erases the region; moving/transforming is lift + erase +
  // re-merge of the transformed clip.

  // Closed loop edges from polygon points (all-quad convention so the
  // fence stays census-safe).
  function polyLoop(points) {
    var loop = [];
    for (var i = 0; i < points.length; i++) {
      var a = points[i], b = points[(i + 1) % points.length];
      var ax = Math.round(a.x), ay = Math.round(a.y);
      var bx = Math.round(b.x), by = Math.round(b.y);
      var e = VB.edge(ax, ay, Math.round((ax + bx) / 2), Math.round((ay + by) / 2),
                      bx, by, 0, 0, 0);
      if (!VB.edgeIsDegenerate(e)) loop.push(e);
    }
    return loop;
  }

  function cloneDoc(doc) {
    var c = new VB.VBDocument();
    c.width = doc.width; c.height = doc.height;
    c.background = doc.background;
    c.fills = doc.fills.map(function (f) {
      return { type: f.type, color: { r: f.color.r, g: f.color.g, b: f.color.b, a: f.color.a } };
    });
    c.lines = doc.lines.map(function (l) {
      return { width: l.width, color: { r: l.color.r, g: l.color.g, b: l.color.b, a: l.color.a } };
    });
    c.edges = doc.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    });
    return c;
  }

  function maskWith(doc, loopEdges, insideMask, maskFill) {
    var fitted = loopEdges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    var preOp = new VB.VBDocument();
    preOp.width = doc.width; preOp.height = doc.height;
    preOp.fills = doc.fills; preOp.lines = doc.lines;
    preOp.edges = doc.edges.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
    });
    var adopted = VB.adoptIdenticalEdges(doc, fitted);
    var pieces = VB.nodeEdges(doc, adopted.fresh);
    for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
    VB.applyRegionMask(doc, preOp, insideMask, maskFill,
                       pieces.concat(adopted.twins));
  }

  /** The drawing clipped to the region, as a fresh document. */
  function regionLift(doc, points) {
    var lifted = cloneDoc(doc);
    var loop = polyLoop(points);
    var winding = loop.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    maskWith(lifted, loop, function (x, y) {
      return VB.geom.windingNumber(winding, x, y) === 0; // erase the COMPLEMENT
    }, 0);
    return lifted;
  }

  /** Erase everything inside the region (marquee/lasso Delete). */
  function regionDelete(doc, points) {
    var loop = polyLoop(points);
    var winding = loop.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    maskWith(doc, loop, function (x, y) {
      return VB.geom.windingNumber(winding, x, y) !== 0;
    }, 0);
    return true;
  }

  /**
   * Transform the region's content by matrix m: lift the clip, erase the
   * region, re-merge the transformed clip (fills paint over what they
   * land on, strokes re-node and inherit destination fills).
   */
  function regionTransform(doc, points, m) {
    var lifted = regionLift(doc, points);
    if (lifted.edges.length === 0) return false;
    regionDelete(doc, points);
    return mergeLifted(doc, lifted, m);
  }

  /** Merge a lifted clip (a standalone document) into doc under matrix m. */
  function mergeLifted(doc, lifted, m) {
    function txEdge(e, f0, f1, ln) {
      var a = applyM(m, e.ax, e.ay);
      var b = applyM(m, e.bx, e.by);
      var c = e.cx === null ? null : applyM(m, e.cx, e.cy);
      return VB.edge(Math.round(a.x), Math.round(a.y),
        c === null ? null : Math.round(c.x), c === null ? null : Math.round(c.y),
        Math.round(b.x), Math.round(b.y), f0, f1, ln);
    }

    // fills: per fill style of the lifted clip, paint the transformed loops
    for (var f = 1; f <= lifted.fills.length; f++) {
      var got = VB.fillLoops(lifted, f);
      if (!got.loops.length) continue;
      var fitted = [];
      got.loops.forEach(function (loop) {
        loop.forEach(function (d) {
          var ne = txEdge(d, 0, 0, 0);
          if (!VB.edgeIsDegenerate(ne)) fitted.push(ne);
        });
      });
      if (!fitted.length) continue;
      var winding = fitted.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
      });
      var fillIdx = doc.addFillStyle({
        type: "solid",
        color: {
          r: lifted.fills[f - 1].color.r, g: lifted.fills[f - 1].color.g,
          b: lifted.fills[f - 1].color.b, a: lifted.fills[f - 1].color.a
        }
      });
      maskWith(doc, fitted, function (x, y) {
        return VB.geom.windingNumber(winding, x, y) !== 0;
      }, fillIdx);
    }

    // strokes: transform, re-node, inherit destination fills
    var newStrokes = [];
    lifted.edges.forEach(function (e) {
      if (e.line === 0) return;
      var lnIdx = doc.addLineStyle({
        width: lifted.lines[e.line - 1].width,
        color: {
          r: lifted.lines[e.line - 1].color.r, g: lifted.lines[e.line - 1].color.g,
          b: lifted.lines[e.line - 1].color.b, a: lifted.lines[e.line - 1].color.a
        }
      });
      var ne = txEdge(e, 0, 0, lnIdx);
      if (!VB.edgeIsDegenerate(ne)) newStrokes.push(ne);
    });
    if (newStrokes.length) {
      var pieces = VB.nodeEdges(doc, newStrokes);
      pieces.forEach(function (pc) {
        var mid = VB.geom.evalEdge(pc, 0.5);
        var fl = VB.geom.fillAt(doc, mid.x, mid.y);
        pc.fill0 = fl; pc.fill1 = fl;
        doc.edges.push(pc);
      });
      VB.repairPlanar(doc);
    }
    return true;
  }

  // ---- interactive tool ---------------------------------------------------------

  // Flash's arrow cursor states: the badge at the pointer's lower right
  // tells what a click/drag will do — dashed marquee over empty space,
  // 4-way move over a fill, a right-angle corner over a vertex, an arc
  // over an edge.
  var ARROW_PATH = '<path d="M4 2 L4 17 L8.2 13.4 L10.8 19.4 L13.4 18.2 L10.8 12.4 L16 12.4 Z"' +
    ' fill="white" stroke="black" stroke-width="1.2"/>';
  function cursorURI(badge) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26">' +
      ARROW_PATH + badge + '</svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") 4 2, default';
  }
  var CURSORS = {
    marquee: cursorURI('<rect x="16" y="17" width="8" height="7" fill="white"' +
      ' stroke="black" stroke-width="1" stroke-dasharray="2 1.4"/>'),
    move: cursorURI('<g stroke="black" stroke-width="1.6" fill="black">' +
      '<path d="M20 15v10M15 20h10"/>' +
      '<path d="M20 13.6 l-2.4 3 h4.8 Z M20 26.4 l-2.4 -3 h4.8 Z' +
      ' M13.6 20 l3 -2.4 v4.8 Z M26.4 20 l-3 -2.4 v4.8 Z" stroke="none"/></g>'),
    vertex: cursorURI('<path d="M16 24 L16 17.5 L23 17.5" fill="none"' +
      ' stroke="black" stroke-width="1.8"/>'),
    curve: cursorURI('<path d="M16 24 Q19 15 24 19" fill="none"' +
      ' stroke="black" stroke-width="1.8"/>')
  };

  function ArrowTool(app) {
    var self = {
      app: app,
      // selection: fills as pick points (+loops snapshot for overlay),
      // strokes as record keys
      sel: { fills: [], edgeKeys: [], region: null },
      float: null, // { origin: points, doc: liftedDoc, dx, dy, points }
      drag: null,
      hoverPos: null
    };

    function pickTol() { return 6 * VB.TWIPS / app.view.zoom; }
    function selEmpty() {
      return self.sel.fills.length === 0 && self.sel.edgeKeys.length === 0 &&
             !self.sel.region;
    }
    self.clearSelection = function () {
      self.sel = { fills: [], edgeKeys: [], region: null };
      self.float = null;
    };
    self.setRegionSelection = function (points) {
      self.commitFloat();
      self.sel = { fills: [], edgeKeys: [], region: points };
      app.requestRender();
    };

    // Commit the floating chunk: merge it into the document at its
    // accumulated offset. The whole multi-drag gesture is ONE journal op
    // and ONE undo step (the history snapshot was taken at lift time).
    self.commitFloat = function () {
      var fl = self.float;
      if (!fl) return false;
      self.float = null;
      var m = [1, 0, 0, 1, fl.dx, fl.dy];
      app.record({ op: "regionTransform", points: fl.origin, m: m });
      VB.regionMergeLifted(app.doc, fl.doc, m);
      var placed = fl.points;
      app.docChanged();
      // keep the committed region selected so Q can adopt it in place
      self.sel = { fills: [], edgeKeys: [], region: placed };
      app.setMsg("selection merged");
      return true;
    };
    self.exportSelection = function () {
      return {
        fills: self.sel.fills.map(function (f) { return { x: f.x, y: f.y }; }),
        edgeKeys: self.sel.edgeKeys.slice(),
        region: self.sel.region ? self.sel.region.slice() : null
      };
    };

    function pickAnchor(pos) {
      var tol = pickTol();
      var best = null, bestD = tol;
      app.doc.edges.forEach(function (e) {
        [[e.ax, e.ay], [e.bx, e.by]].forEach(function (p) {
          var d = Math.hypot(p[0] - pos.x, p[1] - pos.y);
          if (d < bestD) { bestD = d; best = { x: p[0], y: p[1] }; }
        });
      });
      return best;
    }
    function pickEdge(pos) {
      var tol = pickTol();
      var best = -1, bestD = tol;
      app.doc.edges.forEach(function (e, i) {
        var d = VB.geom.distToEdge(e, pos.x, pos.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }

    function cursorFor(pos) {
      if (fillSelected(pos)) return CURSORS.move;
      if (pickAnchor(pos)) return CURSORS.vertex;
      if (pickEdge(pos) >= 0) return CURSORS.curve;
      if (VB.geom.fillAt(app.doc, pos.x, pos.y) > 0) return CURSORS.move;
      return CURSORS.marquee;
    }

    self.onHover = function (pos) {
      if (app.setCursor) app.setCursor(cursorFor(pos));
    };

    function fillSelected(pos) {
      return self.sel.fills.some(function (f) {
        var all = [];
        f.loops.forEach(function (l) { l.forEach(function (e) { all.push(e); }); });
        return VB.geom.windingNumber(all, pos.x, pos.y) !== 0;
      });
    }

    function addFillToSel(pos) {
      var picked = faceLoopsAt(app.doc, pos.x, pos.y);
      if (!picked) return false;
      self.sel.fills.push({ x: pos.x, y: pos.y, loops: picked.loops, face: picked.face });
      return true;
    }

    function insideRegionSel(pos) {
      if (!self.sel.region) return false;
      var loop = polyLoop(self.sel.region);
      return VB.geom.windingNumber(loop, pos.x, pos.y) !== 0;
    }

    self.onDown = function (pos, ev) {
      var shift = !!(ev && ev.shiftKey);
      // press inside the floating chunk: keep dragging it
      if (self.float) {
        var floop = polyLoop(self.float.points);
        if (VB.geom.windingNumber(floop, pos.x, pos.y) !== 0) {
          self.drag = { kind: "moveFloat", from: pos, cur: pos, moved: false };
          return;
        }
        // clicked away: the move gesture is over — merge, then handle
        // this press normally
        self.commitFloat();
      }
      // press inside an active region selection: LIFT it (first drag)
      if (insideRegionSel(pos)) {
        self.drag = { kind: "moveRegion", from: pos, cur: pos, moved: false,
                      points: self.sel.region };
        return;
      }
      var ei = pickEdge(pos);
      var overSelFill = fillSelected(pos);
      var overSelEdge = ei >= 0 &&
        self.sel.edgeKeys.indexOf(edgeKey(app.doc.edges[ei])) >= 0;

      // Press on an already-selected item arms a SELECTION MOVE.
      if (!shift && (overSelFill || overSelEdge)) {
        self.drag = { kind: "moveSel", from: pos, cur: pos, moved: false,
                      items: self.exportSelection(),
                      ghosts: selGhostEdges() };
        return;
      }
      var anchor = pickAnchor(pos);
      if (anchor) {
        if (!shift) self.clearSelection();
        self.drag = { kind: "node", from: anchor, cur: pos };
        app.requestRender();
        return;
      }
      if (ei >= 0) {
        var e = app.doc.edges[ei];
        if (shift) {
          var k = edgeKey(e);
          var at = self.sel.edgeKeys.indexOf(k);
          if (at >= 0) self.sel.edgeKeys.splice(at, 1);
          else self.sel.edgeKeys.push(k);
          app.requestRender();
          return;
        }
        var q = VB.geom.nearestOnEdge(e, pos.x, pos.y);
        self.drag = { kind: "edge", key: edgeKey(e), edge: e, t: q.t,
                      cur: pos, moved: false };
        return;
      }
      var fillIdx = VB.geom.fillAt(app.doc, pos.x, pos.y);
      if (fillIdx > 0) {
        if (!shift) self.clearSelection();
        if (addFillToSel(pos)) {
          self.drag = shift ? null
            : { kind: "moveSel", from: pos, cur: pos, moved: false,
                items: self.exportSelection(), ghosts: selGhostEdges() };
          app.requestRender();
          return;
        }
      }
      if (!shift) self.clearSelection();
      // empty canvas: rubber-band marquee
      self.drag = { kind: "marquee", from: pos, cur: pos, moved: false };
      app.requestRender();
    };

    // Double-click: on a stroke, select ALL attached strokes; on a fill,
    // the face plus its outline strokes.
    self.onDblClick = function (pos) {
      var ei = pickEdge(pos);
      if (ei >= 0 && app.doc.edges[ei].line > 0) {
        self.sel = { fills: [], edgeKeys: VB.connectedStrokeKeys(app.doc, ei) };
        app.setMsg(self.sel.edgeKeys.length + " attached stroke records selected");
        app.requestRender();
        return;
      }
      var fillIdx = VB.geom.fillAt(app.doc, pos.x, pos.y);
      if (fillIdx > 0) {
        self.clearSelection();
        var picked = faceLoopsAt(app.doc, pos.x, pos.y);
        if (picked) {
          self.sel.fills.push({ x: pos.x, y: pos.y, loops: picked.loops });
          [picked.face.outer].concat(picked.face.holes).forEach(function (cyc) {
            cyc.forEach(function (h) {
              var e = app.doc.edges[h.edge];
              if (e.line > 0) {
                var k = edgeKey(e);
                if (self.sel.edgeKeys.indexOf(k) < 0) self.sel.edgeKeys.push(k);
              }
            });
          });
        }
        app.requestRender();
      }
    };

    function selGhostEdges() {
      var out = [];
      self.sel.fills.forEach(function (f) {
        f.loops.forEach(function (l) { l.forEach(function (e) { out.push(e); }); });
      });
      self.sel.edgeKeys.forEach(function (k) {
        var i = findByKey(app.doc, k);
        if (i >= 0) out.push(app.doc.edges[i]);
      });
      return out;
    }

    self.onMove = function (pos) {
      if (!self.drag) return;
      self.drag.cur = pos;
      var d0 = self.drag.from || VB.geom.evalEdge(self.drag.edge, self.drag.t);
      if (Math.hypot(pos.x - d0.x, pos.y - d0.y) > 8) self.drag.moved = true;
      app.requestRender();
    };

    self.onUp = function (pos) {
      var drag = self.drag;
      self.drag = null;
      if (!drag) return;
      pos = pos || drag.cur;

      if (drag.kind === "node") {
        if (Math.hypot(pos.x - drag.from.x, pos.y - drag.from.y) > 8) {
          app.record({ op: "moveNode", x: drag.from.x, y: drag.from.y,
                       nx: Math.round(pos.x), ny: Math.round(pos.y) });
          app.history.push(app.doc);
          arrowMoveNode(app.doc, drag.from.x, drag.from.y, pos.x, pos.y);
          self.clearSelection();
          app.docChanged();
          app.setMsg("node moved");
        }
        return;
      }
      if (drag.kind === "edge") {
        if (drag.moved) {
          app.record({ op: "reshape", key: drag.key, t: drag.t,
                       x: Math.round(pos.x), y: Math.round(pos.y) });
          app.history.push(app.doc);
          arrowReshape(app.doc, drag.key, drag.t, pos.x, pos.y);
          self.clearSelection();
          app.docChanged();
          app.setMsg("edge reshaped");
        } else {
          var idx = findByKey(app.doc, drag.key);
          self.sel = { fills: [], edgeKeys: idx >= 0 ? [drag.key] : [] };
          if (idx >= 0 && app.onEdgeSelected) app.onEdgeSelected(idx);
          app.requestRender();
        }
        return;
      }
      if (drag.kind === "marquee") {
        if (drag.moved) {
          var x0 = Math.min(drag.from.x, pos.x), x1 = Math.max(drag.from.x, pos.x);
          var y0 = Math.min(drag.from.y, pos.y), y1 = Math.max(drag.from.y, pos.y);
          self.setRegionSelection([
            { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }
          ]);
          app.setMsg("region selected — drag to move, Delete to erase, Q to transform");
        }
        app.requestRender();
        return;
      }
      if (drag.kind === "moveRegion") {
        if (!drag.moved) { app.requestRender(); return; }
        // FIRST drag of the gesture: lift the clip OUT of the document.
        // No journal op and no union yet — the chunk floats until the
        // user clicks away (avoids premature unioning across nudges).
        var rdx = Math.round(pos.x - drag.from.x);
        var rdy = Math.round(pos.y - drag.from.y);
        app.history.push(app.doc); // undo point for the whole gesture
        var lifted = regionLift(app.doc, drag.points);
        if (lifted.edges.length === 0) {
          app.history.undoStack.pop();
          self.clearSelection();
          app.requestRender();
          return;
        }
        regionDelete(app.doc, drag.points);
        self.float = {
          origin: drag.points,
          doc: lifted,
          dx: rdx, dy: rdy,
          points: drag.points.map(function (q) {
            return { x: q.x + rdx, y: q.y + rdy };
          })
        };
        self.sel = { fills: [], edgeKeys: [], region: null };
        app.requestRender();
        app.setMsg("selection floating — drag to keep moving, click away to merge, Delete to discard");
        return;
      }
      if (drag.kind === "moveFloat") {
        if (!drag.moved || !self.float) { app.requestRender(); return; }
        var fdx = Math.round(pos.x - drag.from.x);
        var fdy = Math.round(pos.y - drag.from.y);
        self.float.dx += fdx;
        self.float.dy += fdy;
        self.float.points = self.float.points.map(function (q) {
          return { x: q.x + fdx, y: q.y + fdy };
        });
        app.requestRender();
        return;
      }
      if (drag.kind === "moveSel") {
        if (!drag.moved) { app.requestRender(); return; }
        var dx = Math.round(pos.x - drag.from.x);
        var dy = Math.round(pos.y - drag.from.y);
        var m = [1, 0, 0, 1, dx, dy];
        app.record({ op: "transformSel", fills: drag.items.fills,
                     edgeKeys: drag.items.edgeKeys, m: m });
        app.history.push(app.doc);
        arrowTransformSel(app.doc, drag.items.fills, drag.items.edgeKeys, m);
        self.clearSelection();
        app.docChanged();
        app.setMsg("selection moved");
      }
    };

    self.onDeleteKey = function () {
      if (self.float) {
        // the content is already lifted out of the doc; recording the
        // deletion of the ORIGIN reproduces this state on replay
        var fl = self.float;
        self.float = null;
        app.record({ op: "regionDelete", points: fl.origin });
        self.clearSelection();
        app.docChanged();
        app.setMsg("floating selection discarded");
        return true;
      }
      if (selEmpty()) return false;
      if (self.sel.region) {
        var pts = self.sel.region;
        app.record({ op: "regionDelete", points: pts });
        app.history.push(app.doc);
        regionDelete(app.doc, pts);
        self.clearSelection();
        app.docChanged();
        app.setMsg("region erased");
        return true;
      }
      var items = self.exportSelection();
      app.record({ op: "deleteSel", fills: items.fills, edgeKeys: items.edgeKeys });
      app.history.push(app.doc);
      arrowDeleteSel(app.doc, items.fills, items.edgeKeys);
      self.clearSelection();
      app.docChanged();
      app.setMsg("selection deleted");
      return true;
    };

    self.cancel = function () { self.drag = null; app.requestRender(); };

    function strokeEdges(ctx, edges, dx, dy) {
      ctx.beginPath();
      edges.forEach(function (e) {
        ctx.moveTo(e.ax + dx, e.ay + dy);
        if (e.cx === null) ctx.lineTo(e.bx + dx, e.by + dy);
        else ctx.quadraticCurveTo(e.cx + dx, e.cy + dy, e.bx + dx, e.by + dy);
      });
      ctx.stroke();
    }

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
      if (self.sel.fills.length) {
        ctx.save();
        ctx.fillStyle = hatchPattern(ctx);
        self.sel.fills.forEach(function (f) {
          ctx.beginPath();
          f.loops.forEach(function (l) {
            l.forEach(function (e, i2) {
              if (i2 === 0) ctx.moveTo(e.ax, e.ay);
              if (e.cx === null) ctx.lineTo(e.bx, e.by);
              else ctx.quadraticCurveTo(e.cx, e.cy, e.bx, e.by);
            });
            ctx.closePath();
          });
          ctx.fill("evenodd");
        });
        ctx.restore();
      }
      if (self.sel.edgeKeys.length) {
        ctx.strokeStyle = "rgba(0,160,255,0.9)";
        ctx.lineWidth = 3 * hair;
        var edges = [];
        self.sel.edgeKeys.forEach(function (k) {
          var i2 = findByKey(app.doc, k);
          if (i2 >= 0) edges.push(app.doc.edges[i2]);
        });
        strokeEdges(ctx, edges, 0, 0);
      }
      if (self.float) {
        // the floating chunk renders here (it no longer exists in the doc)
        var fl = self.float;
        var extraX = 0, extraY = 0;
        if (self.drag && self.drag.kind === "moveFloat" && self.drag.moved) {
          extraX = self.drag.cur.x - self.drag.from.x;
          extraY = self.drag.cur.y - self.drag.from.y;
        }
        ctx.save();
        ctx.translate(fl.dx + extraX, fl.dy + extraY);
        var fillPaths = VB.buildFillPaths(fl.doc);
        for (var fi2 = 1; fi2 < fillPaths.length; fi2++) {
          var st = fl.doc.fills[fi2 - 1];
          if (!st) continue;
          ctx.beginPath();
          fillPaths[fi2].forEach(function (chain) {
            ctx.moveTo(chain.sx, chain.sy);
            chain.pts.forEach(function (q) { ctx.lineTo(q.x, q.y); });
            ctx.closePath();
          });
          ctx.fillStyle = "rgba(" + st.color.r + "," + st.color.g + "," +
            st.color.b + "," + (st.color.a / 255) + ")";
          ctx.fill("evenodd");
        }
        fl.doc.edges.forEach(function (e) {
          if (e.line === 0) return;
          var ls = fl.doc.lines[e.line - 1];
          ctx.beginPath();
          ctx.moveTo(e.ax, e.ay);
          if (e.cx === null) ctx.lineTo(e.bx, e.by);
          else ctx.quadraticCurveTo(e.cx, e.cy, e.bx, e.by);
          ctx.strokeStyle = "rgba(" + ls.color.r + "," + ls.color.g + "," +
            ls.color.b + "," + (ls.color.a / 255) + ")";
          ctx.lineWidth = Math.max(ls.width, hair);
          ctx.lineCap = "round";
          ctx.stroke();
        });
        ctx.restore();
        ctx.strokeStyle = "rgba(0,160,255,0.9)";
        ctx.lineWidth = 1.5 * hair;
        ctx.setLineDash([6 * hair, 4 * hair]);
        ctx.beginPath();
        fl.points.forEach(function (p, i2) {
          var px2 = p.x + extraX, py2 = p.y + extraY;
          if (i2 === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (self.sel.region) {
        ctx.strokeStyle = "rgba(0,160,255,0.9)";
        ctx.lineWidth = 1.5 * hair;
        ctx.setLineDash([6 * hair, 4 * hair]);
        ctx.beginPath();
        self.sel.region.forEach(function (p, i2) {
          if (i2 === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (!self.drag || !self.drag.moved) return;
      ctx.strokeStyle = "rgba(255,120,0,0.9)";
      ctx.lineWidth = 2 * hair;
      if (self.drag.kind === "marquee") {
        ctx.setLineDash([6 * hair, 4 * hair]);
        ctx.strokeRect(Math.min(self.drag.from.x, self.drag.cur.x),
                       Math.min(self.drag.from.y, self.drag.cur.y),
                       Math.abs(self.drag.cur.x - self.drag.from.x),
                       Math.abs(self.drag.cur.y - self.drag.from.y));
        ctx.setLineDash([]);
      } else if (self.drag.kind === "moveRegion") {
        var rdx2 = self.drag.cur.x - self.drag.from.x;
        var rdy2 = self.drag.cur.y - self.drag.from.y;
        ctx.beginPath();
        self.drag.points.forEach(function (p, i2) {
          if (i2 === 0) ctx.moveTo(p.x + rdx2, p.y + rdy2);
          else ctx.lineTo(p.x + rdx2, p.y + rdy2);
        });
        ctx.closePath();
        ctx.stroke();
      } else if (self.drag.kind === "moveSel") {
        var dx = self.drag.cur.x - self.drag.from.x;
        var dy = self.drag.cur.y - self.drag.from.y;
        strokeEdges(ctx, self.drag.ghosts, dx, dy);
      } else if (self.drag.kind === "edge") {
        var e2 = self.drag.edge;
        var t = Math.min(0.8, Math.max(0.2, self.drag.t));
        var u = 1 - t;
        var cx = (self.drag.cur.x - u * u * e2.ax - t * t * e2.bx) / (2 * t * u);
        var cy = (self.drag.cur.y - u * u * e2.ay - t * t * e2.by) / (2 * t * u);
        ctx.beginPath();
        ctx.moveTo(e2.ax, e2.ay);
        ctx.quadraticCurveTo(cx, cy, e2.bx, e2.by);
        ctx.stroke();
      } else if (self.drag.kind === "node") {
        ctx.beginPath();
        ctx.arc(self.drag.cur.x, self.drag.cur.y, 4 * hair, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    return self;
  }

  window.VB = window.VB || {};
  VB.ArrowTool = ArrowTool;
  VB.arrowReshape = arrowReshape;
  VB.arrowMoveNode = arrowMoveNode;
  VB.arrowMoveFill = arrowMoveFill;
  VB.arrowDeleteFill = arrowDeleteFill;
  VB.arrowDeleteEdge = arrowDeleteEdge;
  VB.arrowDeleteSel = arrowDeleteSel;
  VB.arrowTransformSel = arrowTransformSel;
  VB.connectedStrokeKeys = connectedStrokeKeys;
  VB.regionLift = regionLift;
  VB.regionDelete = regionDelete;
  VB.regionTransform = regionTransform;
  VB.regionPolyLoop = polyLoop;
  VB.regionMergeLifted = mergeLifted;
  VB.arrowEdgeKey = edgeKey;
})();
