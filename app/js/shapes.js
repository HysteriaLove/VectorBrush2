/* shapes.js — Flash's geometric primitives: Line (N), Oval (O),
 * Rectangle (R).
 *
 * Flash MX 2004 semantics:
 *   - a FILLED shape replaces everything beneath its interior (same
 *     planar paint-over as the brush) and its outline becomes stroke
 *     edges carrying the fill on the inside — so the filled-shape path
 *     is the brush's boolean-mask pipeline with the shape loop as the
 *     region and the line style stamped on the fence;
 *   - a STROKE-ONLY shape just merges its outline into the map like a
 *     pencil stroke (crossing edges split, fills inherited);
 *   - the line tool is a one-segment pencil stroke with endpoint
 *     snapping.
 *
 * Records stay Flash-lean by construction: an oval is 8 quads, a
 * rectangle 4 records. Lineless boundary records use the all-quad
 * convention (control at the midpoint) so straightness stays reserved
 * for the phantom-chord tripwire.
 */
(function () {
  "use strict";

  var SNAP_TOL = 55; // twips: endpoint snapping for the line tool

  // ---- geometry builders -----------------------------------------------------

  // Closed ellipse loop: 8 quadratic arcs. The control point of an arc
  // spanning half-angle h sits at the arc's mid-angle, radially scaled
  // by 1/cos(h) — exact tangency at both anchors.
  function ellipseLoop(cx, cy, rx, ry) {
    var geoms = [];
    var K = 1 / Math.cos(Math.PI / 8); // 22.5°
    var prev = null, first = null;
    for (var i = 0; i < 8; i++) {
      var a0 = (Math.PI / 4) * i;
      var am = a0 + Math.PI / 8;
      var a1 = a0 + Math.PI / 4;
      var p0 = prev || {
        x: Math.round(cx + rx * Math.cos(a0)),
        y: Math.round(cy + ry * Math.sin(a0))
      };
      var p1 = { x: Math.round(cx + rx * Math.cos(a1)), y: Math.round(cy + ry * Math.sin(a1)) };
      var c = {
        x: Math.round(cx + rx * K * Math.cos(am)),
        y: Math.round(cy + ry * K * Math.sin(am))
      };
      if (!first) first = p0;
      geoms.push({ ax: p0.x, ay: p0.y, cx: c.x, cy: c.y, bx: p1.x, by: p1.y });
      prev = p1;
    }
    geoms[geoms.length - 1].bx = first.x; // exact closure
    geoms[geoms.length - 1].by = first.y;
    return geoms;
  }

  function rectLoop(x0, y0, x1, y1) {
    return [
      { ax: x0, ay: y0, cx: null, cy: null, bx: x1, by: y0 },
      { ax: x1, ay: y0, cx: null, cy: null, bx: x1, by: y1 },
      { ax: x1, ay: y1, cx: null, cy: null, bx: x0, by: y1 },
      { ax: x0, ay: y1, cx: null, cy: null, bx: x0, by: y0 }
    ];
  }

  // ---- commit ------------------------------------------------------------------

  /**
   * Insert a closed shape loop into the planar map.
   *  geoms:     closed loop, integer twips
   *  fillColor: {r,g,b,a} or null (stroke-only shape)
   *  lineStyle: {width, color} or null (fill-only shape)
   * Returns the number of boundary records contributed.
   */
  function shapeCommit(doc, geoms, fillColor, lineStyle) {
    if (!fillColor && !lineStyle) return 0;
    var lineIdx = lineStyle ? doc.addLineStyle({
      width: lineStyle.width,
      color: {
        r: lineStyle.color.r, g: lineStyle.color.g,
        b: lineStyle.color.b, a: lineStyle.color.a
      }
    }) : 0;

    if (!fillColor) {
      // Stroke-only: plain planar merge, like a closed pencil stroke.
      return VB.mergeStroke(doc, geoms, lineIdx, 0);
    }

    // fillColor may be a full 2DMaterial style (anything with a .type)
    var fillIdx = doc.addFillStyle(fillColor.type
      ? JSON.parse(JSON.stringify(fillColor))
      : { type: "solid",
          color: { r: fillColor.r, g: fillColor.g,
                   b: fillColor.b, a: fillColor.a } });

    // The shape boundary as edges. Lineless straight runs become quads
    // with the control at the midpoint (all-quad convention).
    var fitted = [];
    geoms.forEach(function (g) {
      var cx = g.cx, cy = g.cy;
      if (cx === null && lineIdx === 0) {
        cx = Math.round((g.ax + g.bx) / 2);
        cy = Math.round((g.ay + g.by) / 2);
      }
      var fe = VB.edge(g.ax, g.ay, cx, cy, g.bx, g.by, 0, 0, lineIdx);
      if (!VB.edgeIsDegenerate(fe)) fitted.push(fe);
    });
    if (fitted.length === 0) return 0;

    var windingLoops = fitted.map(function (e) {
      return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
    });
    function insideShape(x, y) {
      return VB.geom.windingNumber(windingLoops, x, y) !== 0;
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

    VB.applyRegionMask(doc, preOp, insideShape, fillIdx,
                       pieces.concat(adopted.twins));
    return fitted.length;
  }

  function lineCommit(doc, a, b, style, snapTol) {
    var lineIdx = doc.addLineStyle({
      width: style.width,
      color: { r: style.color.r, g: style.color.g, b: style.color.b, a: style.color.a }
    });
    return VB.mergeStroke(doc,
      [{ ax: Math.round(a.x), ay: Math.round(a.y), cx: null, cy: null,
         bx: Math.round(b.x), by: Math.round(b.y) }],
      lineIdx, snapTol === undefined ? SNAP_TOL : snapTol);
  }

  // ---- interactive tools --------------------------------------------------------

  function dragTool(app, commitFn, previewFn) {
    return {
      app: app,
      start: null,
      cur: null,
      onDown: function (pos) { this.start = pos; this.cur = pos; },
      onMove: function (pos) {
        if (!this.start) return;
        this.cur = pos;
        app.requestRender();
      },
      onUp: function (pos) {
        if (!this.start) return;
        var a = this.start, b = pos || this.cur;
        this.start = null; this.cur = null;
        if (Math.abs(b.x - a.x) < 4 && Math.abs(b.y - a.y) < 4) {
          app.requestRender();
          return; // degenerate drag
        }
        commitFn(a, b);
        app.docChanged();
      },
      cancel: function () { this.start = null; this.cur = null; app.requestRender(); },
      drawOverlay: function (ctx) {
        if (!this.start || !this.cur) return;
        previewFn(ctx, this.start, this.cur);
      }
    };
  }

  function strokeStyleOf(app) {
    return {
      width: Math.round(app.strokeWidth), // already twips
      color: {
        r: app.strokeColor.r, g: app.strokeColor.g,
        b: app.strokeColor.b, a: app.strokeColor.a
      }
    };
  }
  function fillColorOf(app) {
    // a selected 2DMaterial IS the drawing fill; ops carry it verbatim
    if (app.fillMaterial) return VB.materialClone(app.fillMaterial);
    return {
      r: app.fillColor.r, g: app.fillColor.g,
      b: app.fillColor.b, a: app.fillColor.a
    };
  }
  function css(c, alpha) {
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + (alpha === undefined ? 1 : alpha) + ")";
  }

  function LineTool(app) {
    return dragTool(app,
      function (a, b) {
        var style = strokeStyleOf(app);
        app.record({ op: "line", a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y },
                     style: style, snapTol: SNAP_TOL });
        app.history.push(app.doc);
        var n = VB.lineCommit(app.doc, a, b, style);
        app.setMsg("line: " + n + " edges after merge");
      },
      function (ctx, a, b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = css(app.strokeColor, 0.85);
        ctx.lineWidth = Math.max(app.strokeWidth, VB.TWIPS / app.view.zoom);
        ctx.lineCap = "round";
        ctx.stroke();
      });
  }

  function OvalTool(app) {
    return dragTool(app,
      function (a, b) {
        var x0 = Math.round(Math.min(a.x, b.x)), x1 = Math.round(Math.max(a.x, b.x));
        var y0 = Math.round(Math.min(a.y, b.y)), y1 = Math.round(Math.max(a.y, b.y));
        var fill = fillColorOf(app), line = strokeStyleOf(app);
        app.record({ op: "oval", x0: x0, y0: y0, x1: x1, y1: y1, fill: fill, line: line });
        app.history.push(app.doc);
        var n = VB.shapeCommit(app.doc,
          ellipseLoop((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2),
          fill, line);
        app.setMsg("oval: " + n + " boundary records");
      },
      function (ctx, a, b) {
        ctx.beginPath();
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
          Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        ctx.fillStyle = css(app.fillColor, 0.5);
        ctx.fill();
        ctx.strokeStyle = css(app.strokeColor, 0.85);
        ctx.lineWidth = Math.max(app.strokeWidth, VB.TWIPS / app.view.zoom);
        ctx.stroke();
      });
  }

  function RectTool(app) {
    return dragTool(app,
      function (a, b) {
        var x0 = Math.round(Math.min(a.x, b.x)), x1 = Math.round(Math.max(a.x, b.x));
        var y0 = Math.round(Math.min(a.y, b.y)), y1 = Math.round(Math.max(a.y, b.y));
        var fill = fillColorOf(app), line = strokeStyleOf(app);
        app.record({ op: "rect", x0: x0, y0: y0, x1: x1, y1: y1, fill: fill, line: line });
        app.history.push(app.doc);
        var n = VB.shapeCommit(app.doc, rectLoop(x0, y0, x1, y1), fill, line);
        app.setMsg("rect: " + n + " boundary records");
      },
      function (ctx, a, b) {
        var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        ctx.fillStyle = css(app.fillColor, 0.5);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = css(app.strokeColor, 0.85);
        ctx.lineWidth = Math.max(app.strokeWidth, VB.TWIPS / app.view.zoom);
        ctx.strokeRect(x, y, w, h);
      });
  }

  window.VB = window.VB || {};
  VB.shapeCommit = shapeCommit;
  VB.lineCommit = lineCommit;
  VB.ellipseLoop = ellipseLoop;
  VB.rectLoop = rectLoop;
  VB.LineTool = LineTool;
  VB.OvalTool = OvalTool;
  VB.RectTool = RectTool;
})();
