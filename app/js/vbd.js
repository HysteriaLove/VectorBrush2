/* vbd.js — the VectorBrush Drawing format (.vbd): our own compact binary
 * transmission format, modeled directly on Flash's DefineShape encoding.
 *
 * Why it's compact (same tricks as SWF):
 *   - integer twips + delta-coded edges sized to the minimum bit width
 *   - style tables referenced by small indices, re-selected only on change
 *   - edges welded into chains so moveTo/style records amortize away
 *   - optional zlib (deflate) over the whole body
 *
 * Layout:
 *   "VBD1"                       magic (4 bytes)
 *   u8  flags                    bit0: body is zlib-deflate compressed
 *   --- body (possibly compressed) ---
 *   u8  version = 1
 *   RECT stage                   {0, width, 0, height} twips, SWF bit-packed
 *   RGBA background
 *   fillCount  u8 (0xFF -> u16)  then per fill:  u8 type (0=solid) + RGBA
 *   lineCount  u8 (0xFF -> u16)  then per line:  u16 width(twips) + RGBA
 *   UB4 numFillBits, UB4 numLineBits
 *   shape records (SWF DefineShape bit grammar: style-change / straight /
 *   curved records, terminated by the 6-zero-bit end record)
 *
 * The record grammar is byte-for-byte the SWF one (minus NewStyles, which
 * v1 never emits), so anything that can read a DefineShape can be adapted
 * to read a VBD body trivially.
 */
