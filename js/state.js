// ATLAS shared namespace + tiny DOM helper. Loaded first; every other
// module attaches to window.ATLAS.
window.ATLAS = window.ATLAS || {};
ATLAS.$ = (id) => document.getElementById(id);

// Constants shared across modules.
ATLAS.const = {};

// localStorage setter (silent if storage is blocked).
ATLAS.save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// The single source of mutable working-area state. Feature modules alias this
// as `const S = ATLAS.state;` and read/write S.<field>. Defaults below are the
// initial values; a restore pass in app.js can override them from localStorage.
ATLAS.state = {
  // start adding fields here as the tool grows
};
