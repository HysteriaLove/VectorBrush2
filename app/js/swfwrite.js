/* swfwrite.js — minimal SWF exporter for validity-testing our geometry
 * in Flash MX 2004.
 *
 * Writes an uncompressed SWF v7 movie with exactly one frame:
 *   FWS header · stage RECT · 12 fps · 1 frame
 *   SetBackgroundColor
 *   DefineShape3 (the whole document as one shape: solid RGBA fills,
 *     round lines, and the SAME two-sided edge records our planar map
 *     stores — the record stream is shared with the .vbd encoder)
 *   PlaceObject2 (depth 1, identity placement)
 *   ShowFrame · End
 *
 * Deliberately not full-featured: no compression, no gradients/bitmaps
 * (solid fills only), one shape on one frame. Enough for MX 2004 to
 * open/import the file and show whether our records mean what Flash's
 * mean.
 */
(function () {
  "use strict";

  var TAG_SHOW_FRAME = 1;
  var TAG_SET_BACKGROUND = 9;
  var TAG_PLACE_OBJECT2 = 26;
  var TAG_DEFINE_SHAPE3 = 32;
  var TAG_END = 0;

  function writeRGB(w, c) { w.u8(c.r); w.u8(c.g); w.u8(c.b); }
  function writeRGBA(w, c) { w.u8(c.r); w.u8(c.g); w.u8(c.b); w.u8(c.a); }

  function writeStyleCount(w, n) {
    if (n >= 0xff) { w.u8(0xff); w.u16(n); } else { w.u8(n); }
  }

  // RECORDHEADER + raw body bytes, byte-aligned.
  function appendTag(w, code, body) {
    w.align();
    if (body.length >= 0x3f) {
      w.u16((code << 6) | 0x3f);
      w.u32(body.length);
    } else {
      w.u16((code << 6) | body.length);
    }
    for (var i = 0; i < body.length; i++) w.bytes.push(body[i]);
  }

  // Geometric bounds of the document's edges (control points included —
  // a quad stays inside its control hull), inflated by the widest line's
  // half-width. Flash uses the shape bounds for refresh regions; a lax
  // hull is fine, a too-small one clips.
  function shapeBounds(doc) {
    if (doc.edges.length === 0) {
      return { xmin: 0, xmax: doc.width, ymin: 0, ymax: doc.height };
    }
    var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    var halfLine = 0;
    for (var i = 0; i < doc.edges.length; i++) {
      var e = doc.edges[i];
      xmin = Math.min(xmin, e.ax, e.bx); xmax = Math.max(xmax, e.ax, e.bx);
      ymin = Math.min(ymin, e.ay, e.by); ymax = Math.max(ymax, e.ay, e.by);
      if (e.cx !== null) {
        xmin = Math.min(xmin, e.cx); xmax = Math.max(xmax, e.cx);
        ymin = Math.min(ymin, e.cy); ymax = Math.max(ymax, e.cy);
      }
      if (e.line > 0 && doc.lines[e.line - 1]) {
        halfLine = Math.max(halfLine, Math.ceil(doc.lines[e.line - 1].width / 2));
      }
    }
    return {
      xmin: xmin - halfLine, xmax: xmax + halfLine,
      ymin: ymin - halfLine, ymax: ymax + halfLine
    };
  }

  /**
   * Encode the document as an SWF v7 movie. Returns a Uint8Array.
   * Solid fills only (matching the editor's current feature set).
   */
  function encodeSWF(doc) {
    // ---- DefineShape3 body -------------------------------------------------
    var sw = new VB.BitWriter();
    sw.u16(1); // shape id
    sw.rect(shapeBounds(doc));
    writeStyleCount(sw, doc.fills.length);
    for (var i = 0; i < doc.fills.length; i++) {
      var f = doc.fills[i];
      if (f.type !== "solid") {
        throw new Error("SWF export supports solid fills only");
      }
      sw.u8(0x00); // solid
      writeRGBA(sw, f.color);
    }
    writeStyleCount(sw, doc.lines.length);
    for (var j = 0; j < doc.lines.length; j++) {
      sw.u16(doc.lines[j].width);
      writeRGBA(sw, doc.lines[j].color);
    }
    var numFillBits = VB.ubits(doc.fills.length);
    var numLineBits = VB.ubits(doc.lines.length);
    sw.align();
    sw.ub(4, numFillBits);
    sw.ub(4, numLineBits);
    VB.writeShapeRecords(sw, VB.prepareShapeEdges(doc), numFillBits, numLineBits);
    var shapeBody = sw.toUint8Array();

    // ---- PlaceObject2: character 1 at depth 1, identity placement ----------
    var pw = new VB.BitWriter();
    pw.u8(0x02); // PlaceFlagHasCharacter
    pw.u16(1);   // depth
    pw.u16(1);   // character id
    var placeBody = pw.toUint8Array();

    var bw = new VB.BitWriter();
    writeRGB(bw, doc.background);
    var bgBody = bw.toUint8Array();

    // ---- movie body ---------------------------------------------------------
    var b = new VB.BitWriter();
    b.rect({ xmin: 0, xmax: doc.width, ymin: 0, ymax: doc.height });
    b.u16(12 << 8); // frame rate 12.0 (8.8 fixed, fraction in the low byte)
    b.u16(1);       // frame count
    appendTag(b, TAG_SET_BACKGROUND, bgBody);
    appendTag(b, TAG_DEFINE_SHAPE3, shapeBody);
    appendTag(b, TAG_PLACE_OBJECT2, placeBody);
    appendTag(b, TAG_SHOW_FRAME, []);
    appendTag(b, TAG_END, []);
    var body = b.toUint8Array();

    var out = new Uint8Array(8 + body.length);
    out[0] = 0x46; out[1] = 0x57; out[2] = 0x53; // "FWS"
    out[3] = 7;                                  // SWF version 7 (MX 2004)
    var total = out.length;
    out[4] = total & 0xff;
    out[5] = (total >> 8) & 0xff;
    out[6] = (total >> 16) & 0xff;
    out[7] = (total >>> 24) & 0xff;
    out.set(body, 8);
    return out;
  }

  window.VB = window.VB || {};
  VB.encodeSWF = encodeSWF;
})();