(function () {
  "use strict";

  var MAGIC = [0x56, 0x42, 0x44, 0x31]; // "VBD1"
  var MAX_EDGE_BITS = 17;               // SWF edge nbits field: 4 bits, +2 bias

  // ---- compression ---------------------------------------------------------

  async function deflate(bytes) {
    var cs = new CompressionStream("deflate");
    var stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes) {
    var ds = new DecompressionStream("deflate");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---- encoding ------------------------------------------------------------

  function writeColor(w, c) { w.u8(c.r); w.u8(c.g); w.u8(c.b); w.u8(c.a); }

  function writeStyleCount(w, n) {
    if (n >= 0xff) { w.u8(0xff); w.u16(n); } else { w.u8(n); }
  }

  // Split any edge whose deltas exceed the writable bit width. Returns a
  // list of edges equivalent to e (usually just [e]).
  function splitOversized(e) {
    var ok;
    if (e.cx === null) {
      ok = VB.sbitsAll([e.bx - e.ax, e.by - e.ay]) <= MAX_EDGE_BITS;
    } else {
      ok = VB.sbitsAll([e.cx - e.ax, e.cy - e.ay, e.bx - e.cx, e.by - e.cy]) <= MAX_EDGE_BITS;
    }
    if (ok) return [e];

    var halves;
    if (e.cx === null) {
      var mx = Math.round((e.ax + e.bx) / 2), my = Math.round((e.ay + e.by) / 2);
      halves = [
        VB.edge(e.ax, e.ay, null, null, mx, my, e.fill0, e.fill1, e.line),
        VB.edge(mx, my, null, null, e.bx, e.by, e.fill0, e.fill1, e.line)
      ];
    } else {
      // de Casteljau split at t = 0.5 (rounded to twips; sub-twip error only)
      var m0x = Math.round((e.ax + e.cx) / 2), m0y = Math.round((e.ay + e.cy) / 2);
      var m1x = Math.round((e.cx + e.bx) / 2), m1y = Math.round((e.cy + e.by) / 2);
      var mmx = Math.round((m0x + m1x) / 2), mmy = Math.round((m0y + m1y) / 2);
      halves = [
        VB.edge(e.ax, e.ay, m0x, m0y, mmx, mmy, e.fill0, e.fill1, e.line),
        VB.edge(mmx, mmy, m1x, m1y, e.bx, e.by, e.fill0, e.fill1, e.line)
      ];
    }
    return splitOversized(halves[0]).concat(splitOversized(halves[1]));
  }

  // Order edges for compact emission: keep the pen moving. From the current
  // pen position, prefer an unused edge that starts there with the same
  // styles (no record needed), then one with different styles (style record
  // only — this is Flash's trick: its files have far more style changes
  // than moveTos), and only moveTo when the pen is truly stranded.
  function orderForEncoding(edges) {
    var byStart = new Map(); // "x,y" -> edge indices
    for (var i = 0; i < edges.length; i++) {
      var k = edges[i].ax + "," + edges[i].ay;
      var arr = byStart.get(k);
      if (arr) arr.push(i); else byStart.set(k, [i]);
    }
    var used = new Array(edges.length).fill(false);
    var order = [];
    var cursor = 0;             // insertion-order fallback scan position
    var penX = 0, penY = 0, f0 = 0, f1 = 0, ln = 0;

    for (var done = 0; done < edges.length; done++) {
      var pick = -1;
      var cands = byStart.get(penX + "," + penY);
      if (cands) {
        var alt = -1;
        for (var c = 0; c < cands.length; c++) {
          var ci = cands[c];
          if (used[ci]) continue;
          var e = edges[ci];
          if (e.fill0 === f0 && e.fill1 === f1 && e.line === ln) { pick = ci; break; }
          if (alt < 0) alt = ci;
        }
        if (pick < 0) pick = alt;
      }
      if (pick < 0) {
        while (used[cursor]) cursor++;
        pick = cursor;
      }
      used[pick] = true;
      var pe = edges[pick];
      order.push(pe);
      penX = pe.bx; penY = pe.by;
      f0 = pe.fill0; f1 = pe.fill1; ln = pe.line;
    }
    return order;
  }

  // stats (optional) is filled with Flash-grammar record counts so the
  // debug panel can show exactly what the document costs on the wire.
  function encodeBody(doc, stats) {
    stats = stats || {};
    stats.styleChanges = 0;
    stats.moveTos = 0;
    stats.straightEdges = 0;
    stats.curvedEdges = 0;
    var w = new VB.BitWriter();
    w.u8(1); // version
    w.rect({ xmin: 0, xmax: doc.width, ymin: 0, ymax: doc.height });
    writeColor(w, doc.background);

    writeStyleCount(w, doc.fills.length);
    for (var i = 0; i < doc.fills.length; i++) {
      var f = doc.fills[i];
      if (f.type !== "solid") throw new Error("VBD v1 encodes solid fills only");
      w.u8(0);
      writeColor(w, f.color);
    }
    writeStyleCount(w, doc.lines.length);
    for (var j = 0; j < doc.lines.length; j++) {
      w.u16(doc.lines[j].width);
      writeColor(w, doc.lines[j].color);
    }

    var numFillBits = VB.ubits(doc.fills.length);
    var numLineBits = VB.ubits(doc.lines.length);
    w.align();
    w.ub(4, numFillBits);
    w.ub(4, numLineBits);

    writeShapeRecords(w, prepareShapeEdges(doc), numFillBits, numLineBits, stats);
    w.align();
    return w.toUint8Array();
  }

  // Degenerate-filter + oversized-split + pen-continuity order: the edge
  // list ready for record emission. Shared with the SWF exporter.
  function prepareShapeEdges(doc) {
    var edges = [];
    for (var k = 0; k < doc.edges.length; k++) {
      if (VB.edgeIsDegenerate(doc.edges[k])) continue;
      var parts = splitOversized(doc.edges[k]);
      for (var p = 0; p < parts.length; p++) edges.push(parts[p]);
    }
    return orderForEncoding(edges);
  }

  // Emit the SWF DefineShape record grammar (style-change / straight /
  // curved records + the 6-zero-bit end record) for pre-ordered edges.
  // This is the exact bit layout Flash reads — the VBD body and the SWF
  // exporter share it.
  function writeShapeRecords(w, ordered, numFillBits, numLineBits, stats) {
    stats = stats || {};
    stats.styleChanges = stats.styleChanges || 0;
    stats.moveTos = stats.moveTos || 0;
    stats.straightEdges = stats.straightEdges || 0;
    stats.curvedEdges = stats.curvedEdges || 0;

    var penX = 0, penY = 0, curF0 = 0, curF1 = 0, curLn = 0;
    for (var e2 = 0; e2 < ordered.length; e2++) {
      var e = ordered[e2];
      var needMove = e.ax !== penX || e.ay !== penY;
      var needF0 = e.fill0 !== curF0;
      var needF1 = e.fill1 !== curF1;
      var needLn = e.line !== curLn;

      if (needMove || needF0 || needF1 || needLn) {
        stats.styleChanges++;
        if (needMove) stats.moveTos++;
        w.ub(1, 0); // non-edge record
        w.ub(5, (needLn ? 8 : 0) | (needF1 ? 4 : 0) | (needF0 ? 2 : 0) | (needMove ? 1 : 0));
        if (needMove) {
          var mb = VB.sbitsAll([e.ax, e.ay]);
          w.ub(5, mb);
          w.sb(mb, e.ax); w.sb(mb, e.ay);
        }
        if (needF0) w.ub(numFillBits, e.fill0);
        if (needF1) w.ub(numFillBits, e.fill1);
        if (needLn) w.ub(numLineBits, e.line);
        curF0 = e.fill0; curF1 = e.fill1; curLn = e.line;
        penX = e.ax; penY = e.ay;
      }

      if (e.cx === null) {
        stats.straightEdges++;
        var dx = e.bx - e.ax, dy = e.by - e.ay;
        var nb = Math.max(2, VB.sbitsAll([dx, dy]));
        w.ub(1, 1); w.ub(1, 1);        // edge, straight
        w.ub(4, nb - 2);
        if (dx !== 0 && dy !== 0) {
          w.ub(1, 1);                   // general line
          w.sb(nb, dx); w.sb(nb, dy);
        } else if (dx === 0) {
          w.ub(1, 0); w.ub(1, 1);       // vertical
          w.sb(nb, dy);
        } else {
          w.ub(1, 0); w.ub(1, 0);       // horizontal
          w.sb(nb, dx);
        }
      } else {
        stats.curvedEdges++;
        var cdx = e.cx - e.ax, cdy = e.cy - e.ay;
        var adx = e.bx - e.cx, ady = e.by - e.cy;
        var nb2 = Math.max(2, VB.sbitsAll([cdx, cdy, adx, ady]));
        w.ub(1, 1); w.ub(1, 0);        // edge, curved
        w.ub(4, nb2 - 2);
        w.sb(nb2, cdx); w.sb(nb2, cdy);
        w.sb(nb2, adx); w.sb(nb2, ady);
      }
      penX = e.bx; penY = e.by;
    }

    w.ub(1, 0); w.ub(5, 0); // end record
  }

  async function encodeVBD(doc, opts) {
    var compress = !opts || opts.compress !== false;
    var body = encodeBody(doc);
    var compressed = false;
    if (compress) {
      var deflated = await deflate(body);
      // Deflate only pays off past a certain density; keep whichever wins.
      if (deflated.length < body.length) { body = deflated; compressed = true; }
    }
    var out = new Uint8Array(5 + body.length);
    out.set(MAGIC, 0);
    out[4] = compressed ? 1 : 0;
    out.set(body, 5);
    return out;
  }

  // ---- decoding ------------------------------------------------------------

  function isVBD(bytes) {
    return bytes.length > 5 &&
      bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1] &&
      bytes[2] === MAGIC[2] && bytes[3] === MAGIC[3];
  }

  function readColor(r) {
    return { r: r.u8(), g: r.u8(), b: r.u8(), a: r.u8() };
  }

  function readStyleCount(r) {
    var n = r.u8();
    return n === 0xff ? r.u16() : n;
  }

  async function decodeVBD(bytes) {
    if (!isVBD(bytes)) throw new Error("Not a VBD file");
    var flags = bytes[4];
    var body = bytes.subarray(5);
    if (flags & 1) body = await inflate(body);

    var r = new VB.BitReader(body, 0);
    var version = r.u8();
    if (version !== 1) throw new Error("Unsupported VBD version " + version);

    var doc = new VB.VBDocument();
    var stage = r.rect();
    doc.width = stage.xmax - stage.xmin;
    doc.height = stage.ymax - stage.ymin;
    doc.background = readColor(r);

    var fillCount = readStyleCount(r);
    for (var i = 0; i < fillCount; i++) {
      var t = r.u8();
      if (t !== 0) throw new Error("Unknown VBD fill type " + t);
      doc.fills.push({ type: "solid", color: readColor(r) });
    }
    var lineCount = readStyleCount(r);
    for (var j = 0; j < lineCount; j++) {
      var width = r.u16();
      doc.lines.push({ width: width, color: readColor(r) });
    }

    r.align();
    var numFillBits = r.ub(4), numLineBits = r.ub(4);
    var penX = 0, penY = 0, f0 = 0, f1 = 0, ln = 0;

    for (;;) {
      if (r.ub(1) === 0) {
        var recFlags = r.ub(5);
        if (recFlags === 0) break;
        if (recFlags & 16) throw new Error("VBD v1 must not contain NewStyles records");
        if (recFlags & 1) { var n = r.ub(5); penX = r.sb(n); penY = r.sb(n); }
        if (recFlags & 2) f0 = r.ub(numFillBits);
        if (recFlags & 4) f1 = r.ub(numFillBits);
        if (recFlags & 8) ln = r.ub(numLineBits);
      } else if (r.ub(1)) {
        var nb = r.ub(4) + 2;
        var dx = 0, dy = 0;
        if (r.ub(1)) { dx = r.sb(nb); dy = r.sb(nb); }
        else if (r.ub(1)) { dy = r.sb(nb); }
        else { dx = r.sb(nb); }
        doc.edges.push(VB.edge(penX, penY, null, null, penX + dx, penY + dy, f0, f1, ln));
        penX += dx; penY += dy;
      } else {
        var nc = r.ub(4) + 2;
        var cdx = r.sb(nc), cdy = r.sb(nc), adx = r.sb(nc), ady = r.sb(nc);
        var cx = penX + cdx, cy = penY + cdy;
        doc.edges.push(VB.edge(penX, penY, cx, cy, cx + adx, cy + ady, f0, f1, ln));
        penX = cx + adx; penY = cy + ady;
      }
    }

    return { doc: doc, info: { version: version, compressed: !!(flags & 1) } };
  }

  // Wire-cost introspection for the debug panel: encodes (uncompressed)
  // and reports Flash-grammar record counts + byte size.
  function vbdStats(doc) {
    var stats = {};
    var body = encodeBody(doc, stats);
    stats.bodyBytes = body.length;
    stats.fileBytes = body.length + 5; // + magic/flags header
    return stats;
  }

  window.VB = window.VB || {};
  VB.encodeVBD = encodeVBD;
  VB.decodeVBD = decodeVBD;
  VB.isVBD = isVBD;
  VB.vbdStats = vbdStats;
  VB.prepareShapeEdges = prepareShapeEdges; // shared with the SWF exporter
  VB.writeShapeRecords = writeShapeRecords;
})();
