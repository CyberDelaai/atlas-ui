// ATLAS — clickable city-district regions. Click a district on the rendered map
// to open a small colour popup (the shared preset grid + custom OS picker) and
// give that district a translucent fill; clear it to go back to borders-only.
//
// The clickable geometry is the OSM admin-relation layer the renderer fetches each
// render (stashed on the live canvas as `_regions`; see fetchRegions / renderMap in
// js/map.js). A click is projected back to lon/lat via the canvas view geometry and
// hit-tested against those rings; the smallest district containing the point wins, so
// nested neighbourhoods take precedence over the city around them. Picks are written
// to ATLAS.state.regionColors (keyed on the stable OSM relation id), persisted under
// atlas:regionColors, and applied by re-rendering (tiles + Overpass come from cache,
// so it's quick). Region picking is live only after a render this session — a cold
// reload restores the cached PNG without the heavy ring geometry.
(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  const S = ATLAS.state;
  const C = ATLAS.const;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // ---- restore persisted picks (data only — runs before app.js renders) ----
  if (!S.regionColors || typeof S.regionColors !== 'object') S.regionColors = {};
  try {
    const raw = localStorage.getItem('atlas:regionColors');
    if (raw) Object.assign(S.regionColors, JSON.parse(raw));
  } catch (e) { /* storage blocked / corrupt — keep defaults */ }

  function persist() {
    ATLAS.save('atlas:regionColors', JSON.stringify(S.regionColors));
  }

  // Debounced restyle, mirroring js/colors.js: the custom picker fires 'input'
  // rapidly while dragging, so coalesce the (heavier) re-render.
  let reTimer = 0;
  function scheduleRerender() {
    clearTimeout(reTimer);
    reTimer = setTimeout(() => { if (ATLAS.rerender) ATLAS.rerender(); }, 220);
  }

  // ---- hit-testing -----------------------------------------------------------
  // Even-odd ray cast across all of a region's rings (so inner holes exclude),
  // in lon/lat space — the rings are [lon,lat] straight from fetchRegions.
  function pointInRings(rings, x, y) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
          inside = !inside;
      }
    }
    return inside;
  }
  // Absolute shoelace area (deg²) summed over the rings — only used to rank
  // overlapping matches, so the units don't matter, just the ordering.
  function regionArea(rings) {
    let a = 0;
    for (const ring of rings) {
      let s = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += Math.abs(s);
    }
    return a / 2;
  }
  // The smallest region that contains the point — so clicking inside a city picks
  // the neighbourhood under the cursor, not the whole city.
  function pickRegion(regions, lon, lat) {
    let best = null, bestArea = Infinity;
    for (const rg of regions || []) {
      if (!rg.rings || !rg.rings.length) continue;
      if (!pointInRings(rg.rings, lon, lat)) continue;
      const area = regionArea(rg.rings);
      if (area < bestArea) { bestArea = area; best = rg; }
    }
    return best;
  }

  // The live rendered map and its clickable geometry (both live on the canvas).
  function liveMap() {
    const cv = $('mapCanvas');
    return cv && cv._meta && cv._meta.view && cv._regions ? cv : null;
  }
  // Map a client point to a fractional position in the canvas's map region (the
  // area inside the PAD margin), or null when the click is outside it. Mirrors
  // markers/app.js: the canvas is shown CSS-scaled, so derive from its client rect.
  function clientToMapFrac(cv, clientX, clientY) {
    const m = cv._meta;
    const r = cv.getBoundingClientRect();
    const scale = r.width / cv.width; // uniform (CSS preserves aspect)
    const fx = (clientX - (r.left + m.pad * scale)) / (m.mapW * scale);
    const fy = (clientY - (r.top + m.pad * scale)) / (m.mapH * scale);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return { fx, fy };
  }

  // ---- colour popup ----------------------------------------------------------
  let pop, grid, pick, custom, nameEl;
  let current = null; // region currently being edited

  function syncPop() {
    const cur = ((current && S.regionColors[current.id]) || '').toLowerCase();
    let matched = false;
    grid.querySelectorAll('.swatch').forEach((sw) => {
      if (!sw.dataset.color) { sw.classList.toggle('active', !cur); return; } // clear chip
      const on = sw.dataset.color.toLowerCase() === cur;
      sw.classList.toggle('active', on);
      if (on) matched = true;
    });
    // the pick chip reads as chosen only while a custom (non-preset) colour is active
    const isCustom = !!cur && !matched;
    pick.classList.toggle('has-color', isCustom);
    pick.classList.toggle('active', isCustom);
    pick.style.background = isCustom ? cur : '';
    pick.style.color = isCustom ? cur : ''; // active glow uses currentColor
    custom.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#ffffff';
  }

  function openPop(rg, clientX, clientY) {
    current = rg;
    nameEl.textContent = rg.name || (ATLAS.t('region_district') + ' ' + rg.id);
    pop.hidden = false; // unhide first so we can measure it
    syncPop();
    const pw = pop.offsetWidth, ph = pop.offsetHeight, m = 12;
    let left = clientX + m;
    if (left + pw > window.innerWidth - 8) left = clientX - pw - m;
    pop.style.left = clamp(left, 8, Math.max(8, window.innerWidth - pw - 8)) + 'px';
    pop.style.top = clamp(clientY - 10, 8, Math.max(8, window.innerHeight - ph - 8)) + 'px';
  }
  function closePop() { if (pop) { pop.hidden = true; current = null; } }

  function choose(hex) {
    if (!current) return;
    S.regionColors[current.id] = hex;
    persist();
    syncPop();
    scheduleRerender();
  }
  function clearColor() {
    if (!current) return;
    delete S.regionColors[current.id];
    persist();
    syncPop();
    scheduleRerender();
  }

  // ---- init ------------------------------------------------------------------
  function init() {
    pop = $('regionPop');
    const stage = $('stage');
    if (!pop || !stage) return;
    grid = $('regionPopGrid');
    custom = $('regionPopCustom');
    pick = grid.querySelector('.swatch-pick-btn');
    nameEl = $('regionPopName');

    // Build the preset swatch grid ahead of the pick chip, just like js/colors.js,
    // so the clear chip leads and the custom-pick chip stays the last cell.
    C.PALETTE.forEach((hex) => {
      const sw = document.createElement('div');
      sw.className = 'swatch';
      sw.dataset.color = hex;
      sw.style.background = hex;
      sw.style.color = hex; // drives the .active glow (box-shadow: currentColor)
      grid.insertBefore(sw, pick);
    });

    // Click on the map → hit-test → open the popup for the district under the cursor.
    // A small drag-guard (recorded on pointerdown) ignores the click that ends a
    // marker drag or a draw-to-recrop rubber-band.
    let downX = 0, downY = 0;
    stage.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    stage.addEventListener('click', (e) => {
      if (e.target.closest('.color-pop')) return;            // clicks inside a popup
      if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) return; // was a drag
      if (stage.classList.contains('cropping')) return;      // draw-to-recrop mode
      if (e.target.closest('.marker') || e.target.closest('.zoom-ctl')) return;
      const cv = liveMap();
      if (!cv) return;
      const fr = clientToMapFrac(cv, e.clientX, e.clientY);
      if (!fr) { closePop(); return; }
      const ll = ATLAS.pxFracToLatLon(cv._meta.view, fr.fx, fr.fy);
      const rg = pickRegion(cv._regions, ll.lon, ll.lat);
      if (rg) openPop(rg, e.clientX, e.clientY);
      else closePop();
    });

    // Preset swatch / clear chip → commit + close. (The pick chip isn't a .swatch;
    // it opens the native picker, handled below.)
    grid.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      if (sw.dataset.color) choose(sw.dataset.color); else clearColor();
      closePop();
    });
    // Native picker: live preview while dragging.
    custom.addEventListener('input', () => choose(custom.value));

    // Dismiss on outside click or Escape. A click inside the stage is left for the
    // stage handler above (which reopens for another district or closes itself).
    document.addEventListener('mousedown', (e) => {
      if (pop.hidden) return;
      if (pop.contains(e.target) || e.target.closest('#stage')) return;
      closePop();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closePop(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.ATLAS);
