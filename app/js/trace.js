/* trace.js — resolves the planar edge map into drawable paths.
 *
 * Flash edges are dual-sided: to reconstruct the outline of fill style F,
 * take every edge with fill1 === F forward and every edge with
 * fill0 === F reversed, then weld segments end-to-start into closed
 * loops (the same approach as ruffle's ShapeConverter). Rendering the
 * resulting loops with the even-odd rule reproduces Flash's fills,
 * holes included.
 *
 * Strokes are undirected: chains are welded by matching either endpoint,
 * so caps and joins land in the right places.
 *
 * Coordinates stay integer twips throughout, which makes endpoint
 * matching exact — no epsilon needed.
 */
(function () {
  "use strict";

  function key(x, y) { return x + "," + y; }

  // Segment representation used during welding:
  // { pts: [ {x,y,cx,cy} ... ], start: {x,y} }  — each pts entry is an edge
  // ending at (x,y), with control (cx,cy) or cx === null for straight.
  function segFromEdge(e, reversed) {
    if (!reversed) {
      return {
        sx: e.ax, sy: e.ay,
        pts: [{ x: e.bx, y: e.by, cx: e.cx, cy: e.cy }]
      };
    }
    return {
      sx: e.bx, sy: e.by,
      pts: [{ x: e.ax, y: e.ay, cx: e.cx, cy: e.cy }]
    };
  }

  function segEnd(s) { return s.pts[s.pts.length - 1]; }

  // Weld directed segments into chains: repeatedly extend each chain at its
  // end with an unused segment starting there. Returns array of chains
  // { sx, sy, pts, closed }.
  function weldDirected(segs) {
    var byStart = new Map(); // "x,y" -> array of segment indices
    for (var i = 0; i < segs.length; i++) {
      var k = key(segs[i].sx, segs[i].sy);
      var arr = byStart.get(k);
      if (arr) arr.push(i); else byStart.set(k, [i]);
    }
    var used = new Array(segs.length).fill(false);
    var chains = [];

    for (var i0 = 0; i0 < segs.length; i0++) {
      if (used[i0]) continue;
      used[i0] = true;
      var chain = { sx: segs[i0].sx, sy: segs[i0].sy, pts: segs[i0].pts.slice(), closed: false };

      for (;;) {
        var end = chain.pts[chain.pts.length - 1];
        if (end.x === chain.sx && end.y === chain.sy) { chain.closed = true; break; }
        var cands = byStart.get(key(end.x, end.y));
        var nextIdx = -1;
        if (cands) {
          for (var c = 0; c < cands.length; c++) {
            if (!used[cands[c]]) { nextIdx = cands[c]; break; }
          }
        }
        if (nextIdx < 0) break; // open chain (malformed fill or stroke-only)
        used[nextIdx] = true;
        var seg = segs[nextIdx];
        for (var p = 0; p < seg.pts.length; p++) chain.pts.push(seg.pts[p]);
      }
      chains.push(chain);
    }
    return chains;
  }

  // Weld undirected segments (strokes): extend at the chain end matching
  // either endpoint of a candidate, reversing candidates as needed.
  function weldUndirected(edges) {
    var byPoint = new Map(); // "x,y" -> array of edge indices
    function add(k, i) {
      var arr = byPoint.get(k);
      if (arr) arr.push(i); else byPoint.set(k, [i]);
    }
    for (var i = 0; i < edges.length; i++) {
      add(key(edges[i].ax, edges[i].ay), i);
      add(key(edges[i].bx, edges[i].by), i);
    }
    var used = new Array(edges.length).fill(false);
    var chains = [];

    for (var i0 = 0; i0 < edges.length; i0++) {
      if (used[i0]) continue;
      used[i0] = true;
      var e0 = edges[i0];
      var chain = { sx: e0.ax, sy: e0.ay, pts: [{ x: e0.bx, y: e0.by, cx: e0.cx, cy: e0.cy }], closed: false };

      for (;;) {
        var end = chain.pts[chain.pts.length - 1];
        if (end.x === chain.sx && end.y === chain.sy && chain.pts.length > 1) {
          chain.closed = true; break;
        }
        var cands = byPoint.get(key(end.x, end.y));
        var found = false;
        if (cands) {
          for (var c = 0; c < cands.length; c++) {
            var ci = cands[c];
            if (used[ci]) continue;
            var e = edges[ci];
            used[ci] = true;
            if (e.ax === end.x && e.ay === end.y) {
              chain.pts.push({ x: e.bx, y: e.by, cx: e.cx, cy: e.cy });
            } else {
              chain.pts.push({ x: e.ax, y: e.ay, cx: e.cx, cy: e.cy });
            }
            found = true;
            break;
          }
        }
        if (!found) break;
      }
      chains.push(chain);
    }
    return chains;
  }

  // Returns array indexed by fill style (1-based; [0] unused):
  // each entry is an array of chains forming that fill's compound path.
  function buildFillPaths(doc) {
    var perFill = [null];
    for (var f = 1; f <= doc.fills.length; f++) {
      var segs = [];
      for (var i = 0; i < doc.edges.length; i++) {
        var e = doc.edges[i];
        if (e.fill1 === f) segs.push(segFromEdge(e, false));
        if (e.fill0 === f) segs.push(segFromEdge(e, true));
      }
      perFill.push(segs.length ? weldDirected(segs) : []);
    }
    return perFill;
  }

  // Returns array indexed by line style (1-based; [0] unused):
  // each entry is an array of polyline/curve chains to stroke.
  function buildStrokePaths(doc) {
    var perLine = [null];
    for (var l = 1; l <= doc.lines.length; l++) {
      var edges = [];
      for (var i = 0; i < doc.edges.length; i++) {
        if (doc.edges[i].line === l) edges.push(doc.edges[i]);
      }
      perLine.push(edges.length ? weldUndirected(edges) : []);
    }
    return perLine;
  }

  window.VB = window.VB || {};
  VB.buildFillPaths = buildFillPaths;
  VB.buildStrokePaths = buildStrokePaths;
})();
