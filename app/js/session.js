/* session.js — the ProjectSession: what a mounted section edits through.
 *
 * The seam between the editor and the coming application shell
 * (docs/Implementation.md phase 2; docs/Architecture.md §4). A Session
 * owns the open project's live state — the store (project), the op
 * journal, undo history, and the future clock/language/sections slots —
 * so section frontends talk to the session, never to page globals. The
 * GUI's `app` object in main.js is a thin facade over one Session; the
 * shell (phase 5) will create and dispose Sessions as projects open and
 * close.
 *
 * Command pattern: record() journals an op, exec() journals AND applies
 * it through the same registered command replay uses (journal.js
 * VB.defineOp/applyOp) — live and replay cannot diverge for anything
 * routed through here.
 */
(function () {
  "use strict";

  function Session(opts) {
    var self = this;
    opts = opts || {};

    // ---- store -------------------------------------------------------------
    this.project = new VB.Project();

    // ---- journal -----------------------------------------------------------
    // The deterministic op log. Seeded with the document-creating op so
    // an exported journal replays from nothing.
    this.journal = [];
    if (opts.width && opts.height) {
      this.journal.push({ op: "new", width: opts.width, height: opts.height });
    }
    this.errors = [];   // trapped runtime errors, exported with the journal
    this.onRecord = null;  // hook(op): called before the journal push
                           // (estimator preflight in debug mode)
    this.onChanged = null; // hook(): after exec applies — render/UI refresh

    // ---- undo --------------------------------------------------------------
    // Snapshots capture the WHOLE project, so layer add/delete/move are
    // single undo steps. Tools call history.push(doc) — the wrapper
    // ignores the argument and snapshots the project.
    var history = new VB.History();
    this.history = {
      push: function () { history.push(self.project); },
      undo: function () { return history.undo(self.project); },
      redo: function () { return history.redo(self.project); },
      canUndo: function () { return history.canUndo(); },
      canRedo: function () { return history.canRedo(); },
      clear: function () { history.clear(); },
      get undoStack() { return history.undoStack; },
      get redoStack() { return history.redoStack; }
    };

    // ---- op dispatch context ------------------------------------------------
    // Live doc/project are getters — always current, so ops that swap the
    // project (load, new) stay coherent mid-replay and mid-exec.
    this.execCtx = {
      get doc() { return self.project.activeCell(); },
      get project() { return self.project; },
      set project(p) { self.project = p; },
      get history() { return self.history; },
      sync: function () {}
    };

    // ---- future slots (Architecture §4) --------------------------------------
    // clock: the master playback clock — a stub until Sequence/Roughs
    // (Implementation phase pattern, step 3). language: active language +
    // line resolution — a stub until Writing. sections: mounted section
    // frontends, keyed by name — the shell (phase 5) populates it.
    this.clock = { frame: 0, playing: false };
    this.language = { active: null };
    this.sections = {};
  }

  Session.prototype.record = function (op) {
    if (this.onRecord) this.onRecord(op);
    this.journal.push(op);
  };

  Session.prototype.exec = function (op) {
    this.record(op);
    var r = VB.applyOp(this.execCtx, op);
    if (this.onChanged) this.onChanged();
    return r;
  };

  window.VB = window.VB || {};
  VB.Session = Session;
})();
