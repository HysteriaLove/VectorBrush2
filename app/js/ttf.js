/* ttf.js — TrueType font parser for the text tool.
 *
 * Reads the tables needed to author SWF text: cmap (char -> glyph),
 * glyf/loca (outlines), hmtx (advances), hhea (metrics), kern
 * (pair adjustments), name (family). TrueType outlines are quadratic
 * Béziers — the same curve type as SWF edge records — so conversion
 * to DefineFont2 glyph space is lossless in kind:
 *
 *   EM = coord * 1024/unitsPerEm, y negated (TTF y-up -> SWF y-down),
 *   rounded half-up (floor(v+0.5)) on the REAL points; implied quad
 *   anchors are midpoints of the ROUNDED controls; quads whose rounded
 *   control is exactly collinear with its anchors collapse to lines.
 *
 * These rules were reverse-engineered from MX2004's own embeddings
 * (SWFExamples/Font001): coordinates match MX within ±1/1024 EM — MX
 * converts from HINTED outlines, which we deliberately don't replicate
 * (it would need a TrueType instruction interpreter; the deviation is
 * ~0.02px at render sizes).
 */
(function () {
  "use strict";

  function halfUp(v) { return Math.floor(v + 0.5); }

  function Reader(bytes) {
    this.d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }
  Reader.prototype.u8 = function (p) { return this.d[p]; };
  Reader.prototype.u16 = function (p) { return (this.d[p] << 8) | this.d[p + 1]; };
  Reader.prototype.s16 = function (p) {
    var v = this.u16(p);
    return v & 0x8000 ? v - 0x10000 : v;
  };
  Reader.prototype.u32 = function (p) {
    return ((this.d[p] << 24) | (this.d[p + 1] << 16) |
            (this.d[p + 2] << 8) | this.d[p + 3]) >>> 0;
  };
  Reader.prototype.tag = function (p) {
    return String.fromCharCode(this.d[p], this.d[p + 1], this.d[p + 2], this.d[p + 3]);
  };

  function parseTTF(bytes, faceIndex) {
    var r = new Reader(bytes);
    var base = 0;
    if (r.tag(0) === "ttcf") {
      var nfaces = r.u32(8);
      var fi = Math.min(faceIndex || 0, nfaces - 1);
      base = r.u32(12 + 4 * fi);
    }
    var numTables = r.u16(base + 4);
    var tables = {};
    for (var i = 0; i < numTables; i++) {
      var rec = base + 12 + 16 * i;
      tables[r.tag(rec)] = { off: r.u32(rec + 8), len: r.u32(rec + 12) };
    }
    function need(tag) {
      if (!tables[tag]) throw new Error("font missing " + tag + " table");
      return tables[tag].off;
    }

    var head = need("head");
    var unitsPerEm = r.u16(head + 18);
    var locaLong = r.s16(head + 50) === 1;
    var maxp = need("maxp");
    var numGlyphs = r.u16(maxp + 4);
    var hhea = need("hhea");
    var ascent = r.s16(hhea + 4);
    var descent = r.s16(hhea + 6);
    var lineGap = r.s16(hhea + 8);
    var numHMetrics = r.u16(hhea + 34);
    // OS/2 win metrics: MX2004's text baselines match usWinAscent
    // (Times 12pt yoff 220/240 = 1877/2048 exactly)
    var winAscent = ascent, winDescent = -descent;
    if (tables["OS/2"] && tables["OS/2"].len >= 78) {
      winAscent = r.u16(tables["OS/2"].off + 74);
      winDescent = r.u16(tables["OS/2"].off + 76);
    }
    var hmtx = need("hmtx");
    var loca = need("loca");
    var glyf = need("glyf");

    // ---- cmap: format 4, Windows Unicode (3,1) preferred; symbol
    // fonts (3,0) map chars at 0xF000+code ----
    var cmap = need("cmap");
    var sub = null, symbol = false;
    var nsub = r.u16(cmap + 2);
    for (i = 0; i < nsub; i++) {
      var pid = r.u16(cmap + 4 + 8 * i);
      var eid = r.u16(cmap + 6 + 8 * i);
      var soff = r.u32(cmap + 8 + 8 * i);
      if (pid === 3 && eid === 1) { sub = cmap + soff; symbol = false; break; }
      if (pid === 0 && eid === 3 && sub === null) { sub = cmap + soff; symbol = false; }
      if (pid === 3 && eid === 0) { sub = cmap + soff; symbol = true; }
    }
    if (sub === null || r.u16(sub) !== 4) {
      throw new Error("no usable cmap (format 4) subtable");
    }
    var segCount = r.u16(sub + 6) / 2;
    var endsAt = sub + 14;
    var startsAt = endsAt + 2 * segCount + 2;
    var deltasAt = startsAt + 2 * segCount;
    var rangeAt = deltasAt + 2 * segCount;
    function cmapLookup(code) {
      for (var s = 0; s < segCount; s++) {
        if (code > r.u16(endsAt + 2 * s)) continue;
        if (code < r.u16(startsAt + 2 * s)) return 0;
        var ro = r.u16(rangeAt + 2 * s);
        if (ro === 0) return (code + r.s16(deltasAt + 2 * s)) & 0xFFFF;
        var addr = rangeAt + 2 * s + ro + 2 * (code - r.u16(startsAt + 2 * s));
        var g = r.u16(addr);
        return g === 0 ? 0 : (g + r.s16(deltasAt + 2 * s)) & 0xFFFF;
      }
      return 0;
    }
    function glyphIndex(code) {
      if (symbol) {
        // symbol fonts (3,0) map chars in the 0xF000 private-use page
        var s2 = cmapLookup(0xF000 | (code & 0xFF));
        if (s2) return s2;
      }
      return cmapLookup(code);
    }

    // ---- name: family (nameID 1), Windows Unicode preferred ----
    var family = "";
    if (tables.name) {
      var nm = tables.name.off;
      var count = r.u16(nm + 2);
      var strBase = nm + r.u16(nm + 4);
      var bestScore = -1;
      for (i = 0; i < count; i++) {
        var e = nm + 6 + 12 * i;
        if (r.u16(e + 6) !== 1) continue; // nameID 1 = family
        var p = r.u16(e), enc = r.u16(e + 2);
        var score = (p === 3 && enc === 1) ? 2 : (p === 1 ? 1 : 0);
        if (score <= bestScore) continue;
        bestScore = score;
        var len = r.u16(e + 8), off = strBase + r.u16(e + 10);
        var s = "";
        if (p === 3) {
          for (var k = 0; k + 1 < len; k += 2) s += String.fromCharCode(r.u16(off + k));
        } else {
          for (k = 0; k < len; k++) s += String.fromCharCode(r.u8(off + k));
        }
        family = s;
      }
    }

    // ---- kern: format 0, horizontal ----
    var kernPairs = null;
    if (tables.kern) {
      var kt = tables.kern.off;
      var ntab = r.u16(kt + 2);
      var p2 = kt + 4;
      for (i = 0; i < ntab; i++) {
        var klen = r.u16(p2 + 2);
        var cov = r.u16(p2 + 4);
        if ((cov & 1) && ((cov >> 8) === 0)) { // horizontal, format 0
          kernPairs = { at: p2 + 6, n: r.u16(p2 + 6) };
          break;
        }
        p2 += klen;
      }
    }
    function kern(a, b) {
      if (!kernPairs) return 0;
      var key = a * 65536 + b;
      var lo = 0, hi = kernPairs.n - 1, at = kernPairs.at + 8;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        var k = r.u16(at + 6 * mid) * 65536 + r.u16(at + 6 * mid + 2);
        if (k === key) return r.s16(at + 6 * mid + 4);
        if (k < key) lo = mid + 1; else hi = mid - 1;
      }
      return 0;
    }

    function locaOff(gi) {
      return locaLong ? r.u32(loca + 4 * gi) : r.u16(loca + 2 * gi) * 2;
    }

    function advance(gi) {
      if (gi < numHMetrics) return r.u16(hmtx + 4 * gi);
      return r.u16(hmtx + 4 * (numHMetrics - 1));
    }

    /** Raw contours of glyph gi in FONT units (y-up floats after
     *  composite transforms): [[{x, y, on}]] */
    function contours(gi, xf) {
      var lo = locaOff(gi), hi = locaOff(gi + 1);
      if (lo === hi) return [];
      var g = glyf + lo;
      var ncont = r.s16(g);
      xf = xf || [1, 0, 0, 1, 0, 0];
      var out = [];
      if (ncont < 0) {
        // composite: flatten components through their matrices
        var p = g + 10;
        for (;;) {
          var flags = r.u16(p), comp = r.u16(p + 2);
          p += 4;
          var a1, a2;
          if (flags & 1) { a1 = r.s16(p); a2 = r.s16(p + 2); p += 4; }
          else {
            a1 = r.u8(p); a2 = r.u8(p + 1);
            if (a1 & 0x80) a1 -= 256;
            if (a2 & 0x80) a2 -= 256;
            p += 2;
          }
          var sa = 1, sb = 0, sc = 0, sd = 1;
          if (flags & 8) { sa = sd = r.s16(p) / 16384; p += 2; }
          else if (flags & 0x40) { sa = r.s16(p) / 16384; sd = r.s16(p + 2) / 16384; p += 4; }
          else if (flags & 0x80) {
            sa = r.s16(p) / 16384; sb = r.s16(p + 2) / 16384;
            sc = r.s16(p + 4) / 16384; sd = r.s16(p + 6) / 16384; p += 8;
          }
          var dx = (flags & 2) ? a1 : 0, dy = (flags & 2) ? a2 : 0;
          var sub2 = [
            sa * xf[0] + sb * xf[2], sa * xf[1] + sb * xf[3],
            sc * xf[0] + sd * xf[2], sc * xf[1] + sd * xf[3],
            dx * xf[0] + dy * xf[2] + xf[4], dx * xf[1] + dy * xf[3] + xf[5]
          ];
          var inner = contours(comp, sub2);
          for (var ci = 0; ci < inner.length; ci++) out.push(inner[ci]);
          if (!(flags & 0x20)) break;
        }
        return out;
      }
      var endPts = [];
      for (var c = 0; c < ncont; c++) endPts.push(r.u16(g + 10 + 2 * c));
      var npts = endPts[ncont - 1] + 1;
      var p3 = g + 10 + 2 * ncont;
      var nins = r.u16(p3);
      p3 += 2 + nins;
      var flags2 = [];
      while (flags2.length < npts) {
        var fl = r.u8(p3++);
        flags2.push(fl);
        if (fl & 8) {
          var rep = r.u8(p3++);
          for (var q = 0; q < rep; q++) flags2.push(fl);
        }
      }
      var xs = [], x = 0;
      for (i = 0; i < npts; i++) {
        fl = flags2[i];
        if (fl & 2) { var d1 = r.u8(p3++); x += (fl & 16) ? d1 : -d1; }
        else if (!(fl & 16)) { x += r.s16(p3); p3 += 2; }
        xs.push(x);
      }
      var ys = [], y = 0;
      for (i = 0; i < npts; i++) {
        fl = flags2[i];
        if (fl & 4) { var d2 = r.u8(p3++); y += (fl & 32) ? d2 : -d2; }
        else if (!(fl & 32)) { y += r.s16(p3); p3 += 2; }
        ys.push(y);
      }
      var s0 = 0;
      for (c = 0; c < ncont; c++) {
        var pts = [];
        for (i = s0; i <= endPts[c]; i++) {
          pts.push({
            x: xs[i] * xf[0] + ys[i] * xf[2] + xf[4],
            y: xs[i] * xf[1] + ys[i] * xf[3] + xf[5],
            on: !!(flags2[i] & 1)
          });
        }
        out.push(pts);
        s0 = endPts[c] + 1;
      }
      return out;
    }

    var emCache = {};
    /** Glyph gi in DefineFont2 space: 1024 EM, y-down, integer coords.
     *  Returns [{mx, my, segs:[{x,y} line | {cx,cy,x,y} quad]}]. */
    function emGlyph(gi) {
      if (emCache[gi]) return emCache[gi];
      var scale = 1024 / unitsPerEm;
      var raw = contours(gi);
      var out = [];
      for (var ci = 0; ci < raw.length; ci++) {
        var rp = raw[ci].map(function (p) {
          return { x: halfUp(p.x * scale), y: halfUp(-p.y * scale), on: p.on };
        });
        if (!rp.length) continue;
        // start on an on-curve point (synthesize the midpoint if the
        // contour is all off-curve)
        var si = -1;
        for (var j = 0; j < rp.length; j++) if (rp[j].on) { si = j; break; }
        if (si < 0) {
          rp.unshift({
            x: halfUp((rp[0].x + rp[rp.length - 1].x) / 2),
            y: halfUp((rp[0].y + rp[rp.length - 1].y) / 2), on: true
          });
          si = 0;
        }
        rp = rp.slice(si).concat(rp.slice(0, si));
        rp.push(rp[0]); // close
        var segs = [];
        var cur = { x: rp[0].x, y: rp[0].y };
        function pushLine(x2, y2) {
          if (x2 === cur.x && y2 === cur.y) return;
          segs.push({ x: x2, y: y2 });
          cur = { x: x2, y: y2 };
        }
        function pushQuad(cx2, cy2, x2, y2) {
          // rounded control exactly on the chord -> plain line
          var cross = (x2 - cur.x) * (cy2 - cur.y) - (y2 - cur.y) * (cx2 - cur.x);
          if (cross === 0) { pushLine(x2, y2); return; }
          segs.push({ cx: cx2, cy: cy2, x: x2, y: y2 });
          cur = { x: x2, y: y2 };
        }
        var i2 = 1;
        while (i2 < rp.length) {
          var pt = rp[i2];
          if (pt.on) { pushLine(pt.x, pt.y); i2++; continue; }
          var nxt = i2 + 1 < rp.length ? rp[i2 + 1] : rp[0];
          if (nxt.on) { pushQuad(pt.x, pt.y, nxt.x, nxt.y); i2 += 2; }
          else {
            pushQuad(pt.x, pt.y,
                     halfUp((pt.x + nxt.x) / 2), halfUp((pt.y + nxt.y) / 2));
            i2++;
          }
        }
        // explicit close if rounding left the pen off the start
        pushLine(rp[0].x, rp[0].y);
        out.push({ mx: rp[0].x, my: rp[0].y, segs: segs });
      }
      emCache[gi] = out;
      return out;
    }

    return {
      unitsPerEm: unitsPerEm,
      numGlyphs: numGlyphs,
      family: family,
      ascent: ascent,
      descent: descent,
      lineGap: lineGap,
      winAscent: winAscent,
      winDescent: winDescent,
      glyphIndex: glyphIndex,
      advance: advance,
      kern: kern,
      contours: contours,
      emGlyph: emGlyph
    };
  }

  window.VB = window.VB || {};
  VB.parseTTF = parseTTF;
})();
