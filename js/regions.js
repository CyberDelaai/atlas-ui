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

  // ---- restore persisted groups (data only) ----------------------------------
  // A group fuses several detected faces into one region: shared fill (written
  // per-member into regionColors), one background image (under districtImages[id]),
  // and the borders between members masked out (buildGroupMasks in map.js).
  if (!S.regionGroups || !Array.isArray(S.regionGroups)) S.regionGroups = [];
  try {
    const raw = localStorage.getItem('atlas:regionGroups');
    const g = raw && JSON.parse(raw);
    if (Array.isArray(g)) S.regionGroups = g.filter((x) => x && Array.isArray(x.members));
  } catch (e) { /* storage blocked / corrupt — keep defaults */ }
  function persistGroups() {
    ATLAS.save('atlas:regionGroups', JSON.stringify(S.regionGroups));
  }
  // The group a face belongs to, or null. Ids are the stable centroid face ids.
  function groupOf(faceId) {
    return (S.regionGroups || []).find((g) => g.members.indexOf(faceId) !== -1) || null;
  }
  // Fuse the given face ids into one group (≥2 members). Any pre-existing group
  // that overlaps the set is dissolved first, so a face lives in at most one group.
  function createGroup(ids) {
    const members = Array.from(new Set(ids));
    if (members.length < 2) return null;
    S.regionGroups = (S.regionGroups || []).filter(
      (g) => !g.members.some((m) => members.indexOf(m) !== -1));
    const g = { id: 'g:' + members.slice().sort().join(';'), members };
    S.regionGroups.push(g);
    persistGroups();
    return g;
  }
  function removeGroup(groupId) {
    S.regionGroups = (S.regionGroups || []).filter((g) => g.id !== groupId);
    persistGroups();
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
  // The currently SELECTED districts (by stable centroid id), painted as a striped
  // cyan tint on the #regionSelLayer overlay canvas. Selection is in-memory only
  // (transient UI), keyed by id so it survives a recolour re-render — drawSelection
  // re-resolves each region from the live canvas's _regions each paint. Multiple
  // faces can be selected at once (Ctrl+click); applying a fill/image to >1 fuses
  // them into a group.
  let selLayer = null, selectedIds = new Set(), selRaf = 0, stripeTile = null;

  // Signature cyan, as [r,g,b], for the selection edge re-stroke (see drawSelection).
  const SEL_CYAN = [0, 240, 255];

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
    if (!cv || !selectedIds.size) { selLayer.hidden = true; return; }
    const regs = (cv._regions || []).filter(
      (r) => selectedIds.has(r.id) && r.rings && r.rings.length);
    if (!regs.length) { selLayer.hidden = true; return; }

    const M = cv._meta;
    const stage = $('stage');
    const sr = stage.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    const scale = cr.width / cv.width; // uniform (CSS preserves aspect)
    const W = M.mapW * scale, H = M.mapH * scale;
    selLayer.hidden = false;
    // left/top of an absolutely-positioned child are relative to the stage's PADDING
    // box, but getBoundingClientRect() returns its BORDER box — subtract the stage's
    // own border width (clientLeft/Top) or the overlay lands one border-width too far
    // right/down (visible as the selection outline sitting off the drawn border).
    selLayer.style.left = (cr.left - sr.left - stage.clientLeft + M.pad * scale) + 'px';
    selLayer.style.top = (cr.top - sr.top - stage.clientTop + M.pad * scale) + 'px';
    selLayer.style.width = W + 'px';
    selLayer.style.height = H + 'px';
    const dpr = window.devicePixelRatio || 1;
    selLayer.width = Math.max(1, Math.round(W * dpr));
    selLayer.height = Math.max(1, Math.round(H * dpr));
    const ctx = selLayer.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const stripe = stripePattern(ctx);

    // (1) Striped tint, per face — own clip so a group's members each read as
    // selected without their shared edge vanishing. Clipped straight to the detected
    // ring, exactly like the colour fill (drawRegionFills): the ring sits <1px off the
    // drawn border, so the tint reaches it and the exact border edge composited in
    // step (2) covers the hairline — same as the map border covers the colour fill.
    for (const rg of regs) {
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
      ctx.fillStyle = stripe;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // (2) Crisp outline that EXACTLY matches the drawn borders: a layer re-stroked
    // from the same coastline/admin/city lines the map is drawn from, clipped to the
    // selected district(s), built at native map resolution by map.js and composited
    // here scaled by the same factor the map canvas is displayed at — so the cyan
    // edge lands on the grey border pixel-for-pixel. Falls back to stroking the
    // detected ring on an older render that predates the helper.
    const edge = edgeLayerFor(cv, regs);
    if (edge) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(edge, 0, 0, M.mapW, M.mapH, 0, 0, W, H);
    } else {
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,240,255,0.9)';
      ctx.stroke(); // last face's path is still current — good enough for the fallback
    }
  }

  // Cache the native-resolution edge layer (see step 2 above): it depends only on the
  // render + the selected set, not the display size, so a resize reuses it and only
  // re-composites (cheap). Rebuilt when the live canvas or the selection changes.
  let edgeCache = null; // { cv, key, layer }
  function edgeLayerFor(cv, regs) {
    if (!cv._regionEdgeLayer) return null;
    const key = regs.map((r) => r.id).sort().join('|');
    if (edgeCache && edgeCache.cv === cv && edgeCache.key === key) return edgeCache.layer;
    const clipRings = [];
    for (const rg of regs) for (const ring of rg.rings) clipRings.push(ring);
    const layer = cv._regionEdgeLayer(clipRings, SEL_CYAN);
    edgeCache = { cv, key, layer };
    return layer;
  }

  // Selection mutators — all redraw the overlay.
  function setSelection(ids) { selectedIds = new Set(ids); drawSelection(); }
  function clearSelection() {
    if (!selectedIds.size) return;
    selectedIds.clear();
    drawSelection();
  }
  // Faces that move together when (de)selecting `rg`: its whole group, or just it.
  function unitOf(rg) { const g = groupOf(rg.id); return g ? g.members.slice() : [rg.id]; }

  // ---- colour popup ----------------------------------------------------------
  let pop, grid, pick, custom, nameEl, imgBtn, imgRemoveBtn, ungroupBtn;
  let current = null; // the right-clicked region (names the popup + identifies a single target)

  // The faces this popup acts on: the whole live selection, else just `current`.
  function targetIds() {
    if (selectedIds.size) return Array.from(selectedIds);
    return current ? [current.id] : [];
  }
  // Auto-group: when the popup acts on >1 face, fuse them so they share fill/image
  // and lose their internal borders. Returns the group acting (existing or new), or
  // the single face's group (which may be null). Re-selects the group's members.
  function ensureGroupForApply() {
    const ids = targetIds();
    if (ids.length <= 1) return current ? groupOf(current.id) : null;
    let g = groupOf(ids[0]);
    const same = g && g.members.length === ids.length &&
      ids.every((id) => g.members.indexOf(id) !== -1);
    if (!same) g = createGroup(ids);
    if (g) selectedIds = new Set(g.members);
    return g;
  }
  // Where a (group's or single face's) shared image is keyed.
  function imageTargetId() {
    const g = current && groupOf(current.id);
    return g ? g.id : (current ? current.id : null);
  }

  // Reflect the open target's image state on the SET/EDIT + REMOVE buttons.
  function syncImageBtns() {
    if (!imgBtn) return;
    const di = ATLAS.districtImages;
    const id = imageTargetId();
    const has = !!(id && di && di.has(id));
    imgBtn.textContent = ATLAS.t(has ? 'b_edit_image' : 'b_set_image');
    if (imgRemoveBtn) imgRemoveBtn.hidden = !has;
  }
  // Show UNGROUP only when the popup targets a grouped district.
  function syncGroupBtn() {
    if (!ungroupBtn) return;
    ungroupBtn.hidden = !(current && groupOf(current.id));
  }

  function syncPop() {
    // Members share a colour, so the right-clicked face's colour is representative.
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
    const n = selectedIds.size;
    const base = rg.name || (ATLAS.t('region_district') + ' ' + (rg.idx || rg.id));
    nameEl.textContent = (groupOf(rg.id) || n > 1) ? base + ' (' + Math.max(n, 1) + ')' : base;
    pop.hidden = false; // unhide first so we can measure it
    syncPop();
    syncImageBtns();
    syncGroupBtn();
    const pw = pop.offsetWidth, ph = pop.offsetHeight, m = 12;
    let left = clientX + m;
    if (left + pw > window.innerWidth - 8) left = clientX - pw - m;
    pop.style.left = clamp(left, 8, Math.max(8, window.innerWidth - pw - 8)) + 'px';
    pop.style.top = clamp(clientY - 10, 8, Math.max(8, window.innerHeight - ph - 8)) + 'px';
  }
  function closePop() { if (pop) { pop.hidden = true; current = null; } }

  function choose(hex) {
    const ids = targetIds();
    if (!ids.length) return;
    ensureGroupForApply();              // applying to >1 face fuses them
    ids.forEach((id) => { S.regionColors[id] = hex; });
    persist();
    syncPop();
    syncGroupBtn();
    drawSelection();
    scheduleRerender();
  }
  function clearColor() {
    const ids = targetIds();
    if (!ids.length) return;
    ids.forEach((id) => { delete S.regionColors[id]; });
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
    ungroupBtn = $('regionPopUngroup');
    selLayer = $('regionSelLayer');

    // Build the preset swatch grid ahead of the pick chip, just like js/colors.js,
    // so the clear chip leads and the custom-pick chip stays the last cell.
    // Trimmed to the first 16 presets (drop the last 8) — this popup's grid was
    // getting too tall; the custom picker still covers the rest.
    C.PALETTE.slice(0, -8).forEach((hex) => {
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
    // a grouped district selects its whole group. Ctrl/Cmd+click ADDS/REMOVES a
    // district (or group) from a multi-selection without clearing the rest. Plain
    // click on sea / empty space deselects. The menu is right-click only now, so a
    // left click always dismisses any open popup. A small drag-guard (recorded on
    // pointerdown) ignores the click that ends a marker drag or a recrop rubber-band.
    let downX = 0, downY = 0;
    stage.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    stage.addEventListener('click', (e) => {
      if (blocked(e)) return;
      if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) return; // was a drag
      closePop();
      const rg = regionAt(e.clientX, e.clientY);
      const additive = e.ctrlKey || e.metaKey;
      if (!rg) { if (!additive) clearSelection(); return; } // empty/sea: plain click clears
      const ids = unitOf(rg);
      if (additive) {
        // toggle this face/group in the running selection
        const all = ids.every((id) => selectedIds.has(id));
        ids.forEach((id) => all ? selectedIds.delete(id) : selectedIds.add(id));
        drawSelection();
      } else {
        // plain click: select just this unit; clicking the sole current selection clears
        const sole = selectedIds.size === ids.length && ids.every((id) => selectedIds.has(id));
        if (sole) clearSelection(); else setSelection(ids);
      }
    });

    // RIGHT-click on a district → open its menu at the cursor. If the district isn't
    // already in the selection, it becomes the selection (its whole group if grouped);
    // otherwise the existing multi-selection is kept so the menu acts on all of it.
    // Suppress the browser context menu anywhere over the map so the right-click reads
    // as ours; off a district it just dismisses the popup.
    stage.addEventListener('contextmenu', (e) => {
      if (blocked(e)) return;
      const cv = liveMap();
      if (!cv) return; // no live map → leave the native menu alone
      e.preventDefault();
      const rg = regionAt(e.clientX, e.clientY);
      if (!rg) { closePop(); return; }
      const ids = unitOf(rg);
      const inSel = ids.some((id) => selectedIds.has(id));
      if (!inSel) setSelection(ids);
      else if (groupOf(rg.id)) setSelection(ids); // ensure the full group is lit
      openPop(rg, e.clientX, e.clientY);
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

    // Image controls: set/edit opens the placement editor (js/district-images.js).
    // For a multi-selection this auto-groups first and edits ONE image spanning the
    // group's union (a synthetic region whose rings are all members' rings); for a
    // single district it edits that district. Remove clears the shared image.
    if (imgBtn) imgBtn.addEventListener('click', () => {
      const ids = targetIds();
      const g = ids.length > 1 ? ensureGroupForApply() : (current && groupOf(current.id));
      const single = current;
      closePop();
      if (!ATLAS.districtImages) return;
      if (g) {
        const cv = liveMap();
        const faces = ((cv && cv._regions) || []).filter((r) => g.members.indexOf(r.id) !== -1);
        const rings = faces.reduce((acc, f) => acc.concat(f.rings), []);
        if (rings.length) ATLAS.districtImages.begin({ id: g.id, name: '', rings });
      } else if (single) {
        ATLAS.districtImages.begin(single);
      }
    });
    if (imgRemoveBtn) imgRemoveBtn.addEventListener('click', () => {
      const id = imageTargetId();
      if (id && ATLAS.districtImages) ATLAS.districtImages.remove(id);
      closePop();
    });

    // UNGROUP: dissolve the group back into individual districts — drop its shared
    // image (the per-member fills stay, so each district keeps its colour) and
    // re-render so the internal borders come back.
    if (ungroupBtn) ungroupBtn.addEventListener('click', () => {
      const g = current && groupOf(current.id);
      closePop();
      if (!g) return;
      removeGroup(g.id);
      if (ATLAS.districtImages && ATLAS.districtImages.has(g.id)) {
        ATLAS.districtImages.remove(g.id);   // deletes + persists + re-renders
      } else if (ATLAS.rerender) {
        ATLAS.rerender();
      }
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
