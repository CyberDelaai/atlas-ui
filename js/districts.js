// ATLAS — district DETECTION by enclosed-area flood fill. The OSM admin relations
// the renderer fetches (fetchRegions in js/map.js) still draw the district *border
// lines* and name the areas, but they no longer decide what the user can fill.
// Instead we treat every line drawn on the map — country/region borders, the OSM
// city/district lines, the coastline and the map frame itself — as a wall, and the
// closed areas those walls enclose ARE the districts. This decouples "districts the
// API reports" from "areas you can colour": what you fill is exactly what reads as a
// bounded region on the map, even where admin polygons overlap, nest, run out to sea
// or stop mid-air.
//
// Why flood fill rather than polygonising the line graph: it matches the eye. A
// dangling border that doesn't close encloses nothing (so it's ignored); an island's
// coastline is its own region; a district nested inside another falls out as a hole.
// None of that needs robust line-intersection maths — it's just connected components
// over a raster, which this canvas app is already built around.
//
// Pipeline: stroke all the lines onto an offscreen mask -> the lit pixels are walls
// -> 4-connected flood fill labels each enclosed pool of non-wall pixels -> each pool
// is vectorised (marching squares + ring assembly + Douglas–Peucker) back into lon/lat
// rings and handed back in the SAME { id, name, level, rings } shape the OSM relations
// used to have, so the fill (drawRegionFills), click-to-pick (js/regions.js) and
// per-district images (js/district-images.js) all keep working unchanged. Each face's
// id is derived from its centroid's lon/lat, so a colour pick survives a re-style /
// re-render of the same view (and roughly survives a pan). Exposes ATLAS.computeDistricts.
(function (ATLAS) {
  'use strict';

  // Wall stroke width when rasterising the lines (px). >=2 keeps the walls
  // 4-connected so the flood can't leak diagonally between adjacent districts.
  const WALL_LW = 2;
  // Drop enclosed pools smaller than this (px²) — slivers pinched off between two
  // near-parallel border lines, not real districts.
  const MIN_AREA_PX = 350;
  // Douglas–Peucker tolerance (px) for the traced ring, matching the faceted,
  // low-poly look of the rest of the map's line work.
  const TRACE_SIMPLIFY = 2;
  // Treat a wall mask pixel as a wall when its alpha clears this (anti-aliased
  // stroke edges are faint; the core of the line is opaque).
  const WALL_ALPHA = 40;

  // Ramer–Douglas–Peucker (iterative; mirrors js/map.js simplify) — collapse a
  // pixel staircase into a few straight facets.
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a][0], ay = pts[a][1];
      const dx = pts[b][0] - ax, dy = pts[b][1] - ay;
      const len = Math.hypot(dx, dy) || 1;
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  // Marching squares over a boolean cell predicate, emitting the boundary as 2-point
  // segments at half-pixel coordinates. Same case table / edge-midpoint geometry as
  // drawCoastline in js/map.js (step = 1 here), so neighbouring cells emit identical
  // shared endpoints — which assembleRings then stitches into closed loops.
  function contourSegments(at, bx0, by0, bx1, by1) {
    const segs = [];
    const seg = (a, b) => segs.push([a, b]);
    for (let gy = by0 - 1; gy <= by1; gy++) {
      for (let gx = bx0 - 1; gx <= bx1; gx++) {
        const cse = (at(gx, gy) << 3) | (at(gx + 1, gy) << 2)
                  | (at(gx + 1, gy + 1) << 1) | at(gx, gy + 1);
        if (cse === 0 || cse === 15) continue;
        const ox = gx + 0.5, oy = gy + 0.5;
        const T = [ox + 0.5, oy], R = [ox + 1, oy + 0.5],
              B = [ox + 0.5, oy + 1], L = [ox, oy + 0.5];
        switch (cse) {
          case 1: case 14: seg(L, B); break;
          case 2: case 13: seg(B, R); break;
          case 3: case 12: seg(L, R); break;
          case 4: case 11: seg(T, R); break;
          case 6: case 9:  seg(T, B); break;
          case 7: case 8:  seg(T, L); break;
          case 5:  seg(T, L); seg(B, R); break; // saddle
          case 10: seg(T, R); seg(B, L); break; // saddle
        }
      }
    }
    return segs;
  }

  // Stitch the marching-squares segments into closed rings by walking shared
  // endpoints. Endpoints are exact half-integer values, so a string key matches
  // without any epsilon. A region traces as one outer ring plus one ring per hole
  // (an enclosed inner district), which the even-odd fill / hit-test handle directly.
  function assembleRings(segs) {
    const key = (p) => p[0] + ',' + p[1];
    const map = new Map();
    segs.forEach((s, i) => {
      for (const e of s) { const k = key(e); (map.get(k) || map.set(k, []).get(k)).push(i); }
    });
    const used = new Array(segs.length).fill(false);
    const rings = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const ring = [segs[i][0], segs[i][1]];
      let grew = true;
      while (grew) {
        grew = false;
        if (key(ring[0]) === key(ring[ring.length - 1]) && ring.length > 2) break; // closed
        const tailK = key(ring[ring.length - 1]);
        for (const j of (map.get(tailK) || [])) {
          if (used[j]) continue;
          const s = segs[j];
          if (key(s[0]) === tailK) { ring.push(s[1]); used[j] = true; grew = true; break; }
          if (key(s[1]) === tailK) { ring.push(s[0]); used[j] = true; grew = true; break; }
        }
      }
      if (ring.length >= 4) rings.push(ring);
    }
    return rings;
  }

  // o: { polylines:[[ [x,y]… ]…], mapW, mapH, toLonLat(x,y)->[lon,lat],
  //      labelAt(lon,lat)->name|'' , isWater(x,y)->bool }
  // Returns faces [{ id, idx, name, level, rings:[[ [lon,lat]… ]…], area }] — the
  // enclosed land areas, sea pools dropped, in the OSM-relation shape (see top).
  ATLAS.computeDistricts = function computeDistricts(o) {
    const { polylines, mapW, mapH, toLonLat, labelAt, isWater } = o;
    const N = mapW * mapH;

    // 1) rasterise every line (plus the frame) as walls
    const cv = document.createElement('canvas');
    cv.width = mapW; cv.height = mapH;
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = WALL_LW;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    for (const pl of polylines) {
      if (!pl || pl.length < 2) continue;
      ctx.moveTo(pl[0][0], pl[0][1]);
      for (let i = 1; i < pl.length; i++) ctx.lineTo(pl[i][0], pl[i][1]);
    }
    ctx.rect(0.5, 0.5, mapW - 1, mapH - 1); // the map frame closes edge areas
    ctx.stroke();
    const d = ctx.getImageData(0, 0, mapW, mapH).data;
    const wall = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (d[p * 4 + 3] > WALL_ALPHA) wall[p] = 1;

    // 2) flood fill: label each connected pool of non-wall pixels (4-connectivity,
    // explicit queue so deep regions don't blow the stack)
    const label = new Int32Array(N); // 0 = wall / unvisited
    const queue = new Int32Array(N); // reused BFS ring buffer (a pool ≤ N pixels)
    const pools = [];
    let next = 0;
    for (let start = 0; start < N; start++) {
      if (wall[start] || label[start]) continue;
      const L = ++next;
      let head = 0, tail = 0;
      queue[tail++] = start; label[start] = L;
      let area = 0, sx = 0, sy = 0, x0 = mapW, y0 = mapH, x1 = 0, y1 = 0;
      const fx = start % mapW, fy = (start / mapW) | 0; // a guaranteed-interior pixel
      while (head < tail) {
        const q = queue[head++];
        const x = q % mapW, y = (q / mapW) | 0;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0)        { const r = q - 1;    if (!wall[r] && !label[r]) { label[r] = L; queue[tail++] = r; } }
        if (x < mapW - 1) { const r = q + 1;    if (!wall[r] && !label[r]) { label[r] = L; queue[tail++] = r; } }
        if (y > 0)        { const r = q - mapW; if (!wall[r] && !label[r]) { label[r] = L; queue[tail++] = r; } }
        if (y < mapH - 1) { const r = q + mapW; if (!wall[r] && !label[r]) { label[r] = L; queue[tail++] = r; } }
      }
      pools.push({ L, area, sx, sy, x0, y0, x1, y1, fx, fy });
    }

    // 2b) grow each pool out into the wall band so the traced fills reach the
    // border lines instead of stopping ~1–2px short of them. The flood above
    // never claims wall pixels (the rasterised lines + their anti-aliased
    // fringe), so each pool's edge sits inside the stroke and the whole wall
    // band between two neighbours reads as an unfilled gap — uneven because the
    // stroke's width/AA vary along it. A multi-source BFS over JUST the wall
    // pixels (pools stay put — we only write where !label) assigns each wall
    // pixel to its nearest pool, so adjacent fills meet at the line's centre.
    // GROW = half the stroke + 1 for the AA skirt; two fronts close the band
    // with at most ~1px of overlap, hidden under the border drawn on top.
    const GROW = Math.ceil(WALL_LW / 2) + 1;
    let frontier = [];
    for (let p = 0; p < N; p++) if (label[p]) frontier.push(p);
    for (let step = 0; step < GROW && frontier.length; step++) {
      const nextF = [];
      for (const q of frontier) {
        const L = label[q];
        const x = q % mapW, y = (q / mapW) | 0;
        if (x > 0)        { const r = q - 1;    if (wall[r] && !label[r]) { label[r] = L; nextF.push(r); } }
        if (x < mapW - 1) { const r = q + 1;    if (wall[r] && !label[r]) { label[r] = L; nextF.push(r); } }
        if (y > 0)        { const r = q - mapW; if (wall[r] && !label[r]) { label[r] = L; nextF.push(r); } }
        if (y < mapH - 1) { const r = q + mapW; if (wall[r] && !label[r]) { label[r] = L; nextF.push(r); } }
      }
      frontier = nextF;
    }

    // 3) vectorise each kept pool back into lon/lat rings
    const faces = [];
    let idx = 0;
    for (const pl of pools) {
      if (pl.area < MIN_AREA_PX) continue;
      // representative interior point: the centroid when it lands inside the pool,
      // else the first pixel (the centroid can fall in a hole for a C-shaped region)
      let rx = Math.round(pl.sx / pl.area), ry = Math.round(pl.sy / pl.area);
      if (label[ry * mapW + rx] !== pl.L) { rx = pl.fx; ry = pl.fy; }
      if (isWater && isWater(rx, ry)) continue; // a sea pool — not a district
      const at = (x, y) => (x >= 0 && y >= 0 && x < mapW && y < mapH &&
                            label[y * mapW + x] === pl.L) ? 1 : 0;
      // bbox was recorded pre-dilation; the pool now reaches up to GROW px
      // further out, so widen the trace window (clamped) or it clips the edge.
      const segs = contourSegments(at,
        Math.max(0, pl.x0 - GROW), Math.max(0, pl.y0 - GROW),
        Math.min(mapW - 1, pl.x1 + GROW), Math.min(mapH - 1, pl.y1 + GROW));
      const rings = [];
      for (let ring of assembleRings(segs)) {
        // assembleRings closes each loop (first vertex repeated as last). RDP anchors
        // on the two endpoints, so a closed ring's degenerate (zero-length) chord
        // would collapse the whole loop to that single point — drop the duplicate
        // closing vertex first so it simplifies as an open chain. Downstream fill /
        // hit-test / clip all close the path themselves, so an open ring is fine.
        const a = ring[0], b = ring[ring.length - 1];
        if (ring.length > 1 && a[0] === b[0] && a[1] === b[1]) ring = ring.slice(0, -1);
        ring = simplify(ring, TRACE_SIMPLIFY);
        if (ring.length >= 3) rings.push(ring.map(([x, y]) => toLonLat(x, y)));
      }
      if (!rings.length) continue;
      const [lon, lat] = toLonLat(rx, ry);
      faces.push({
        id: 'd:' + lat.toFixed(4) + ',' + lon.toFixed(4),
        idx: ++idx,
        name: (labelAt && labelAt(lon, lat)) || '',
        level: 0,            // flat partition — no nesting (sort in drawRegionFills is a no-op)
        rings,
        area: pl.area,
      });
    }
    return faces;
  };
})(window.ATLAS);
