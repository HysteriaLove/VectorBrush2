/* bitio.js — SWF-style bit-level I/O.
 *
 * Bit order is MSB-first within each byte, matching the SWF spec.
 * Multi-byte integers (u16/u32) are little-endian and byte-aligned,
 * also matching SWF. All coordinates throughout VectorBrush are
 * integer twips (1/20 px).
 */
(function () {
  "use strict";

  function BitReader(bytes, pos) {
    this.bytes = bytes;           // Uint8Array
    this.pos = pos || 0;          // byte position
    this.bit = 0;                 // bit position within current byte (0..7)
  }

  BitReader.prototype.align = function () {
    if (this.bit !== 0) { this.pos++; this.bit = 0; }
  };

  BitReader.prototype.eof = function () {
    return this.pos >= this.bytes.length;
  };

  // Unsigned bits, MSB first.
  BitReader.prototype.ub = function (n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      v = (v << 1) | ((this.bytes[this.pos] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v >>> 0;
  };

  // Signed bits (two's complement).
  BitReader.prototype.sb = function (n) {
    var v = this.ub(n);
    if (n > 0 && (v & (1 << (n - 1)))) v -= (1 << n);
    return v;
  };

  BitReader.prototype.u8 = function () {
    this.align();
    return this.bytes[this.pos++];
  };

  BitReader.prototype.u16 = function () {
    this.align();
    var v = this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  };

  BitReader.prototype.u32 = function () {
    this.align();
    var b = this.bytes, p = this.pos;
    this.pos += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  };

  // SWF RECT: 5-bit size, then xmin/xmax/ymin/ymax as signed bits. Twips.
  BitReader.prototype.rect = function () {
    this.align();
    var n = this.ub(5);
    var r = { xmin: this.sb(n), xmax: this.sb(n), ymin: this.sb(n), ymax: this.sb(n) };
    this.align();
    return r;
  };

  function BitWriter() {
    this.bytes = [];
    this.cur = 0;      // partial byte being filled
    this.bit = 0;      // bits used in cur
  }

  BitWriter.prototype.align = function () {
    if (this.bit !== 0) { this.bytes.push(this.cur); this.cur = 0; this.bit = 0; }
  };

  BitWriter.prototype.ub = function (n, v) {
    for (var i = n - 1; i >= 0; i--) {
      this.cur |= ((v >>> i) & 1) << (7 - this.bit);
      if (++this.bit === 8) { this.bytes.push(this.cur); this.cur = 0; this.bit = 0; }
    }
  };

  BitWriter.prototype.sb = function (n, v) {
    this.ub(n, v < 0 ? (v + (1 << n)) : v);
  };

  BitWriter.prototype.u8 = function (v) {
    this.align();
    this.bytes.push(v & 0xff);
  };

  BitWriter.prototype.u16 = function (v) {
    this.align();
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  };

  BitWriter.prototype.u32 = function (v) {
    this.align();
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  };

  BitWriter.prototype.rect = function (r) {
    this.align();
    var n = Math.max(sbits(r.xmin), sbits(r.xmax), sbits(r.ymin), sbits(r.ymax));
    this.ub(5, n);
    this.sb(n, r.xmin); this.sb(n, r.xmax); this.sb(n, r.ymin); this.sb(n, r.ymax);
    this.align();
  };

  BitWriter.prototype.toUint8Array = function () {
    this.align();
    return Uint8Array.from(this.bytes);
  };

  // Minimum bit-widths for signed/unsigned values (SWF "count bits" logic).
  function sbits(v) {
    if (v === 0) return 0;
    if (v > 0) return 33 - Math.clz32(v);      // magnitude bits + sign bit
    return 33 - Math.clz32(~v);                // two's complement
  }

  function sbitsAll(values) {
    var n = 0;
    for (var i = 0; i < values.length; i++) n = Math.max(n, sbits(values[i]));
    return n;
  }

  function ubits(v) {
    return v === 0 ? 0 : 32 - Math.clz32(v);
  }

  window.VB = window.VB || {};
  VB.BitReader = BitReader;
  VB.BitWriter = BitWriter;
  VB.sbits = sbits;
  VB.sbitsAll = sbitsAll;
  VB.ubits = ubits;
})();
