/* y2kvector.js — the y2kvector format (.y2kvector): our own compact
 * binary transmission format for one vector document, modeled directly
 * on Flash's DefineShape encoding. (Formerly ".vbd" — files written
 * with the legacy "VBD1" magic decode forever, see isY2KVector.)
 *
 * Why it's compact (same tricks as SWF):
 *   - integer twips + delta-coded edges sized to the minimum bit width
 *   - style tables referenced by small indices, re-selected only on change
 *   - edges welded into chains so moveTo/style records amortize away
 *   - optional zlib (deflate) over the whole body
 *
 * Layout:
 *   "Y2KV"                       magic (4 bytes; legacy "VBD1" accepted)
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

  var MAGIC = [0x59, 0x32, 0x4B, 0x56];        // "Y2KV" (written)
  var LEGACY_MAGIC = [0x56, 0x42, 0x44, 0x31]; // "VBD1" (read forever)
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

  // 2DMaterial fill styles. The tag byte has been in the format since
  // v1 (solid = 0), so extending the tag space needs no version bump:
  // old files carry only tag 0 and decode unchanged.
  //   0 solid  : rgba
  //   1 linear : matrix (sx,r0,r1,sy as 16.16 + tx,ty s32 twips),
  //              flags (spread<<6|interp<<4|stopCount), stops
  //              (ratio u8 + rgba), focal s32 (×256, 0 for linear)
  //   2 radial : same layout as linear
  //   3 matcap : base rgba + bumpScale s32 tw + blurPx s32 (×100)
  //              + resolution s32 (×100)
  function writeFillStyle(w, f) {
    if (f.type === "linear" || f.type === "radial") {
      w.u8(f.type === "linear" ? 1 : 2);
      var m = f.matrix || { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 };
      s32w(w, Math.round(m.sx * 65536)); s32w(w, Math.round(m.r0 * 65536));
      s32w(w, Math.round(m.r1 * 65536)); s32w(w, Math.round(m.sy * 65536));
      s32w(w, Math.round(m.tx)); s32w(w, Math.round(m.ty));
      var g = f.gradient || { spread: 0, interpolation: 0, stops: [] };
      w.u8(((g.spread & 3) << 6) | ((g.interpolation & 3) << 4) |
           (g.stops.length & 15));
      for (var s = 0; s < (g.stops.length & 15); s++) {
        w.u8(g.stops[s].ratio);
        writeColor(w, g.stops[s].color);
      }
      s32w(w, Math.round((f.focal || 0) * 256));
      return;
    }
    if (f.type === "matcap") {
      // tag 4 = matcap with a texture source; tag 3 (no texture,
      // implies "studio") is still decoded for files saved before
      // textures existed.
      w.u8(4);
      writeColor(w, f.color);
      s32w(w, Math.round(f.bumpScale || 0));
      s32w(w, Math.round((f.blurPx || 0) * 100));
      s32w(w, Math.round((f.resolution || 1) * 100));
      var src = f.matcap || "studio";
      if (typeof src === "string") {
        w.u8(0);
        writeStr(w, src);
      } else {
        w.u8(1);
        var mb = VB.b64ToBytes(src.b64 || "");
        w.u32(mb.length);
        for (var mi = 0; mi < mb.length; mi++) w.u8(mb[mi]);
      }
      return;
    }
    // solid — and legacy/unsupported (bitmap) baked to base color so
    // the file stays valid everywhere
    w.u8(0);
    writeColor(w, f.type === "solid" ? f.color
      : (VB.materialBaseColor ? VB.materialBaseColor(f)
                              : { r: 128, g: 128, b: 128, a: 255 }));
  }

  function readFillStyle(r) {
    var t = r.u8();
    if (t === 0) return { type: "solid", color: readColor(r) };
    if (t === 1 || t === 2) {
      var m = { sx: s32r(r) / 65536, r0: s32r(r) / 65536,
                r1: s32r(r) / 65536, sy: s32r(r) / 65536,
                tx: s32r(r), ty: s32r(r) };
      var flags = r.u8();
      var stops = [];
      for (var i = 0; i < (flags & 15); i++) {
        stops.push({ ratio: r.u8(), color: readColor(r) });
      }
      var focal = s32r(r) / 256;
      var st = { type: t === 1 ? "linear" : "radial", matrix: m,
                 gradient: { spread: flags >> 6,
                             interpolation: (flags >> 4) & 3,
                             stops: stops } };
      if (t === 2 && focal) st.focal = focal;
      return st;
    }
    if (t === 3) {
      return { type: "matcap", color: readColor(r), matcap: "studio",
               bumpScale: s32r(r), blurPx: s32r(r) / 100,
               resolution: s32r(r) / 100 };
    }
    if (t === 4) {
      var mc = { type: "matcap", color: readColor(r),
                 bumpScale: s32r(r), blurPx: s32r(r) / 100,
                 resolution: s32r(r) / 100 };
      if (r.u8() === 0) {
        mc.matcap = readStr(r);
      } else {
        var mlen = r.u32();
        var mbytes = new Uint8Array(mlen);
        for (var mj = 0; mj < mlen; mj++) mbytes[mj] = r.u8();
        mc.matcap = { b64: VB.bytesToB64(mbytes) };
      }
      return mc;
    }
    throw new Error("Unknown y2kvector fill type " + t);
  }

  // stats (optional) is filled with Flash-grammar record counts so the
  // debug panel can show exactly what the document costs on the wire.
  // The reusable cell payload: styles + shape records (+ text section).
  // v1/v2 bodies contain exactly one (text presence implied by the
  // version); v3 layer cells carry an explicit hasText flag byte.
  function encodeCell(w, doc, stats, withTextFlag) {
    var hasText = !!((doc.texts && doc.texts.length) ||
                     (doc.fonts && doc.fonts.length));
    writeStyleCount(w, doc.fills.length);
    for (var i = 0; i < doc.fills.length; i++) {
      writeFillStyle(w, doc.fills[i]);
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
    if (withTextFlag) {
      w.u8(hasText ? 1 : 0);
      if (hasText) writeTextSection(w, doc);
    } else if (hasText) {
      writeTextSection(w, doc);
    }
    return hasText;
  }

  function encodeBody(doc, stats) {
    stats = stats || {};
    stats.styleChanges = 0;
    stats.moveTos = 0;
    stats.straightEdges = 0;
    stats.curvedEdges = 0;
    var hasText = (doc.texts && doc.texts.length) || (doc.fonts && doc.fonts.length);
    var w = new VB.BitWriter();
    w.u8(hasText ? 2 : 1); // v2 = v1 + a trailing text section
    w.rect({ xmin: 0, xmax: doc.width, ymin: 0, ymax: doc.height });
    writeColor(w, doc.background);
    encodeCell(w, doc, stats, false);
    return w.toUint8Array();
  }

  function writeStr(w, s) {
    var utf8 = unescape(encodeURIComponent(s));
    w.u8(Math.min(utf8.length, 255));
    for (var i = 0; i < Math.min(utf8.length, 255); i++) w.u8(utf8.charCodeAt(i));
  }

  // v4: the whole Flash-style DOM — scenes -> layers -> frame cells —
  // plus the GLOBAL material library (v3 = same without the library).
  function encodeProjectBody(project, stats) {
    stats = stats || {};
    stats.styleChanges = 0;
    stats.moveTos = 0;
    stats.straightEdges = 0;
    stats.curvedEdges = 0;
    var w = new VB.BitWriter();
    w.u8(4);
    w.rect({ xmin: 0, xmax: project.width, ymin: 0, ymax: project.height });
    writeColor(w, project.background);
    w.u8(project.scenes.length);
    project.scenes.forEach(function (sc) {
      writeStr(w, sc.name);
      w.u16(sc.layers.length);
      sc.layers.forEach(function (l) {
        writeStr(w, l.name);
        w.u8((l.visible ? 1 : 0) | (l.locked ? 2 : 0));
        encodeCell(w, l.frames[0], stats, true);
      });
    });
    w.u8(project.cur.scene);
    w.u8(project.cur.layer);
    var mats = project.materials || [];
    writeStyleCount(w, mats.length);
    for (var mi = 0; mi < mats.length; mi++) writeFillStyle(w, mats[mi]);
    return w.toUint8Array();
  }

  // A single default layer round-trips as plain v1/v2 (older builds can
  // still open the file); anything structural forces v3.
  function needsProjectFormat(project) {
    if (project.scenes.length > 1) return true;
    // a curated material library must persist even for a single default
    // layer (entries beyond what the cell fills would rebuild)
    if ((project.materials || []).length) {
      var cell = project.scenes[0].layers[0].frames[0];
      var rebuilt = [];
      cell.fills.forEach(function (f) {
        if (f.type !== "solid") rebuilt.push(JSON.stringify(f));
      });
      var extra = project.materials.some(function (m) {
        return rebuilt.indexOf(JSON.stringify(m)) < 0;
      });
      if (extra) return true;
    }
    var sc = project.scenes[0];
    if (sc.name !== "Scene 1" || sc.layers.length > 1) return true;
    var l = sc.layers[0];
    return l.name !== "Layer 1" || !l.visible || l.locked;
  }

  // ---- text section (v2) -----------------------------------------------------
  // Byte-aligned: text is tiny next to the shape, so no bit packing.
  // Fonts store their glyph outlines verbatim (1024-EM y-down contours),
  // so an imported SWF's text round-trips through .vbd losslessly.

  function s16w(w, v) { w.u16(v & 0xFFFF); }
  function s32w(w, v) { w.u16((v >> 16) & 0xFFFF); w.u16(v & 0xFFFF); }

  // Section format 2 opens with a 0xFFFF sentinel (impossible as a real
  // font count) so old files — which start straight with the count —
  // still parse. It adds per-block wrapWidth/pitch and per-record soft
  // wrap flags.
  var TEXT_SECTION_SENTINEL = 0xFFFF;

  function writeTextSection(w, doc) {
    var fonts = doc.fonts || [], texts = doc.texts || [];
    w.u16(TEXT_SECTION_SENTINEL);
    w.u8(4); // section format (3: align/spacing; 4: box height)
    w.u16(fonts.length);
    fonts.forEach(function (f) {
      var name = unescape(encodeURIComponent(f.name)); // utf8 bytes
      w.u8(Math.min(name.length, 255));
      for (var i = 0; i < Math.min(name.length, 255); i++) w.u8(name.charCodeAt(i));
      w.u8((f.bold ? 1 : 0) | (f.italic ? 2 : 0));
      w.u16(f.glyphs.length);
      f.glyphs.forEach(function (g) {
        w.u16(g.code);
        w.u16(g.contours.length);
        g.contours.forEach(function (c) {
          s16w(w, c.mx); s16w(w, c.my);
          w.u16(c.segs.length);
          c.segs.forEach(function (s) {
            if (s.cx === undefined) { w.u8(0); s16w(w, s.x); s16w(w, s.y); }
            else { w.u8(1); s16w(w, s.cx); s16w(w, s.cy); s16w(w, s.x); s16w(w, s.y); }
          });
        });
      });
    });
    w.u16(texts.length);
    texts.forEach(function (t) {
      // a,b,c,d as 16.16 fixed (SWF's own precision), tx/ty as s32 twips
      for (var i = 0; i < 4; i++) s32w(w, Math.round(t.matrix[i] * 65536));
      s32w(w, t.matrix[4]); s32w(w, t.matrix[5]);
      s32w(w, t.wrapWidth || -1);
      s32w(w, t.pitch || 0);
      w.u8(t.align || 0);
      s16w(w, t.spacing || 0);
      s32w(w, t.boxHeight || -1);
      w.u16(t.records.length);
      t.records.forEach(function (rec) {
        w.u16(rec.font);
        w.u16(rec.height);
        writeColor(w, rec.color);
        s16w(w, rec.x); s16w(w, rec.y);
        w.u8(rec.soft ? 1 : 0);
        w.u16(rec.glyphs.length);
        rec.glyphs.forEach(function (g) { w.u16(g.gi); s16w(w, g.adv); });
      });
    });
  }

  function s16r(r) { return (r.u16() << 16) >> 16; }
  function s32r(r) { return ((r.u16() << 16) | r.u16()) | 0; }

  function readTextSection(r, doc) {
    var nf = r.u16();
    var fmt = 1;
    if (nf === TEXT_SECTION_SENTINEL) { fmt = r.u8(); nf = r.u16(); }
    for (var i = 0; i < nf; i++) {
      var nameLen = r.u8();
      var raw = "";
      for (var j = 0; j < nameLen; j++) raw += String.fromCharCode(r.u8());
      var name;
      try { name = decodeURIComponent(escape(raw)); } catch (e) { name = raw; }
      var style = r.u8();
      var font = { name: name, bold: !!(style & 1), italic: !!(style & 2), glyphs: [] };
      var ng = r.u16();
      for (var g = 0; g < ng; g++) {
        var glyph = { code: r.u16(), contours: [] };
        var nc = r.u16();
        for (var c = 0; c < nc; c++) {
          var ct = { mx: s16r(r), my: s16r(r), segs: [] };
          var ns = r.u16();
          for (var s = 0; s < ns; s++) {
            if (r.u8() === 0) ct.segs.push({ x: s16r(r), y: s16r(r) });
            else ct.segs.push({ cx: s16r(r), cy: s16r(r), x: s16r(r), y: s16r(r) });
          }
          glyph.contours.push(ct);
        }
        font.glyphs.push(glyph);
      }
      doc.fonts.push(font);
    }
    var nt = r.u16();
    for (i = 0; i < nt; i++) {
      var matrix = [s32r(r) / 65536, s32r(r) / 65536, s32r(r) / 65536,
                    s32r(r) / 65536, s32r(r), s32r(r)];
      var text = { matrix: matrix, records: [], wrapWidth: null, pitch: null,
                   align: 0, spacing: 0, boxHeight: null };
      if (fmt >= 2) {
        var ww = s32r(r);
        text.wrapWidth = ww > 0 ? ww : null;
        var pp = s32r(r);
        text.pitch = pp > 0 ? pp : null;
      }
      if (fmt >= 3) {
        text.align = r.u8();
        text.spacing = s16r(r);
      }
      if (fmt >= 4) {
        var bh = s32r(r);
        text.boxHeight = bh > 0 ? bh : null;
      }
      var nr = r.u16();
      for (var k = 0; k < nr; k++) {
        var rec = {
          font: r.u16(), height: r.u16(), color: readColor(r),
          x: s16r(r), y: s16r(r), glyphs: []
        };
        if (fmt >= 2 && r.u8() === 1) rec.soft = true;
        var ngl = r.u16();
        for (var g2 = 0; g2 < ngl; g2++) {
          rec.glyphs.push({ gi: r.u16(), adv: s16r(r) });
        }
        text.records.push(rec);
      }
      doc.texts.push(text);
    }
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

  async function encodeVBD(target, opts) {
    var compress = !opts || opts.compress !== false;
    var body;
    if (target.scenes) {
      body = needsProjectFormat(target)
        ? encodeProjectBody(target)
        : encodeBody(target.activeCell());
    } else {
      body = encodeBody(target);
    }
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
    if (bytes.length <= 5) return false;
    function m(magic) {
      return bytes[0] === magic[0] && bytes[1] === magic[1] &&
             bytes[2] === magic[2] && bytes[3] === magic[3];
    }
    return m(MAGIC) || m(LEGACY_MAGIC);
  }

  function readColor(r) {
    return { r: r.u8(), g: r.u8(), b: r.u8(), a: r.u8() };
  }

  function readStyleCount(r) {
    var n = r.u8();
    return n === 0xff ? r.u16() : n;
  }

  function decodeCell(r, doc, textMode) {
    // textMode: "none" (v1) | "implicit" (v2) | "flagged" (v3 cells)
    var fillCount = readStyleCount(r);
    for (var i = 0; i < fillCount; i++) {
      doc.fills.push(readFillStyle(r));
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
        if (recFlags & 16) throw new Error("y2kvector must not contain NewStyles records");
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

    if (textMode === "implicit") {
      r.align();
      readTextSection(r, doc);
    } else if (textMode === "flagged") {
      r.align();
      if (r.u8() === 1) readTextSection(r, doc);
    }
  }

  function readStr(r) {
    var len = r.u8();
    var raw = "";
    for (var i = 0; i < len; i++) raw += String.fromCharCode(r.u8());
    try { return decodeURIComponent(escape(raw)); } catch (e) { return raw; }
  }

  async function decodeVBD(bytes) {
    if (!isVBD(bytes)) throw new Error("Not a y2kvector file");
    var flags = bytes[4];
    var body = bytes.subarray(5);
    if (flags & 1) body = await inflate(body);

    var r = new VB.BitReader(body, 0);
    var version = r.u8();
    if (version < 1 || version > 4) {
      throw new Error("Unsupported y2kvector version " + version);
    }

    if (version === 3 || version === 4) {
      var stage3 = r.rect();
      var project = new VB.Project(stage3.xmax - stage3.xmin,
                                   stage3.ymax - stage3.ymin);
      project.background = readColor(r);
      project.scenes = [];
      var nScenes = r.u8();
      for (var si = 0; si < nScenes; si++) {
        var scene = { name: readStr(r), layers: [] };
        var nLayers = r.u16();
        for (var li = 0; li < nLayers; li++) {
          var lname = readStr(r);
          var lflags = r.u8();
          var cell = new VB.Y2KVectorDocument();
          cell.width = project.width;
          cell.height = project.height;
          cell.background = project.background;
          decodeCell(r, cell, "flagged");
          scene.layers.push({
            name: lname, visible: !!(lflags & 1), locked: !!(lflags & 2),
            frames: [cell]
          });
        }
        project.scenes.push(scene);
      }
      project.cur.scene = Math.min(r.u8(), project.scenes.length - 1);
      project.cur.layer = Math.min(r.u8(),
        project.scenes[project.cur.scene].layers.length - 1);
      if (version === 4) {
        // v4 = v3 + the GLOBAL material library
        var nMat = readStyleCount(r);
        for (var mi2 = 0; mi2 < nMat; mi2++) {
          project.materials.push(readFillStyle(r));
        }
      } else {
        VB.projectCollectMaterials(project);
      }
      return {
        doc: project.activeCell(), project: project,
        info: { version: version, compressed: !!(flags & 1) }
      };
    }

    var doc = new VB.Y2KVectorDocument();
    var stage = r.rect();
    doc.width = stage.xmax - stage.xmin;
    doc.height = stage.ymax - stage.ymin;
    doc.background = readColor(r);
    decodeCell(r, doc, version === 2 ? "implicit" : "none");

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
  VB.encodeY2KVector = encodeVBD;
  VB.decodeY2KVector = decodeVBD;
  VB.isY2KVector = isVBD;
  VB.y2kvectorStats = vbdStats;
  VB.prepareShapeEdges = prepareShapeEdges; // shared with the SWF exporter
  VB.writeShapeRecords = writeShapeRecords;
})();
