// ATLAS — map colour palette UI. Each "color-row" in the OUTPUT panel opens a
// shared popup (preset swatch grid + a custom OS colour picker, the same idiom
// as chronos-ui) for one render slot: land / water / borders / frame / marker /
// region. Picks are written to ATLAS.state.colors, persisted under atlas:* keys,
// and applied by re-rendering the existing map (tiles come from cache, so it's
// quick). The renderer reads these via ATLAS.resolvePalette() in js/map.js.
(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  const S = ATLAS.state;
  const C = ATLAS.const;

  // ---- restore persisted picks (data only — runs before app.js renders) ----
  try {
    const raw = localStorage.getItem('atlas:colors');
    if (raw) Object.assign(S.colors, JSON.parse(raw));
    const rawC = localStorage.getItem('atlas:customColors');
    if (rawC) Object.assign(S.customColors, JSON.parse(rawC));
  } catch (e) { /* storage blocked / corrupt — keep defaults */ }

  function persist() {
    ATLAS.save('atlas:colors', JSON.stringify(S.colors));
    ATLAS.save('atlas:customColors', JSON.stringify(S.customColors));
  }

  // Debounced restyle: drag-picking fires 'input' rapidly, so coalesce the
  // (relatively heavy) re-render and only fire once the user settles.
  let reTimer = 0;
  function scheduleRerender() {
    clearTimeout(reTimer);
    reTimer = setTimeout(() => { if (ATLAS.rerender) ATLAS.rerender(); }, 220);
  }

  function init() {
    const rows = $('colorRows');
    const pop = $('colorPop');
    if (!rows || !pop) return;
    const grid = $('colorPopGrid');
    const saved = $('colorPopSaved');
    const custom = $('colorPopCustom');
    const nameEl = $('colorPopName');
    const customGroup = grid.querySelector('.custom-color-group');

    let openSlot = null; // which colour-row the popup is currently editing

    // Build the preset swatch grid once, ahead of the custom-pick group.
    C.PALETTE.forEach((hex) => {
      const sw = document.createElement('div');
      sw.className = 'swatch';
      sw.dataset.color = hex;
      sw.style.background = hex;
      sw.style.color = hex; // drives the .active glow (box-shadow: currentColor)
      grid.insertBefore(sw, customGroup);
    });

    // Paint a row's chip to its current colour.
    function paintChip(slot) {
      const chip = rows.querySelector(`.color-row[data-slot="${slot}"] .cr-chip`);
      if (chip) chip.style.background = S.colors[slot];
    }
    function paintAllChips() { Object.keys(S.colors).forEach(paintChip); }

    // Reflect the current slot inside the popup: active preset, saved-custom
    // swatch, and the native picker's starting value.
    function syncPop() {
      const cur = S.colors[openSlot];
      grid.querySelectorAll('.swatch:not(.swatch-saved)').forEach((sw) =>
        sw.classList.toggle('active', sw.dataset.color.toLowerCase() === (cur || '').toLowerCase()));
      const cust = S.customColors[openSlot];
      if (cust) {
        saved.hidden = false;
        saved.dataset.color = cust;
        saved.style.background = cust;
        saved.style.color = cust;
        saved.classList.toggle('active', cust.toLowerCase() === (cur || '').toLowerCase());
      } else {
        saved.hidden = true;
      }
      custom.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#ffffff';
    }

    function openPop(slot, btn) {
      openSlot = slot;
      nameEl.textContent = btn.querySelector('.cr-name').textContent;
      pop.hidden = false; // unhide first so we can measure it
      syncPop();
      // Anchor to the left of the (right-panel) row; fall back to the right and
      // clamp vertically so the popup always stays on-screen.
      const r = btn.getBoundingClientRect();
      const pw = pop.offsetWidth, ph = pop.offsetHeight, m = 10;
      let left = r.left - pw - m;
      if (left < 8) left = Math.min(r.right + m, window.innerWidth - pw - 8);
      let top = Math.min(r.top, window.innerHeight - ph - 8);
      pop.style.left = Math.max(8, left) + 'px';
      pop.style.top = Math.max(8, top) + 'px';
    }
    function closePop() { pop.hidden = true; openSlot = null; }

    // Commit a colour to the open slot. `isCustom` also stores it as the slot's
    // remembered custom swatch.
    function choose(hex, isCustom) {
      if (!openSlot) return;
      S.colors[openSlot] = hex;
      if (isCustom) S.customColors[openSlot] = hex;
      paintChip(openSlot);
      syncPop();
      persist();
      scheduleRerender();
    }

    // ---- wiring ----
    rows.addEventListener('click', (e) => {
      const btn = e.target.closest('.color-row');
      if (btn) openPop(btn.dataset.slot, btn);
    });
    // Preset (and saved-custom) swatch click → commit + close.
    grid.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw || !sw.dataset.color) return;
      choose(sw.dataset.color, sw.classList.contains('swatch-saved'));
      closePop();
    });
    // Native picker: live preview while dragging, remember as the slot's custom.
    custom.addEventListener('input', () => choose(custom.value, true));

    // Dismiss on outside click or Escape.
    document.addEventListener('mousedown', (e) => {
      if (pop.hidden) return;
      if (!pop.contains(e.target) && !e.target.closest('.color-row')) closePop();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closePop(); });

    paintAllChips();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.ATLAS);
