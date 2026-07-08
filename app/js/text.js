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
  function textApplyOp(doc, op) {
    var merged = mergeFont(doc, op.font);
    var block = {
      matrix: op.matrix.slice(),
      records: op.records.map(function (rec) {
        return {
          font: merged.fontIndex,
          height: rec.height,
          color: { r: rec.color.r, g: rec.color.g, b: rec.color.b, a: rec.color.a },
          x: rec.x, y: rec.y,
          glyphs: rec.glyphs.map(function (g) {
            return { gi: merged.giMap[g.gi], adv: g.adv };
          })
        };
      })
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
    t.records = op.records.map(function (rec) {
      return {
        font: merged.fontIndex,
        height: rec.height,
        color: { r: rec.color.r, g: rec.color.g, b: rec.color.b, a: rec.color.a },
        x: rec.x, y: rec.y,
        glyphs: rec.glyphs.map(function (g) {
          return { gi: merged.giMap[g.gi], adv: g.adv };
        })
      };
    });
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

  /** Lay a string out with a parsed TTF into a self-contained textCreate
   *  op. sizeTw = point size in twips (Flash: height field). Advances
   *  bake hmtx + kerning at authoring time, like MX2004. */
  function buildTextOp(ttf, meta, str, sizeTw, color, x, y) {
    var scale = sizeTw / ttf.unitsPerEm;
    var lines = str.split("\n");
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
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var glyphs = [];
      for (var ci = 0; ci < line.length; ci++) {
        var code = line.charCodeAt(ci);
        var gi = ttf.glyphIndex(code);
        var adv = ttf.advance(gi);
        if (ci + 1 < line.length) {
          adv += ttf.kern(gi, ttf.glyphIndex(line.charCodeAt(ci + 1)));
        }
        glyphs.push({ gi: opGi(code), adv: Math.round(adv * scale) });
      }
      if (glyphs.length === 0) continue; // blank line still advances y
      records.push({
        height: sizeTw,
        color: { r: color.r, g: color.g, b: color.b, a: color.a },
        x: 0, y: baseline + li * pitch,
        str: line,
        glyphs: glyphs
      });
    }
    if (records.length === 0) return null;
    return {
      op: "textCreate",
      font: { name: meta.name, bold: !!meta.bold, italic: !!meta.italic,
              glyphs: subset },
      matrix: [1, 0, 0, 1, Math.round(x), Math.round(y)],
      records: records
    };
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
      var label = parsed.family || name.replace(/\.[^.]+$/, "");
      var e = this.find(label);
      if (!e) {
        e = { label: label, family: parsed.family, style: "Regular" };
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
      var op = buildTextOp(s.ttf, s.meta, s.area.value, s.sizeTw, s.color, 0, 0);
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
      // reconstruct the string from glyph codes, one record per line
      var str = block.records.map(function (rec) {
        return rec.glyphs.map(function (g) {
          var glyph = font.glyphs[g.gi];
          return glyph ? String.fromCharCode(glyph.code) : "";
        }).join("");
      }).join("\n");
      app.history.push(app.doc); // pre-lift snapshot (one undo step)
      app.doc.texts.splice(index, 1);
      beginSession({
        matrix: block.matrix.slice(),
        editIndex: index,
        stash: block,
        original: str,
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
        if (!commit || str === s.original) {
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
        var editOp = buildTextOp(s.ttf, s.meta, str, s.sizeTw, s.color, 0, 0);
        app.record({ op: "textEdit", index: s.editIndex,
                     font: editOp.font, records: editOp.records });
        textEditApply(app.doc, { index: s.editIndex,
                                 font: editOp.font, records: editOp.records });
        app.docChanged();
        app.setMsg("text updated");
        return true;
      }

      if (!commit || !str.length) { app.requestRender(); return false; }
      var op = buildTextOp(s.ttf, s.meta, str, s.sizeTw, s.color,
                           s.matrix[4], s.matrix[5]);
      if (!op) { app.requestRender(); return false; }
      app.record(op);
      app.history.push(app.doc);
      textApplyOp(app.doc, op);
      app.docChanged();
      app.setMsg("text placed");
      return true;
    }

    self.commitPending = function () { return endSession(true); };

    self.onDown = function (pos, ev) {
      if (self.session) {
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

    self.onHover = function () {
      if (app.setCursor) app.setCursor(TEXT_CURSOR);
    };

    self.cancel = function () {};

    self.drawOverlay = function (ctx) {
      var s = self.session;
      if (!s) return;
      var hair = VB.TWIPS / app.view.zoom;
      if (s.preview) {
        VB.drawTextBlock(ctx, s.preview.doc, s.preview.block);
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
  VB.textEditApply = textEditApply;
  VB.textTransformApply = textTransformApply;
  VB.textDeleteApply = textDeleteApply;
  VB.textBlockBounds = textBlockBounds;
  VB.textHit = textHit;
  VB.buildTextOp = buildTextOp;
  VB.textFonts = fonts;
  VB.TextTool = TextTool;
})();
