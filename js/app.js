// ATLAS — main UI controller. Everything runs inside one IIFE and reads/writes
// the shared state via `const S = ATLAS.state;`. Wires the coordinate / area
// controls to the canvas map engine (js/map.js) and the PNG export.
(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  const S = ATLAS.state;
  const C = ATLAS.const;

  let lastCanvas = null; // most recent rendered map, for export

  // ---- helpers ----
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  function setStatus(msg, kind) {
    const el = $('status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Nominatim asks callers to identify themselves and stay under ~1 req/sec; we
  // only ever fire on an explicit user action, so that's covered.
  async function geocode(query) {
    const url = `${C.GEOCODE}?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const j = await r.json();
    return j && j[0] ? j[0] : null;
  }
  async function reverse(lat, lon) {
    const url = `${C.REVERSE}?lat=${lat}&lon=${lon}&format=json&zoom=12&addressdetails=1`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    return r.json();
  }

  // Pull human-friendly names out of a Nominatim address block.
  function pickCenter(a) {
    return a && (a.city || a.town || a.village || a.suburb || a.county || a.state) || '';
  }

  // ---- state <-> form sync ----
  const clampKm = (n) => Math.min(Math.max(n, 1), 600);
  function readForm() {
    S.lat = num($('latInput').value) ?? S.lat;
    S.lon = num($('lonInput').value) ?? S.lon;
    const w = num($('areaInputW').value), h = num($('areaInputH').value);
    if (w && w > 0) S.areaKmW = clampKm(w);
    if (h && h > 0) S.areaKmH = clampKm(h);
    S.title = $('titleInput').value.trim();
  }
  function writeForm() {
    $('latInput').value = S.lat;
    $('lonInput').value = S.lon;
    $('areaInputW').value = S.areaKmW;
    $('areaInputH').value = S.areaKmH;
    $('titleInput').value = S.title;
    updateZoomBtns();
  }
  function persist() {
    ATLAS.save('atlas:lat', S.lat);
    ATLAS.save('atlas:lon', S.lon);
    ATLAS.save('atlas:areaW', S.areaKmW);
    ATLAS.save('atlas:areaH', S.areaKmH);
    ATLAS.save('atlas:title', S.title);
    ATLAS.save('atlas:cityBorders', S.cityBorders ? '1' : '0');
  }
  // Persist the rendered map itself (PNG data URL) plus the zoom shown in the
  // output readout, so a reload restores the whole working area, not just the
  // form. toDataURL can throw on a tainted canvas (ours isn't — all tile hosts
  // send CORS headers) and setItem can throw on quota; both fail silently.
  function persistMap(canvas, zoom) {
    try {
      ATLAS.save('atlas:map', canvas.toDataURL('image/png'));
      ATLAS.save('atlas:mapZoom', zoom == null ? '' : zoom);
    } catch (e) {}
  }
  // The output readout below the map (rebuilt on render and on restore).
  function writeOutInfo(zoom) {
    $('outInfo').innerHTML =
      `<span>LAT ${S.lat}</span><span>LON ${S.lon}</span>` +
      `<span>${S.areaKmW}×${S.areaKmH} km</span><span>z${zoom}</span>`;
  }

  // ---- city-district border toggle ----
  // Boolean ON/OFF switch (data-pos right = ON) for the OSM city/district
  // sub-layer. Flipping it re-renders the existing map (tiles are cached, so
  // the only network cost is the Overpass fetch — skipped entirely when off).
  function syncDistrictToggle() {
    const btn = $('districtToggle');
    if (btn) btn.dataset.pos = S.cityBorders ? 'right' : 'left';
  }
  function toggleDistricts() {
    S.cityBorders = !S.cityBorders;
    syncDistrictToggle();
    persist();
    ATLAS.rerender();
  }

  // ---- locate (forward geocode a place name) ----
  async function onLocate() {
    const q = $('placeSearch').value.trim();
    if (!q) { setStatus(ATLAS.t('st_need_place'), 'warn'); return; }
    readForm(); // preserve the user's current area (and any edits) before we writeForm
    setStatus(ATLAS.t('st_locating'));
    try {
      const hit = await geocode(q);
      if (!hit) { setStatus(ATLAS.t('st_not_found'), 'warn'); return; }
      S.lat = +parseFloat(hit.lat).toFixed(5);
      S.lon = +parseFloat(hit.lon).toFixed(5);
      S.title = (hit.display_name || q).split(',').slice(0, 2).join(',').trim();
      writeForm();
      persist();
      await render();
    } catch (e) {
      setStatus(ATLAS.t('st_geo_fail'), 'warn');
    }
  }

  // ---- render the map ----
  async function render() {
    if (S.rendering) return;
    readForm();
    if (S.lat == null || S.lon == null) { setStatus(ATLAS.t('st_need_coords'), 'warn'); return; }

    // auto-fill the title from a reverse lookup if the user left it blank
    if (!S.title) {
      try {
        const rv = await reverse(S.lat, S.lon);
        const a = (rv && rv.address) || {};
        S.title = pickCenter(a);
        writeForm();
      } catch (e) { /* the title is optional — carry on */ }
    }

    S.rendering = true;
    $('genBtn').disabled = true;
    $('dlBtn').disabled = true;
    $('stage').classList.add('rendering');
    try {
      const canvas = await ATLAS.renderMap({
        lat: S.lat, lon: S.lon, areaKmW: S.areaKmW, areaKmH: S.areaKmH,
        title: S.title, cityBorders: S.cityBorders,
        onProgress: (d, t) => setStatus(ATLAS.t('st_loading') + ` ${d}/${t}`),
      });
      lastCanvas = canvas;
      mountCanvas(canvas);
      const m = canvas._meta || {};
      writeOutInfo(m.zoom);
      $('dlBtn').disabled = false;
      setStatus(ATLAS.t('st_done'), 'ok');
      persist();
      persistMap(canvas, m.zoom);
    } catch (e) {
      console.error(e);
      setStatus(ATLAS.t('st_render_fail'), 'warn');
    } finally {
      S.rendering = false;
      $('genBtn').disabled = false;
      $('stage').classList.remove('rendering');
    }
  }

  // ---- recrop / zoom ----
  // Each step scales the captured km area (both edges, so the aspect ratio is
  // kept) around the same centre and re-renders: zooming in shrinks the box for
  // more detail, zooming out grows it. STEP is the per-click multiplier.
  const ZOOM_STEP = 1.5;
  function zoomBy(factor) {
    if (S.rendering || !lastCanvas) return;
    readForm();
    // Clamp the factor so neither edge leaves [1, 600] km, preserving aspect:
    // the larger edge can't exceed 600, the smaller can't drop below 1.
    let f = Math.min(factor, 600 / Math.max(S.areaKmW, S.areaKmH));
    f = Math.max(f, 1 / Math.min(S.areaKmW, S.areaKmH));
    const w = clampKm(Math.round(S.areaKmW * f)), h = clampKm(Math.round(S.areaKmH * f));
    if (w === S.areaKmW && h === S.areaKmH) return; // already at the limit
    S.areaKmW = w;
    S.areaKmH = h;
    writeForm();
    render();
  }
  // Grey out a zoom button once both edges have hit the matching km limit.
  function updateZoomBtns() {
    const zin = $('zoomInBtn'), zout = $('zoomOutBtn');
    if (!zin || !zout) return;
    zin.disabled = S.areaKmW <= 1 && S.areaKmH <= 1;
    zout.disabled = S.areaKmW >= 600 && S.areaKmH >= 600;
  }

  // ---- pan (recenter) ----
  // The four arrows nudge the captured centre N/S/E/W by a fraction of the
  // visible area and re-render. A degree of longitude shrinks with latitude, so
  // the east/west step is scaled by cos(lat); north/south is constant.
  const PAN_STEP = 0.3; // fraction of the visible edge moved per click
  function panBy(dx, dy) {
    if (S.rendering || !lastCanvas) return;
    readForm();
    const cl = Math.cos(S.lat * Math.PI / 180) || 1;
    const dLon = dx * PAN_STEP * S.areaKmW * 1000 / (111320 * cl);
    const dLat = dy * PAN_STEP * S.areaKmH * 1000 / 111320;
    S.lat = +clamp(S.lat + dLat, -85, 85).toFixed(5);
    S.lon = +clamp(S.lon + dLon, -180, 180).toFixed(5);
    writeForm();
    persist();
    render();
  }

  // ---- draw-to-recrop -------------------------------------------------------
  // A toggle in the zoom cluster lets the user rubber-band a rectangle straight
  // on the rendered map; on release we convert that box (via the view geometry
  // stored on the canvas meta) into a new centre + km area and re-render.
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  let cropping = false;
  let cropDrag = null; // { sx, sy, reg } while dragging

  // The map's drawable region (inside the PAD margins / above the title strip)
  // in client coords, plus the display scale and view — from the live canvas.
  function mapRegionRect() {
    const m = lastCanvas && lastCanvas._meta;
    if (!m || !m.view) return null;
    const r = lastCanvas.getBoundingClientRect();
    const scale = r.width / lastCanvas.width; // uniform: CSS preserves aspect
    return {
      left: r.left + m.pad * scale, top: r.top + m.pad * scale,
      w: m.mapW * scale, h: m.mapH * scale, view: m.view,
    };
  }

  function setCropMode(on) {
    cropping = !!(on && lastCanvas && lastCanvas._meta && lastCanvas._meta.view);
    $('cropBtn').setAttribute('aria-pressed', cropping ? 'true' : 'false');
    $('stage').classList.toggle('cropping', cropping);
    if (!cropping) { cropDrag = null; $('cropSel').hidden = true; }
  }

  function onCropDown(e) {
    if (!cropping || e.button !== 0) return;
    const reg = mapRegionRect();
    if (!reg) return;
    e.preventDefault();
    const x = clamp(e.clientX, reg.left, reg.left + reg.w);
    const y = clamp(e.clientY, reg.top, reg.top + reg.h);
    cropDrag = { sx: x, sy: y, reg };
    drawCropSel(x, y, x, y);
    window.addEventListener('pointermove', onCropMove);
    window.addEventListener('pointerup', onCropUp);
  }
  function onCropMove(e) {
    if (!cropDrag) return;
    const reg = cropDrag.reg;
    drawCropSel(cropDrag.sx, cropDrag.sy,
      clamp(e.clientX, reg.left, reg.left + reg.w),
      clamp(e.clientY, reg.top, reg.top + reg.h));
  }
  function onCropUp(e) {
    window.removeEventListener('pointermove', onCropMove);
    window.removeEventListener('pointerup', onCropUp);
    const drag = cropDrag;
    cropDrag = null;
    $('cropSel').hidden = true;
    if (!drag) return;
    const reg = drag.reg;
    const x1 = clamp(e.clientX, reg.left, reg.left + reg.w);
    const y1 = clamp(e.clientY, reg.top, reg.top + reg.h);
    // Ignore an accidental click / tiny drag.
    if (Math.abs(x1 - drag.sx) < 10 || Math.abs(y1 - drag.sy) < 10) return;
    applyCrop(drag.sx, drag.sy, x1, y1, reg);
    setCropMode(false);
  }

  // Position the rubber-band div (a child of #stage) for the two client points.
  function drawCropSel(x0, y0, x1, y1) {
    const sr = $('stage').getBoundingClientRect();
    const sel = $('cropSel');
    sel.hidden = false;
    sel.style.left = (Math.min(x0, x1) - sr.left) + 'px';
    sel.style.top = (Math.min(y0, y1) - sr.top) + 'px';
    sel.style.width = Math.abs(x1 - x0) + 'px';
    sel.style.height = Math.abs(y1 - y0) + 'px';
  }

  // Turn the drawn box (two client points) into a new centre + area, then render.
  function applyCrop(x0, y0, x1, y1, reg) {
    const fx = (cx) => clamp((cx - reg.left) / reg.w, 0, 1);
    const fy = (cy) => clamp((cy - reg.top) / reg.h, 0, 1);
    const fx0 = fx(Math.min(x0, x1)), fx1 = fx(Math.max(x0, x1));
    const fy0 = fy(Math.min(y0, y1)), fy1 = fy(Math.max(y0, y1));
    const nw = ATLAS.pxFracToLatLon(reg.view, fx0, fy0); // top-left
    const se = ATLAS.pxFracToLatLon(reg.view, fx1, fy1); // bottom-right
    const c  = ATLAS.pxFracToLatLon(reg.view, (fx0 + fx1) / 2, (fy0 + fy1) / 2);
    const cl = Math.cos(c.lat * Math.PI / 180);
    S.lat = +c.lat.toFixed(5);
    S.lon = +c.lon.toFixed(5);
    S.areaKmW = clampKm(Math.round((se.lon - nw.lon) * 111320 * cl / 1000));
    S.areaKmH = clampKm(Math.round((nw.lat - se.lat) * 111320 / 1000));
    writeForm();
    persist();
    render();
  }

  // Re-run the render with the current state — used by the colour palette UI to
  // restyle the existing map (tiles come from browser cache, so it's quick).
  // No-op until a map has been rendered at least once this session.
  ATLAS.rerender = function rerender() { if (lastCanvas) render(); };

  // Drop the rendered canvas into the stage (replacing placeholder / prior map).
  function mountCanvas(canvas) {
    const stage = $('stage');
    stage.querySelector('.placeholder')?.remove();
    const prev = stage.querySelector('canvas');
    if (prev) prev.remove();
    canvas.id = 'mapCanvas';
    canvas.removeAttribute('style');
    stage.appendChild(canvas);
    $('zoomCtl').hidden = false; // recrop controls become usable once a map exists
    setCropMode(false);          // a fresh map cancels any in-progress draw
    updateZoomBtns();
  }

  // Rebuild the last rendered map from a persisted PNG data URL so a reload
  // brings back the working area (and re-enables export) without re-fetching
  // tiles. No-op when nothing was stored.
  function restoreMap(dataUrl, zoom) {
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      lastCanvas = canvas;
      mountCanvas(canvas);
      writeOutInfo(zoom);
      $('dlBtn').disabled = false;
    };
    img.src = dataUrl;
  }

  // ---- export PNG ----
  function onDownload() {
    if (!lastCanvas) return;
    lastCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const tag = (S.title || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      a.href = url;
      a.download = `atlas-${tag || 'map'}-${S.areaKmW}x${S.areaKmH}km.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  // ---- init ----
  function init() {
    // restore persisted coords / area + the text inputs
    const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
    S.lat = num(get('atlas:lat', S.lat)) ?? S.lat;
    S.lon = num(get('atlas:lon', S.lon)) ?? S.lon;
    // Migrate the old single square edge ('atlas:area') into both dimensions.
    const oldArea = num(get('atlas:area', null));
    S.areaKmW = num(get('atlas:areaW', oldArea ?? S.areaKmW)) ?? S.areaKmW;
    S.areaKmH = num(get('atlas:areaH', oldArea ?? S.areaKmH)) ?? S.areaKmH;
    S.title = get('atlas:title', S.title);
    S.cityBorders = get('atlas:cityBorders', S.cityBorders ? '1' : '0') !== '0';
    writeForm();
    syncDistrictToggle();
    restoreMap(get('atlas:map', ''), get('atlas:mapZoom', ''));

    $('genBtn').addEventListener('click', render);
    $('dlBtn').addEventListener('click', onDownload);
    $('zoomInBtn').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
    $('zoomOutBtn').addEventListener('click', () => zoomBy(ZOOM_STEP));
    $('panUpBtn').addEventListener('click', () => panBy(0, 1));
    $('panDownBtn').addEventListener('click', () => panBy(0, -1));
    $('panLeftBtn').addEventListener('click', () => panBy(-1, 0));
    $('panRightBtn').addEventListener('click', () => panBy(1, 0));
    $('districtToggle').addEventListener('click', toggleDistricts);
    $('cropBtn').addEventListener('click', () => setCropMode(!cropping));
    $('stage').addEventListener('pointerdown', onCropDown);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cropping) setCropMode(false); });
    $('searchBtn').addEventListener('click', onLocate);
    $('placeSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') onLocate(); });
    // re-render on Enter from any coordinate / area field
    ['latInput', 'lonInput', 'areaInputW', 'areaInputH'].forEach((id) =>
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') render(); }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.ATLAS);
