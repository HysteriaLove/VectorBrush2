/* streaming.js — the streaming skeleton (Implementation.md phase 4;
 * Architecture §5).
 *
 * Views subscribe to windows of data; this layer feeds them and keeps
 * memory under an explicit budget. Streaming is CACHING, never truth:
 * the journal and ops never depend on what is resident — an eviction
 * costs a recompute, it cannot change geometry or replay.
 *
 * Three pieces:
 *   ChunkSource — range reads over package units (the PackageStore
 *     backend here; the iPad native bridge and desktop shells implement
 *     the same surface later).
 *   AssetCache — ONE global LRU under an explicit byte budget. Owners
 *     claim(key, bytes, evict) for every derived resident asset (raster
 *     sprites, matcap paints, decoded images…); eviction calls the
 *     owner's evict() which drops the asset so its next use recomputes.
 *     Entries claimed since the last frameStart() are exempt — a render
 *     pass can never evict what it is drawing.
 *   Prefetcher — one priority queue for background loads; nearest work
 *     first, bounded concurrency, deduped by key.
 */
(function () {
  "use strict";

  // ---- ChunkSource -----------------------------------------------------------

  /** Range-read view over an open PackageHandle. */
  function chunkSource(handle) {
    return {
      read: function (path, offset, length) {
        return handle.readRange(path, offset, length);
      },
      size: function (path) { return handle.unitSize(path); },
      whole: function (path) { return handle.readUnit(path); }
    };
  }

  // ---- AssetCache ------------------------------------------------------------

  function AssetCache(budgetBytes) {
    this.budget = budgetBytes;
    this.resident = 0;
    this._entries = new Map(); // key -> { bytes, evict, seq }
    this._seq = 0;
    // no frame in flight → everything is evictable; each frameStart()
    // raises the floor so that frame's claims/touches are exempt
    this._frameFloor = Infinity;
  }

  /** Marks the start of a render pass: everything claimed or touched
   *  from here on is exempt from eviction until the next frameStart. */
  AssetCache.prototype.frameStart = function () {
    this._frameFloor = this._seq;
  };

  /** Registers (or replaces) a resident asset. evict() is called ONLY
   *  on budget eviction — never on release/replace — and must drop the
   *  asset so its next use recomputes. */
  AssetCache.prototype.claim = function (key, bytes, evict) {
    var old = this._entries.get(key);
    if (old) this.resident -= old.bytes;
    this._entries.set(key, { bytes: bytes, evict: evict, seq: ++this._seq });
    this.resident += bytes;
    this._evictToFit();
  };

  AssetCache.prototype.touch = function (key) {
    var e = this._entries.get(key);
    if (e) e.seq = ++this._seq;
  };

  /** Owner dropped the asset itself; no evict callback. */
  AssetCache.prototype.release = function (key) {
    var e = this._entries.get(key);
    if (e) {
      this.resident -= e.bytes;
      this._entries.delete(key);
    }
  };

  AssetCache.prototype.setBudget = function (bytes) {
    this.budget = bytes;
    this._evictToFit();
  };

  AssetCache.prototype._evictToFit = function () {
    while (this.resident > this.budget && this._entries.size > 1) {
      var lruKey = null, lruSeq = Infinity, lruEntry = null;
      this._entries.forEach(function (e, k) {
        if (e.seq < lruSeq) { lruSeq = e.seq; lruKey = k; lruEntry = e; }
      });
      // current-frame entries are exempt; if the oldest survivor is
      // already in-frame, the frame simply runs over budget
      if (lruEntry === null || lruSeq > this._frameFloor) break;
      this._entries.delete(lruKey);
      this.resident -= lruEntry.bytes;
      try { lruEntry.evict(); } catch (e) { /* an evict must never wedge the cache */ }
    }
  };

  AssetCache.prototype.stats = function () {
    return { resident: this.resident, count: this._entries.size, budget: this.budget };
  };

  // ---- Prefetcher --------------------------------------------------------------

  function Prefetcher(concurrency) {
    this.concurrency = concurrency || 2;
    this._pending = new Map(); // key -> { priority, load, resolve, promise, started }
    this._running = 0;
  }

  /** Queues load() under `key`. Higher priority runs first. Duplicate
   *  keys share one promise (the later call may raise the priority). */
  Prefetcher.prototype.schedule = function (key, priority, load) {
    var e = this._pending.get(key);
    if (e) {
      if (priority > e.priority && !e.started) e.priority = priority;
      return e.promise;
    }
    var self = this;
    e = { priority: priority, load: load, started: false };
    e.promise = new Promise(function (res) { e.resolve = res; });
    this._pending.set(key, e);
    this._pump();
    return e.promise;
  };

  /** Drops a not-yet-started load; its promise resolves null. */
  Prefetcher.prototype.cancel = function (key) {
    var e = this._pending.get(key);
    if (e && !e.started) {
      this._pending.delete(key);
      e.resolve(null);
    }
  };

  Prefetcher.prototype.clear = function () {
    var self = this;
    this._pending.forEach(function (e, key) {
      if (!e.started) {
        self._pending.delete(key);
        e.resolve(null);
      }
    });
  };

  Prefetcher.prototype._pump = function () {
    var self = this;
    while (this._running < this.concurrency) {
      var best = null, bestKey = null;
      this._pending.forEach(function (e, key) {
        if (!e.started && (best === null || e.priority > best.priority)) {
          best = e; bestKey = key;
        }
      });
      if (!best) return;
      best.started = true;
      this._running++;
      (function (e, key) {
        Promise.resolve().then(function () { return e.load(); }).then(
          function (v) {
            self._pending.delete(key);
            self._running--;
            e.resolve(v);
            self._pump();
          },
          function () {
            self._pending.delete(key);
            self._running--;
            e.resolve(null);
            self._pump();
          });
      })(best, bestKey);
    }
  };

  window.VB = window.VB || {};
  VB.chunkSource = chunkSource;
  VB.AssetCache = AssetCache;
  VB.Prefetcher = Prefetcher;
  // the ONE global budget every resident asset class shares
  // (Architecture §5.2); rung-0 placeholder budget, device classes later
  VB.assets = new AssetCache(256 * 1024 * 1024);
  VB.prefetcher = new Prefetcher(2);
})();
