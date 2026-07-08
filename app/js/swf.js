/* swf.js — loads Flash .swf files (SWF7 / MX 2004 era) into a VBDocument.
 *
 * Reads the tag stream up to the first ShowFrame, decodes every
 * DefineShape(1/2/3/4) into planar-map edges, and bakes PlaceObject
 * matrices into edge coordinates (Flash stores whole-drawing shapes
 * placed at the origin, but we handle arbitrary placements).
 *
 * Compression: FWS (none) and CWS (zlib, via native DecompressionStream).
 * ZWS (LZMA) is rejected.
 */
(function () {
  "use strict";

  var TAG = {
    END: 0, SHOW_FRAME: 1, DEFINE_SHAPE: 2, PLACE_OBJECT: 4, REMOVE_OBJECT: 5,
    SET_BACKGROUND_COLOR: 9, DEFINE_TEXT: 11, DEFINE_SHAPE2: 22,
    PLACE_OBJECT2: 26, REMOVE_OBJECT2: 28, DEFINE_SHAPE3: 32,
    DEFINE_TEXT2: 33, DEFINE_EDIT_TEXT: 37, DEFINE_SPRITE: 39,
    FRAME_LABEL: 43, DEFINE_FONT2: 48, DEFINE_SHAPE4: 83
  };

  async function inflateZlib(bytes) {
    // "deflate" in the Compression Streams API means zlib-wrapped deflate,
    // which is exactly what CWS bodies are.
    var ds = new DecompressionStream("deflate");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // ---- style parsing -------------------------------------------------------

  function readColor(r, hasAlpha) {
    var c = { r: r.u8(), g: r.u8(), b: r.u8(), a: 255 };
    if (hasAlpha) c.a = r.u8();
    return c;
  }

  function readMatrix(r) {
    r.align();
    var m = { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 };
    if (r.ub(1)) { var n = r.ub(5); m.sx = r.sb(n) / 65536; m.sy = r.sb(n) / 65536; }
    if (r.ub(1)) { var n2 = r.ub(5); m.r0 = r.sb(n2) / 65536; m.r1 = r.sb(n2) / 65536; }
    var n3 = r.ub(5); m.tx = r.sb(n3); m.ty = r.sb(n3);
    r.align();
    return m;
  }

  function readGradient(r, hasAlpha) {
    r.align();
    var flags = r.u8();
    var count = flags & 0x0f;
    var stops = [];
    for (var i = 0; i < count; i++) {
      stops.push({ ratio: r.u8(), color: readColor(r, hasAlpha) });
    }
    return { spread: flags >> 6, interpolation: (flags >> 4) & 3, stops: stops };
  }

  function readFillStyles(r, shapeVer, warnings) {
    r.align();
    var count = r.u8();
    if (count === 0xff && shapeVer >= 2) count = r.u16();
    var hasAlpha = shapeVer >= 3;
    var styles = [];
    for (var i = 0; i < count; i++) {
      var t = r.u8();
      if (t === 0x00) {
        styles.push({ type: "solid", color: readColor(r, hasAlpha) });
      } else if (t === 0x10 || t === 0x12 || t === 0x13) {
        var g = { type: t === 0x10 ? "linear" : "radial", matrix: readMatrix(r), gradient: readGradient(r, hasAlpha) };
        if (t === 0x13) g.focal = r.u16() / 256;
        styles.push(g);
        warnings.push("gradient fill imported (rendered as first stop color)");
      } else if (t >= 0x40 && t <= 0x43) {
        styles.push({ type: "bitmap", bitmapId: r.u16(), matrix: readMatrix(r) });
        warnings.push("bitmap fill imported (rendered as gray)");
      } else {
        throw new Error("Unknown fill style type 0x" + t.toString(16));
      }
    }
    return styles;
  }

  function readLineStyles(r, shapeVer, warnings) {
    r.align();
    var count = r.u8();
    if (count === 0xff) count = r.u16();
    var styles = [];
    for (var i = 0; i < count; i++) {
      if (shapeVer === 4) {
        // LineStyle2 (DefineShape4) — bit layout per the SWF spec.
        var width = r.u16();
        r.align();
        var startCap = r.ub(2), join = r.ub(2), hasFill = r.ub(1);
        r.ub(1); r.ub(1); r.ub(1); // noHScale, noVScale, pixelHinting
        r.ub(5);                   // reserved
        r.ub(1); r.ub(2);          // noClose, endCap
        if (join === 2) r.u16();   // miter limit
        var color;
        if (hasFill) {
          // A full fill style follows; read it and reduce to a color.
          var f = readOneFillStyle(r, 4, warnings);
          color = f.type === "solid" ? f.color : { r: 0, g: 0, b: 0, a: 255 };
        } else {
          color = readColor(r, true);
        }
        if (startCap !== 0 || join !== 0) warnings.push("LineStyle2 caps/joins reduced to round");
        styles.push({ width: width, color: color });
      } else {
        var w = r.u16();
        styles.push({ width: w, color: readColor(r, shapeVer >= 3) });
      }
    }
    return styles;
  }

  // Reads exactly one fill style entry (used by LineStyle2 HasFill).
  function readOneFillStyle(r, shapeVer, warnings) {
    var t = r.u8();
    var hasAlpha = shapeVer >= 3;
    if (t === 0x00) return { type: "solid", color: readColor(r, hasAlpha) };
    if (t === 0x10 || t === 0x12 || t === 0x13) {
      var g = { type: t === 0x10 ? "linear" : "radial", matrix: readMatrix(r), gradient: readGradient(r, hasAlpha) };
      if (t === 0x13) g.focal = r.u16() / 256;
      return g;
    }
    if (t >= 0x40 && t <= 0x43) return { type: "bitmap", bitmapId: r.u16(), matrix: readMatrix(r) };
    throw new Error("Unknown fill style type 0x" + t.toString(16));
  }

  // ---- shape parsing -------------------------------------------------------

  // Parses a DefineShape body into { edges, warnings } with edges carrying
  // LOCAL 1-based style indices into the returned fills/lines arrays.
  function readShape(r, shapeVer, warnings) {
    var id = r.u16();
    r.rect(); // shape bounds (recomputed on our side; not stored)
    if (shapeVer === 4) {
      r.rect();            // edge bounds
      var flags4 = r.u8();
      if (flags4 & 0x04) warnings.push("DefineShape4 uses non-zero winding (rendered even-odd)");
    }

    var fills = readFillStyles(r, shapeVer, warnings);
    var lines = readLineStyles(r, shapeVer, warnings);
    r.align();
    var numFillBits = r.ub(4), numLineBits = r.ub(4);

    var edges = [];
    // Style-array offsets let NewStyles records extend the arrays while
    // older edges keep valid indices.
    var fillBase = 0, lineBase = 0;
    var penX = 0, penY = 0;
    var f0 = 0, f1 = 0, ln = 0;

    for (;;) {
      if (r.ub(1) === 0) {
        var flags = r.ub(5);
        if (flags === 0) break; // end of shape
        if (flags & 1) { var n = r.ub(5); penX = r.sb(n); penY = r.sb(n); }
        if (flags & 2) { var i0 = r.ub(numFillBits); f0 = i0 === 0 ? 0 : fillBase + i0; }
        if (flags & 4) { var i1 = r.ub(numFillBits); f1 = i1 === 0 ? 0 : fillBase + i1; }
        if (flags & 8) { var il = r.ub(numLineBits); ln = il === 0 ? 0 : lineBase + il; }
        if (flags & 16) {
          fillBase = fills.length; lineBase = lines.length;
          fills = fills.concat(readFillStyles(r, shapeVer, warnings));
          lines = lines.concat(readLineStyles(r, shapeVer, warnings));
          r.align();
          numFillBits = r.ub(4); numLineBits = r.ub(4);
        }
      } else if (r.ub(1)) {
        // straight edge
        var nb = r.ub(4) + 2;
        var dx = 0, dy = 0;
        if (r.ub(1)) { dx = r.sb(nb); dy = r.sb(nb); }
        else if (r.ub(1)) { dy = r.sb(nb); }
        else { dx = r.sb(nb); }
        edges.push(VB.edge(penX, penY, null, null, penX + dx, penY + dy, f0, f1, ln));
        penX += dx; penY += dy;
      } else {
        // curved edge (quadratic)
        var nc = r.ub(4) + 2;
        var cdx = r.sb(nc), cdy = r.sb(nc), adx = r.sb(nc), ady = r.sb(nc);
        var cx = penX + cdx, cy = penY + cdy;
        edges.push(VB.edge(penX, penY, cx, cy, cx + adx, cy + ady, f0, f1, ln));
        penX = cx + adx; penY = cy + ady;
      }
    }
    r.align();
    return { id: id, fills: fills, lines: lines, edges: edges };
  }

  // ---- font / text parsing --------------------------------------------------

  // One glyph's shape stream -> contours in ttf.js emGlyph format
  // ({mx,my,segs:[{x,y}|{cx,cy,x,y}]}, 1024-EM y-down). Style values in
  // the records are read and dropped (glyphs are single-fill by spec).
  function readGlyphShape(r) {
    var fillBits = r.ub(4), lineBits = r.ub(4);
    var contours = [];
    var cur = null;
    var penX = 0, penY = 0;
    for (;;) {
      if (r.ub(1) === 0) {
        var flags = r.ub(5);
        if (flags === 0) break;
        if (flags & 1) {
          var n = r.ub(5);
          penX = r.sb(n); penY = r.sb(n);
          cur = { mx: penX, my: penY, segs: [] };
          contours.push(cur);
        }
        if (flags & 2) r.ub(fillBits);
        if (flags & 4) r.ub(fillBits);
        if (flags & 8) r.ub(lineBits);
      } else if (r.ub(1)) {
        var nb = r.ub(4) + 2;
        var dx = 0, dy = 0;
        if (r.ub(1)) { dx = r.sb(nb); dy = r.sb(nb); }
        else if (r.ub(1)) { dy = r.sb(nb); }
        else { dx = r.sb(nb); }
        penX += dx; penY += dy;
        if (cur) cur.segs.push({ x: penX, y: penY });
      } else {
        var nc = r.ub(4) + 2;
        var cdx = r.sb(nc), cdy = r.sb(nc), adx = r.sb(nc), ady = r.sb(nc);
        var cx = penX + cdx, cy = penY + cdy;
        penX = cx + adx; penY = cy + ady;
        if (cur) cur.segs.push({ cx: cx, cy: cy, x: penX, y: penY });
      }
    }
    return contours;
  }

  function readFont2(body, start) {
    var r = new VB.BitReader(body, start);
    var id = r.u16();
    var flags = r.u8();
    r.u8(); // language code
    var nameLen = r.u8();
    var name = "";
    for (var i = 0; i < nameLen; i++) {
      var ch = r.u8();
      if (ch !== 0) name += String.fromCharCode(ch); // MX NUL-terminates
    }
    var nglyphs = r.u16();
    var wideOffsets = !!(flags & 8);
    var wideCodes = !!(flags & 4);
    var table = r.pos;
    var offs = [];
    for (i = 0; i < nglyphs; i++) offs.push(wideOffsets ? r.u32() : r.u16());
    var codeOff = wideOffsets ? r.u32() : r.u16();
    var glyphs = [];
    for (i = 0; i < nglyphs; i++) {
      var gr = new VB.BitReader(body, table + offs[i]);
      glyphs.push({ code: 0, contours: readGlyphShape(gr) });
    }
    var cr = new VB.BitReader(body, table + codeOff);
    for (i = 0; i < nglyphs; i++) {
      glyphs[i].code = wideCodes ? cr.u16() : cr.u8();
    }
    return {
      id: id, name: name,
      bold: !!(flags & 1), italic: !!(flags & 2),
      glyphs: glyphs
    };
  }

  // DefineText / DefineText2 -> block-local records with resolved
  // font/color/height carry-over. Positions stay block-local twips; the
  // block's own matrix (identity in MX files) composes with the
  // placement matrix at assembly.
  function readText(body, start, ver) {
    var r = new VB.BitReader(body, start);
    var id = r.u16();
    r.rect(); // bounds (recomputed on export)
    var blockMatrix = readMatrix(r);
    var glyphBits = r.u8();
    var advBits = r.u8();
    var records = [];
    var fontId = 0, height = 240;
    var color = { r: 0, g: 0, b: 0, a: 255 };
    var penX = 0, penY = 0;
    for (;;) {
      r.align();
      var flags = r.u8();
      if (flags === 0) break;
      if (flags & 8) fontId = r.u16();
      if (flags & 4) color = readColor(r, ver === 2);
      if (flags & 1) penX = (r.u16() << 16) >> 16; // SI16
      if (flags & 2) penY = (r.u16() << 16) >> 16;
      if (flags & 8) height = r.u16();
      var count = r.u8();
      var glyphs = [];
      for (var g = 0; g < count; g++) {
        glyphs.push({ gi: r.ub(glyphBits), adv: r.sb(advBits) });
      }
      records.push({
        fontId: fontId, height: height,
        color: { r: color.r, g: color.g, b: color.b, a: color.a },
        x: penX, y: penY, glyphs: glyphs
      });
      // pen advances through the record so a follow-up record without
      // an explicit X continues where this one ended
      for (g = 0; g < count; g++) penX += glyphs[g].adv;
    }
    return { id: id, matrix: blockMatrix, records: records };
  }

  // SWF matrix struct -> our [a,b,c,d,tx,ty] (x' = a·x + c·y + tx).
  function matrixToArray(m) {
    if (!m) return [1, 0, 0, 1, 0, 0];
    return [m.sx, m.r0, m.r1, m.sy, m.tx, m.ty];
  }

  function matMul(m2, m1) { // apply m1 first, then m2
    return [
      m2[0] * m1[0] + m2[2] * m1[1],
      m2[1] * m1[0] + m2[3] * m1[1],
      m2[0] * m1[2] + m2[2] * m1[3],
      m2[1] * m1[2] + m2[3] * m1[3],
      m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
      m2[1] * m1[4] + m2[3] * m1[5] + m2[5]
    ];
  }

  // ---- document assembly ---------------------------------------------------

  function bakeMatrix(e, m) {
    function tx(x, y) { return Math.round(m.sx * x + m.r1 * y + m.tx); }
    function ty(x, y) { return Math.round(m.r0 * x + m.sy * y + m.ty); }
    var out = VB.edge(
      tx(e.ax, e.ay), ty(e.ax, e.ay),
      null, null,
      tx(e.bx, e.by), ty(e.bx, e.by),
      e.fill0, e.fill1, e.line);
    if (e.cx !== null) { out.cx = tx(e.cx, e.cy); out.cy = ty(e.cx, e.cy); }
    return out;
  }

  function isIdentity(m) {
    return m.sx === 1 && m.sy === 1 && m.r0 === 0 && m.r1 === 0 && m.tx === 0 && m.ty === 0;
  }

  // Merge one placed shape into the document, remapping style indices.
  function mergeShape(doc, shape, matrix) {
    var fillMap = [0], lineMap = [0];
    for (var i = 0; i < shape.fills.length; i++) {
      doc.fills.push(shape.fills[i]);
      fillMap.push(doc.fills.length);
    }
    for (var j = 0; j < shape.lines.length; j++) {
      doc.lines.push(shape.lines[j]);
      lineMap.push(doc.lines.length);
    }
    var identity = !matrix || isIdentity(matrix);
    for (var k = 0; k < shape.edges.length; k++) {
      var e = shape.edges[k];
      var out = identity ? VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0)
                         : bakeMatrix(e, matrix);
      out.fill0 = fillMap[e.fill0] || 0;
      out.fill1 = fillMap[e.fill1] || 0;
      out.line = lineMap[e.line] || 0;
      doc.edges.push(out);
    }
  }

  // ---- top level -----------------------------------------------------------

  async function parseSWF(arrayBuffer) {
    var raw = new Uint8Array(arrayBuffer);
    if (raw.length < 8) throw new Error("Not a SWF file (too short)");
    var sig = String.fromCharCode(raw[0], raw[1], raw[2]);
    var version = raw[3];
    var body;
    if (sig === "FWS") body = raw.subarray(8);
    else if (sig === "CWS") body = await inflateZlib(raw.subarray(8));
    else if (sig === "ZWS") throw new Error("LZMA-compressed SWF not supported");
    else throw new Error("Not a SWF file (bad signature)");

    var r = new VB.BitReader(body, 0);
    var frameRect = r.rect();
    var fps = r.u16() / 256;
    var frameCount = r.u16();

    var doc = new VB.VBDocument();
    doc.width = frameRect.xmax - frameRect.xmin;
    doc.height = frameRect.ymax - frameRect.ymin;

    var warnings = [];
    var shapes = {};      // character id -> parsed shape
    var textDefs = {};    // character id -> parsed text block
    var fontIndex = {};   // font id -> index into doc.fonts
    var placements = {};  // depth -> { charId, matrix }

    tagLoop:
    while (r.pos < body.length) {
      r.align();
      var codeAndLen = r.u16();
      var code = codeAndLen >> 6;
      var len = codeAndLen & 0x3f;
      if (len === 0x3f) len = r.u32();
      var next = r.pos + len;
      var tr = new VB.BitReader(body, r.pos);

      switch (code) {
        case TAG.END:
          break tagLoop;
        case TAG.SHOW_FRAME:
          break tagLoop; // frame 1 only — VectorBrush documents are single-frame
        case TAG.SET_BACKGROUND_COLOR:
          doc.background = readColor(tr, false);
          break;
        case TAG.DEFINE_SHAPE:
        case TAG.DEFINE_SHAPE2:
        case TAG.DEFINE_SHAPE3:
        case TAG.DEFINE_SHAPE4: {
          var ver = { 2: 1, 22: 2, 32: 3, 83: 4 }[code];
          var shape = readShape(tr, ver, warnings);
          shapes[shape.id] = shape;
          break;
        }
        case TAG.DEFINE_FONT2: {
          var font = readFont2(body, r.pos);
          fontIndex[font.id] = doc.fonts.length;
          doc.fonts.push({
            name: font.name, bold: font.bold, italic: font.italic,
            glyphs: font.glyphs
          });
          break;
        }
        case TAG.DEFINE_TEXT:
        case TAG.DEFINE_TEXT2: {
          var text = readText(body, r.pos, code === TAG.DEFINE_TEXT ? 1 : 2);
          textDefs[text.id] = text;
          break;
        }
        case TAG.DEFINE_EDIT_TEXT:
          warnings.push("dynamic text (DefineEditText) not supported — skipped");
          break;
        case TAG.PLACE_OBJECT: {
          var pid = tr.u16(), pdepth = tr.u16();
          placements[pdepth] = { charId: pid, matrix: readMatrix(tr) };
          break;
        }
        case TAG.PLACE_OBJECT2: {
          var flags = tr.u8();
          var depth = tr.u16();
          var place = placements[depth] || { charId: null, matrix: null };
          if (flags & 0x02) place.charId = tr.u16();
          if (flags & 0x04) place.matrix = readMatrix(tr);
          placements[depth] = place;
          break;
        }
        case TAG.REMOVE_OBJECT:
          tr.u16(); delete placements[tr.u16()];
          break;
        case TAG.REMOVE_OBJECT2:
          delete placements[tr.u16()];
          break;
        default:
          break; // skip everything else (fonts, sounds, actions, ...)
      }
      r.pos = next; r.bit = 0;
    }

    var depths = Object.keys(placements).map(Number).sort(function (a, b) { return a - b; });
    var placedCount = 0, textsPlaced = 0;
    for (var d = 0; d < depths.length; d++) {
      var p = placements[depths[d]];
      if (p.charId === null) continue;
      if (shapes[p.charId]) {
        mergeShape(doc, shapes[p.charId], p.matrix);
        placedCount++;
      } else if (textDefs[p.charId]) {
        // a text block: placement matrix composed over the block's own
        // (identity in MX files); records reference doc.fonts indices.
        // The same definition may be placed at several depths (Break
        // Apart dedupes repeated characters) — each becomes a block.
        var def = textDefs[p.charId];
        var total = matMul(matrixToArray(p.matrix), matrixToArray(def.matrix));
        var records = [];
        var ok = true;
        for (var t = 0; t < def.records.length; t++) {
          var rec = def.records[t];
          if (fontIndex[rec.fontId] === undefined) { ok = false; break; }
          records.push({
            font: fontIndex[rec.fontId], height: rec.height,
            color: { r: rec.color.r, g: rec.color.g, b: rec.color.b, a: rec.color.a },
            x: rec.x, y: rec.y,
            glyphs: rec.glyphs.map(function (g2) { return { gi: g2.gi, adv: g2.adv }; })
          });
        }
        if (ok) { doc.texts.push({ matrix: total, records: records }); textsPlaced++; }
        else warnings.push("text block references a missing font — skipped");
      }
    }
    // Definitions never placed are dropped (they're invisible anyway).

    return {
      doc: doc,
      info: {
        signature: sig, version: version, fps: fps, frames: frameCount,
        shapesDefined: Object.keys(shapes).length, shapesPlaced: placedCount,
        fontsDefined: doc.fonts.length, textsPlaced: textsPlaced,
        warnings: warnings
      }
    };
  }

  window.VB = window.VB || {};
  VB.parseSWF = parseSWF;
})();
