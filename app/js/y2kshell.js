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
        // drawers remember how far the user pulled them
        top:    { open: false, h: 220 },
        bottom: { open: true, h: 130 } // the animation timeline
      },
      // the step sequencer's own view (the scene timeline keeps its
      // zoom/pan inside the strip itself)
      step: { cellW: 13 },
      // floating toolpanels — every xPanel is its own island: docked
      // into the top or bottom bar's row, or floating free where it
      // was dropped; shared (and remembered) across every workspace
      float: { panels: {} }
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

  // Smooth follow (user spec): the width tracks the drag exactly — the
  // ONLY snap is the ~4px close zone at the edge. No jerky minimums.
  var SNAP_SHUT = 4;

  function setRackWidth(state, side, width, shellWidth) {
    var other = side === "left" ? "right" : "left";
    var max = Math.min(RACK_MAX,
      Math.max(RACK_MIN, (shellWidth || Infinity) -
        state.racks[other].width - CENTER_MIN));
    var w = Math.max(0, Math.min(max, width));
    if (w <= SNAP_SHUT) { // disappears to its side; width kept for reopen
      state.racks[side].open = false;
      return 0;
    }
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

  // ---- floating toolpanels (dock to a bar's bounds, or float free) ----------------
  // placement lives HERE (pure); the DOM layer measures elements and
  // lays the docked rows out along the top/bottom bar bounds

  function floatGet(state, name) {
    return state.float.panels[name] || null;
  }

  function floatRow(state, dock) {
    var panels = state.float.panels;
    var names = Object.keys(panels).filter(function (n) {
      return panels[n].dock === dock;
    });
    names.sort(function (a, b) { return panels[a].ord - panels[b].ord; });
    return names;
  }

  // snapping to a bar seats the panel in that row (index counts the
  // row WITHOUT the moving panel); ords renumber densely
  function floatDock(state, name, dock, index) {
    var row = floatRow(state, dock).filter(function (n) {
      return n !== name;
    });
    var at = index === undefined ? row.length
      : Math.max(0, Math.min(row.length, index | 0));
    row.splice(at, 0, name);
    state.float.panels[name] = { dock: dock, ord: at };
    row.forEach(function (n, i) { state.float.panels[n].ord = i; });
    return state.float.panels[name];
  }

  function floatFree(state, name, x, y) {
    state.float.panels[name] = {
      dock: "free", x: Math.round(x) || 0, y: Math.round(y) || 0
    };
    return state.float.panels[name];
  }

  // ---- persistence (view state — never the journal) ------------------------------

  function serialize(state) {
    return JSON.stringify({
      racks: state.racks, toolbars: state.toolbars,
      drawers: state.drawers, step: state.step,
      float: state.float
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
      if (data && data.step) state.step = data.step;
      if (data && data.float) state.float = data.float;
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
    if (state.drawers.bottom.h === undefined) state.drawers.bottom.h = 130;
    if (!state.step || !(state.step.cellW > 0)) state.step = { cellW: 13 };
    if (!state.float || typeof state.float !== "object" ||
        !state.float.panels || typeof state.float.panels !== "object") {
      state.float = { panels: {} };
    }
    Object.keys(state.float.panels).forEach(function (n) {
      var e = state.float.panels[n];
      if (!e || (e.dock !== "top" && e.dock !== "bottom" &&
                 e.dock !== "free")) {
        delete state.float.panels[n];
        return;
      }
      if (e.dock === "free") {
        if (!isFinite(e.x)) e.x = 8;
        if (!isFinite(e.y)) e.y = 44;
      } else if (!isFinite(e.ord)) {
        e.ord = 0;
      }
    });
    return state;
  }

  window.VB = window.VB || {};
  VB.Y2KShell = {
    CELL: CELL, TAB_H: TAB_H, SNAP: SNAP, SNAP_SHUT: SNAP_SHUT,
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
    floatGet: floatGet,
    floatRow: floatRow,
    floatDock: floatDock,
    floatFree: floatFree,
    serialize: serialize,
    restore: restore
  };
})();
