/* bucket.js — the bucket fill tool, Flash-style.
 *
 * A click finds the planar-map face under the cursor (faces.js), then
 * stamps the current fill style onto the side of every boundary
 * half-edge that faces the region: forward half-edges get fill1, backward
 * ones fill0 (the face-on-right walk makes this exact). Both the face's
 * outer cycle and its hole cycles are stamped, so islands keep their own
 * fill.
 *
 * Afterwards, borders that separate two same-fill regions and carry no
 * line style are dissolved — this is what the MX2004 Fill*.swf snapshots
 * show Flash doing (files shrink when neighboring regions unify).
 */
(function () {
  "use strict";

  // Programmatic fill. Returns {stamped, dissolved} edge counts;
  // stamped === 0 means the click was outside every region (no-op).
  function bucketFill(doc, x, y, fillStyle) {
    var face = VB.faceAt(doc, x, y);
    if (!face) return { stamped: 0, dissolved: 0 };

    // fillStyle.style: a full 2DMaterial definition takes precedence
    // over the flat color (a selected material IS the drawing color)
    var idx = doc.addFillStyle(fillStyle.style && fillStyle.style.type
      ? JSON.parse(JSON.stringify(fillStyle.style))
      : { type: "solid",
          color: { r: fillStyle.color.r, g: fillStyle.color.g,
                   b: fillStyle.color.b, a: fillStyle.color.a } });

    var stamped = 0;
    function stampCycle(cycle) {
      for (var i = 0; i < cycle.length; i++) {
        var e = doc.edges[cycle[i].edge];
        if (cycle[i].forward) e.fill1 = idx; else e.fill0 = idx;
        stamped++;
      }
    }
    stampCycle(face.outer);
    for (var h = 0; h < face.holes.length; h++) stampCycle(face.holes[h]);

    // Dissolve invisible borders between same-fill regions.
    var before = doc.edges.length;
    doc.edges = doc.edges.filter(function (e) {
      return !(e.fill0 === e.fill1 && e.line === 0);
    });

    return { stamped: stamped, dissolved: before - doc.edges.length };
  }

  // ---- interactive tool ------------------------------------------------------

  function BucketTool(app) {
    this.app = app;
  }

  BucketTool.prototype.onDown = function (pos) {
    var op = {
      op: "bucket", x: pos.x, y: pos.y,
      color: {
        r: this.app.fillColor.r, g: this.app.fillColor.g,
        b: this.app.fillColor.b, a: this.app.fillColor.a
      }
    };
    if (this.app.fillMaterial) op.style = VB.materialClone(this.app.fillMaterial);
    this.app.record(op);
    this.app.history.push(this.app.doc);
    var result = bucketFill(this.app.doc, pos.x, pos.y,
                            { color: this.app.fillColor, style: op.style });
    if (result.stamped === 0) {
      this.app.history.undoStack.pop(); // nothing happened; drop the snapshot
      this.app.setMsg("no enclosed region here");
      return;
    }
    this.app.docChanged();
    this.app.setMsg("filled: " + result.stamped + " sides stamped" +
      (result.dissolved ? ", " + result.dissolved + " border edge" +
        (result.dissolved === 1 ? "" : "s") + " dissolved" : ""));
  };

  window.VB = window.VB || {};
  VB.BucketTool = BucketTool;
  VB.bucketFill = bucketFill;
})();
