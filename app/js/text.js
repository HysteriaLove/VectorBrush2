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
      var op = buildTextOp(s.ttf, s.meta, s.area.value, s.sizeTw, s.color, s.x, s.y);
      if (op) {
        var doc = { fonts: [], texts: [] };
        textApplyOp(doc, op);
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
      self.session = {
        x: pos.x, y: pos.y,
        ttf: ttf,
        meta: { name: entry.family || label,
                bold: style.indexOf("bold") >= 0,
                italic: style.indexOf("italic") >= 0 || style.indexOf("oblique") >= 0 },
        sizeTw: sizeTw(),
        color: { r: app.fillColor.r, g: app.fillColor.g, b: app.fillColor.b, a: app.fillColor.a },
        area: makeArea(screen.x, screen.y),
        preview: null,
        caretOn: true
      };
      self.session.area.addEventListener("input", rebuildPreview);
      self.session.area.focus();
      self.caretTimer = setInterval(function () {
        if (!self.session) return;
        self.session.caretOn = !self.session.caretOn;
        app.requestRender();
      }, 530);
      app.setMsg("type; click away to place the text");
      app.requestRender();
    }

    function endSession(commit) {
      var s = self.session;
      if (!s) return false;
      self.session = null;
      clearInterval(self.caretTimer);
      var str = s.area.value;
      s.area.remove();
      if (!commit || !str.length) { app.requestRender(); return false; }
      var op = buildTextOp(s.ttf, s.meta, str, s.sizeTw, s.color, s.x, s.y);
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
      // caret from the textarea's native caret position
      var str = s.area.value;
      var caret = s.area.selectionStart;
      var before = str.slice(0, caret);
      var lineIdx = before.split("\n").length - 1;
      var linePrefix = before.slice(before.lastIndexOf("\n") + 1);
      var scale = s.sizeTw / s.ttf.unitsPerEm;
      var cx = s.x;
      for (var i = 0; i < linePrefix.length; i++) {
        var gi = s.ttf.glyphIndex(linePrefix.charCodeAt(i));
        var adv = s.ttf.advance(gi);
        if (i + 1 < linePrefix.length) {
          adv += s.ttf.kern(gi, s.ttf.glyphIndex(linePrefix.charCodeAt(i + 1)));
        }
        cx += Math.round(adv * scale);
      }
      var pitch = Math.round((s.ttf.winAscent + s.ttf.winDescent) * scale);
      var baseline = s.y + Math.round(s.ttf.winAscent * scale) + lineIdx * pitch;
      var ascTw = Math.round(s.ttf.winAscent * scale);
      if (s.caretOn) {
        ctx.strokeStyle = "#000";
        ctx.lineWidth = Math.max(1.5 * hair, 20);
        ctx.beginPath();
        ctx.moveTo(cx, baseline - ascTw);
        ctx.lineTo(cx, baseline + Math.round(s.ttf.winDescent * scale));
        ctx.stroke();
      }
    };

    return self;
  }

  window.VB = window.VB || {};
  VB.textApplyOp = textApplyOp;
  VB.buildTextOp = buildTextOp;
  VB.textFonts = fonts;
  VB.TextTool = TextTool;
})();
