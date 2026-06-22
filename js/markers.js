// ATLAS — land markers. Draggable, editable annotation pins anchored to
// geographic coordinates, so they stay put when the map is panned, zoomed,
// recropped or recoloured. Each carries a label and an optional callout bubble.
//
// Rendered two ways from one source of truth (ATLAS.state.markers): a DOM
// overlay (#markerLayer) positioned over the map region for interaction, and —
// at export time — drawn straight onto the canvas so they appear in the PNG.
// Persisted under atlas:markers. Attaches its public API to ATLAS.markers.
(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  const S = ATLAS.state;

  // Annotation accent: the app's signature cyan, kept distinct from the (user
  // recolourable) map palette so markers always read as a separate overlay.
  const ACCENT = '#00f0ff';
  const INK = 'rgba(6,18,26,0.92)'; // dark backing for legibility
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  let layer = null;     // #markerLayer (covers the map region)
  let editor = null;    // #markerEditor popup
  let editingId = null; // marker id currently open in the editor
  let uid = 1;          // next marker id
  let raf = 0;          // debounce handle for resize repositioning

  // ---- persistence -----------------------------------------------------------
  function persist() {
    ATLAS.save('atlas:markers', JSON.stringify(S.markers));
  }
  function restore() {
    if (!Array.isArray(S.markers)) S.markers = []; // defensive: always iterable
    try {
      const raw = localStorage.getItem('atlas:markers');
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) S.markers = arr;
    } catch (e) { /* corrupt / blocked — keep the empty default */ }
    // normalise ids so uid never collides with a restored one
    for (const m of S.markers) {
      if (m.id == null) m.id = uid++;
      else uid = Math.max(uid, m.id + 1);
    }
  }

  // ---- the live rendered map (its canvas carries the view geometry in _meta) --
  function currentMeta() {
    const cv = $('mapCanvas');
    return cv && cv._meta && cv._meta.view ? { cv, meta: cv._meta } : null;
  }
  const editing = () => S.markers.find((m) => m.id === editingId);

  // ---- build / place the DOM overlay -----------------------------------------
  function buildMarker(m) {
    const el = document.createElement('div');
    el.className = 'marker';
    el.dataset.id = m.id;

    const pin = document.createElement('div');
    pin.className = 'marker-pin';

    const body = document.createElement('div');
    body.className = 'marker-body';
    const label = document.createElement('div');
    label.className = 'marker-label';
    label.textContent = m.label || '';
    const callout = document.createElement('div');
    callout.className = 'marker-callout';
    callout.textContent = m.callout || '';
    callout.hidden = !(m.showCallout && m.callout);
    body.append(label, callout);

    el.append(pin, body);
    attachDrag(el, m);
    return el;
  }

  // Rebuild the overlay's children from state. Cheap for the marker counts a map
  // annotation realistically carries; called whenever the set changes.
  function build() {
    if (!layer) return;
    layer.textContent = '';
    for (const m of S.markers) layer.appendChild(buildMarker(m));
  }

  // Size + place the overlay over the map region of the displayed canvas, then
  // position each marker by its geographic fraction (hiding any off-view). The
  // canvas is shown CSS-scaled, so everything is derived from its client rect.
  function reposition() {
    const mc = currentMeta();
    const add = $('addMarkerBtn');
    if (add) add.disabled = !mc;
    if (!layer) return;
    if (!mc) { layer.hidden = true; return; }
    layer.hidden = false;
    // self-heal: keep the overlay's elements in step with state (e.g. markers
    // restored before the layer was first built). Content edits rebuild via
    // sync(); this only guards the element/state membership.
    if (layer.querySelectorAll('.marker').length !== S.markers.length) build();

    const stage = $('stage');
    const M = mc.meta;
    const sr = stage.getBoundingClientRect();
    const cr = mc.cv.getBoundingClientRect();
    const scale = cr.width / mc.cv.width; // uniform (CSS preserves aspect)
    layer.style.left = (cr.left - sr.left + M.pad * scale) + 'px';
    layer.style.top = (cr.top - sr.top + M.pad * scale) + 'px';
    layer.style.width = (M.mapW * scale) + 'px';
    layer.style.height = (M.mapH * scale) + 'px';

    layer.querySelectorAll('.marker').forEach((el) => {
      const m = S.markers.find((x) => String(x.id) === el.dataset.id);
      if (!m) { el.remove(); return; }
      const f = ATLAS.latLonToPxFrac(M.view, m.lat, m.lon);
      if (f.fx < -0.03 || f.fx > 1.03 || f.fy < -0.03 || f.fy > 1.03) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = (f.fx * 100) + '%';
      el.style.top = (f.fy * 100) + '%';
    });
  }

  // Rebuild + reposition: the all-purpose refresh used after any change.
  function sync() { build(); reposition(); }

  // ---- drag (move) / click (edit) --------------------------------------------
  // Window-level move/up listeners (the same robust pattern the recrop drag
  // uses) rather than pointer capture, since the marker root is pointer-events
  // none and only its children are hit targets. A sub-threshold press with no
  // movement is treated as a click → open the editor.
  function attachDrag(el, m) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const mc = currentMeta();
      if (!mc) return;
      e.preventDefault();
      const lr = layer.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      let moved = false, fx = null, fy = null;
      el.classList.add('dragging');

      const move = (ev) => {
        if (!moved && (Math.abs(ev.clientX - sx) > 3 || Math.abs(ev.clientY - sy) > 3)) moved = true;
        if (!moved) return;
        fx = clamp((ev.clientX - lr.left) / lr.width, 0, 1);
        fy = clamp((ev.clientY - lr.top) / lr.height, 0, 1);
        el.style.left = (fx * 100) + '%';
        el.style.top = (fy * 100) + '%';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        el.classList.remove('dragging');
        if (moved && fx != null) {
          const ll = ATLAS.pxFracToLatLon(mc.meta.view, fx, fy);
          m.lat = +ll.lat.toFixed(5);
          m.lon = +ll.lon.toFixed(5);
          persist();
        } else {
          openEditor(m, el);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  // ---- add ----
  function addMarker() {
    const mc = currentMeta();
    if (!mc) return;
    const c = ATLAS.pxFracToLatLon(mc.meta.view, 0.5, 0.5); // centre of current view
    const m = {
      id: uid++,
      lat: +c.lat.toFixed(5),
      lon: +c.lon.toFixed(5),
      label: 'MARKER ' + S.markers.length,
      callout: '',
      showCallout: false,
    };
    S.markers.push(m);
    persist();
    sync();
    openEditor(m, layer.querySelector(`.marker[data-id="${m.id}"]`));
  }

  // ---- editor ----------------------------------------------------------------
  function openEditor(m, el) {
    editingId = m.id;
    $('meLabel').value = m.label || '';
    $('meCallout').value = m.callout || '';
    const on = !!m.showCallout;
    $('meCalloutToggle').dataset.pos = on ? 'right' : 'left';
    $('meCalloutField').hidden = !on;
    editor.hidden = false;
    positionEditor(el);
    const lab = $('meLabel');
    lab.focus();
    lab.select();
  }
  function closeEditor() { editor.hidden = true; editingId = null; }

  // Place the popup beside the marker pin, flipping/clamping to stay on-screen.
  function positionEditor(el) {
    const pin = el && el.querySelector('.marker-pin');
    const r = pin ? pin.getBoundingClientRect()
                  : { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 2 };
    editor.style.visibility = 'hidden';
    editor.hidden = false;
    const ew = editor.offsetWidth, eh = editor.offsetHeight, m = 14;
    let left = r.right + m;
    if (left + ew > innerWidth - 8) left = r.left - ew - m; // flip to the left side
    left = clamp(left, 8, Math.max(8, innerWidth - ew - 8));
    let top = clamp(r.top - 10, 8, Math.max(8, innerHeight - eh - 8));
    editor.style.left = left + 'px';
    editor.style.top = top + 'px';
    editor.style.visibility = '';
  }

  // ---- export: draw markers onto a canvas context ----------------------------
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // Word-wrap honouring explicit newlines.
  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const raw of String(text).split('\n')) {
      if (!raw) { out.push(''); continue; }
      let line = '';
      for (const word of raw.split(/\s+/)) {
        const t = line ? line + ' ' + word : word;
        if (line && ctx.measureText(t).width > maxW) { out.push(line); line = word; }
        else line = t;
      }
      out.push(line);
    }
    return out;
  }
  function drawCallout(ctx, x, y, text) {
    ctx.font = "500 12px 'JetBrains Mono', monospace";
    const maxW = 200, padX = 8, padY = 6, lh = 16;
    const lines = wrapText(ctx, text, maxW);
    let tw = 0;
    for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
    const bw = tw + padX * 2, bh = lines.length * lh + padY * 2;
    ctx.fillStyle = 'rgba(6,18,26,0.9)';
    roundRect(ctx, x, y, bw, bh, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,240,255,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = ACCENT; ctx.fillRect(x, y, 2, bh); // accent left edge
    ctx.fillStyle = '#d8e6ee'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x + padX, y + padY + i * lh));
  }
  function drawOneMarker(ctx, x, y, m) {
    const label = (m.label || '').toUpperCase();
    const bx = x + 12; // label/callout column, right of the pin
    if (label) {
      ctx.font = "700 13px 'JetBrains Mono', monospace";
      ctx.textBaseline = 'middle';
      const padX = 7, bh = 20, tw = ctx.measureText(label).width, bw = tw + padX * 2;
      ctx.fillStyle = INK;
      roundRect(ctx, bx, y - bh / 2, bw, bh, 2); ctx.fill();
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = ACCENT; ctx.textAlign = 'left';
      ctx.fillText(label, bx + padX, y + 0.5);
      if (m.showCallout && m.callout) drawCallout(ctx, bx, y + bh / 2 + 5, m.callout);
    } else if (m.showCallout && m.callout) {
      drawCallout(ctx, bx, y - 8, m.callout);
    }
    // pin diamond on top
    ctx.save();
    ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = ACCENT;
    roundRect(ctx, -7, -7, 14, 14, 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#06121a'; ctx.stroke();
    ctx.restore();
  }
  // Public: stamp the in-view markers onto a context using a stored canvas meta.
  function drawOnto(ctx, meta) {
    if (!meta || !meta.view || !S.markers || !S.markers.length) return;
    ctx.save();
    for (const m of S.markers) {
      const f = ATLAS.latLonToPxFrac(meta.view, m.lat, m.lon);
      if (f.fx < 0 || f.fx > 1 || f.fy < 0 || f.fy > 1) continue;
      drawOneMarker(ctx, meta.pad + f.fx * meta.mapW, meta.pad + f.fy * meta.mapH, m);
    }
    ctx.restore();
  }

  // ---- init ------------------------------------------------------------------
  function init() {
    layer = $('markerLayer');
    editor = $('markerEditor');
    if (!layer || !editor) return;
    restore();
    build();

    $('addMarkerBtn').addEventListener('click', addMarker);

    // editor inputs operate on the currently-open marker, live + persisted
    $('meLabel').addEventListener('input', () => {
      const m = editing(); if (!m) return;
      m.label = $('meLabel').value;
      persist(); sync();
    });
    $('meCalloutToggle').addEventListener('click', () => {
      const m = editing(); if (!m) return;
      m.showCallout = !m.showCallout;
      $('meCalloutToggle').dataset.pos = m.showCallout ? 'right' : 'left';
      $('meCalloutField').hidden = !m.showCallout;
      persist(); sync();
    });
    $('meCallout').addEventListener('input', () => {
      const m = editing(); if (!m) return;
      m.callout = $('meCallout').value;
      persist(); sync();
    });
    $('meDelete').addEventListener('click', () => {
      S.markers = S.markers.filter((x) => x.id !== editingId);
      persist(); closeEditor(); sync();
    });
    $('meDone').addEventListener('click', closeEditor);

    // dismiss the editor on outside click / Escape (a click on another marker is
    // left for that marker's own handler, which reopens the editor for it)
    document.addEventListener('pointerdown', (e) => {
      if (editor.hidden) return;
      if (e.target.closest('#markerEditor') || e.target.closest('.marker')) return;
      closeEditor();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !editor.hidden) closeEditor(); });

    // the overlay tracks the canvas's displayed size
    window.addEventListener('resize', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(reposition);
    });
  }

  // public API (app.js drives reposition on mount/restore + drawOnto on export)
  ATLAS.markers = { reposition, drawOnto };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.ATLAS);
