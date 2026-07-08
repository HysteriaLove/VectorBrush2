/* text.js — the Text tool (T): Flash-style static text authoring.
 *
 * Editing is a SESSION (like the arrow float and transform sessions):
 * click places a caret, typing goes through a hidden textarea (native
 * caret/selection/clipboard/IME semantics for free) and renders live
 * from the real glyph outlines; clicking away or switching tools lands
 * the whole block as ONE journal op. Empty blocks record nothing.
 *
 * Determinism: the textCreate op is SELF-CONTAINED — it carries the
 * font subset (glyph outlines in DefineFont2's 1024-EM space) and the
 * advances baked at authoring time (hmtx + kern scaled to twips, the
 * same metrics MX2004 bakes into its text records). Replay never
 * touches installed fonts.
 *
 * Fonts come from the local system (queryLocalFonts, lazily parsed) or
 * dropped .ttf files, via ttf.js.
 */
(function () {
  "use strict";

  // ---- core ops (journal-replayable) ----------------------------------------

  /** Merge a font subset into doc.fonts (dedupe by name+style, union of
   *  glyphs by character code) and return {fontIndex, giMap} where
   *  giMap[i] is the doc-side glyph index for opFont.glyphs[i]. */
  function mergeFont(doc, opFont) {
    var idx = -1;
    for (var i = 0; i < doc.fonts.length; i++) {
      var f = doc.fonts[i];
      if (f.name === opFont.name && !!f.bold === !!opFont.bold &&
          !!f.italic === !!opFont.italic) { idx = i; break; }
    }
    if (idx < 0) {
      doc.fonts.push({
        name: opFont.name, bold: !!opFont.bold, italic: !!opFont.italic,
        glyphs: []
      });
      idx = doc.fonts.length - 1;
    }
    var font = doc.fonts[idx];
    var byCode = {};
    for (var g = 0; g < font.glyphs.length; g++) byCode[font.glyphs[g].code] = g;
    var giMap = [];
    for (var k = 0; k < opFont.glyphs.length; k++) {
      var og = opFont.glyphs[k];
      if (byCode[og.code] !== undefined) {
        giMap.push(byCode[og.code]);
      } else {
        font.glyphs.push({
          code: og.code,
          contours: JSON.parse(JSON.stringify(og.contours))
        });
        byCode[og.code] = font.glyphs.length - 1;
        giMap.push(font.glyphs.length - 1);
      }
    }
    return { fontIndex: idx, giMap: giMap };
  }

  /** Apply a textCreate op: op = { font:{name,bold,italic,glyphs},
   *  matrix, records:[{height,color,x,y,str?,glyphs:[{gi,adv}]}] }.
   *  gi indexes the OP's font glyph list and is remapped. */
  function opRecords(merged, records) {
    return records.map(function (rec) {
      var out = {
        font: merged.fontIndex,
        height: rec.height,
        color: { r: rec.color.r, g: rec.color.g, b: rec.color.b, a: rec.color.a },
        x: rec.x, y: rec.y,
        glyphs: rec.glyphs.map(function (g) {
          return { gi: merged.giMap[g.gi], adv: g.adv };
        })
      };
      if (rec.soft) out.soft = true;
      return out;
    });
  }

  function textApplyOp(doc, op) {
    var merged = mergeFont(doc, op.font);
    var block = {
      matrix: op.matrix.slice(),
      records: opRecords(merged, op.records),
      wrapWidth: op.wrapWidth || null,
      pitch: op.pitch || null
    };
    doc.texts.push(block);
    return doc.texts.length - 1;
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

  /** Transform a block: compose a world-space matrix ONTO its own
   *  (text stays text under move/rotate/scale, like Flash). */
  function textTransformApply(doc, index, m) {
    var t = doc.texts[index];
    if (!t) return false;
    t.matrix = matMul(m, t.matrix);
    return true;
  }

  function textDeleteApply(doc, index) {
    if (index < 0 || index >= doc.texts.length) return false;
    doc.texts.splice(index, 1);
    return true;
  }

  /** Replace a block's content (records + font subset), keeping its
   *  placement matrix — the edit-session commit. Self-contained like
   *  textCreate. */
  function textEditApply(doc, op) {
    var t = doc.texts[op.index];
    if (!t) return false;
    var merged = mergeFont(doc, op.font);
    t.records = opRecords(merged, op.records);
    t.wrapWidth = op.wrapWidth || null;
    t.pitch = op.pitch || t.pitch || null;
    if (op.matrix) t.matrix = op.matrix.slice(); // box origin moved
    return true;
  }

  /** Block-LOCAL bounds (before the matrix) from the actual glyph
   *  contours, with an advance/height fallback for empty glyphs. */
  function textBlockBounds(doc, block) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    block.records.forEach(function (rec) {
      var font = doc.fonts[rec.font];
      var scale = rec.height / 1024;
      var penX = rec.x;
      rec.glyphs.forEach(function (g) {
        var glyph = font && font.glyphs[g.gi];
        if (glyph && glyph.contours.length) {
          glyph.contours.forEach(function (c) {
            var px = penX + c.mx * scale, py = rec.y + c.my * scale;
            x0 = Math.min(x0, px); x1 = Math.max(x1, px);
            y0 = Math.min(y0, py); y1 = Math.max(y1, py);
            c.segs.forEach(function (s) {
              var sx = penX + s.x * scale, sy = rec.y + s.y * scale;
              x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
              y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
            });
          });
        }
        penX += g.adv;
      });
      // baseline box fallback so spaces/empty lines stay grabbable
      x0 = Math.min(x0, rec.x); x1 = Math.max(x1, penX);
      y0 = Math.min(y0, rec.y - rec.height); y1 = Math.max(y1, rec.y);
    });
    if (!isFinite(x0)) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /** Break a block apart into planar-map geometry: every glyph outline
   *  is instantiated through the pen position, the EM scale and the
   *  block matrix (affine keeps quads quads), then merged through the
   *  boolean-mask pipeline with EVEN-ODD stamping — Flash's fill rule,
   *  which makes letter counters holes regardless of orientation. One
   *  mask pass per record (records never share borders). */
  function textBreakApply(doc, index) {
    var t = doc.texts[index];
    if (!t) return false;
    doc.texts.splice(index, 1);
    var m = t.matrix;
    t.records.forEach(function (rec) {
      var font = doc.fonts[rec.font];
      if (!font) return;
      var scale = rec.height / 1024;
      var fitted = [];
      var penX = rec.x;
      rec.glyphs.forEach(function (g) {
        var glyph = font.glyphs[g.gi];
        if (glyph) {
          glyph.contours.forEach(function (c) {
            function tp(x, y) {
              var lx = penX + x * scale, ly = rec.y + y * scale;
              return {
                x: Math.round(m[0] * lx + m[2] * ly + m[4]),
                y: Math.round(m[1] * lx + m[3] * ly + m[5])
              };
            }
            var prev = tp(c.mx, c.my);
            c.segs.forEach(function (s) {
              var to = tp(s.x, s.y);
              var e = s.cx === undefined
                ? VB.edge(prev.x, prev.y, null, null, to.x, to.y, 0, 0, 0)
                : (function () {
                    var ct = tp(s.cx, s.cy);
                    return VB.edge(prev.x, prev.y, ct.x, ct.y, to.x, to.y, 0, 0, 0);
                  })();
              if (!VB.edgeIsDegenerate(e)) fitted.push(e);
              prev = to;
            });
          });
        }
        penX += g.adv;
      });
      if (!fitted.length) return;
      var fillIdx = doc.addFillStyle({
        type: "solid",
        color: { r: rec.color.r, g: rec.color.g, b: rec.color.b, a: rec.color.a }
      });
      var winding = fitted.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, 0, 0, 0);
      });
      var preOp = new VB.VBDocument();
      preOp.width = doc.width; preOp.height = doc.height;
      preOp.fills = doc.fills; preOp.lines = doc.lines;
      preOp.edges = doc.edges.map(function (e) {
        return VB.edge(e.ax, e.ay, e.cx, e.cy, e.bx, e.by, e.fill0, e.fill1, e.line);
      });
      var adopted = VB.adoptIdenticalEdges(doc, fitted);
      var pieces = VB.nodeEdges(doc, adopted.fresh);
      for (var k = 0; k < pieces.length; k++) doc.edges.push(pieces[k]);
      VB.applyRegionMask(doc, preOp, function (x, y) {
        return (VB.geom.windingNumber(winding, x, y) & 1) === 1;
      }, fillIdx, pieces.concat(adopted.twins));
    });
    return true;
  }

  /** Topmost block whose LOCAL bounds contain the stage point, or -1. */
  function textHit(doc, x, y) {
    for (var i = doc.texts.length - 1; i >= 0; i--) {
      var t = doc.texts[i];
      var b = textBlockBounds(doc, t);
      if (!b) continue;
      var m = t.matrix;
      var det = m[0] * m[3] - m[1] * m[2];
      if (Math.abs(det) < 1e-9) continue;
      var ix = (m[3] * (x - m[4]) - m[2] * (y - m[5])) / det;
      var iy = (-m[1] * (x - m[4]) + m[0] * (y - m[5])) / det;
      if (ix >= b.x0 && ix <= b.x1 && iy >= b.y0 && iy <= b.y1) return i;
    }
    return -1;
  }

  // ---- authoring layout ------------------------------------------------------

  /** Greedy word-wrap of a glyph run: break after the last space that
   *  fits (the space stays on the wrapped line), or mid-word when a
   *  single word overflows. width null/0 = point text (no wrap). */
  function wrapRun(run, width) {
    if (!width) return run.length ? [run] : [];
    var lines = [];
    var cur = [], curW = 0, lastSpace = -1;
    for (var i = 0; i < run.length; i++) {
      cur.push(run[i]);
      curW += run[i].adv;
      if (run[i].code === 32) lastSpace = cur.length - 1;
      if (curW > width && cur.length > 1) {
        var cut = lastSpace >= 0 ? lastSpace + 1 : cur.length - 1;
        if (cut < 1) cut = 1;
        lines.push(cur.slice(0, cut));
        cur = cur.slice(cut);
        curW = 0;
        lastSpace = -1;
        for (var j = 0; j < cur.length; j++) {
          curW += cur[j].adv;
          if (cur[j].code === 32) lastSpace = j;
        }
      }
    }
    if (cur.length) lines.push(cur);
    return lines;
  }

  /** Lay a string out with a parsed TTF into a self-contained textCreate
   *  op. sizeTw = point size in twips (Flash: height field). Advances
   *  bake hmtx + kerning at authoring time, like MX2004. wrapWidth
   *  (block-local twips) makes it a fixed-width box: lines wrap at
   *  spaces, continuation records are marked soft so edits and later
   *  re-wraps can reassemble the paragraphs. */
  function buildTextOp(ttf, meta, str, sizeTw, color, x, y, wrapWidth) {
    var scale = sizeTw / ttf.unitsPerEm;
    var subset = [];       // op font glyph list
    var subsetByCode = {};
    function opGi(code) {
      if (subsetByCode[code] !== undefined) return subsetByCode[code];
      var gi = ttf.glyphIndex(code);
      subset.push({ code: code, contours: ttf.emGlyph(gi) });
      subsetByCode[code] = subset.length - 1;
      return subset.length - 1;
    }
    var baseline = Math.round(ttf.winAscent * scale);
    var pitch = Math.round((ttf.winAscent + ttf.winDescent) * scale);
    var records = [];
    var lineNo = 0;
    str.split("\n").forEach(function (para) {
      var run = [];
      for (var ci = 0; ci < para.length; ci++) {
        var code = para.charCodeAt(ci);
        var gi = ttf.glyphIndex(code);
        var adv = ttf.advance(gi);
        if (ci + 1 < para.length) {
          adv += ttf.kern(gi, ttf.glyphIndex(para.charCodeAt(ci + 1)));
        }
        run.push({ code: code, gi: opGi(code), adv: Math.round(adv * scale) });
      }
      var lines = wrapRun(run, wrapWidth);
      if (!lines.length) { lineNo++; return; } // blank line advances y
      lines.forEach(function (line, li) {
        records.push({
          height: sizeTw,
          color: { r: color.r, g: color.g, b: color.b, a: color.a },
          x: 0, y: baseline + lineNo * pitch,
          soft: li > 0,
          str: line.map(function (e2) { return String.fromCharCode(e2.code); }).join(""),
          glyphs: line.map(function (e2) { return { gi: e2.gi, adv: e2.adv }; })
        });
        lineNo++;
      });
    });
    if (records.length === 0) return null;
    return {
      op: "textCreate",
      font: { name: meta.name, bold: !!meta.bold, italic: !!meta.italic,
              glyphs: subset },
      matrix: [1, 0, 0, 1, Math.round(x), Math.round(y)],
      records: records,
      wrapWidth: wrapWidth || null,
      pitch: pitch
    };
  }

  /** Re-wrap a block to a new box width using ONLY its stored records
   *  (advances and codes are baked in, so no font file is needed —
   *  imported MX text re-wraps too). Soft continuations first rejoin
   *  their paragraph, then each paragraph re-breaks. dx (optional,
   *  block-local) shifts the origin — dragging the LEFT tab keeps the
   *  right edge planted. */
  function textWrapApply(doc, index, width, dx) {
    var t = doc.texts[index];
    if (!t || !t.records.length) return false;
    var font = doc.fonts[t.records[0].font];
    if (!font) return false;
    var pitch = t.pitch;
    if (!pitch) {
      pitch = t.records.length > 1
        ? Math.abs(t.records[1].y - t.records[0].y)
        : Math.round(t.records[0].height * 1.2);
      if (!pitch) pitch = Math.round(t.records[0].height * 1.2);
    }
    var paras = [];
    t.records.forEach(function (rec) {
      if (rec.soft && paras.length) {
        var last = paras[paras.length - 1];
        last.glyphs = last.glyphs.concat(rec.glyphs);
      } else {
        paras.push({ rec0: rec, glyphs: rec.glyphs.slice() });
      }
    });
    var y0 = t.records[0].y;
    var out = [];
    var lineNo = 0;
    paras.forEach(function (p) {
      var run = p.glyphs.map(function (g) {
        var glyph = font.glyphs[g.gi];
        return { gi: g.gi, adv: g.adv, code: glyph ? glyph.code : 0 };
      });
      var lines = wrapRun(run, width);
      if (!lines.length) { lineNo++; return; }
      lines.forEach(function (line, li) {
        var rec = {
          font: p.rec0.font, height: p.rec0.height,
          color: { r: p.rec0.color.r, g: p.rec0.color.g,
                   b: p.rec0.color.b, a: p.rec0.color.a },
          x: p.rec0.x, y: y0 + lineNo * pitch,
          glyphs: line.map(function (e2) { return { gi: e2.gi, adv: e2.adv }; })
        };
        if (li > 0) rec.soft = true; // presence-only, like the codecs
        out.push(rec);
        lineNo++;
      });
    });
    t.records = out;
    t.wrapWidth = width || null;
    t.pitch = pitch;
    if (dx) t.matrix = matMul(t.matrix, [1, 0, 0, 1, dx, 0]);
    return true;
  }

  // ---- font manager ------------------------------------------------------------

  var fonts = {
    entries: [],   // {label, family, style, parsed?, ref? (FontData), buffer?}
    listeners: [],
    onChange: function (fn) { this.listeners.push(fn); },
    changed: function () {
      this.listeners.forEach(function (fn) { fn(); });
    },
    find: function (label) {
      for (var i = 0; i < this.entries.length; i++) {
        if (this.entries[i].label === label) return this.entries[i];
      }
      return null;
    },
    addBuffer: function (name, buf) {
      var parsed = VB.parseTTF(buf);
      var family = parsed.family || name.replace(/\.[^.]+$/, "");
      var style = parsed.subfamily || "Regular";
      // Bold/Italic faces are their own dropdown entries; the regular
      // weight goes by many names (DejaVu says "Book")
      var isRegular = /^(regular|book|roman|normal)$/i.test(style);
      var label = isRegular ? family : family + " " + style;
      var e = this.find(label);
      if (!e) {
        e = { label: label, family: family, style: style };
        this.entries.push(e);
      }
      e.parsed = parsed;
      this.changed();
      return e;
    },
    loadLocal: async function () {
      if (!window.queryLocalFonts) {
        throw new Error("this browser has no local font access — drop a .ttf instead");
      }
      var all = await window.queryLocalFonts();
      var seen = {};
      var self = this;
      all.forEach(function (fd) {
        // one entry per family; prefer the Regular style
        var cur = seen[fd.family];
        if (!cur || fd.style === "Regular") seen[fd.family] = cur && fd.style !== "Regular" ? cur : fd;
      });
      Object.keys(seen).sort().forEach(function (fam) {
        if (!self.find(fam)) {
          self.entries.push({ label: fam, family: fam,
                              style: seen[fam].style, ref: seen[fam] });
        }
      });
      this.changed();
      return this.entries.length;
    },
    ensureParsed: async function (label) {
      var e = this.find(label);
      if (!e) throw new Error("unknown font " + label);
      if (e.parsed) return e.parsed;
      var blob = await e.ref.blob();
      e.parsed = VB.parseTTF(await blob.arrayBuffer());
      return e.parsed;
    }
  };

  // ---- interactive tool ----------------------------------------------------------

  var TEXT_CURSOR = "text";

  function TextTool(app) {
    var self = {
      app: app,
      session: null, // {x, y, ttf, meta, sizeTw, color, area, preview, caretOn}
      caretTimer: null
    };

    function fontLabel() {
      var sel = document.getElementById("text-font");
      return sel && sel.value ? sel.value : null;
    }
    function sizeTw() {
      var inp = document.getElementById("text-size");
      var pt = inp ? parseFloat(inp.value) || 24 : 24;
      return Math.round(pt * 20);
    }

    function makeArea(x, y) {
      var area = document.createElement("textarea");
      area.id = "text-input";
      area.setAttribute("autocomplete", "off");
      area.setAttribute("spellcheck", "false");
      area.style.cssText =
        "position:absolute; width:2px; height:2px; padding:0; border:0;" +
        "opacity:0.01; resize:none; overflow:hidden; z-index:5;" +
        "left:" + Math.round(x) + "px; top:" + Math.round(y) + "px;";
      document.getElementById("canvaswrap").appendChild(area);
      return area;
    }

    function rebuildPreview() {
      var s = self.session;
      if (!s) return;
      var op = buildTextOp(s.ttf, s.meta, s.area.value, s.sizeTw, s.color,
                           0, 0, s.wrapWidth);
      if (op) {
        var doc = { fonts: [], texts: [] };
        textApplyOp(doc, op);
        doc.texts[0].matrix = s.matrix.slice();
        s.preview = { doc: doc, block: doc.texts[0] };
      } else {
        s.preview = null;
      }
      app.requestRender();
    }

    /** The session's box in block-LOCAL space: hugs the text but never
     *  narrower than the set wrap width (Flash shows the box you set). */
    function sessionBox() {
      var s = self.session;
      if (!s) return null;
      var scale = s.sizeTw / s.ttf.unitsPerEm;
      var box = {
        x0: 0, y0: 0,
        x1: s.wrapWidth || Math.round(s.sizeTw),
        y1: Math.round((s.ttf.winAscent + s.ttf.winDescent) * scale)
      };
      if (s.preview) {
        var bb = textBlockBounds(s.preview.doc, s.preview.block);
        if (bb) {
          box.x0 = Math.min(box.x0, bb.x0);
          box.y0 = Math.min(box.y0, bb.y0);
          box.x1 = Math.max(box.x1, s.wrapWidth || bb.x1);
          box.y1 = Math.max(box.y1, bb.y1);
        }
      }
      return box;
    }

    /** Start an editing session at stage position (twips). */
    async function startSession(pos, screen) {
      var label = fontLabel();
      if (!label) {
        // first use: try the system font list (needs this user gesture)
        try {
          await fonts.loadLocal();
          app.setMsg("fonts loaded — pick one and click again");
        } catch (err) {
          app.setMsg("load a font first: press Fonts… or drop a .ttf on the canvas");
        }
        return;
      }
      var ttf;
      try {
        ttf = await fonts.ensureParsed(label);
      } catch (err) {
        app.setMsg("font failed to load: " + err.message);
        return;
      }
      var entry = fonts.find(label);
      var style = (entry.style || "").toLowerCase();
      beginSession({
        matrix: [1, 0, 0, 1, Math.round(pos.x), Math.round(pos.y)],
        editIndex: null,
        stash: null,
        original: "",
        wrapWidth: null,
        ttf: ttf,
        meta: { name: entry.family || label,
                bold: style.indexOf("bold") >= 0,
                italic: style.indexOf("italic") >= 0 || style.indexOf("oblique") >= 0 },
        sizeTw: sizeTw(),
        color: { r: app.fillColor.r, g: app.fillColor.g, b: app.fillColor.b, a: app.fillColor.a }
      }, screen, "");
      app.setMsg("type; click away to place the text");
    }

    function beginSession(fields, screen, seed) {
      var s = fields;
      s.area = makeArea(screen.x, screen.y);
      s.preview = null;
      s.caretOn = true;
      self.session = s;
      s.area.value = seed;
      s.area.addEventListener("input", rebuildPreview);
      s.area.focus();
      s.area.setSelectionRange(seed.length, seed.length);
      self.caretTimer = setInterval(function () {
        if (!self.session) return;
        self.session.caretOn = !self.session.caretOn;
        app.requestRender();
      }, 530);
      rebuildPreview();
    }

    /** Re-open an existing block for editing (double-click). The block
     *  is lifted out while the session runs (history snapshot taken, the
     *  lift itself is un-journaled — the arrow-float convention). */
    self.editBlock = async function (index) {
      if (self.session) endSession(true);
      var block = app.doc.texts[index];
      if (!block || !block.records.length) return false;
      var font = app.doc.fonts[block.records[0].font];
      var entry = fonts.find(font.name);
      var ttf = null;
      if (entry) {
        try { ttf = await fonts.ensureParsed(entry.label); } catch (e) { ttf = null; }
      }
      if (!ttf) {
        app.setMsg("editing “" + font.name + "” needs its font — press Fonts… " +
                   "or drop the .ttf, then double-click again");
        return false;
      }
      // reconstruct the string from glyph codes — soft-wrapped
      // continuations rejoin their paragraph (the wrap space is still
      // in the glyph stream), hard records restore their newline
      var str = "";
      block.records.forEach(function (rec, ri) {
        if (ri > 0 && !rec.soft) str += "\n";
        str += rec.glyphs.map(function (g) {
          var glyph = font.glyphs[g.gi];
          return glyph ? String.fromCharCode(glyph.code) : "";
        }).join("");
      });
      app.history.push(app.doc); // pre-lift snapshot (one undo step)
      app.doc.texts.splice(index, 1);
      beginSession({
        matrix: block.matrix.slice(),
        editIndex: index,
        stash: block,
        original: str,
        wrapWidth: block.wrapWidth || null,
        ttf: ttf,
        meta: { name: font.name, bold: font.bold, italic: font.italic },
        sizeTw: block.records[0].height,
        color: block.records[0].color
      }, { x: 0, y: 0 }, str);
      app.requestRender();
      app.setMsg("editing text; click away to apply");
      return true;
    };

    function endSession(commit) {
      var s = self.session;
      if (!s) return false;
      self.session = null;
      clearInterval(self.caretTimer);
      var str = s.area.value;
      s.area.remove();

      if (s.editIndex !== null) {
        // put the lifted block back so the doc matches what replay sees
        app.doc.texts.splice(s.editIndex, 0, s.stash);
        var unchanged = str === s.original &&
          (s.wrapWidth || null) === (s.stash.wrapWidth || null) &&
          JSON.stringify(s.matrix) === JSON.stringify(s.stash.matrix);
        if (!commit || unchanged) {
          // nothing changed: drop the lift snapshot, record nothing
          app.history.undoStack.pop();
          app.requestRender();
          return false;
        }
        if (!str.length) {
          app.record({ op: "textDelete", index: s.editIndex });
          textDeleteApply(app.doc, s.editIndex);
          app.docChanged();
          app.setMsg("text deleted");
          return true;
        }
        var editOp = buildTextOp(s.ttf, s.meta, str, s.sizeTw, s.color,
                                 0, 0, s.wrapWidth);
        var edit = { op: "textEdit", index: s.editIndex,
                     font: editOp.font, records: editOp.records,
                     wrapWidth: editOp.wrapWidth, pitch: editOp.pitch };
        if (JSON.stringify(s.matrix) !== JSON.stringify(s.stash.matrix)) {
          edit.matrix = s.matrix.slice(); // the left tab moved the origin
        }
        app.record(edit);
        textEditApply(app.doc, edit);
        app.docChanged();
        app.setMsg("text updated");
        return true;
      }

      if (!commit || !str.length) { app.requestRender(); return false; }
      var op = buildTextOp(s.ttf, s.meta, str, s.sizeTw, s.color,
                           s.matrix[4], s.matrix[5], s.wrapWidth);
      if (!op) { app.requestRender(); return false; }
      app.record(op);
      app.history.push(app.doc);
      textApplyOp(app.doc, op);
      app.docChanged();
      app.setMsg("text placed");
      return true;
    }

    self.commitPending = function () { return endSession(true); };

    /** The session box's side-tab positions in stage space. */
    function sessionTabs() {
      var s = self.session;
      var box = sessionBox();
      if (!s || !box) return null;
      var midY = (box.y0 + box.y1) / 2;
      var m = s.matrix;
      function mp(x, y) {
        return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
      }
      return { box: box, left: mp(box.x0, midY), right: mp(box.x1, midY), mp: mp };
    }

    self.onDown = function (pos, ev) {
      if (self.session) {
        // side tabs EXTEND the box (wrap width) — glyphs never scale
        var tabs = sessionTabs();
        var tol = 8 * VB.TWIPS / app.view.zoom;
        if (tabs) {
          var side = 0;
          if (Math.hypot(pos.x - tabs.right.x, pos.y - tabs.right.y) <= tol * 1.5) side = 1;
          else if (Math.hypot(pos.x - tabs.left.x, pos.y - tabs.left.y) <= tol * 1.5) side = -1;
          if (side) {
            self.boxDrag = {
              side: side,
              baseMatrix: self.session.matrix.slice(),
              right: self.session.wrapWidth || tabs.box.x1
            };
            return;
          }
        }
        endSession(true); // click-away lands the block
        return;
      }
      // double-click editing works from the text tool too
      var hit = textHit(app.doc, pos.x, pos.y);
      if (hit >= 0) { self.editBlock(hit); return; }
      // screen position for the hidden textarea (keeps IME popups near)
      var rect = ev && ev.target && ev.target.getBoundingClientRect
        ? ev.target.getBoundingClientRect() : { left: 0, top: 0 };
      var sx = ev ? ev.clientX - rect.left : 0;
      var sy = ev ? ev.clientY - rect.top : 0;
      startSession(pos, { x: sx, y: sy });
    };

    self.onMove = function (pos) {
      var s = self.session, d = self.boxDrag;
      if (!s || !d) return;
      // pointer in block-local space (against the drag-start matrix)
      var m = d.baseMatrix;
      var det = m[0] * m[3] - m[1] * m[2];
      if (Math.abs(det) < 1e-9) return;
      var lx = (m[3] * (pos.x - m[4]) - m[2] * (pos.y - m[5])) / det;
      var MIN = 200; // 10px — a box can't collapse
      if (d.side === 1) {
        s.wrapWidth = Math.max(MIN, Math.round(lx));
        s.matrix = d.baseMatrix.slice();
      } else {
        // left tab: the right edge stays planted, the origin follows
        var width = Math.max(MIN, Math.round(d.right - lx));
        var dx = d.right - width;
        s.wrapWidth = width;
        s.matrix = matMul(d.baseMatrix, [1, 0, 0, 1, dx, 0]);
      }
      rebuildPreview();
    };

    self.onUp = function () {
      self.boxDrag = null; // the session keeps the new width; commit bakes it
    };

    self.onHover = function () {
      if (app.setCursor) app.setCursor(TEXT_CURSOR);
    };

    self.cancel = function () { self.boxDrag = null; };

    self.drawOverlay = function (ctx) {
      var s = self.session;
      if (!s) return;
      var hair = VB.TWIPS / app.view.zoom;
      if (s.preview) {
        VB.drawTextBlock(ctx, s.preview.doc, s.preview.block);
      }
      // the entry box: outline + side tabs that EXTEND the wrap width
      var tabs = sessionTabs();
      if (tabs) {
        var bx = tabs.box;
        var cs = [tabs.mp(bx.x0, bx.y0), tabs.mp(bx.x1, bx.y0),
                  tabs.mp(bx.x1, bx.y1), tabs.mp(bx.x0, bx.y1)];
        ctx.strokeStyle = "rgba(0,160,255,0.75)";
        ctx.lineWidth = hair;
        ctx.setLineDash([5 * hair, 4 * hair]);
        ctx.beginPath();
        cs.forEach(function (p, i) {
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        [tabs.left, tabs.right].forEach(function (p, side) {
          // flat tab: a bar along the box edge (vertical in local space)
          var eA = cs[side === 0 ? 0 : 1], eB = cs[side === 0 ? 3 : 2];
          var dx = eB.x - eA.x, dy = eB.y - eA.y;
          var len = Math.hypot(dx, dy) || 1;
          var ux = dx / len * 8 * hair, uy = dy / len * 8 * hair;
          ctx.strokeStyle = "rgba(0,160,255,0.95)";
          ctx.lineWidth = 4 * hair;
          ctx.beginPath();
          ctx.moveTo(p.x - ux, p.y - uy);
          ctx.lineTo(p.x + ux, p.y + uy);
          ctx.stroke();
        });
      }
      // caret from the textarea's native caret position, computed in
      // block-local space and mapped through the placement matrix
      var str = s.area.value;
      var caret = s.area.selectionStart;
      var before = str.slice(0, caret);
      var lineIdx = before.split("\n").length - 1;
      var linePrefix = before.slice(before.lastIndexOf("\n") + 1);
      var scale = s.sizeTw / s.ttf.unitsPerEm;
      var cx = 0;
      for (var i = 0; i < linePrefix.length; i++) {
        var gi = s.ttf.glyphIndex(linePrefix.charCodeAt(i));
        var adv = s.ttf.advance(gi);
        if (i + 1 < linePrefix.length) {
          adv += s.ttf.kern(gi, s.ttf.glyphIndex(linePrefix.charCodeAt(i + 1)));
        }
        cx += Math.round(adv * scale);
      }
      var pitch = Math.round((s.ttf.winAscent + s.ttf.winDescent) * scale);
      var baseline = Math.round(s.ttf.winAscent * scale) + lineIdx * pitch;
      var top = baseline - Math.round(s.ttf.winAscent * scale);
      var bottom = baseline + Math.round(s.ttf.winDescent * scale);
      if (s.caretOn) {
        var m = s.matrix;
        function mp(x, y) {
          return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
        }
        var a = mp(cx, top), b = mp(cx, bottom);
        ctx.strokeStyle = "#000";
        ctx.lineWidth = Math.max(1.5 * hair, 20);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    };

    return self;
  }

  window.VB = window.VB || {};
  VB.textApplyOp = textApplyOp;
  VB.textBreakApply = textBreakApply;
  VB.textWrapApply = textWrapApply;
  VB.textEditApply = textEditApply;
  VB.textTransformApply = textTransformApply;
  VB.textDeleteApply = textDeleteApply;
  VB.textBlockBounds = textBlockBounds;
  VB.textHit = textHit;
  VB.buildTextOp = buildTextOp;
  VB.textFonts = fonts;
  VB.TextTool = TextTool;
})();
