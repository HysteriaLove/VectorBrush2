/* doc.js — the VectorBrush document model.
 *
 * A document is a Flash-style *planar edge map*, not a list of stacked
 * objects. The whole drawing is one set of edges; every edge knows which
 * fill lies on each of its two sides and which line style (if any) is
 * painted along it. This mirrors what Flash MX 2004 writes into a
 * DefineShape tag and is the model all editing tools operate on.
 *
 * Conventions (identical to SWF):
 *   - All coordinates are integer twips (20 twips = 1 px).
 *   - Style indices are 1-based; 0 means "none". fills[0] is style #1.
 *   - Edges are either straight (cx === null) or quadratic Béziers.
 *   - fill1 is the fill on the side such that walking the edge in its
 *     stored direction traces the fill's outline forward; fill0 is the
 *     fill on the opposite side (its loops are traced with the edge
 *     reversed). This is exactly Flash's FillStyle0/FillStyle1.
 */
(function () {
  "use strict";

  // ---- styles ------------------------------------------------------------

  // color: {r,g,b,a} with 0..255 components (a=255 opaque).
  function solidFill(r, g, b, a) {
    return { type: "solid", color: { r: r, g: g, b: b, a: a === undefined ? 255 : a } };
  }

  // width in twips; Flash MX default cap/join are round.
  function lineStyle(width, r, g, b, a) {
    return { width: width, color: { r: r, g: g, b: b, a: a === undefined ? 255 : a } };
  }

  // ---- edges --------------------------------------------------------------

  // Straight edge: cx/cy null. Curved edge: quadratic control point cx/cy.
  function edge(ax, ay, cx, cy, bx, by, fill0, fill1, line) {
    return {
      ax: ax, ay: ay,          // start anchor (twips)
      cx: cx, cy: cy,          // control point or null (straight)
      bx: bx, by: by,          // end anchor (twips)
      fill0: fill0 | 0,        // fill style index on the reverse side (0 = none)
      fill1: fill1 | 0,        // fill style index on the forward side (0 = none)
      line: line | 0           // line style index (0 = none)
    };
  }

  function reversedEdge(e) {
    return edge(e.bx, e.by, e.cx, e.cy, e.ax, e.ay, e.fill1, e.fill0, e.line);
  }

  function edgeIsDegenerate(e) {
    return e.ax === e.bx && e.ay === e.by &&
      (e.cx === null || (e.cx === e.ax && e.cy === e.ay));
  }

  // ---- document -----------------------------------------------------------

  function VBDocument() {
    this.width = 550 * 20;         // stage size, twips
    this.height = 400 * 20;
    this.background = { r: 255, g: 255, b: 255, a: 255 };
    this.fills = [];               // fill styles; index i is style i+1
    this.lines = [];               // line styles; index i is style i+1
    this.edges = [];               // the planar map
  }

  VBDocument.prototype.clear = function () {
    this.fills = [];
    this.lines = [];
    this.edges = [];
  };

  // Add a style, reusing an identical existing entry. Returns 1-based index.
  VBDocument.prototype.addFillStyle = function (style) {
    for (var i = 0; i < this.fills.length; i++) {
      if (sameFill(this.fills[i], style)) return i + 1;
    }
    this.fills.push(style);
    return this.fills.length;
  };

  VBDocument.prototype.addLineStyle = function (style) {
    for (var i = 0; i < this.lines.length; i++) {
      var s = this.lines[i];
      if (s.width === style.width && sameColor(s.color, style.color)) return i + 1;
    }
    this.lines.push(style);
    return this.lines.length;
  };

  // Bounds of the geometry itself (no stroke padding), in twips.
  // Returns null for an empty document.
  VBDocument.prototype.edgeBounds = function () {
    if (this.edges.length === 0) return null;
    var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      xmin = Math.min(xmin, e.ax, e.bx); xmax = Math.max(xmax, e.ax, e.bx);
      ymin = Math.min(ymin, e.ay, e.by); ymax = Math.max(ymax, e.ay, e.by);
      if (e.cx !== null) {
        // Control points of quads can bulge past anchors; using them
        // directly gives a conservative (slightly loose) bound.
        xmin = Math.min(xmin, e.cx); xmax = Math.max(xmax, e.cx);
        ymin = Math.min(ymin, e.cy); ymax = Math.max(ymax, e.cy);
      }
    }
    return { xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax };
  };

  VBDocument.prototype.stats = function () {
    var straight = 0, curved = 0;
    for (var i = 0; i < this.edges.length; i++) {
      if (this.edges[i].cx === null) straight++; else curved++;
    }
    return {
      fills: this.fills.length,
      lines: this.lines.length,
      edges: this.edges.length,
      straight: straight,
      curved: curved
    };
  };

  // Data integrity: every coordinate must be an integer twip and every
  // style index must resolve — the exact invariants that keep the document
  // bit-packable at Flash density. Returns a list of violation strings
  // (empty = valid).
  VBDocument.prototype.validate = function () {
    var bad = [];
    function isInt(v) { return typeof v === "number" && Number.isInteger(v); }
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if (!isInt(e.ax) || !isInt(e.ay) || !isInt(e.bx) || !isInt(e.by)) {
        bad.push("edge #" + i + ": non-integer anchor");
      }
      if (e.cx !== null && (!isInt(e.cx) || !isInt(e.cy))) {
        bad.push("edge #" + i + ": non-integer control");
      }
      if (!isInt(e.fill0) || e.fill0 < 0 || e.fill0 > this.fills.length) {
        bad.push("edge #" + i + ": bad fill0 " + e.fill0);
      }
      if (!isInt(e.fill1) || e.fill1 < 0 || e.fill1 > this.fills.length) {
        bad.push("edge #" + i + ": bad fill1 " + e.fill1);
      }
      if (!isInt(e.line) || e.line < 0 || e.line > this.lines.length) {
        bad.push("edge #" + i + ": bad line " + e.line);
      }
      if (bad.length > 20) { bad.push("..."); break; }
    }
    if (!Number.isInteger(this.width) || !Number.isInteger(this.height)) {
      bad.push("non-integer stage size");
    }
    for (var j = 0; j < this.lines.length; j++) {
      if (!Number.isInteger(this.lines[j].width)) bad.push("line style " + (j + 1) + ": non-integer width");
    }
    return bad;
  };

  // ---- helpers ------------------------------------------------------------

  function sameColor(a, b) {
    return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  }

  function sameFill(a, b) {
    if (a.type !== b.type) return false;
    if (a.type === "solid") return sameColor(a.color, b.color);
    return false; // gradients/bitmaps: never coalesced for now
  }

  function colorToCSS(c) {
    return c.a === 255
      ? "rgb(" + c.r + "," + c.g + "," + c.b + ")"
      : "rgba(" + c.r + "," + c.g + "," + c.b + "," + (c.a / 255) + ")";
  }

  window.VB = window.VB || {};
  VB.VBDocument = VBDocument;
  VB.solidFill = solidFill;
  VB.lineStyle = lineStyle;
  VB.edge = edge;
  VB.reversedEdge = reversedEdge;
  VB.edgeIsDegenerate = edgeIsDegenerate;
  VB.sameColor = sameColor;
  VB.colorToCSS = colorToCSS;
  VB.TWIPS = 20;
})();
