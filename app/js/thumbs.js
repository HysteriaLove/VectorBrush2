/* thumbs.js — streamed cell thumbnails (Actors beat 3; Architecture
 * §5.3 "Actors: thumbnail wall" — the streaming layer's first client
 * that exercises the WHOLE contract, not just the caches).
 *
 * A thumbnail is derived data: keyed by its owner (pose/drawing id),
 * versioned by the cell's content hash, rendered through the ORACLE
 * painter, cached under the global AssetCache budget (eviction just
 * costs a re-render), and loaded through the Prefetcher so visible
 * thumbs win over scrolled-away ones. The DOM windowing (which thumbs
 * are visible) lives with the panel in main.js; this module is the
 * headless-testable machinery.
 */
(function () {
  "use strict";

  var cache = new Map(); // key -> { hash, canvas }
  VB._thumbRenders = 0;  // instrumentation for the suite

  function cellHash(cell) {
    if (VB.pixiHashCell) return VB.pixiHashCell(cell);
    // weak fallback for pages without the pixi module
    return cell.edges.length + ":" + cell.fills.length + ":" +
           (cell.texts ? cell.texts.length : 0);
  }

  /** Oracle mini-render of a cell, letterboxed into w×h. */
  function renderThumb(cell, w, h) {
    var cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    var pad = 2;
    var cw = cell.width / VB.TWIPS, ch = cell.height / VB.TWIPS;
    var zoom = Math.min((w - pad * 2) / cw, (h - pad * 2) / ch);
    VB.render(cv.getContext("2d"), cell, {
      zoom: zoom,
      panX: (w - cw * zoom) / 2,
      panY: (h - ch * zoom) / 2,
      dpr: 1
    });
    VB._thumbRenders++;
    return cv;
  }

  /** Cache-only lookup: the canvas when fresh (content hash matches),
   *  else null. Never renders. */
  function thumbGet(key, cell) {
    var hit = cache.get(key);
    if (hit && hit.hash === cellHash(cell)) {
      if (VB.assets) VB.assets.touch("thumb:" + key);
      return hit.canvas;
    }
    return null;
  }

  /** Streamed request: resolves with the thumb canvas. Fresh cache hits
   *  resolve immediately; misses render via the Prefetcher (dedup per
   *  content version, higher priority first). A mid-flight cell edit
   *  self-heals: the stale result stores under its own hash and the
   *  next thumbGet misses, re-requesting. */
  function thumbRequest(key, cell, w, h, priority) {
    var hit = thumbGet(key, cell);
    if (hit) return Promise.resolve(hit);
    var hash = cellHash(cell);
    var load = function () {
      var cv = renderThumb(cell, w, h);
      cache.set(key, { hash: hash, canvas: cv });
      if (VB.assets) {
        VB.assets.claim("thumb:" + key, w * h * 4, function () {
          cache.delete(key); // eviction = recompute on next request
        });
      }
      return cv;
    };
    if (!VB.prefetcher) return Promise.resolve(load());
    return VB.prefetcher.schedule("thumb:" + key + ":" + hash,
                                  priority || 0, load);
  }

  window.VB = window.VB || {};
  VB.thumbGet = thumbGet;
  VB.thumbRequest = thumbRequest;
  VB.renderThumb = renderThumb;
})();
