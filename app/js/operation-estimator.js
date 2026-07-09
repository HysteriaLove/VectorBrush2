/* operation-estimator.js — deterministic preflight/postcommit profiles
 * for every operation (docs/OperationEstimator.md).
 *
 * Estimates are ANALYTIC: pure functions of the document, the op
 * params, material profiles and areas — never wall-clock, never
 * device-dependent. Same document + same op = same numbers on every
 * machine, so profiles can ride inside exported journals and be pinned
 * by tests. Areas are DOCUMENT-space megapixels (twips/20, at 1×) so
 * estimates do not vary with the window; only the synthetic
 * `renderFrame` op is inherently view-shaped and still uses doc space
 * as its reference frame.
 *
 * The estimator never mutates anything and must stay cheaper than the
 * operations it describes (one O(E) bbox scan is the ceiling).
 */
(function () {
  "use strict";

  var VERSION = 1;

  // ---- shared helpers -------------------------------------------------------

  function edgeBBoxOverlaps(e, bb) {
    var xmin = Math.min(e.ax, e.bx), xmax = Math.max(e.ax, e.bx);
    var ymin = Math.min(e.ay, e.by), ymax = Math.max(e.ay, e.by);
    if (e.cx !== null) {
      xmin = Math.min(xmin, e.cx); xmax = Math.max(xmax, e.cx);
      ymin = Math.min(ymin, e.cy); ymax = Math.max(ymax, e.cy);
    }
    return xmin <= bb.xmax && xmax >= bb.xmin &&
           ymin <= bb.ymax && ymax >= bb.ymin;
  }

  function bboxOfPoints(pts, pad) {
    if (!pts || !pts.length) return null;
    var bb = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < bb.xmin) bb.xmin = pts[i].x;
      if (pts[i].x > bb.xmax) bb.xmax = pts[i].x;
      if (pts[i].y < bb.ymin) bb.ymin = pts[i].y;
      if (pts[i].y > bb.ymax) bb.ymax = pts[i].y;
    }
    pad = pad || 0;
    bb.xmin -= pad; bb.ymin -= pad; bb.xmax += pad; bb.ymax += pad;
    return bb;
  }

  function bboxMpx(bb) {
    if (!bb) return 0;
    var wpx = Math.max(0, bb.xmax - bb.xmin) / VB.TWIPS;
    var hpx = Math.max(0, bb.ymax - bb.ymin) / VB.TWIPS;
    // rounded to a millionth of a megapixel: stable across replays
    return Math.round(wpx * hpx) / 1e6;
  }

  /** Affected bbox of a journal op, in twips (null when the op has no
   *  spatial footprint — style edits, undo, layer ops). */
  function estimateOpBBox(op) {
    switch (op.op) {
      case "pencil": return bboxOfPoints(op.points, (op.style && op.style.width || 0) / 2 + 80);
      case "brush": return bboxOfPoints(op.points, (op.radius || 0) + 40);
      case "erase": return bboxOfPoints(op.points, (op.radius || 0) + 40);
      case "line": return bboxOfPoints([op.a, op.b], (op.style && op.style.width || 0) / 2 + 80);
      case "rect": case "oval":
        return { xmin: Math.min(op.x0, op.x1), ymin: Math.min(op.y0, op.y1),
                 xmax: Math.max(op.x0, op.x1), ymax: Math.max(op.y0, op.y1) };
      case "bucket": return { xmin: op.x - 20, ymin: op.y - 20,
                              xmax: op.x + 20, ymax: op.y + 20 };
      case "regionTransform": case "regionDelete":
        return bboxOfPoints(op.points, 40);
      case "paste": {
        if (!op.clip || !op.clip.edges || !op.clip.edges.length) return null;
        var bb = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
        op.clip.edges.forEach(function (e) {
          [[e.ax, e.ay], [e.bx, e.by]].concat(
            e.cx === null ? [] : [[e.cx, e.cy]]).forEach(function (p) {
            var x = p[0], y = p[1];
            if (op.m) {
              var tx2 = op.m[0] * x + op.m[2] * y + op.m[4];
              y = op.m[1] * x + op.m[3] * y + op.m[5];
              x = tx2;
            }
            if (x < bb.xmin) bb.xmin = x; if (x > bb.xmax) bb.xmax = x;
            if (y < bb.ymin) bb.ymin = y; if (y > bb.ymax) bb.ymax = y;
          });
        });
        return bb;
      }
      default: return null;
    }
  }

  /** Candidate existing edges whose bbox overlaps the op bbox — the
   *  `B` symbol. One O(E) pass, the estimator's cost ceiling. */
  function estimateCandidateEdges(doc, bb) {
    if (!bb) return 0;
    var n = 0;
    for (var i = 0; i < doc.edges.length; i++) {
      if (edgeBBoxOverlaps(doc.edges[i], bb)) n++;
    }
    return n;
  }

  /** Material paint cost over a bbox: perPx × area, buffers, passes —
   *  delegates the formulas to VB.materialProfile (never duplicated). */
  function estimateMaterialPaint(style, bb) {
    var M = VB.materialProfile(style);
    var A = bboxMpx(bb);
    return {
      paintPxOps: Math.round(M.perPx * A * 1e6),
      textureBytes: Math.round(M.texBytesPerMpx * A),
      gpuPasses: M.gpu ? M.passes.length : 0,
      profile: M,
      areaMpx: A
    };
  }

  /** The documented score fold — a debug sorting scalar, not a time. */
  function operationScore(t) {
    return t.cpuUnits +
      t.paintPxOps +
      t.gpuPasses * 5000 +
      Math.ceil(t.textureBytes / 1024) +
      t.recordBits +
      t.allocations * 1000;
  }

  function scoreLevel(score) {
    if (score < 50000) return "ok";
    if (score < 250000) return "watch";
    if (score < 1000000) return "warn";
    return "hot";
  }

  // ---- profile assembly -----------------------------------------------------

  function Builder(kind, label, doc, bb) {
    var b = {
      profile: {
        kind: kind, label: label, version: VERSION,
        deterministic: true, confidence: "preflight",
        scope: {
          edgesBefore: doc.edges.length,
          candidateEdges: 0,
          fills: doc.fills.length,
          lines: doc.lines.length,
          bboxTw: bb || null,
          bboxMpx: bboxMpx(bb)
        },
        totals: { score: 0, cpuUnits: 0, paintPxOps: 0, gpuPasses: 0,
                  textureBytes: 0, recordBits: 0, allocations: 0 },
        stages: [],
        warnings: []
      },
      stage: function (name, unit, count, weight, metrics) {
        count = Math.max(0, Math.round(count));
        var s = { name: name, unit: unit, count: count, weight: weight,
                  score: Math.round(count * weight) };
        if (metrics) s.metrics = metrics;
        b.profile.stages.push(s);
        b.profile.totals.cpuUnits += s.score;
        return s;
      },
      paint: function (style, bb2) {
        var p = estimateMaterialPaint(style, bb2);
        b.profile.totals.paintPxOps += p.paintPxOps;
        b.profile.totals.textureBytes += p.textureBytes;
        b.profile.totals.gpuPasses += p.gpuPasses;
        b.profile.stages.push({
          name: "material paint (" + p.profile.label + ")",
          unit: "px-op", count: p.paintPxOps, weight: 1,
          score: p.paintPxOps,
          metrics: { areaMpx: p.areaMpx, textureBytes: p.textureBytes }
        });
        return p;
      },
      alloc: function (n) { b.profile.totals.allocations += n; },
      bits: function (n) { b.profile.totals.recordBits += Math.round(n); },
      warn: function (level, code, text) {
        b.profile.warnings.push({ level: level, code: code, text: text });
      },
      done: function () {
        b.profile.totals.score = operationScore(b.profile.totals);
        b.profile.level = scoreLevel(b.profile.totals.score);
        return b.profile;
      }
    };
    return b;
  }

  function commonWarnings(b, doc, B, G) {
    var E = Math.max(doc.edges.length, 1);
    if (B / E > 0.35 && doc.edges.length > 40) {
      b.warn("warn", "large-candidate-set",
        "candidate edges cover " + Math.round(100 * B / E) + "% of the document");
    }
    if (G !== undefined && G * B > 100000) {
      b.warn("warn", "candidate-explosion",
        "estimated pair tests " + (G * B));
    }
  }

  // ---- per-op estimators ----------------------------------------------------
  // Stage names/weights mirror the tables in docs/OperationEstimator.md.

  var ESTIMATORS = {
    pencil: function (doc, op) {
      var P = (op.points || []).length;
      var bb = estimateOpBBox(op);
      var B = estimateCandidateEdges(doc, bb);
      var G = Math.max(2, Math.ceil(P * 0.5)); // fitted records
      var b = Builder("pencil", "pencil stroke", doc, bb);
      b.profile.scope.candidateEdges = B;
      b.stage("capture samples", "point", P, 1);
      b.stage("fit stroke", "point", P, 6);
      b.stage("add line style", "style", 1, 20);
      b.stage("candidate edge scan", "edge", doc.edges.length, 1);
      b.stage("node/merge stroke", "pair-test", G * B, 4,
              { fittedG: G, candidateEdges: B });
      b.bits(G * 40);
      if (P > 512) b.warn("warn", "many-pointer-samples", P + " pointer samples");
      commonWarnings(b, doc, B, G);
      return b.done();
    },

    line: function (doc, op) {
      var bb = estimateOpBBox(op);
      var B = estimateCandidateEdges(doc, bb);
      var b = Builder("line", "line", doc, bb);
      b.profile.scope.candidateEdges = B;
      b.stage("capture samples", "point", 2, 1);
      b.stage("fit stroke", "point", 2, 6);
      b.stage("add line style", "style", 1, 20);
      b.stage("candidate edge scan", "edge", doc.edges.length, 1);
      b.stage("node/merge stroke", "pair-test", 1 * B, 4);
      b.bits(40);
      commonWarnings(b, doc, B, 1);
      return b.done();
    },

    brush: function (doc, op) {
      var P = (op.points || []).length;
      var bb = estimateOpBBox(op);
      var B = estimateCandidateEdges(doc, bb);
      // documented preflight defaults
      var G = Math.max(8, Math.ceil(P * 0.75));
      var F = Math.max(1, Math.ceil(B / 3));
      var C = Math.max(G, B);
      var b = Builder("brush", "brush stroke", doc, bb);
      b.profile.scope.candidateEdges = B;
      b.stage("build swath path", "point", P, 2);
      b.stage("capsule union", "point", P, 20);
      b.stage("fit swept outline", "record", G, 12);
      b.stage("snapshot pre-op doc", "edge", doc.edges.length, 2);
      b.alloc(1); // the pre-op copy
      b.stage("adopt identical edges", "edge", G + B, 4);
      b.stage("node boundary", "pair-test", G * B, 4,
              { boundaryEdges: G, candidateEdges: B });
      b.stage("face mask walk", "half-edge", F + C, 10,
              { faces: F, cycleHalfEdges: C });
      b.alloc(1); // the face graph
      b.stage("dissolve submerged edges", "edge", B, 3);
      b.paint({ type: "solid", color: op.color }, bb);
      b.bits(G * 40);
      var pathBB = bboxOfPoints(op.points, 0);
      if (pathBB && bb && bboxMpx(bb) > 4 * Math.max(bboxMpx(pathBB), 0.0001)) {
        b.warn("info", "wide-brush", "radius dominates the stroke bbox");
      }
      if (P > 256) b.warn("warn", "boolean-heavy", P + " capsule samples");
      commonWarnings(b, doc, B, G);
      return b.done();
    },

    erase: function (doc, op) {
      var P = (op.points || []).length;
      var bb = estimateOpBBox(op);
      var B = estimateCandidateEdges(doc, bb);
      var G = Math.max(8, Math.ceil(P * 0.75));
      var F = Math.max(1, Math.ceil(B / 3));
      var C = Math.max(G, B);
      var b = Builder("erase", "eraser stroke", doc, bb);
      b.profile.scope.candidateEdges = B;
      b.stage("build swath path", "point", P, 2);
      b.stage("capsule union", "point", P, 20);
      b.stage("fit swept outline", "record", G, 12);
      b.stage("snapshot pre-op doc", "edge", doc.edges.length, 2);
      b.alloc(1);
      b.stage("adopt identical edges", "edge", G + B, 4);
      b.stage("node boundary", "pair-test", G * B, 4,
              { boundaryEdges: G, candidateEdges: B });
      b.stage("face mask walk", "half-edge", F + C, 10);
      b.alloc(1);
      b.stage("dissolve submerged edges", "edge", B, 3);
      // no material paint: the output is emptiness
      if (B === 0 && op.points && op.points.length &&
          VB.geom.fillAt(doc, op.points[0].x, op.points[0].y) === 0 &&
          VB.geom.fillAt(doc, op.points[P - 1].x, op.points[P - 1].y) === 0) {
        b.warn("info", "blank-erase", "estimated no-op (blank space)");
      }
      commonWarnings(b, doc, B, G);
      return b.done();
    },

    bucket: function (doc, op) {
      var bb = estimateOpBBox(op);
      var B = estimateCandidateEdges(doc, bb);
      var C = Math.max(B, 4); // stamped cycle guess: local boundary size
      var b = Builder("bucket", "bucket fill", doc, bb);
      b.profile.scope.candidateEdges = B;
      b.stage("point face query", "edge", doc.edges.length, 4);
      b.stage("stamp outer cycle + holes", "half-edge", C, 2);
      b.stage("dissolve borders", "edge", doc.edges.length, 1);
      b.paint({ type: "solid", color: op.color },
              bb && doc.edges.length ? {
                xmin: 0, ymin: 0, xmax: doc.width, ymax: doc.height
              } : bb); // face extent unknown preflight: stage bound
      return b.done();
    },

    rect: function (doc, op) { return shapeEstimate(doc, op, 4, "rect"); },
    oval: function (doc, op) { return shapeEstimate(doc, op, 8, "oval"); },

    fillStyle: function (doc, op) {
      var b = Builder("fillStyle", "material edit", doc, null);
      b.stage("clone style", "style", 1, 20);
      var sides = 0;
      for (var i = 0; i < doc.edges.length; i++) {
        if (doc.edges[i].fill0 === op.index + 1) sides++;
        if (doc.edges[i].fill1 === op.index + 1) sides++;
      }
      b.stage("affected fill references", "half-edge", sides, 1);
      b.stage("material profile", "style", 1, 1);
      if (op.style) {
        b.paint(op.style, { xmin: 0, ymin: 0, xmax: doc.width, ymax: doc.height });
      }
      // invariant: a style edit mutates zero geometry
      return b.done();
    },

    paste: function (doc, op) {
      var bb = estimateOpBBox(op);
      var B = estimateCandidateEdges(doc, bb);
      var G = op.clip && op.clip.edges ? op.clip.edges.length : 0;
      var F = Math.max(1, Math.ceil((G + B) / 3));
      var C = Math.max(G, B);
      var b = Builder("paste", "paste clip", doc, bb);
      b.profile.scope.candidateEdges = B;
      b.stage("transform clip", "edge", G, 3);
      b.stage("snapshot pre-op doc", "edge", doc.edges.length, 2);
      b.alloc(1);
      b.stage("node boundary", "pair-test", G * B, 4,
              { clipEdges: G, candidateEdges: B });
      b.stage("face mask walk", "half-edge", F + C, 10);
      b.alloc(1);
      b.stage("claim rewrite", "half-edge", 2 * (G + B), 2);
      b.bits(G * 40);
      commonWarnings(b, doc, B, G);
      return b.done();
    },

    regionTransform: function (doc, op) { return regionEstimate(doc, op, "regionTransform", true); },
    regionDelete: function (doc, op) { return regionEstimate(doc, op, "regionDelete", false); },

    transformSel: function (doc, op) { return selEstimate(doc, op, "transformSel", true); },
    deleteSel: function (doc, op) { return selEstimate(doc, op, "deleteSel", false); },
    deleteFill: function (doc, op) { return selEstimate(doc, op, "deleteFill", false); },
    deleteEdge: function (doc, op) { return selEstimate(doc, op, "deleteEdge", false); },
    moveFill: function (doc, op) { return selEstimate(doc, op, "moveFill", true); },
    moveNode: function (doc, op) { return selEstimate(doc, op, "moveNode", true); },
    reshape: function (doc, op) { return selEstimate(doc, op, "reshape", true); },

    renderFrame: function (doc) {
      var E = doc.edges.length;
      var b = Builder("renderFrame", "render frame", doc,
                      { xmin: 0, ymin: 0, xmax: doc.width, ymax: doc.height });
      b.stage("build fill paths", "edge", E, 3);
      b.stage("build stroke paths", "edge", E, 2);
      var stroked = 0;
      for (var i = 0; i < E; i++) if (doc.edges[i].line !== 0) stroked++;
      for (var f = 0; f < doc.fills.length; f++) {
        b.paint(doc.fills[f], { xmin: 0, ymin: 0, xmax: doc.width, ymax: doc.height });
      }
      b.stage("stroke lines", "edge", stroked, 2);
      var T = 0;
      (doc.texts || []).forEach(function (t) {
        t.records.forEach(function (r) { T += r.glyphs.length; });
      });
      b.stage("draw text", "glyph", T, 4);
      if (E > 4000) b.warn("warn", "many-render-edges", E + " edges");
      if (b.profile.totals.textureBytes > 64000000) {
        b.warn("warn", "large-gpu-bbox",
          Math.round(b.profile.totals.textureBytes / 1e6) + "MB of material buffers");
      }
      return b.done();
    },

    saveVBD: function (doc) {
      var b = Builder("saveVBD", "save .vbd", doc,
                      { xmin: 0, ymin: 0, xmax: doc.width, ymax: doc.height });
      b.stage("write records", "edge", doc.edges.length, 4);
      b.stage("material encode", "style", doc.fills.length + doc.lines.length, 4);
      var glyphs = 0;
      (doc.fonts || []).forEach(function (f) { glyphs += f.glyphs.length; });
      b.stage("font subset", "glyph", glyphs, 10);
      var stats = VB.vbdStats ? VB.vbdStats(doc) : null;
      if (stats && stats.bits) b.bits(stats.bits);
      return b.done();
    }
  };

  function shapeEstimate(doc, op, G, kind) {
    var bb = estimateOpBBox(op);
    var B = estimateCandidateEdges(doc, bb);
    var filled = !!op.fill;
    var F = Math.max(1, Math.ceil(B / 3));
    var C = Math.max(G, B);
    var b = Builder(kind, kind, doc, bb);
    b.profile.scope.candidateEdges = B;
    b.stage("fixed geometry", "record", G, 1);
    b.stage("candidate edge scan", "edge", doc.edges.length, 1);
    b.stage("node boundary", "pair-test", G * B, 4);
    if (filled) {
      b.stage("face mask walk", "half-edge", F + C, 10);
      b.alloc(2); // pre-op copy + face graph
      b.paint(op.fill.color ? { type: "solid", color: op.fill.color }
                            : op.fill, bb);
    }
    b.bits(G * 40);
    var stageBB = { xmin: 0, ymin: 0, xmax: doc.width, ymax: doc.height };
    if (bb && bboxMpx(bb) > 0.8 * bboxMpx(stageBB)) {
      b.warn("info", "stage-sized-shape", "shape covers most of the stage");
    }
    if (bb && (bb.xmax - bb.xmin < 20 || bb.ymax - bb.ymin < 20)) {
      b.warn("info", "thin-shape", "near-degenerate shape");
    }
    commonWarnings(b, doc, B, G);
    return b.done();
  }

  function regionEstimate(doc, op, kind, transforms) {
    var bb = estimateOpBBox(op);
    var B = estimateCandidateEdges(doc, bb);
    var loop = (op.points || []).length;
    var F = Math.max(1, Math.ceil(B / 3));
    var C = Math.max(loop, B);
    var b = Builder(kind, kind, doc, bb);
    b.profile.scope.candidateEdges = B;
    b.stage("hit/selection lookup", "edge", doc.edges.length, 2);
    if (transforms) b.stage("transform geometry", "edge", B, 3);
    // lift + delete + (merge): each runs a mask pass over the region
    var passes = transforms ? 3 : 1;
    b.stage("node boundary", "pair-test", loop * B * passes, 4);
    b.stage("face mask walk", "half-edge", (F + C) * passes, 10);
    b.alloc(passes); // scratch docs / face graphs per pass
    b.stage("claim rewrite", "half-edge", 2 * B, 2);
    b.bits(B * 20);
    commonWarnings(b, doc, B, loop);
    return b.done();
  }

  function selEstimate(doc, op, kind, transforms) {
    var selected = (op.fills ? op.fills.length * 8 : 0) +
                   (op.edgeKeys ? op.edgeKeys.length : 0) + 1;
    var b = Builder(kind, kind, doc, null);
    b.stage("hit/selection lookup", "edge", doc.edges.length, 2);
    if (transforms) b.stage("transform geometry", "edge", selected, 3);
    b.stage("revalidate planarity", "edge", selected * 4, 5);
    b.stage("claim rewrite", "half-edge", selected * 2, 2);
    b.bits(selected * 20);
    return b.done();
  }

  // text ops share one estimator shape
  ["textCreate", "textEdit", "textTransform", "textDelete", "textBreak",
   "textWrap", "textSize", "textBoxH"].forEach(function (kind) {
    ESTIMATORS[kind] = function (doc, op) {
      var glyphs = 0, contours = 0, records = 0;
      (op.records || []).forEach(function (r) {
        records++;
        glyphs += (r.glyphs || []).length;
      });
      if (!records && op.index != null && doc.texts && doc.texts[op.index]) {
        doc.texts[op.index].records.forEach(function (r) {
          records++;
          glyphs += r.glyphs.length;
        });
      }
      contours = glyphs * 2; // ~2 contours per glyph, deterministic guess
      var b = Builder(kind, kind, doc, null);
      b.stage("glyph lookup", "glyph", glyphs, 3);
      b.stage("contour copy", "contour", contours, 5);
      b.stage("layout advances", "glyph", glyphs, 2);
      b.stage("bbox update", "record", records, 2);
      if (kind === "textBreak") {
        b.stage("break to shapes", "contour", contours, 12);
        if (contours > 200) {
          b.warn("warn", "large-text-break",
            contours + " contours become planar geometry");
        }
      }
      b.bits(glyphs * 30);
      return b.done();
    };
  });

  // trivial ops: valid low-cost profiles, never null
  ["undo", "redo", "new", "load", "layerAdd", "layerDelete", "layerMove",
   "layerRename", "layerSelect", "layerVisible", "layerLock", "sceneAdd",
   "sceneSelect"].forEach(function (kind) {
    ESTIMATORS[kind] = function (doc) {
      var b = Builder(kind, kind, doc, null);
      b.stage("bookkeeping", "op", 1, 10);
      return b.done();
    };
  });

  // ---- entry points ----------------------------------------------------------

  /** Estimate one op. options: { phase: "preflight"|"postcommit",
   *  result?, preflight? } — postcommit merges actual mutation counts
   *  into a comparison block and re-grades the anomaly warnings. */
  function operationEstimate(ctx, op, options) {
    var doc = ctx.doc;
    var fn = ESTIMATORS[op.op];
    var profile;
    if (fn) {
      profile = fn(doc, op);
    } else {
      var b = Builder(op.op || "unknown", "unknown op", doc, null);
      b.stage("unknown", "op", 1, 10);
      b.warn("info", "unknown-op", "no estimator for " + op.op);
      profile = b.done();
      profile.deterministic = true;
    }
    if (options && options.phase === "postcommit") {
      profile.confidence = "postcommit";
      var pre = options.preflight || null;
      var res = options.result || {};
      var cmp = {};
      if (res.boundary !== undefined) cmp.actualBoundary = res.boundary;
      if (res.removed !== undefined) cmp.actualRemoved = res.removed;
      if (res.stamped !== undefined) cmp.actualStamped = res.stamped;
      if (pre) {
        cmp.estimatedScore = pre.totals.score;
        cmp.postScore = profile.totals.score;
        cmp.ratio = pre.totals.score
          ? Math.round(profile.totals.score / pre.totals.score * 100) / 100
          : 0;
        if (profile.totals.score > 2 * pre.totals.score) {
          profile.warnings.push({ level: "warn", code: "unexpected-growth",
            text: "postcommit score " + cmp.ratio + "× preflight" });
        }
        var changed = (res.boundary || 0) + (res.removed || 0) + (res.stamped || 0);
        if (pre.totals.score >= 50000 && res &&
            ("boundary" in res || "removed" in res || "stamped" in res) &&
            changed === 0) {
          profile.warnings.push({ level: "warn", code: "unexpected-noop",
            text: "preflight predicted work, nothing changed" });
        }
      }
      profile.comparison = cmp;
    }
    return profile;
  }

  window.VB = window.VB || {};
  VB.operationEstimate = operationEstimate;
  VB.estimateOpBBox = estimateOpBBox;
  VB.estimateCandidateEdges = estimateCandidateEdges;
  VB.estimateMaterialPaint = estimateMaterialPaint;
  VB.operationScore = operationScore;
  VB.operationScoreLevel = scoreLevel;
})();
