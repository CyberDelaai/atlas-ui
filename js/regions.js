// ATLAS — clickable city-district regions. Left-click a district on the rendered
// map to SELECT it — a striped cyan tint is painted over it (a transient overlay
// canvas, #regionSelLayer, not baked into the export). Right-click a district then
// opens its small popup menu (the shared preset colour grid + custom OS picker +
// image controls) to give that district a translucent fill or background image;
// clear it to go back to borders-only.
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
  // Is the (fractional) map point over sea? Reads the per-pixel water mask the
  // renderer stashes on the canvas (1 = water; see renderMap). Districts whose
  // admin area runs out over the water shouldn't be pickable there. Absent mask
  // (cold reload, no live render) → treat as land so picking still works.
  function isWaterAt(cv, fx, fy) {
    const mask = cv._waterMask, m = cv._meta;
    if (!mask) return false;
    const x = Math.floor(fx * m.mapW), y = Math.floor(fy * m.mapH);
    if (x < 0 || y < 0 || x >= m.mapW || y >= m.mapH) return false;
    return mask[y * m.mapW + x] === 1;
  }

  // The district under a client point, or null (outside the map / over sea / no
  // enclosing district). Shared by the left-click select + right-click menu.
  function regionAt(clientX, clientY) {
    const cv = liveMap();
    if (!cv) return null;
    const fr = clientToMapFrac(cv, clientX, clientY);
    if (!fr) return null;
    if (isWaterAt(cv, fr.fx, fr.fy)) return null;
    const ll = ATLAS.pxFracToLatLon(cv._meta.view, fr.fx, fr.fy);
    return pickRegion(cv._regions, ll.lon, ll.lat);
  }

  // ---- selection highlight ---------------------------------------------------
  // The currently SELECTED district (by stable centroid id), painted as a striped
  // cyan tint on the #regionSelLayer overlay canvas. Selection is in-memory only
  // (transient UI), keyed by id so it survives a recolour re-render — drawSelection
  // re-resolves the region from the live canvas's _regions each paint.
  let selLayer = null, selectedId = null, selRaf = 0, stripeTile = null;

  // A small repeating tile of diagonal cyan stripes over a translucent black base.
  // Built once and reused; createPattern is rebound to the live ctx each paint.
  function stripePattern(ctx) {
    if (!stripeTile) {
      const T = 12;
      const t = document.createElement('canvas');
      t.width = t.height = T;
      const c = t.getContext('2d');
      c.fillStyle = 'rgba(2,16,22,0.5)';        // black-ish base
      c.fillRect(0, 0, T, T);
      c.strokeStyle = 'rgba(0,240,255,0.5)';    // signature-cyan stripes
      c.lineWidth = 4;
      c.lineCap = 'square';
      for (let o = -T; o <= T; o += T) {        // anti-diagonals, tiling seamlessly
        c.beginPath(); c.moveTo(o, T); c.lineTo(o + T, 0); c.stroke();
      }
      stripeTile = t;
    }
    return ctx.createPattern(stripeTile, 'repeat');
  }

  // Size + place the overlay over the map region of the displayed canvas (mirrors
  // markers' reposition), then fill the selected district's polygon with the
  // stripe pattern and outline it in cyan. Hides when nothing's selected or the
  // map carries no live geometry (cold reload restores the PNG without _regions).
  function drawSelection() {
    if (!selLayer) return;
    const cv = liveMap();
    if (!cv || !selectedId) { selLayer.hidden = true; return; }
    const rg = (cv._regions || []).find((r) => r.id === selectedId);
    if (!rg || !rg.rings || !rg.rings.length) { selLayer.hidden = true; return; }

    const M = cv._meta;
    const sr = $('stage').getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    const scale = cr.width / cv.width; // uniform (CSS preserves aspect)
    const W = M.mapW * scale, H = M.mapH * scale;
    selLayer.hidden = false;
    selLayer.style.left = (cr.left - sr.left + M.pad * scale) + 'px';
    selLayer.style.top = (cr.top - sr.top + M.pad * scale) + 'px';
    selLayer.style.width = W + 'px';
    selLayer.style.height = H + 'px';
    const dpr = window.devicePixelRatio || 1;
    selLayer.width = Math.max(1, Math.round(W * dpr));
    selLayer.height = Math.max(1, Math.round(H * dpr));
    const ctx = selLayer.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.beginPath();
    for (const ring of rg.rings) {
      if (ring.length < 3) continue;
      for (let i = 0; i < ring.length; i++) {
        const f = ATLAS.latLonToPxFrac(M.view, ring[i][1], ring[i][0]); // ring = [lon,lat]
        const x = f.fx * W, y = f.fy * H;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
    }
    ctx.save();
    ctx.clip('evenodd');          // inner holes (nested districts) punch through
    ctx.fillStyle = stripePattern(ctx);
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.lineWidth = 1.5;          // crisp cyan edge on top of the tint
    ctx.strokeStyle = 'rgba(0,240,255,0.85)';
    ctx.stroke();
  }

  function selectRegion(rg) { selectedId = rg.id; drawSelection(); }
  function clearSelection() {
    if (selectedId == null) return;
    selectedId = null;
    drawSelection();
  }

  // ---- colour popup ----------------------------------------------------------
  let pop, grid, pick, custom, nameEl, imgBtn, imgRemoveBtn;
  let current = null; // region currently being edited

  // Reflect the open district's image state on the SET/EDIT + REMOVE buttons.
  function syncImageBtns() {
    if (!imgBtn) return;
    const di = ATLAS.districtImages;
    const has = !!(current && di && di.has(current.id));
    imgBtn.textContent = ATLAS.t(has ? 'b_edit_image' : 'b_set_image');
    if (imgRemoveBtn) imgRemoveBtn.hidden = !has;
  }

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
    nameEl.textContent = rg.name || (ATLAS.t('region_district') + ' ' + (rg.idx || rg.id));
    pop.hidden = false; // unhide first so we can measure it
    syncPop();
    syncImageBtns();
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
    imgBtn = $('regionPopImage');
    imgRemoveBtn = $('regionPopImageRemove');
    selLayer = $('regionSelLayer');

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

    // Is this event in a mode / on an element where region picking shouldn't fire?
    function blocked(e) {
      return stage.classList.contains('cropping')      // draw-to-recrop mode
          || stage.classList.contains('placing-image') // district-image placement
          || e.target.closest('.color-pop')            // a popup
          || e.target.closest('.marker')               // a marker
          || e.target.closest('.zoom-ctl');            // the recrop / pan controls
    }

    // LEFT-click on the map → SELECT the district under the cursor (striped tint);
    // clicking sea / empty space deselects. The menu is right-click only now, so a
    // left click always dismisses any open popup. A small drag-guard (recorded on
    // pointerdown) ignores the click that ends a marker drag or a recrop rubber-band.
    let downX = 0, downY = 0;
    stage.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    stage.addEventListener('click', (e) => {
      if (blocked(e)) return;
      if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) return; // was a drag
      closePop();
      const rg = regionAt(e.clientX, e.clientY);
      // toggle: clicking the already-selected district (or sea / empty) deselects.
      if (rg && rg.id !== selectedId) selectRegion(rg); else clearSelection();
    });

    // RIGHT-click on a district → select it (if not already) and open its menu at
    // the cursor. Suppress the browser context menu anywhere over the map so the
    // right-click reads as ours; off a district it just dismisses the popup.
    stage.addEventListener('contextmenu', (e) => {
      if (blocked(e)) return;
      const cv = liveMap();
      if (!cv) return; // no live map → leave the native menu alone
      e.preventDefault();
      const rg = regionAt(e.clientX, e.clientY);
      if (rg) { selectRegion(rg); openPop(rg, e.clientX, e.clientY); }
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

    // Image controls: set/edit opens the placement editor (js/district-images.js);
    // remove clears the district's image. Both close the popup.
    if (imgBtn) imgBtn.addEventListener('click', () => {
      const rg = current;
      closePop();
      if (rg && ATLAS.districtImages) ATLAS.districtImages.begin(rg);
    });
    if (imgRemoveBtn) imgRemoveBtn.addEventListener('click', () => {
      if (current && ATLAS.districtImages) ATLAS.districtImages.remove(current.id);
      closePop();
    });

    // Dismiss on outside click or Escape. A click inside the stage is left for the
    // stage handler above (which reopens for another district or closes itself).
    document.addEventListener('mousedown', (e) => {
      if (pop.hidden) return;
      if (pop.contains(e.target) || e.target.closest('#stage')) return;
      closePop();
    });
    // Escape steps back: close an open menu first, then clear the selection.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!pop.hidden) closePop();
      else clearSelection();
    });

    // The overlay tracks the canvas's displayed size (mirrors markers' resize hook).
    window.addEventListener('resize', () => {
      cancelAnimationFrame(selRaf);
      selRaf = requestAnimationFrame(drawSelection);
    });
  }

  // Public: redraw the selection overlay after the map is (re)mounted — app.js
  // calls this from mountCanvas, alongside the marker overlay's reposition.
  ATLAS.regions = { refresh: drawSelection };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.ATLAS);
