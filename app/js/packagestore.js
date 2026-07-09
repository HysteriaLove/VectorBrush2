/* packagestore.js — the .y2kproj package store (Implementation.md phase 3).
 *
 * A project is a PACKAGE: many small addressable units (manifest,
 * journal segments, drawings, assets) instead of one blob — the shape
 * the streaming layer needs (Architecture §3/§5). This is the rung-0
 * browser backend: units live in IndexedDB as Blobs, so readRange() is
 * an honest range read (Blob.slice never materializes the whole unit).
 * The interface is the contract; the iPad native bridge and desktop
 * shells implement the same surface later (§10).
 *
 * Interchange is a zip of the unit tree (.y2kproj file). The writer
 * emits STORE entries only (y2kvector bodies are already deflated
 * inside); the reader accepts STORE and DEFLATE, so foreign zips of a
 * package folder import too.
 */
(function () {
  "use strict";

  var DB_VERSION = 1;

  function preq(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function openDB(name) {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(name, DB_VERSION);
      r.onupgradeneeded = function () {
        var db = r.result;
        db.createObjectStore("projects", { keyPath: "id" });
        var units = db.createObjectStore("units", { keyPath: ["project", "path"] });
        units.createIndex("byProject", "project");
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function newId() {
    var rnd = "";
    var a = new Uint8Array(6);
    (self.crypto || {}).getRandomValues ? crypto.getRandomValues(a)
      : a.forEach(function (_, i) { a[i] = (Math.random() * 256) | 0; });
    for (var i = 0; i < a.length; i++) rnd += (a[i] & 15).toString(16) + (a[i] >> 4).toString(16);
    return "p" + Date.now().toString(36) + rnd.slice(0, 6);
  }

  // ---- store ---------------------------------------------------------------

  function PackageStore(db) { this.db = db; }

  /** Opens (creating on first use) the package database. dbName is for
   *  test isolation; the app uses the default. */
  PackageStore.open = async function (dbName) {
    return new PackageStore(await openDB(dbName || "vb-packages"));
  };

  PackageStore.prototype.list = async function () {
    var rows = await preq(this.db.transaction("projects").objectStore("projects").getAll());
    rows.sort(function (a, b) { return b.modified - a.modified; });
    return rows;
  };

  PackageStore.prototype.create = async function (meta) {
    var rec = {
      id: newId(),
      name: (meta && meta.name) || "Untitled",
      group: (meta && meta.group) || null,
      created: Date.now(),
      modified: Date.now()
    };
    await preq(this.db.transaction("projects", "readwrite")
      .objectStore("projects").add(rec));
    return rec;
  };

  PackageStore.prototype.remove = async function (id) {
    var tx = this.db.transaction(["projects", "units"], "readwrite");
    tx.objectStore("projects").delete(id);
    var idx = tx.objectStore("units").index("byProject");
    var keys = await preq(idx.getAllKeys(id));
    keys.forEach(function (k) { tx.objectStore("units").delete(k); });
    return preq(tx.objectStore("projects").count()); // settles when tx work is queued
  };

  PackageStore.prototype.open = function (id) {
    return new PackageHandle(this, id);
  };

  // ---- handle --------------------------------------------------------------

  function PackageHandle(store, id) {
    this.store = store;
    this.id = id;
  }

  PackageHandle.prototype._touch = function (tx) {
    var self = this;
    var projects = tx.objectStore("projects");
    projects.get(this.id).onsuccess = function (ev) {
      var rec = ev.target.result;
      if (rec) { rec.modified = Date.now(); projects.put(rec); }
    };
  };

  /** data: Uint8Array or string (stored UTF-8). */
  PackageHandle.prototype.writeUnit = async function (path, data) {
    var blob = new Blob([typeof data === "string" ? new TextEncoder().encode(data) : data]);
    var tx = this.store.db.transaction(["units", "projects"], "readwrite");
    tx.objectStore("units").put({ project: this.id, path: path, blob: blob });
    this._touch(tx);
    return new Promise(function (res, rej) {
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  };

  PackageHandle.prototype.readUnit = async function (path) {
    var row = await preq(this.store.db.transaction("units")
      .objectStore("units").get([this.id, path]));
    if (!row) return null;
    return new Uint8Array(await row.blob.arrayBuffer());
  };

  PackageHandle.prototype.readUnitText = async function (path) {
    var bytes = await this.readUnit(path);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  };

  /** Honest range read: only the sliced range is materialized. */
  PackageHandle.prototype.readRange = async function (path, offset, length) {
    var row = await preq(this.store.db.transaction("units")
      .objectStore("units").get([this.id, path]));
    if (!row) return null;
    var slice = row.blob.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  };

  PackageHandle.prototype.unitSize = async function (path) {
    var row = await preq(this.store.db.transaction("units")
      .objectStore("units").get([this.id, path]));
    return row ? row.blob.size : -1;
  };

  PackageHandle.prototype.deleteUnit = async function (path) {
    var tx = this.store.db.transaction(["units", "projects"], "readwrite");
    tx.objectStore("units").delete([this.id, path]);
    this._touch(tx);
    return new Promise(function (res, rej) {
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  };

  PackageHandle.prototype.listUnits = async function (prefix) {
    var rows = await preq(this.store.db.transaction("units")
      .objectStore("units").index("byProject").getAll(this.id));
    var paths = rows.map(function (r) { return r.path; });
    if (prefix) {
      paths = paths.filter(function (p) { return p.indexOf(prefix) === 0; });
    }
    return paths.sort();
  };

  PackageHandle.prototype.manifest = async function () {
    var text = await this.readUnitText("manifest.json");
    return text === null ? null : JSON.parse(text);
  };

  PackageHandle.prototype.flushManifest = function (m) {
    return this.writeUnit("manifest.json", JSON.stringify(m));
  };

  // ---- zip interchange (.y2kproj file) --------------------------------------

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // fixed timestamp (2026-01-01, 00:00) — exports are deterministic for
  // identical content
  var DOS_TIME = 0;
  var DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

  function u16le(arr, v) { arr.push(v & 255, (v >> 8) & 255); }
  function u32le(arr, v) { arr.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }

  /** entries: [{name, bytes}] → zip Blob (STORE method). */
  function zipWrite(entries) {
    var chunks = [];
    var central = [];
    var offset = 0;
    entries.forEach(function (e) {
      var name = new TextEncoder().encode(e.name);
      var crc = crc32(e.bytes);
      var head = [];
      u32le(head, 0x04034b50);
      u16le(head, 20); u16le(head, 0x0800 /* UTF-8 names */); u16le(head, 0);
      u16le(head, DOS_TIME); u16le(head, DOS_DATE);
      u32le(head, crc); u32le(head, e.bytes.length); u32le(head, e.bytes.length);
      u16le(head, name.length); u16le(head, 0);
      chunks.push(new Uint8Array(head), name, e.bytes);

      var c = [];
      u32le(c, 0x02014b50);
      u16le(c, 20); u16le(c, 20); u16le(c, 0x0800); u16le(c, 0);
      u16le(c, DOS_TIME); u16le(c, DOS_DATE);
      u32le(c, crc); u32le(c, e.bytes.length); u32le(c, e.bytes.length);
      u16le(c, name.length); u16le(c, 0); u16le(c, 0);
      u16le(c, 0); u16le(c, 0); u32le(c, 0);
      u32le(c, offset);
      central.push(new Uint8Array(c), name);
      offset += head.length + name.length + e.bytes.length;
    });
    var centralLen = 0;
    central.forEach(function (c) { centralLen += c.length; });
    var eocd = [];
    u32le(eocd, 0x06054b50);
    u16le(eocd, 0); u16le(eocd, 0);
    u16le(eocd, entries.length); u16le(eocd, entries.length);
    u32le(eocd, centralLen); u32le(eocd, offset);
    u16le(eocd, 0);
    return new Blob(chunks.concat(central, [new Uint8Array(eocd)]),
                    { type: "application/octet-stream" });
  }

  async function inflateRaw(bytes) {
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** zip bytes → [{name, bytes}]. STORE and DEFLATE entries supported. */
  async function zipRead(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // EOCD: scan backwards over the (comment-bearing) tail
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a zip file");
    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var out = [];
    var p = cdOff;
    for (var e = 0; e < count; e++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Bad central directory");
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      // local header repeats name/extra with its own lengths
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataOff = localOff + 30 + lNameLen + lExtraLen;
      var data = bytes.subarray(dataOff, dataOff + csize);
      if (method === 0) out.push({ name: name, bytes: new Uint8Array(data) });
      else if (method === 8) out.push({ name: name, bytes: await inflateRaw(data) });
      else throw new Error("Unsupported zip method " + method);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  PackageHandle.prototype.exportZip = async function () {
    var self = this;
    var paths = await this.listUnits();
    var entries = [];
    for (var i = 0; i < paths.length; i++) {
      entries.push({ name: paths[i], bytes: await self.readUnit(paths[i]) });
    }
    return zipWrite(entries);
  };

  /** Imports a .y2kproj zip as a NEW project; returns its index record. */
  PackageStore.prototype.importZip = async function (blob, meta) {
    var entries = await zipRead(new Uint8Array(await blob.arrayBuffer()));
    var rec = await this.create(meta || {});
    var handle = this.open(rec.id);
    for (var i = 0; i < entries.length; i++) {
      await handle.writeUnit(entries[i].name, entries[i].bytes);
    }
    return rec;
  };

  // ---- journal segmentation --------------------------------------------------
  // The op log persists as journal/seg-NNNNN.json units so autosave
  // flushes touch one small tail file and crash recovery replays
  // segments in order. Pure functions here; persistence wiring is
  // phase 6.

  function segmentJournal(ops, opsPerSegment) {
    var size = opsPerSegment || 256;
    var segs = [];
    for (var i = 0; i < ops.length; i += size) {
      segs.push({
        path: "journal/seg-" + String(segs.length + 1).padStart(5, "0") + ".json",
        json: JSON.stringify({ seq: segs.length + 1, ops: ops.slice(i, i + size) })
      });
    }
    return segs;
  }

  function joinJournalSegments(segJsons) {
    var parsed = segJsons.map(function (j) { return JSON.parse(j); });
    parsed.sort(function (a, b) { return a.seq - b.seq; });
    var ops = [];
    parsed.forEach(function (s) { ops.push.apply(ops, s.ops); });
    return ops;
  }

  window.VB = window.VB || {};
  VB.PackageStore = PackageStore;
  VB.zipWrite = zipWrite; // exposed for tests
  VB.zipRead = zipRead;
  VB.segmentJournal = segmentJournal;
  VB.joinJournalSegments = joinJournalSegments;
})();
