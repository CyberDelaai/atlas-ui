// ATLAS — main UI controller. Everything runs inside one IIFE and reads/writes
// the shared state via `const S = ATLAS.state;`. This is the blank starting
// point; build the tool out from here in clearly-marked `// ---- section ----`
// blocks, the same convention the other cyberdeck.tools apps follow.
(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  const S = ATLAS.state;

  // ---- init ----
  function init() {
    // wire up controls here
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.ATLAS);
