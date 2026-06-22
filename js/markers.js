// ATLAS — land markers. Draggable, editable annotation pins anchored to
// geographic coordinates, so they stay put when the map is panned, zoomed,
// recropped or recoloured. Each carries a label and an optional callout bubble.
//
// Pin and label are disjointed: the pin is anchored to a lat/lon, the label
// floats at its own offset from the pin (stored as a fraction of the map, so it
// survives zoom and exports cleanly) and is dragged independently. A connector
// line — straight or right-angled (90°), per marker — links the two.
//
// Rendered two ways from one source of truth (ATLAS.state.markers): a DOM
// overlay (#markerLayer) positioned over the map region for interaction, and —
// at export time — drawn straight onto the canvas so they appear in the PNG.
// Persisted under atlas:markers. Attaches its public API to ATLAS.markers.
(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  const S = ATLAS.state;
  const C = ATLAS.const;

  // Annotation accent fallback: the app's signature cyan. Each marker resolves
  // its own colour via colorOf() — its per-marker override if set, otherwise the
  // user-pickable colors.marker default, otherwise this. Kept conceptually
  // distinct from the map palette so markers read as a separate overlay.
  const ACCENT = '#00f0ff';
  const INK = 'rgba(6,18,26,0.92)'; // dark backing for legibility
  // Resolve a marker's accent colour, and build an rgba() string from a hex.
  const colorOf = (m) => m.color || (S.colors && S.colors.marker) || ACCENT;
  const rgba = (hex, a) => { const [r, g, b] = ATLAS.hexToArr(hex); return `rgba(${r},${g},${b},${a})`; };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  // Default label offset from the pin (fraction of map width / height): a little
  // to the right and up, mirroring the old fixed label position.
  const DEF_LDX = 0.06, DEF_LDY = -0.05;

  // ---- pin shapes ------------------------------------------------------------
  // The pin glyph anchored on the coordinate. 'diamond' is the historical look
  // (and the default for older persisted markers); 'none' draws nothing but
  // keeps a clickable/draggable hit area. Geometry is defined once as a unit
  // outline centred on the origin, then scaled — shared by the DOM pin (SVG),
  // the editor's picker icons, and the export (canvas) so all three match.
  const SHAPES = ['diamond', 'circle', 'square', 'triangle', 'star', 'none'];
  const DEF_SHAPE = 'diamond';
  function starUnit(n, ro, ri) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const rad = i % 2 ? ri : ro, a = -Math.PI / 2 + (i * Math.PI) / n;
      pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
    }
    return pts;
  }
  // Returns { poly:[[x,y]…] } for angular shapes, { circle:true } or { none:true }.
  function shapeGeom(shape) {
    switch (shape) {
      case 'square':   return { poly: [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]] };
      case 'triangle': return { poly: [[0, -1], [0.92, 0.72], [-0.92, 0.72]] };
      case 'star':     return { poly: starUnit(5, 1, 0.46) };
      case 'circle':   return { circle: true };
      case 'none':     return { none: true };
      case 'diamond':
      default:         return { poly: [[0, -1], [1, 0], [0, 1], [-1, 0]] };
    }
  }
  const PIN_R = 8; // pin radius in SVG/canvas units

  let layer = null;     // #markerLayer (covers the map region)
  let lines = null;     // <svg> inside the layer carrying the connector paths
  let editor = null;    // #markerEditor popup
  let editingId = null; // marker id currently open in the editor
  let uid = 1;          // next marker id
  let raf = 0;          // debounce handle for resize repositioning

  // ---- model -----------------------------------------------------------------
  // Backfill fields that older persisted markers (pre disjoint-label) lack.
  function normalize(m) {
    if (m.ldx == null) m.ldx = DEF_LDX;
    if (m.ldy == null) m.ldy = DEF_LDY;
    if (m.line !== 'elbow') m.line = 'straight';
    m.underline = !!m.underline; // bare-underline label style (no box/background)
    if (m.color == null) m.color = null; // per-marker colour override (null = default)
    if (!SHAPES.includes(m.shape)) m.shape = DEF_SHAPE; // pin glyph
  }

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
      normalize(m);
    }
  }

  // ---- the live rendered map (its canvas carries the view geometry in _meta) --
  function currentMeta() {
    const cv = $('mapCanvas');
    return cv && cv._meta && cv._meta.view ? { cv, meta: cv._meta } : null;
  }
  const editing = () => S.markers.find((m) => m.id === editingId);

  // ---- connector geometry ----------------------------------------------------
  // Points (in a shared coordinate space) for the line from pin P to a label
  // box, either straight or right-angled. Returns null when the pin sits inside
  // the box (nothing to connect). The elbow turns horizontally first, then drops
  // onto the box's nearest edge/corner — which collapses to a clean single
  // segment when the pin is directly beside / above the box.
  function connectorPoints(P, box, mode, underline) {
    const l = box.x, t = box.y, r = box.x + box.w, b = box.y + box.h;
    if (P.x >= l && P.x <= r && P.y >= t && P.y <= b) return null;
    if (underline) {
      // Underline style: arrive at the bottom corner nearest the pin, then run
      // the full width of the box. That last segment *is* the label's underline,
      // so pin → label → underline read as one continuous, unbroken line.
      const near = Math.abs(P.x - l) <= Math.abs(P.x - r) ? l : r;
      const far = near === l ? r : l;
      if (mode === 'elbow') return [P, { x: near, y: P.y }, { x: near, y: b }, { x: far, y: b }];
      return [P, { x: near, y: b }, { x: far, y: b }];
    }
    const ax = clamp(P.x, l, r), ay = clamp(P.y, t, b); // nearest point on box
    if (mode === 'elbow') return [P, { x: ax, y: P.y }, { x: ax, y: ay }];
    return [P, { x: ax, y: ay }];
  }

  // ---- build / place the DOM overlay -----------------------------------------
  // The pin glyph as an SVG sized to the .marker-pin box. 'none' yields an empty
  // SVG (the .marker-pin div still carries the drag/click hit area). Fill/stroke
  // come from CSS (.pin-shape → var(--mk)).
  function buildPinSvg(shape) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'pin-svg');
    svg.setAttribute('viewBox', '-10 -10 20 20');
    const g = shapeGeom(shape);
    if (g.none) return svg;
    let node;
    if (g.circle) {
      node = document.createElementNS(SVGNS, 'circle');
      node.setAttribute('r', PIN_R - 1);
    } else {
      node = document.createElementNS(SVGNS, 'polygon');
      node.setAttribute('points', g.poly.map(([x, y]) =>
        (x * PIN_R).toFixed(2) + ',' + (y * PIN_R).toFixed(2)).join(' '));
    }
    node.setAttribute('class', 'pin-shape');
    svg.appendChild(node);
    return svg;
  }

  function buildMarker(m) {
    const el = document.createElement('div');
    el.className = 'marker';
    el.dataset.id = m.id;

    const pin = document.createElement('div');
    pin.className = 'marker-pin';
    pin.appendChild(buildPinSvg(m.shape));

    const body = document.createElement('div');
    body.className = 'marker-body';
    const label = document.createElement('div');
    label.className = 'marker-label';
    label.classList.toggle('underline', !!m.underline);
    label.textContent = m.label || '';
    const callout = document.createElement('div');
    callout.className = 'marker-callout';
    callout.textContent = m.callout || '';
    callout.hidden = !(m.showCallout && m.callout);
    body.append(label, callout);

    el.append(pin, body);
    // pin and label drag independently; either, clicked, opens the editor
    attachDrag(el, pin, m, 'pin');
    attachDrag(el, body, m, 'label');
    return el;
  }

  // Rebuild the overlay's children from state. Cheap for the marker counts a map
  // annotation realistically carries; called whenever the set changes.
  function build() {
    if (!layer) return;
    // keep the persistent <svg> of connector lines; replace only the markers
    layer.querySelectorAll('.marker').forEach((el) => el.remove());
    lines.textContent = '';
    for (const m of S.markers) {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'marker-line');
      path.dataset.id = m.id;
      lines.appendChild(path);
      layer.appendChild(buildMarker(m));
    }
  }

  // Size + place the overlay over the map region of the displayed canvas, then
  // position each pin by its geographic fraction, float each label at its offset,
  // and route the connector between them (hiding any whose pin is off-view). The
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
    const W = M.mapW * scale, H = M.mapH * scale;
    layer.style.width = W + 'px';
    layer.style.height = H + 'px';
    lines.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const lr = layer.getBoundingClientRect();
    layer.querySelectorAll('.marker').forEach((el) => {
      const m = S.markers.find((x) => String(x.id) === el.dataset.id);
      const path = lines.querySelector(`.marker-line[data-id="${el.dataset.id}"]`);
      if (!m) { el.remove(); if (path) path.remove(); return; }
      // drive the overlay's colour vars from the marker's resolved accent
      const col = colorOf(m);
      el.style.setProperty('--mk', col);
      if (path) { path.style.stroke = col; path.style.filter = `drop-shadow(0 0 3px ${rgba(col, 0.6)})`; }
      const f = ATLAS.latLonToPxFrac(M.view, m.lat, m.lon);
      if (f.fx < -0.03 || f.fx > 1.03 || f.fy < -0.03 || f.fy > 1.03) {
        el.style.display = 'none';
        if (path) path.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = (f.fx * 100) + '%';
      el.style.top = (f.fy * 100) + '%';

      // float the label at its offset (fraction of the displayed map), centred
      const body = el.querySelector('.marker-body');
      const bw = body.offsetWidth, bh = body.offsetHeight;
      body.style.left = (m.ldx * W - bw / 2) + 'px';
      body.style.top = (m.ldy * H - bh / 2) + 'px';

      // route the connector: pin point → nearest edge of the label box
      if (!path) return;
      const pinPt = { x: f.fx * W, y: f.fy * H };
      const target = el.querySelector('.marker-label');
      const tEl = (target && target.offsetWidth) ? target : body;
      const br = tEl.getBoundingClientRect();
      if (!br.width || !br.height) { path.style.display = 'none'; return; }
      const box = { x: br.left - lr.left, y: br.top - lr.top, w: br.width, h: br.height };
      const pts = connectorPoints(pinPt, box, m.line, m.underline);
      if (!pts) { path.style.display = 'none'; return; }
      path.style.display = '';
      path.setAttribute('d', pts.map((p, i) =>
        (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' '));
    });
  }

  // Rebuild + reposition: the all-purpose refresh used after any change.
  function sync() { build(); reposition(); }

  // ---- drag (move) / click (edit) --------------------------------------------
  // Window-level move/up listeners (the same robust pattern the recrop drag
  // uses) rather than pointer capture. A sub-threshold press with no movement is
  // treated as a click → open the editor. kind 'pin' repositions the geographic
  // anchor; kind 'label' shifts the label's offset (leaving the pin put).
  function attachDrag(el, handle, m, kind) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const mc = currentMeta();
      if (!mc) return;
      e.preventDefault();
      e.stopPropagation();
      const lr = layer.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const ldx0 = m.ldx, ldy0 = m.ldy;
      let moved = false;
      el.classList.add('dragging');

      const move = (ev) => {
        if (!moved && (Math.abs(ev.clientX - sx) > 3 || Math.abs(ev.clientY - sy) > 3)) moved = true;
        if (!moved) return;
        if (kind === 'pin') {
          const fx = clamp((ev.clientX - lr.left) / lr.width, 0, 1);
          const fy = clamp((ev.clientY - lr.top) / lr.height, 0, 1);
          const ll = ATLAS.pxFracToLatLon(mc.meta.view, fx, fy);
          m.lat = +ll.lat.toFixed(5);
          m.lon = +ll.lon.toFixed(5);
        } else {
          m.ldx = ldx0 + (ev.clientX - sx) / lr.width;
          m.ldy = ldy0 + (ev.clientY - sy) / lr.height;
        }
        reposition();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        el.classList.remove('dragging');
        if (moved) persist();
        else openEditor(m, el);
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
      ldx: DEF_LDX,
      ldy: DEF_LDY,
      line: 'straight',
      underline: false,
      color: null, // use the colors.marker default until overridden in the editor
      shape: DEF_SHAPE,
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
    $('meLineToggle').dataset.pos = m.line === 'elbow' ? 'right' : 'left';
    $('meUnderlineToggle').dataset.pos = m.underline ? 'right' : 'left';
    syncEditorShape(m);
    syncEditorColor(m);
    editor.hidden = false;
    positionEditor(el);
    const lab = $('meLabel');
    lab.focus();
    lab.select();
  }
  function closeEditor() { editor.hidden = true; editingId = null; }

  // ---- per-marker shape picker (inside the editor) ---------------------------
  // A small monochrome icon of each shape, currentColor-filled so the active
  // button's accent flows through. 'none' shows a slashed ring (an empty glyph
  // would be an invisible button).
  function shapeIcon(shape) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'shape-icon');
    svg.setAttribute('viewBox', '-10 -10 20 20');
    const g = shapeGeom(shape);
    if (g.none) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', PIN_R - 1); c.setAttribute('class', 'shape-none');
      const ln = document.createElementNS(SVGNS, 'line');
      ln.setAttribute('x1', -5); ln.setAttribute('y1', 5);
      ln.setAttribute('x2', 5); ln.setAttribute('y2', -5);
      ln.setAttribute('class', 'shape-none');
      svg.append(c, ln);
      return svg;
    }
    let node;
    if (g.circle) {
      node = document.createElementNS(SVGNS, 'circle');
      node.setAttribute('r', PIN_R - 1);
    } else {
      node = document.createElementNS(SVGNS, 'polygon');
      node.setAttribute('points', g.poly.map(([x, y]) =>
        (x * PIN_R).toFixed(2) + ',' + (y * PIN_R).toFixed(2)).join(' '));
    }
    node.setAttribute('class', 'shape-fill');
    svg.appendChild(node);
    return svg;
  }
  // Light the button matching marker m's current shape.
  function syncEditorShape(m) {
    const grid = $('meShapeGrid');
    if (!grid) return;
    grid.querySelectorAll('.me-shape').forEach((b) =>
      b.classList.toggle('active', b.dataset.shape === m.shape));
  }

  // ---- per-marker colour palette (inside the editor) -------------------------
  // Reflect marker `m`'s colour: light the active swatch (the "default" chip when
  // m has no override), paint that chip to the current default, and seed the
  // native picker. Built once in init(); presets come from the shared palette.
  function syncEditorColor(m) {
    const grid = $('meColorGrid');
    if (!grid) return;
    const def = (S.colors && S.colors.marker) || ACCENT;
    const dflt = grid.querySelector('.me-sw-default');
    dflt.style.background = def;        // the default chip previews the map default
    dflt.style.color = def;             // drives its .active glow (currentColor)
    const cur = (m.color || '').toLowerCase();
    grid.querySelectorAll('.me-sw').forEach((sw) => {
      if (sw.classList.contains('me-sw-pick')) return;
      const c = (sw.dataset.color || '').toLowerCase();
      sw.classList.toggle('active', cur ? c === cur : sw.classList.contains('me-sw-default'));
    });
    $('meColorCustom').value = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : def;
  }

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
  // Measure the callout box (its lines + size) without drawing, so the label
  // group can be laid out as a whole and centred on the label's offset point.
  const CALLOUT = { maxW: 200, padX: 8, padY: 6, lh: 16 };
  function measureCallout(ctx, text) {
    ctx.font = "500 12px 'JetBrains Mono', monospace";
    const lines = wrapText(ctx, text, CALLOUT.maxW);
    let tw = 0;
    for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
    return { lines, w: tw + CALLOUT.padX * 2, h: lines.length * CALLOUT.lh + CALLOUT.padY * 2 };
  }
  function drawCallout(ctx, x, y, c, col) {
    ctx.fillStyle = 'rgba(6,18,26,0.9)';
    roundRect(ctx, x, y, c.w, c.h, 2); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.5); ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = col; ctx.fillRect(x, y, 2, c.h); // accent left edge
    ctx.font = "500 12px 'JetBrains Mono', monospace";
    ctx.fillStyle = '#d8e6ee'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    c.lines.forEach((l, i) => ctx.fillText(l, x + CALLOUT.padX, y + CALLOUT.padY + i * CALLOUT.lh));
  }
  // Stroke a connector path (array of points) with the marker accent + glow.
  function strokeConnector(ctx, pts, col) {
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.lineJoin = 'miter'; ctx.lineCap = 'round';
    ctx.shadowColor = rgba(col, 0.7); ctx.shadowBlur = 4;
    ctx.stroke();
    ctx.restore();
  }
  // Draw one marker: connector first (under everything), then the label group at
  // its offset, then the pin diamond on top — matching the DOM stacking.
  function drawOneMarker(ctx, px, py, m) {
    const label = (m.label || '').toUpperCase();
    const hasCallout = !!(m.showCallout && m.callout);
    const col = colorOf(m);

    // ---- lay out the label group (label box + optional callout below) --------
    let labelBox = null;
    if (label) {
      ctx.font = "700 13px 'JetBrains Mono', monospace";
      // underline boxes are a touch shorter so the underline hugs the text
      const padX = 7, h = m.underline ? 17 : 20, tw = ctx.measureText(label).width;
      labelBox = { w: tw + padX * 2, h, padX };
    }
    const cc = hasCallout ? measureCallout(ctx, m.callout) : null;
    const gap = 5;
    const bodyW = Math.max(labelBox ? labelBox.w : 0, cc ? cc.w : 0);
    const bodyH = (labelBox ? labelBox.h : 0) + (labelBox && cc ? gap : 0) + (cc ? cc.h : 0);
    if (!bodyW || !bodyH) { drawPin(ctx, px, py, m, col); return; }

    // group centred on the label offset point (fraction of map → px)
    const cx = px + m.ldx * ctx._mapW, cy = py + m.ldy * ctx._mapH;
    const left = cx - bodyW / 2, top = cy - bodyH / 2;

    // ---- connector: pin → nearest edge of the label box ----------------------
    const connBox = labelBox
      ? { x: left, y: top, w: labelBox.w, h: labelBox.h }
      : { x: left, y: top, w: cc.w, h: cc.h };
    const pts = connectorPoints({ x: px, y: py }, connBox, m.line, m.underline);
    if (pts) strokeConnector(ctx, pts, col);

    // ---- label box -----------------------------------------------------------
    let y = top;
    if (labelBox) {
      ctx.font = "700 13px 'JetBrains Mono', monospace";
      ctx.textBaseline = 'middle';
      if (m.underline) {
        // bare style: just the text — the underline is drawn by the connector,
        // which runs along this box's bottom edge as one continuous line
        ctx.fillStyle = col; ctx.textAlign = 'left';
        ctx.fillText(label, left + labelBox.padX, y + labelBox.h / 2 + 0.5);
      } else {
        ctx.fillStyle = INK;
        roundRect(ctx, left, y, labelBox.w, labelBox.h, 2); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = col; ctx.textAlign = 'left';
        ctx.fillText(label, left + labelBox.padX, y + labelBox.h / 2 + 0.5);
      }
      y += labelBox.h + gap;
    }
    if (cc) drawCallout(ctx, left, y, cc, col);

    drawPin(ctx, px, py, m, col);
  }
  function drawPin(ctx, x, y, m, col) {
    const g = shapeGeom(m.shape);
    if (g.none) return;
    ctx.save();
    ctx.fillStyle = col; ctx.lineWidth = 2; ctx.strokeStyle = '#06121a';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (g.circle) {
      ctx.arc(x, y, PIN_R - 1, 0, Math.PI * 2);
    } else {
      g.poly.forEach(([px, py], i) => {
        const X = x + px * PIN_R, Y = y + py * PIN_R;
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      });
      ctx.closePath();
    }
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // Public: stamp the in-view markers onto a context using a stored canvas meta.
  function drawOnto(ctx, meta) {
    if (!meta || !meta.view || !S.markers || !S.markers.length) return;
    ctx.save();
    ctx._mapW = meta.mapW; ctx._mapH = meta.mapH; // for label-offset → px
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
    // connector lines: a single SVG behind the markers, sized to the layer
    lines = document.createElementNS(SVGNS, 'svg');
    lines.setAttribute('class', 'marker-lines');
    lines.setAttribute('preserveAspectRatio', 'none');
    layer.appendChild(lines);
    restore();
    build();

    $('addMarkerBtn').addEventListener('click', addMarker);

    // shape picker: one icon button per shape; clicking switches the open marker.
    const shapeGrid = $('meShapeGrid');
    SHAPES.forEach((shape) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'me-shape';
      b.dataset.shape = shape;
      b.title = shape;
      b.appendChild(shapeIcon(shape));
      shapeGrid.appendChild(b);
    });
    shapeGrid.addEventListener('click', (e) => {
      const b = e.target.closest('.me-shape');
      if (!b) return;
      const m = editing(); if (!m) return;
      m.shape = b.dataset.shape;
      persist(); sync(); syncEditorShape(m);
    });

    // colour palette: inject the shared preset swatches ahead of the picker chip,
    // then commit a pick (or reset to the map default) to the open marker.
    const meGrid = $('meColorGrid');
    const mePick = meGrid.querySelector('.me-sw-pick');
    (C.PALETTE || []).forEach((hex) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'me-sw';
      sw.dataset.color = hex;
      sw.style.background = hex;
      sw.style.color = hex; // .active glow uses currentColor
      meGrid.insertBefore(sw, mePick);
    });
    meGrid.addEventListener('click', (e) => {
      const sw = e.target.closest('.me-sw');
      if (!sw || sw.classList.contains('me-sw-pick')) return;
      const m = editing(); if (!m) return;
      m.color = sw.dataset.color || null; // empty data-color = the "default" chip
      persist(); sync(); syncEditorColor(m);
    });
    $('meColorCustom').addEventListener('input', () => {
      const m = editing(); if (!m) return;
      m.color = $('meColorCustom').value;
      persist(); sync(); syncEditorColor(m);
    });

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
    $('meLineToggle').addEventListener('click', () => {
      const m = editing(); if (!m) return;
      m.line = m.line === 'elbow' ? 'straight' : 'elbow';
      $('meLineToggle').dataset.pos = m.line === 'elbow' ? 'right' : 'left';
      persist(); reposition();
    });
    $('meUnderlineToggle').addEventListener('click', () => {
      const m = editing(); if (!m) return;
      m.underline = !m.underline;
      $('meUnderlineToggle').dataset.pos = m.underline ? 'right' : 'left';
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
