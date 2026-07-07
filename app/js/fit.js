/* fit.js — pencil stroke smoothing: raw pointer points → lines + quads.
 *
 * Reproduces the character of Flash MX's pencil ("smooth" mode): the mouse
 * trail is segmented at sharp corners, near-straight runs become straight
 * edges, and everything else is least-squares-fitted with quadratic
 * Béziers, recursively splitting at the worst point until the fit is
 * within tolerance (Schneider's fit-and-split scheme, but emitting quads
 * because that's what the format stores).
 *
 * Input points and tolerances are in twips; output is a list of
 * {ax, ay, cx, cy, bx, by} geometry (cx null for straight), rounded to
 * integer twips, each piece starting exactly where the previous ended.
 */
(function () {
  "use strict";

  var DEFAULT_TOL = 45;        // max deviation, twips (2.25 px) — "smooth"
  var CORNER_COS = -0.25;      // angle at a sample sharper than ~104° = corner
  var MIN_SAMPLE_DIST = 8;     // collapse jittery duplicates (0.4 px)

  // ---- public entry ---------------------------------------------------------

  function fitStroke(rawPoints, tolerance) {
    var tol = tolerance || DEFAULT_TOL;
    var pts = dedupe(rawPoints);
    if (pts.length < 2) return [];

    var pieces = [];
    var corners = findCorners(pts);
    for (var s = 0; s + 1 < corners.length; s++) {
      var run = pts.slice(corners[s], corners[s + 1] + 1);
      fitRun(run, tol, pieces);
    }
    return roundAndWeld(pieces);
  }

  // ---- preprocessing ---------------------------------------------------------

  function dedupe(points) {
    var out = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var last = out[out.length - 1];
      if (last) {
        var dx = p.x - last.x, dy = p.y - last.y;
        if (dx * dx + dy * dy < MIN_SAMPLE_DIST * MIN_SAMPLE_DIST) {
          if (i === points.length - 1) out[out.length - 1] = p; // keep true end
          continue;
        }
      }
      out.push(p);
    }
    return out;
  }

  // Indices where the polyline turns sharply — fit runs break there so
  // corners the user actually drew stay crisp.
  function findCorners(pts) {
    var corners = [0];
    for (var i = 1; i + 1 < pts.length; i++) {
      var ax = pts[i].x - pts[i - 1].x, ay = pts[i].y - pts[i - 1].y;
      var bx = pts[i + 1].x - pts[i].x, by = pts[i + 1].y - pts[i].y;
      var la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la === 0 || lb === 0) continue;
      var cos = (ax * bx + ay * by) / (la * lb);
      if (cos < CORNER_COS) corners.push(i);
    }
    corners.push(pts.length - 1);
    return corners;
  }

  // ---- fitting ---------------------------------------------------------------

  function fitRun(pts, tol, out) {
    if (pts.length < 2) return;
    var first = pts[0], last = pts[pts.length - 1];

    if (pts.length === 2) {
      out.push({ ax: first.x, ay: first.y, cx: null, cy: null, bx: last.x, by: last.y });
      return;
    }

    // Straight-line attempt: cheap and Flash loves straight edges.
    var lineErr = maxDistToChord(pts);
    if (lineErr.dist <= tol * 0.6) {
      out.push({ ax: first.x, ay: first.y, cx: null, cy: null, bx: last.x, by: last.y });
      return;
    }

    // Quadratic attempt with chord-length parameterization.
    var params = chordParams(pts);
    var ctrl = solveControlPoint(pts, params);
    var worst = maxQuadError(pts, params, ctrl);
    if (worst.dist <= tol) {
      out.push({ ax: first.x, ay: first.y, cx: ctrl.x, cy: ctrl.y, bx: last.x, by: last.y });
      return;
    }

    // Too curvy for one quad: split at the worst-fitting sample.
    var k = worst.index;
    if (k <= 0 || k >= pts.length - 1) k = Math.floor(pts.length / 2);
    fitRun(pts.slice(0, k + 1), tol, out);
    fitRun(pts.slice(k), tol, out);
  }

  function chordParams(pts) {
    var params = [0];
    var total = 0;
    for (var i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      params.push(total);
    }
    for (var j = 0; j < params.length; j++) params[j] = total === 0 ? 0 : params[j] / total;
    return params;
  }

  // Least-squares control point with fixed endpoints:
  // B(t) = (1-t)²P0 + 2t(1-t)C + t²P2, minimize Σ|B(t_i) - p_i|².
  function solveControlPoint(pts, params) {
    var first = pts[0], last = pts[pts.length - 1];
    var num_x = 0, num_y = 0, den = 0;
    for (var i = 1; i + 1 < pts.length; i++) {
      var t = params[i], u = 1 - t;
      var b = 2 * t * u;
      num_x += b * (pts[i].x - u * u * first.x - t * t * last.x);
      num_y += b * (pts[i].y - u * u * first.y - t * t * last.y);
      den += b * b;
    }
    if (den === 0) {
      return { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
    }
    return { x: num_x / den, y: num_y / den };
  }

  function maxQuadError(pts, params, ctrl) {
    var first = pts[0], last = pts[pts.length - 1];
    var worst = { dist: 0, index: 0 };
    for (var i = 1; i + 1 < pts.length; i++) {
      var t = params[i], u = 1 - t;
      var x = u * u * first.x + 2 * u * t * ctrl.x + t * t * last.x;
      var y = u * u * first.y + 2 * u * t * ctrl.y + t * t * last.y;
      var d = Math.hypot(x - pts[i].x, y - pts[i].y);
      if (d > worst.dist) { worst.dist = d; worst.index = i; }
    }
    return worst;
  }

  function maxDistToChord(pts) {
    var first = pts[0], last = pts[pts.length - 1];
    var worst = { dist: 0, index: 0 };
    for (var i = 1; i + 1 < pts.length; i++) {
      var d = VB.geom.distToSegment(pts[i].x, pts[i].y, first.x, first.y, last.x, last.y);
      if (d > worst.dist) { worst.dist = d; worst.index = i; }
    }
    return worst;
  }

  // Round every piece to integer twips, forcing exact continuity (each
  // piece starts at the previous piece's rounded end) and dropping slivers.
  function roundAndWeld(pieces) {
    var out = [];
    var px = null, py = null;
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      var ax = px === null ? Math.round(p.ax) : px;
      var ay = py === null ? Math.round(p.ay) : py;
      var bx = Math.round(p.bx), by = Math.round(p.by);
      var g = {
        ax: ax, ay: ay,
        cx: p.cx === null ? null : Math.round(p.cx),
        cy: p.cy === null ? null : Math.round(p.cy),
        bx: bx, by: by
      };
      px = bx; py = by;
      if (g.ax === g.bx && g.ay === g.by &&
          (g.cx === null || (g.cx === g.ax && g.cy === g.ay))) continue;
      out.push(g);
    }
    return out;
  }

  window.VB = window.VB || {};
  VB.fitStroke = fitStroke;
  VB.FIT_TOLERANCE = DEFAULT_TOL;
})();
