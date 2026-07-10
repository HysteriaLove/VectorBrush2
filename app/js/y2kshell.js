/* y2kshell.js — the unified workspace shell's geometry engine
 * (xRack port, Phase A — reference: D:\_xRackEditor02).
 *
 * Pure logic, no DOM: rack columns with draggable modules (collapsed
 * 32pt tabs / expanded panels, island-push collisions, cross-side
 * moves), infinitely scrollable toolbars of panels with the same 1D
 * physics, collapsible drawers, and clamped rack widths. Everything is
 * logical units on the 8pt cell grid (the reference's xCellHeight
 * discipline — CSS px = Apple pt, so this is the iPad metric system).
 *
 * Shell state is VIEW state: persisted per user, never journaled —
 * replay must not depend on where someone parked their panels.
 */
(function () {
  "use strict";

  var CELL = 8;
  var TAB_H = 32;            // collapsed module tab (reference TAB_HEIGHT)
  var SNAP = 12;             // reference RACK_SNAP_DISTANCE
  var RACK_MIN = 168, RACK_MAX = 420, RACK_DEFAULT = 240;
  var CENTER_MIN = 320;      // the canvas never collapses

  function defaults() {
    return {
      cell: CELL,
      racks: {
        left:  { width: RACK_DEFAULT, scroll: 0, open: true, modules: [] },
        right: { width: RACK_DEFAULT, scroll: 0, open: true, modules: [] }
      },
      cols: { // the thin tool columns — collapse off to their side
        left:  { open: true },
        right: { open: true }
      },
      toolbars: {
        top:    { scroll: 0, panels: [], order: [] },
        bottom: { scroll: 0, panels: [], order: [] }
      },
      drawers: {
        // the scratchpad drawer starts tucked; h is the user's pull
        top:    { open: false, h: 220 },
        bottom: { open: true } // the animation timeline starts out
      }
    };
  }

  function moduleById(state, id) {
    var sides = ["left", "right"];
    for (var s = 0; s < sides.length; s++) {
      var mods = state.racks[sides[s]].modules;
      for (var i = 0; i < mods.length; i++) {
        if (mods[i].id === id) {
          return { mod: mods[i], side: sides[s], index: i };
        }
      }
    }
    return null;
  }

  function moduleHeight(mod) {
    return mod.expanded ? Math.max(TAB_H, mod.h | 0) : TAB_H;
  }

  // ---- 1D island physics -------------------------------------------------------
  // The reference's move-as-island: the dragged item sits at the cursor;
  // items it collides with are pushed ahead of it (cascading) in the
  // drag direction, working from each item's pre-drag position. Order
  // can change by dragging past an item; nothing ever overlaps and
  // nothing goes below 0.

  function solveIsland(items, movedId, movedPos, dir) {
    // items: [{id, pos, size}] pre-drag; returns {id: pos}
    var out = {};
    var moved = null;
    var rest = [];
    items.forEach(function (it) {
      if (it.id === movedId) moved = it;
      else rest.push({ id: it.id, pos: it.pos, size: it.size });
    });
    if (!moved) return out;
    var mPos = Math.max(0, movedPos);
    out[movedId] = mPos;
    var mLo = mPos, mHi = mPos + moved.size;
    rest.sort(function (a, b) { return a.pos - b.pos; });
    if (dir >= 0) { // pushing DOWN/RIGHT: sweep ascending
      var floor = -Infinity;
      rest.forEach(function (it) {
        var pos = it.pos;
        if (pos < mHi && pos + it.size > mLo) pos = mHi; // pushed ahead
        if (pos < floor) pos = floor;
        out[it.id] = pos;
        if (pos >= mHi) floor = pos + it.size; // cascade among the pushed
      });
    } else { // pushing UP/LEFT: sweep descending
      var ceil = Infinity;
      for (var i = rest.length - 1; i >= 0; i--) {
        var it = rest[i];
        var pos = it.pos;
        if (pos < mHi && pos + it.size > mLo) pos = mLo - it.size;
        if (pos + it.size > ceil) pos = ceil - it.size;
        out[it.id] = pos;
        if (pos + it.size <= mLo) ceil = pos;
      }
      // a push off the top shoves the whole island back down
      var under = 0;
      rest.forEach(function (it) {
        under = Math.min(under, out[it.id]);
      });
      if (under < 0) {
        rest.forEach(function (it) { out[it.id] -= under; });
        // the moved item yields too if it caused the underflow
        if (mLo < -under) out[movedId] = mPos - under;
      }
    }
    return out;
  }

  /** Drop settle: snap the dragged item onto a neighbor edge when it
   *  lands within SNAP, then close every remaining overlap downward. */
  function settleColumn(mods) {
    var sorted = mods.slice().sort(function (a, b) { return a.y - b.y; });
    var cursor = 0;
    sorted.forEach(function (m) {
      if (m.y < cursor) m.y = cursor;
      else if (m.y - cursor <= SNAP) m.y = cursor; // magnetic stack
      cursor = m.y + moduleHeight(m);
    });
    return mods;
  }

  // ---- packed stacking (the shell's positioning mode) -----------------------------
  // Panels never float (user decision): they always collapse together,
  // packed from the top in order. Dragging picks an INSERTION INDEX;
  // everything closes up around it. solveIsland stays exported for
  // hosts that want the reference's free positioning.

  function packRack(state, side) {
    var y = 0;
    state.racks[side].modules.forEach(function (m) {
      m.y = y;
      y += moduleHeight(m);
    });
    return y;
  }

  /** Which slot a pointer at content-space y means. */
  function insertionIndexAt(state, side, y) {
    var mods = state.racks[side].modules;
    var acc = 0;
    for (var i = 0; i < mods.length; i++) {
      var h = moduleHeight(mods[i]);
      if (y < acc + h / 2) return i;
      acc += h;
    }
    return mods.length;
  }

  /** Reorder (or move across racks) to an index; both columns repack.
   *  Landing on a closed rack opens it. */
  function reorderModule(state, id, side, index) {
    var hit = moduleById(state, id);
    if (!hit) return;
    state.racks[hit.side].modules.splice(hit.index, 1);
    var mods = state.racks[side].modules;
    mods.splice(Math.max(0, Math.min(mods.length, index | 0)), 0, hit.mod);
    if (!state.racks[side].width) state.racks[side].width = RACK_DEFAULT;
    state.racks[side].open = true;
    packRack(state, "left");
    packRack(state, "right");
  }

  // ---- rack modules --------------------------------------------------------------

  function addModule(state, side, mod) {
    // stacks under the current content
    var mods = state.racks[side].modules;
    var y = 0;
    mods.forEach(function (m) { y = Math.max(y, m.y + moduleHeight(m)); });
    mod.y = mod.y === undefined ? y : mod.y;
    mod.expanded = mod.expanded !== false;
    mods.push(mod);
    return mod;
  }

  function toggleModule(state, id) {
    var hit = moduleById(state, id);
    if (hit) hit.mod.expanded = !hit.mod.expanded;
    return hit;
  }

  /** Live drag: the module follows the cursor, neighbors are pushed as
   *  an island. `startPositions` snapshots {id: y} at drag begin. */
  function dragModule(state, id, side, startPositions, newY, dir) {
    var hit = moduleById(state, id);
    if (!hit) return;
    if (hit.side !== side) { // crossing to the other column
      var moved = hit.mod;
      state.racks[hit.side].modules.splice(hit.index, 1);
      state.racks[side].modules.push(moved);
      if (!state.racks[side].width) state.racks[side].width = RACK_DEFAULT;
    }
    var mods = state.racks[side].modules;
    var items = mods.map(function (m) {
      var pos = startPositions[m.id] !== undefined ? startPositions[m.id] : m.y;
      return { id: m.id, pos: pos, size: moduleHeight(m) };
    });
    var solved = solveIsland(items, id, newY, dir);
    mods.forEach(function (m) {
      if (solved[m.id] !== undefined) m.y = solved[m.id];
    });
  }

  function endModuleDrag(state, side) {
    settleColumn(state.racks[side].modules);
    clampRackScroll(state, side, Infinity);
  }

  function rackContentHeight(state, side) {
    var h = 0;
    state.racks[side].modules.forEach(function (m) {
      h = Math.max(h, m.y + moduleHeight(m));
    });
    return h;
  }

  function clampRackScroll(state, side, viewH) {
    var rack = state.racks[side];
    var max = Math.max(0, rackContentHeight(state, side) - viewH + CELL);
    rack.scroll = Math.max(0, Math.min(max, rack.scroll));
    return rack.scroll;
  }

  function setRackWidth(state, side, width, shellWidth) {
    var other = side === "left" ? "right" : "left";
    var max = Math.min(RACK_MAX,
      Math.max(RACK_MIN, (shellWidth || Infinity) -
        state.racks[other].width - CENTER_MIN));
    if (width < RACK_MIN / 2) { // dragged shut: disappears to its side
      state.racks[side].open = false;
      return state.racks[side].width;
    }
    var w = Math.max(RACK_MIN, Math.min(max, width));
    state.racks[side].open = true;
    state.racks[side].width = w;
    return w;
  }

  // ---- toolbars (the same physics, horizontal) -----------------------------------

  function panelById(state, key, id) {
    var panels = state.toolbars[key].panels;
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].id === id) return { panel: panels[i], index: i };
    }
    return null;
  }

  function addPanel(state, key, panel) {
    var panels = state.toolbars[key].panels;
    var x = 0;
    panels.forEach(function (p) { x = Math.max(x, p.x + p.w); });
    panel.x = panel.x === undefined ? x : panel.x;
    panels.push(panel);
    return panel;
  }

  function dragPanel(state, key, id, startPositions, newX, dir) {
    var panels = state.toolbars[key].panels;
    var items = panels.map(function (p) {
      var pos = startPositions[p.id] !== undefined ? startPositions[p.id] : p.x;
      return { id: p.id, pos: pos, size: p.w };
    });
    var solved = solveIsland(items, id, newX, dir);
    panels.forEach(function (p) {
      if (solved[p.id] !== undefined) p.x = solved[p.id];
    });
  }

  function endPanelDrag(state, key) {
    var panels = state.toolbars[key].panels;
    var sorted = panels.slice().sort(function (a, b) { return a.x - b.x; });
    var cursor = 0;
    sorted.forEach(function (p) {
      if (p.x < cursor) p.x = cursor;
      else if (p.x - cursor <= SNAP) p.x = cursor;
      cursor = p.x + p.w;
    });
  }

  function toolbarContentWidth(state, key) {
    var w = 0;
    state.toolbars[key].panels.forEach(function (p) {
      w = Math.max(w, p.x + p.w);
    });
    return w;
  }

  function clampToolbarScroll(state, key, viewW) {
    var bar = state.toolbars[key];
    var max = Math.max(0, toolbarContentWidth(state, key) - viewW + CELL);
    bar.scroll = Math.max(0, Math.min(max, bar.scroll));
    return bar.scroll;
  }

  // ---- persistence (view state — never the journal) ------------------------------

  function serialize(state) {
    return JSON.stringify({
      racks: state.racks, toolbars: state.toolbars, drawers: state.drawers
    });
  }

  function restore(json) {
    var state = defaults();
    try {
      var data = JSON.parse(json);
      if (data && data.racks) {
        ["left", "right"].forEach(function (side) {
          if (data.racks[side]) state.racks[side] = data.racks[side];
        });
      }
      if (data && data.cols) state.cols = data.cols;
      if (data && data.toolbars) state.toolbars = data.toolbars;
      if (data && data.drawers) state.drawers = data.drawers;
    } catch (e) { /* fresh defaults */ }
    // normalize fields older persisted states lack
    ["left", "right"].forEach(function (side) {
      var rack = state.racks[side];
      if (rack.open === undefined) rack.open = true;
      if (!rack.width) rack.width = RACK_DEFAULT;
      if (!state.cols[side]) state.cols[side] = { open: true };
    });
    ["top", "bottom"].forEach(function (key) {
      if (!state.toolbars[key]) state.toolbars[key] = { scroll: 0, panels: [], order: [] };
      if (!state.toolbars[key].order) state.toolbars[key].order = [];
      if (!state.drawers[key]) state.drawers[key] = { open: key === "bottom" };
    });
    if (state.drawers.top.h === undefined) state.drawers.top.h = 220;
    return state;
  }

  window.VB = window.VB || {};
  VB.Y2KShell = {
    CELL: CELL, TAB_H: TAB_H, SNAP: SNAP,
    RACK_MIN: RACK_MIN, RACK_MAX: RACK_MAX, RACK_DEFAULT: RACK_DEFAULT,
    defaults: defaults,
    moduleById: moduleById,
    moduleHeight: moduleHeight,
    packRack: packRack,
    insertionIndexAt: insertionIndexAt,
    reorderModule: reorderModule,
    addModule: addModule,
    toggleModule: toggleModule,
    dragModule: dragModule,
    endModuleDrag: endModuleDrag,
    settleColumn: settleColumn,
    rackContentHeight: rackContentHeight,
    clampRackScroll: clampRackScroll,
    setRackWidth: setRackWidth,
    addPanel: addPanel,
    dragPanel: dragPanel,
    endPanelDrag: endPanelDrag,
    clampToolbarScroll: clampToolbarScroll,
    solveIsland: solveIsland,
    serialize: serialize,
    restore: restore
  };
})();
