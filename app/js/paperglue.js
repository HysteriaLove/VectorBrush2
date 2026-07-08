/* paperglue.js — paper.js (vendored, v0.12.18) as the boolean geometry
 * engine.
 *
 * The swept region of a brush/eraser drag is the union of one capsule
 * per pen-path segment. paper.js computes that union exactly (circular
 * arcs, winding-rule crossing resolution — see paper.js
 * src/path/PathItem.Boolean.js), replacing the hand-rolled outline
 * classification that kept fragmenting on self-crossing strokes.
 *
 * The united boundary comes back as many small cubic fragments (slivers
 * of each capsule's arcs), so each loop is arclength-sampled and
 * curve-fit to quadratics — the Brush*.swf references show Flash stores
 * stroke outlines exactly like that: a whole stroke is 14-26 fitted
 * quads. Everything stays in integer twips.
 */
(function () {
  "use strict";

  var scope = null;
  function ensureScope() {
    if (scope) return scope;
    scope = new paper.PaperScope();
    // Off-DOM canvas: we only use the geometry classes, never the view.
    var cv = document.createElement("canvas");
    cv.width = 8; cv.height = 8;
    scope.setup(cv);
    return scope;
  }

  // One capsule (stadium) covering the segment p→q with the given radius,
  // as a closed clockwise paper path. Zero-length segments get a circle.
  function capsule(p, q, radius) {
    var s = ensureScope();
    var dx = q.x - p.x, dy = q.y - p.y;
    var len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      return new s.Path.Circle({ center: [p.x, p.y], radius: radius, insert: false });
    }
    dx /= len; dy /= len;
    var nx = -dy, ny = dx;
    var path = new s.Path({ insert: false });
    path.moveTo([p.x + nx * radius, p.y + ny * radius]);
    path.lineTo([q.x + nx * radius, q.y + ny * radius]);
    // cap around q: through q + r*dir
    path.arcTo([q.x + dx * radius, q.y + dy * radius],
               [q.x - nx * radius, q.y - ny * radius]);
    path.lineTo([p.x - nx * radius, p.y - ny * radius]);
    // cap around p: through p - r*dir
    path.arcTo([p.x - dx * radius, p.y - dy * radius],
               [p.x + nx * radius, p.y + ny * radius]);
    path.closePath();
    return path;
  }

  /**
   * The exact swept region of a drag: union of the per-segment capsules.
   * Returns a paper.PathItem (Path or CompoundPath), not inserted.
   */
  function sweptRegion(pathPts, radius) {
    var s = ensureScope();
    var kids = [];
    if (pathPts.length === 1) {
      kids.push(capsule(pathPts[0], pathPts[0], radius));
    }
    for (var i = 0; i + 1 < pathPts.length; i++) {
      kids.push(capsule(pathPts[i], pathPts[i + 1], radius));
    }
    if (kids.length === 1) return kids[0];
    var compound = new s.CompoundPath({ children: kids, insert: false });
    // Self-union: trace the nonzero-winding outline of all children.
    var united = compound.unite(null, { insert: false });
    compound.remove();
    return united;
  }

  // Closed loops of a path item as point lists (integer twips), sampled
  // by arclength. Degenerate slivers are dropped.
  function itemLoops(item, step) {
    var paths = item.children ? item.children : [item];
    var loops = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (!p.length || p.length < 4 * step) {
        if (Math.abs(p.area || 0) < 64) continue; // sub-8tw² sliver
      }
      var n = Math.max(8, Math.ceil(p.length / step));
      var pts = [];
      for (var k = 0; k < n; k++) {
        var pt = p.getPointAt(p.length * k / n);
        if (pt) pts.push({ x: pt.x, y: pt.y });
      }
      if (pts.length >= 3) loops.push(pts);
    }
    return loops;
  }

  /**
   * Swept region of a drag as LEAN closed quad loops (Flash-style fitted
   * outline records, integer twips). Returns an array of edge arrays —
   * one per boundary loop (outer boundaries and pocket holes alike),
   * each loop closed exactly. Fill claims are left 0 for the caller.
   */
  function sweptOutline(pathPts, radius, fitTol) {
    var region = sweptRegion(pathPts, radius);
    if (!region) return [];
    var step = Math.min(40, Math.max(8, radius * 0.3));
    var loops = itemLoops(region, step);
    region.remove();
    var out = [];
    loops.forEach(function (pts) {
      pts.push({ x: pts[0].x, y: pts[0].y }); // close for the fitter
      var geoms = VB.fitStroke(pts, fitTol || 12);
      if (geoms.length === 0) return;
      geoms[geoms.length - 1].bx = geoms[0].ax; // exact closure
      geoms[geoms.length - 1].by = geoms[0].ay;
      var loop = [];
      geoms.forEach(function (g) {
        // All-quad records, like the references: straight runs become
        // quads with the control at the midpoint (straightness stays
        // reserved for the phantom-chord tripwire).
        var cx = g.cx, cy = g.cy;
        if (cx === null) {
          cx = Math.round((g.ax + g.bx) / 2);
          cy = Math.round((g.ay + g.by) / 2);
        }
        var fe = VB.edge(g.ax, g.ay, cx, cy, g.bx, g.by, 0, 0, 0);
        if (!VB.edgeIsDegenerate(fe)) loop.push(fe);
      });
      if (loop.length) out.push(loop);
    });
    return out;
  }

  window.VB = window.VB || {};
  VB.paperScope = ensureScope;
  VB.sweptRegion = sweptRegion;
  VB.sweptOutline = sweptOutline;
})();
