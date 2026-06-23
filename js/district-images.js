// ATLAS — per-district background images. After clicking a city-district region
// (js/regions.js), the colour popup offers SET / EDIT / REMOVE IMAGE. Setting an
// image opens a placement editor: the picture is masked to the district's exact
// polygon ("a window of the district's shape") and the user drags to pan and
// scrolls to zoom it into position. On DONE the transform is committed to
// ATLAS.state.districtImages (keyed on the stable OSM relation id) and the map is
// re-rendered, which bakes the image into the canvas on top of every other map
// element but under the annotation markers (drawDistrictImages in js/map.js).
//
// The stored transform is { src, scale, ox, oy }: src is a downscaled data URL,
// scale a multiplier on a cover-fit baseline, and ox/oy a pan offset as a fraction
// of the district's projected bounding box — so, like regionColors, the placement
// survives pan / zoom / recrop. The editor previews with the identical cover-fit +
// scale + pan math the renderer uses, so what you position is what you export.
//
// Like region colour-picking, this is live only after a render this session: it
// needs the district ring geometry stashed on the live canvas (_regions), which is
// too heavy to persist with the cached PNG. Persisted under atlas:districtImages.
(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  const S = ATLAS.state;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const SVGNS = 'http://www.w3.org/2000/svg';

  const MAX_EDGE = 1024;   // longest stored image edge (px) — keeps localStorage small
  const JPEG_Q = 0.82;     // stored encode quality
  const MIN_SCALE = 0.1, MAX_SCALE = 12; // zoom clamps

  // ---- restore persisted images (data only — runs before app.js renders) ----
  if (!S.districtImages || typeof S.districtImages !== 'object') S.districtImages = {};
  try {
    const raw = localStorage.getItem('atlas:districtImages');
    if (raw) Object.assign(S.districtImages, JSON.parse(raw));
  } catch (e) { /* storage blocked / corrupt — keep defaults */ }
  function persist() {
    // Best-effort, like the cached map PNG: many/large images can exceed the
    // localStorage quota; ATLAS.save swallows the throw, so the image still works
    // for this session and simply isn't restored on the next reload.
    ATLAS.save('atlas:districtImages', JSON.stringify(S.districtImages));
  }

  // ---- the live rendered map (carries the view geometry in _meta) ------------
  function liveMap() {
    const cv = $('mapCanvas');
    return cv && cv._meta && cv._meta.view ? cv : null;
  }

  // ---- image import (downscale + re-encode) ----------------------------------
  // Read the picked file → downscale to <= MAX_EDGE on its longest edge → re-encode
  // as a JPEG data URL. Callback gets the data URL, or null on failure.
  function importFile(file, cb) {
    if (!file) { cb(null); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        const long = Math.max(w, h);
        if (long > MAX_EDGE) { const k = MAX_EDGE / long; w = Math.round(w * k); h = Math.round(h * k); }
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, w); cv.height = Math.max(1, h);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        let url;
        try { url = cv.toDataURL('image/jpeg', JPEG_Q); } catch (e) { url = null; }
        cb(url);
      };
      img.onerror = () => cb(null);
      img.src = reader.result;
    };
    reader.onerror = () => cb(null);
    reader.readAsDataURL(file);
  }

  // ---- placement editor ------------------------------------------------------
  let layer, svg, clipPath, imgEl, outline, bar; // DOM (built once, lazily)
  let region = null;     // the district being edited ({ id, name, rings })
  let img = null;        // the decoded <Image> currently being placed
  let t = null;          // working transform { scale, ox, oy } (committed on DONE)
  let geom = null;       // cached overlay geometry { W, H, bb }
  let raf = 0;

  function build() {
    layer = $('districtImageLayer');
    if (!layer || svg) return;
    svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'dimg-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    const defs = document.createElementNS(SVGNS, 'defs');
    clipPath = document.createElementNS(SVGNS, 'clipPath');
    clipPath.setAttribute('id', 'dimgClip');
    clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const clipShape = document.createElementNS(SVGNS, 'path');
    clipShape.setAttribute('class', 'dimg-clip-shape');
    clipPath.appendChild(clipShape);
    defs.appendChild(clipPath);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('clip-path', 'url(#dimgClip)');
    imgEl = document.createElementNS(SVGNS, 'image');
    imgEl.setAttribute('preserveAspectRatio', 'none');
    g.appendChild(imgEl);
    outline = document.createElementNS(SVGNS, 'path'); // dashed district edge, on top
    outline.setAttribute('class', 'dimg-outline');
    svg.append(defs, g, outline);

    // control bar: a hint + DONE / REMOVE / CANCEL (built in JS, styled via CSS)
    bar = document.createElement('div');
    bar.className = 'dimg-bar';
    bar.innerHTML =
      '<span class="dimg-hint" data-i18n="hint_image">Drag to move · scroll to zoom</span>' +
      '<button type="button" class="btn btn-sm dimg-done" data-augmented-ui="tl-clip br-clip border" data-i18n="b_done">DONE</button>' +
      '<button type="button" class="btn btn-sm dimg-remove" data-augmented-ui="tl-clip br-clip border" data-i18n="b_remove_image">REMOVE</button>' +
      '<button type="button" class="btn btn-sm dimg-cancel" data-augmented-ui="tl-clip br-clip border" data-i18n="b_cancel">CANCEL</button>';
    layer.append(svg, bar);
    if (ATLAS.applyLang) bar.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = ATLAS.t(el.getAttribute('data-i18n')); if (v) el.textContent = v;
    });

    bar.querySelector('.dimg-done').addEventListener('click', commit);
    bar.querySelector('.dimg-cancel').addEventListener('click', () => teardown());
    bar.querySelector('.dimg-remove').addEventListener('click', removeCurrent);
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('wheel', onWheel, { passive: false });
  }

  // Compute the overlay geometry from the live canvas (mirrors markers.reposition):
  // size + place #districtImageLayer over the map region, and project the district's
  // lon/lat bbox into that px space. Returns false if there's no live map.
  function computeGeom() {
    const cv = liveMap();
    if (!cv || !region) return false;
    const M = cv._meta;
    const stage = $('stage');
    const sr = stage.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    const scale = cr.width / cv.width; // uniform (CSS preserves aspect)
    const W = M.mapW * scale, H = M.mapH * scale;
    layer.style.left = (cr.left - sr.left + M.pad * scale) + 'px';
    layer.style.top = (cr.top - sr.top + M.pad * scale) + 'px';
    layer.style.width = W + 'px';
    layer.style.height = H + 'px';
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    // project the district rings' lon/lat bbox to overlay px (mercator keeps the
    // bbox axis-aligned, so corners suffice)
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const ring of region.rings) for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    const tl = ATLAS.latLonToPxFrac(M.view, maxLat, minLon); // top-left
    const br = ATLAS.latLonToPxFrac(M.view, minLat, maxLon); // bottom-right
    const bb = { x: tl.fx * W, y: tl.fy * H, w: (br.fx - tl.fx) * W, h: (br.fy - tl.fy) * H };
    geom = { W, H, bb, view: M.view };
    return true;
  }

  // Build the clip path + dashed outline from the district rings (overlay px).
  function pathFromRings(M, W, H) {
    let d = '';
    for (const ring of region.rings) {
      if (ring.length < 3) continue;
      ring.forEach(([lon, lat], i) => {
        const f = ATLAS.latLonToPxFrac(M.view, lat, lon);
        d += (i ? 'L' : 'M') + (f.fx * W).toFixed(1) + ' ' + (f.fy * H).toFixed(1) + ' ';
      });
      d += 'Z ';
    }
    return d;
  }

  // Re-layout everything from the current transform `t` + geometry `geom`.
  function layout() {
    if (!computeGeom() || !img) return;
    const { W, H, bb, view } = geom;
    const d = pathFromRings({ view }, W, H);
    clipPath.firstChild.setAttribute('d', d);
    outline.setAttribute('d', d);
    if (!(bb.w > 0) || !(bb.h > 0)) return;
    const s0 = Math.max(bb.w / img.naturalWidth, bb.h / img.naturalHeight); // cover-fit
    const drawW = img.naturalWidth * s0 * t.scale, drawH = img.naturalHeight * s0 * t.scale;
    const cx = bb.x + bb.w / 2 + t.ox * bb.w, cy = bb.y + bb.h / 2 + t.oy * bb.h;
    imgEl.setAttribute('x', cx - drawW / 2);
    imgEl.setAttribute('y', cy - drawH / 2);
    imgEl.setAttribute('width', drawW);
    imgEl.setAttribute('height', drawH);
  }

  // ---- drag (pan) ------------------------------------------------------------
  function onDown(e) {
    if (e.button !== 0 || !geom) return;
    e.preventDefault();
    const lr = layer.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, ox0 = t.ox, oy0 = t.oy;
    const bb = geom.bb;
    svg.classList.add('grabbing');
    const move = (ev) => {
      // ox/oy are a fraction of the projected bbox, so a px drag delta maps to
      // delta / bb.{w,h}
      t.ox = ox0 + (ev.clientX - sx) / bb.w;
      t.oy = oy0 + (ev.clientY - sy) / bb.h;
      layout();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      svg.classList.remove('grabbing');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- wheel (zoom about the cursor) -----------------------------------------
  function onWheel(e) {
    if (!geom) return;
    e.preventDefault();
    const lr = layer.getBoundingClientRect();
    const px = e.clientX - lr.left, py = e.clientY - lr.top; // cursor in overlay px
    const k = Math.exp(-e.deltaY * 0.0015); // smooth multiplicative zoom
    const ns = clamp(t.scale * k, MIN_SCALE, MAX_SCALE);
    const kk = ns / t.scale;
    if (kk === 1) return;
    const bb = geom.bb;
    const cx = bb.x + bb.w / 2 + t.ox * bb.w, cy = bb.y + bb.h / 2 + t.oy * bb.h;
    // scale the image about the cursor: the new centre keeps the point under the
    // cursor fixed (newC = P + (C - P) * kk)
    const ncx = px + (cx - px) * kk, ncy = py + (cy - py) * kk;
    t.scale = ns;
    t.ox = (ncx - (bb.x + bb.w / 2)) / bb.w;
    t.oy = (ncy - (bb.y + bb.h / 2)) / bb.h;
    layout();
  }

  // ---- open / commit / teardown ----------------------------------------------
  function open(reg, src, transform) {
    build();
    region = reg;
    t = { scale: transform.scale > 0 ? transform.scale : 1, ox: transform.ox || 0, oy: transform.oy || 0 };
    // point the SVG <image> at the picture (href + legacy xlink:href for safety)
    imgEl.setAttribute('href', src);
    imgEl.setAttributeNS('http://www.w3.org/1999/xlink', 'href', src);
    // a separate decode gives us the natural dimensions for the cover-fit math
    img = new Image();
    img.onload = () => { layer.hidden = false; layout(); };
    img.onerror = () => teardown();
    img._src = src;
    img.src = src;
    $('stage').classList.add('placing-image');
  }
  function commit() {
    if (region && img && img._src) {
      S.districtImages[region.id] = { src: img._src, scale: t.scale, ox: t.ox, oy: t.oy };
      persist();
    }
    teardown(true);
  }
  function removeCurrent() {
    if (region) { delete S.districtImages[region.id]; persist(); }
    teardown(true);
  }
  function teardown(rerender) {
    if (layer) layer.hidden = true;
    $('stage').classList.remove('placing-image');
    region = null; img = null; t = null; geom = null;
    if (rerender && ATLAS.rerender) ATLAS.rerender();
  }

  // ---- public API ------------------------------------------------------------
  // begin(region): set (file pick) or edit (existing) a district's image.
  function begin(reg) {
    if (!reg || !liveMap()) return;
    const existing = S.districtImages[reg.id];
    if (existing && existing.src) {
      open(reg, existing.src, existing);
      return;
    }
    const input = $('districtImageFile');
    if (!input) return;
    input.value = ''; // allow re-picking the same file
    input.onchange = () => {
      const file = input.files && input.files[0];
      importFile(file, (url) => { if (url) open(reg, url, { scale: 1, ox: 0, oy: 0 }); });
    };
    input.click();
  }
  function has(id) { return !!(S.districtImages[id] && S.districtImages[id].src); }
  function remove(id) {
    if (!has(id)) return;
    delete S.districtImages[id];
    persist();
    if (ATLAS.rerender) ATLAS.rerender();
  }

  ATLAS.districtImages = { begin, has, remove };

  // keep the placement overlay aligned if the window resizes mid-edit + allow Esc
  window.addEventListener('resize', () => {
    if (!region) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(layout);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && region) teardown(); });
})(window.ATLAS);
