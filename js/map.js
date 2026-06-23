// ATLAS — map rendering engine. Pure canvas + fetch (no map library), so the
// result is a single styled bitmap we can export as PNG, the same way the other
// cyberdeck.tools apps export their working area.
//
// Pipeline: coords + area -> Web-Mercator tile range -> stitch ESRI hillshade
// tiles -> recolor to the teal duotone -> fetch country/region borders as vector
// GeoJSON (plus finer city/district borders from OSM Overpass) and stroke them as
// light lines -> draw the rectangular frame, title and scale bar. Exposes
// ATLAS.renderMap(opts) -> Promise<canvas>.
(function (ATLAS) {
  'use strict';
  const C = ATLAS.const;
  const TILE = 256;

  // ---- Web Mercator helpers (EPSG:3857, global pixel space at a zoom) ----
  const worldPx = (z) => TILE * Math.pow(2, z);
  const lonToX = (lon, z) => (lon + 180) / 360 * worldPx(z);
  const latToY = (lat, z) => {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * worldPx(z);
  };
  // Inverses, for turning a pixel position back into geographic coordinates.
  const xToLon = (x, z) => x / worldPx(z) * 360 - 180;
  const yToLat = (y, z) => 180 / Math.PI *
    Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / worldPx(z)));

  // Convert a fractional position within the rendered map region (fx, fy each
  // in [0,1], origin top-left) back to lat/lon, using a stored view. Lets the UI
  // translate a rectangle drawn on the map into a new centre + area to recrop.
  ATLAS.pxFracToLatLon = function pxFracToLatLon(v, fx, fy) {
    const x = v.x0 + (v.x1 - v.x0) * fx;
    const y = v.y0 + (v.y1 - v.y0) * fy;
    return { lat: yToLat(y, v.z), lon: xToLon(x, v.z) };
  };

  // Forward of pxFracToLatLon: project a lat/lon back to its fractional position
  // (fx, fy each in [0,1] when on-map, origin top-left) within the rendered map
  // region of a stored view. Lets the marker overlay place a geographic point on
  // the displayed map and lets export draw it onto the canvas. Values outside
  // [0,1] are off the current view.
  ATLAS.latLonToPxFrac = function latLonToPxFrac(v, lat, lon) {
    return {
      fx: (lonToX(lon, v.z) - v.x0) / (v.x1 - v.x0),
      fy: (latToY(lat, v.z) - v.y0) / (v.y1 - v.y0),
    };
  };

  // ---- geometry: rectangular ground area -> bbox + best zoom ----------------
  // A km-rectangle on the ground maps to an (almost) pixel-rectangle in Web
  // Mercator near the centre, because the projection is locally conformal — so
  // we render into a canvas whose pixel aspect matches the km aspect (mapW/mapH)
  // without distortion. Width spans longitude (east-west), height latitude.
  function computeView(lat, lon, areaKmW, areaKmH, mapW, mapH) {
    const dLat = (areaKmH * 1000 / 2) / 111320;
    const dLon = (areaKmW * 1000 / 2) / (111320 * Math.cos(lat * Math.PI / 180));
    const north = lat + dLat, south = lat - dLat, west = lon - dLon, east = lon + dLon;
    // Largest zoom whose bbox pixel-width is ~1:1 with the target, capped.
    let z = Math.round(Math.log2(mapW * 360 / ((east - west) * worldPx(0))));
    z = Math.max(1, Math.min(C.MAX_ZOOM, z));
    return {
      z, north, south, west, east,
      x0: lonToX(west, z), x1: lonToX(east, z),
      y0: latToY(north, z), y1: latToY(south, z), // north = smaller y
    };
  }

  // ---- render cache ----------------------------------------------------------
  // Re-renders repeatedly ask for the *same* data: a recolour / re-style
  // (ATLAS.rerender) renders the identical view, and panning often revisits a
  // bbox seen moments ago. Memoising both the stitched tile layers and the parsed
  // border rings — each keyed on the exact request — turns those repeats into
  // instant hits: no re-decoding browser-cached tile images, no border re-fetch,
  // and no pressure on Overpass's 2-slot public rate limit. Each cache is a
  // bounded LRU (a Map keeps insertion order, so the oldest key is evicted once
  // past `max`) so a long session of distinct views can't grow memory unbounded.
  function lru(max) {
    const m = new Map();
    return {
      get(k) {
        if (!m.has(k)) return undefined;
        const v = m.get(k); m.delete(k); m.set(k, v); // refresh recency
        return v;
      },
      set(k, v) {
        m.set(k, v);
        if (m.size > max) m.delete(m.keys().next().value);
      },
    };
  }
  const tileCache = lru(6);   // stitched {cv,ox,oy} layers — capped low (each is a big canvas)
  const ringCache = lru(32);  // parsed border rings — small arrays, keyed on the request

  // ---- tile loading / stitching ---------------------------------------------
  function loadTile(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';       // keep the canvas exportable
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);   // missing tile -> just skip it
      img.src = url;
    });
  }

  // Count how many tiles a view needs (for progress reporting).
  function tileCount(v) {
    const tx0 = Math.floor(v.x0 / TILE), tx1 = Math.floor((v.x1 - 1) / TILE);
    const ty0 = Math.floor(v.y0 / TILE), ty1 = Math.floor((v.y1 - 1) / TILE);
    return (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  }

  // Stitch one tiled layer into an offscreen canvas; returns it plus the global
  // pixel origin of its top-left corner so the caller can crop precisely.
  async function stitch(urlTmpl, v, onTile) {
    const z = v.z, n = Math.pow(2, z);
    const tx0 = Math.floor(v.x0 / TILE), tx1 = Math.floor((v.x1 - 1) / TILE);
    const ty0 = Math.floor(v.y0 / TILE), ty1 = Math.floor((v.y1 - 1) / TILE);
    // The tile grid (layer + zoom + range) fully determines the stitched bitmap,
    // so a cache hit skips re-decoding every tile. Still tick progress per tile so
    // the done/total readout stays honest whether or not we hit the cache.
    const key = urlTmpl + '@' + z + ':' + tx0 + ',' + ty0 + ',' + tx1 + ',' + ty1;
    const cached = tileCache.get(key);
    if (cached) {
      if (onTile) for (let i = (tx1 - tx0 + 1) * (ty1 - ty0 + 1); i > 0; i--) onTile();
      return cached;
    }
    const cv = document.createElement('canvas');
    cv.width = (tx1 - tx0 + 1) * TILE;
    cv.height = (ty1 - ty0 + 1) * TILE;
    const ctx = cv.getContext('2d');
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wx = ((tx % n) + n) % n; // wrap longitude across the antimeridian
        const url = urlTmpl.replace('{z}', z).replace('{y}', ty).replace('{x}', wx);
        const dx = (tx - tx0) * TILE, dy = (ty - ty0) * TILE;
        jobs.push(loadTile(url).then((img) => {
          if (img) ctx.drawImage(img, dx, dy);
          if (onTile) onTile();
        }));
      }
    }
    await Promise.all(jobs);
    const layer = { cv, ox: tx0 * TILE, oy: ty0 * TILE };
    tileCache.set(key, layer);
    return layer;
  }

  // Crop the stitched layer down to exactly the bbox, scaled to the mapW×mapH
  // output rectangle.
  function cropTo(layer, v, mapW, mapH) {
    const out = document.createElement('canvas');
    out.width = mapW;
    out.height = mapH;
    out.getContext('2d').drawImage(
      layer.cv,
      v.x0 - layer.ox, v.y0 - layer.oy, v.x1 - v.x0, v.y1 - v.y0,
      0, 0, mapW, mapH
    );
    return out;
  }

  // ---- palette resolution ----------------------------------------------------
  // Turn the user-picked hex colours in ATLAS.state.colors into the numeric
  // COL / WATER structure the renderer consumes. Single-colour slots map
  // straight through; land / water seed a derived ramp (and the sea's waves /
  // the title tone) so one pick restyles a whole element. Falls back to the
  // ATLAS.const defaults for any slot left unset, keeping the stock look intact.
  const _mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
  const _mix = (c, d, t) => [c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t, c[2] + (d[2] - c[2]) * t];
  ATLAS.resolvePalette = function resolvePalette() {
    const A = ATLAS.hexToArr;
    const cc = (ATLAS.state && ATLAS.state.colors) || {};
    const D = C.COL, DW = C.WATER;
    const land   = cc.land   ? A(cc.land)   : D.hilight;
    const water  = cc.water  ? A(cc.water)  : DW.hilight;
    const region = cc.region ? A(cc.region) : D.region;
    return {
      COL: {
        // dark end of the land ramp: the picked shade, or derived from land if unset
        shadow:  cc.landShade ? A(cc.landShade) : _mul(land, 0.20),
        hilight: land,                             // land ramp: light end (the pick)
        line:    cc.border ? A(cc.border) : D.line,
        frame:   cc.frame  ? A(cc.frame)  : D.frame,
        region:  region,
        title:   _mix(region, [236, 247, 240], 0.62), // bottom title: lightened region
        bg:      D.bg,
      },
      WATER: {
        blueMin: DW.blueMin,
        shadow:  _mul(water, 0.45),                // deep-water ramp: dark
        hilight: water,                            // deep-water ramp: light (the pick)
        wave:    _mix(water, [200, 225, 235], 0.55), // wave stroke: lightened water
        waveA:   DW.waveA,
      },
    };
  };

  // ---- pixel recolouring -----------------------------------------------------
  const lerp = (a, b, t) => a + (b - a) * t;

  // Build a per-pixel water mask (1 = sea/lake/river) from a cropped TILE_WATERMASK
  // layer: OSM paints water blue, land green/beige. A pixel is water when its
  // blue channel clearly leads red (rejects beige land) and is at least its
  // green (rejects green vegetation, where green leads).
  function waterMask(maskCv, w, h) {
    const d = maskCv.getContext('2d').getImageData(0, 0, w, h).data;
    const N = w * h, t = C.WATER.blueMin, mask = new Uint8Array(N);
    for (let p = 0, i = 0; p < N; p++, i += 4) {
      if (d[i + 3] > 8 && d[i + 2] - d[i] > t && d[i + 2] >= d[i + 1]) mask[p] = 1;
    }
    return mask;
  }

  // Map hillshade luminance onto a duotone ramp, in place. Land uses the teal
  // shadow->highlight ramp; pixels flagged in the water mask are pulled onto a
  // separate deep ramp so the sea reads darker. A directional light gradient
  // (lighter toward the light's azimuth, darker opposite) is added over the
  // land only, so flat terrain still reads as lit from one angle.
  function duotone(data, sh, hi, water, W, w, h) {
    // Light vector pointing FROM the light source into the scene, in pixel space
    // (y grows downward). azimuth 0 = N (up), 90 = E (right).
    const a = C.LIGHT.azimuth * Math.PI / 180, str = C.LIGHT.strength;
    const lx = Math.sin(a), ly = -Math.cos(a);
    for (let p = 0, i = 0; i < data.length; p++, i += 4) {
      let L = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      L = Math.min(1, Math.max(0, (L - 0.5) * 1.18 + 0.5)); // gentle contrast
      if (!water[p] && str) {
        // dot of the pixel's centred position with the light vector, in [-1,1]:
        // +1 on the lit side, -1 on the shaded side.
        const x = p % w, y = (p - x) / w;
        const d = ((x / w * 2 - 1) * lx + (y / h * 2 - 1) * ly) / 2;
        L = Math.min(1, Math.max(0, L + d * str));
      }
      const c0 = water[p] ? W.shadow  : sh;
      const c1 = water[p] ? W.hilight : hi;
      data[i]     = lerp(c0[0], c1[0], L);
      data[i + 1] = lerp(c0[1], c1[1], L);
      data[i + 2] = lerp(c0[2], c1[2], L);
    }
  }

  // Stroke a horizontal sine-wave weave, clipped to the water mask, over the map.
  function drawWaterWaves(ctx, w, h, water, W) {
    const wcv = document.createElement('canvas');
    wcv.width = w;
    wcv.height = h;
    const wctx = wcv.getContext('2d');
    wctx.strokeStyle = rgb(W.wave, W.waveA);
    wctx.lineWidth = 1;
    const amp = 2.2, wl = 22, gap = 10;
    for (let y = -gap; y < h + gap; y += gap) {
      const ph = y * 0.5; // offset each row so crests don't line up vertically
      wctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const yy = y + Math.sin(x / wl + ph) * amp;
        x ? wctx.lineTo(x, yy) : wctx.moveTo(x, yy);
      }
      wctx.stroke();
    }
    // Punch the waves out to water only, then composite over the map.
    const wid = wctx.getImageData(0, 0, w, h), wd = wid.data;
    for (let p = 0; p < w * h; p++) if (!water[p]) wd[p * 4 + 3] = 0;
    wctx.putImageData(wid, 0, 0);
    ctx.drawImage(wcv, 0, 0);
  }

  // Coarsen the pixel-noisy water mask onto a STEP-grid (majority vote per cell)
  // then denoise with a 3x3 majority pass that drops lone specks. This is the
  // shared low-poly water shape: both the land/sea fill and the coastline outline
  // are built from it, so they line up exactly. Bigger STEP = lower-poly.
  const COAST_STEP = 4;
  // Stroke widths (output px). Both the coast outline and the region/country
  // borders are vector strokes, so their width is set purely by these knobs.
  const COAST_LW = 1.5;
  const BORDER_LW = 2;  // region/country border width (px); 1 = crisp 1px line
  // How hard to facet the region/country borders. The boundary geometry comes in
  // as GeoJSON rings (already lightly generalised server-side via
  // maxAllowableOffset); we collapse near-collinear vertices with Douglas-Peucker
  // at this tolerance (output px) so the lines read as faceted low-poly edges
  // like the coastline. Bigger = chunkier facets.
  const BORDER_SIMPLIFY = 3.5;
  // City / district borders (the OSM admin_level 6-10 sub-layer) are drawn thinner,
  // dimmer and a touch less faceted than the country/region lines so they read as a
  // finer layer underneath them. CITY_MAX_KM gates the whole layer off once the
  // captured area is wider than a city region — a country-scale view shows none.
  const CITY_BORDER_LW = 1;
  const CITY_BORDER_ALPHA = 0.55;
  const CITY_SIMPLIFY = 2;
  const CITY_MAX_KM = 160;
  function lowPolyWater(water, w, h, step) {
    const gw = Math.ceil(w / step), gh = Math.ceil(h / step);

    // 1) coarsen: each cell is water if most of its pixels are
    const g = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let wet = 0, tot = 0;
        const x1 = Math.min(w, gx * step + step), y1 = Math.min(h, gy * step + step);
        for (let y = gy * step; y < y1; y++)
          for (let x = gx * step; x < x1; x++) { tot++; if (water[y * w + x]) wet++; }
        g[gy * gw + gx] = wet * 2 >= tot ? 1 : 0;
      }
    }

    // 2) denoise: majority over the 3x3 neighbourhood smooths edges and removes
    // isolated cells (single-block lakes/islands that read as noise)
    const sm = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = gx + dx, y = gy + dy;
            if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
            n++; s += g[y * gw + x];
          }
        sm[gy * gw + gx] = s * 2 > n ? 1 : 0;
      }
    }
    return { grid: sm, gw, gh, step };
  }

  // Expand a low-poly grid back to a per-pixel mask (each pixel takes its cell's
  // value) so the duotone land/sea fill snaps to the same blocky shape the coast
  // outline traces — the marching-squares contour sits right on these cell edges.
  function gridToMask(lp, w, h) {
    const { grid, gw, step } = lp;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = Math.floor(y / step) * gw;
      for (let x = 0; x < w; x++) mask[y * w + x] = grid[row + Math.floor(x / step)];
    }
    return mask;
  }

  // Trace the coast as a low-poly outline in the border colour, so the sea reads
  // as a bordered shape like the countries. Marching squares over the shared
  // low-poly grid emits clean faceted segments instead of a jagged pixel edge.
  function drawCoastline(ctx, lp, col) {
    const { grid, gw, gh, step } = lp;
    const at = (gx, gy) => (gx < 0 || gy < 0 || gx >= gw || gy >= gh) ? 0 : grid[gy * gw + gx];
    ctx.save();
    ctx.strokeStyle = rgb(col, 0.9);
    ctx.lineWidth = COAST_LW;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    const seg = (a, b) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };
    for (let gy = 0; gy < gh - 1; gy++) {
      for (let gx = 0; gx < gw - 1; gx++) {
        const cse = (at(gx, gy) << 3) | (at(gx + 1, gy) << 2)
                  | (at(gx + 1, gy + 1) << 1) | at(gx, gy + 1);
        if (cse === 0 || cse === 15) continue;
        const ox = gx * step + step / 2, oy = gy * step + step / 2;
        const T = [ox + step / 2, oy], R = [ox + step, oy + step / 2],
              B = [ox + step / 2, oy + step], L = [ox, oy + step / 2];
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
    ctx.stroke();
    ctx.restore();
  }

  // Ramer–Douglas–Peucker: drop interior points that lie within `eps` of the
  // chord, collapsing pixel staircases into a few straight facets. Iterative
  // (explicit stack) so long borders don't blow the call stack.
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

  // Fetch admin boundaries intersecting the view as GeoJSON, returning a flat list
  // of rings (each an array of [lon, lat] vertices). We pass maxAllowableOffset so
  // the server generalises the geometry to roughly our pixel resolution — keeps the
  // payload small and the lines naturally low-poly. A failed fetch yields [] so a
  // borderless map still renders rather than throwing.
  async function fetchBoundaries(v, mapW) {
    const offset = (v.east - v.west) / mapW * 1.5;  // ~1.5 output px, in degrees
    const params = new URLSearchParams({
      where: '1=1',
      geometry: [v.west, v.south, v.east, v.north].join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      returnGeometry: 'true', outFields: '',
      maxAllowableOffset: String(offset),
      f: 'geojson',
    });
    const qs = params.toString();
    const hit = ringCache.get('b:' + qs);   // [] is a valid cached result; only a miss is undefined
    if (hit) return hit;
    let json;
    try {
      const r = await fetch(C.BOUNDARIES + '?' + qs);
      json = await r.json();
    } catch (e) { return []; } // don't cache failures — let the next render retry the fetch
    const rings = [];
    for (const f of (json && json.features) || []) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'Polygon') for (const ring of g.coordinates) rings.push(ring);
      else if (g.type === 'MultiPolygon')
        for (const poly of g.coordinates) for (const ring of poly) rings.push(ring);
    }
    // Only cache a well-formed FeatureCollection; an ESRI error parses as JSON
    // ({error:...}) with no features array — caching its empty result would
    // permanently blank the layer for this view.
    if (Array.isArray(json && json.features)) ringCache.set('b:' + qs, rings);
    return rings;
  }

  // Which OSM admin levels to pull for the city layer, scaled to the captured area:
  // a tight view wants every level down to neighbourhoods, a metro-wide one only the
  // coarser district/county lines (so the payload and the line density stay sane).
  // Returns a regex alternation for the admin_level filter, or null to fetch nothing.
  function cityLevels(areaKm) {
    if (areaKm <= 30) return '6|7|8|9|10';
    if (areaKm <= 80) return '6|7|8';
    if (areaKm <= CITY_MAX_KM) return '6|7';
    return null;
  }

  // Fetch the finer city / district borders from OSM Overpass. Each returned way is
  // an admin boundary segment whose node coordinates come back inline (`out geom;`),
  // so we map it straight to a [lon, lat] ring the same drawBorders consumes. Gated
  // by area (see cityLevels) and, like fetchBoundaries, returns [] on any failure so
  // the map still renders without the layer.
  async function fetchCityBorders(v, areaKm) {
    const levels = cityLevels(areaKm);
    if (!levels) return [];
    const q = '[out:json][timeout:25];'
      + 'way["boundary"="administrative"]["admin_level"~"^(' + levels + ')$"]'
      + '(' + [v.south, v.west, v.north, v.east].join(',') + ');out geom;';
    const hit = ringCache.get('c:' + q);   // keyed on bbox + levels (the whole query)
    if (hit) return hit;
    let json;
    try {
      const r = await fetch(C.CITY_BOUNDARIES + '?' + new URLSearchParams({ data: q }));
      json = await r.json();
    } catch (e) { return []; } // don't cache failures — a re-render should re-try Overpass
    const rings = [];
    for (const el of (json && json.elements) || []) {
      if (el.type === 'way' && el.geometry && el.geometry.length > 1)
        rings.push(el.geometry.map((p) => [p.lon, p.lat]));
    }
    // Only cache a clean Overpass result. A rate-limited / timed-out query can
    // still return parseable JSON (no `elements`, or an error `remark`); caching
    // that empty result would hide the city layer until the view changes.
    if (json && Array.isArray(json.elements) && !json.remark) ringCache.set('c:' + q, rings);
    return rings;
  }

  // Draw the region/country borders as low-poly faceted lines. The boundary rings
  // arrive as lon/lat GeoJSON; we project each vertex into the output rectangle via
  // the same Web-Mercator mapping the rest of the pipeline uses, simplify
  // (BORDER_SIMPLIFY) for the faceted look, then stroke at BORDER_LW with round
  // joins. No raster, no labels — the lines come straight from the geometry.
  // When `waterMask` is supplied (the per-pixel sea mask, 1 = water), the lines are
  // stroked onto an offscreen layer, knocked out wherever they cross water, then
  // composited back — so e.g. the city sub-layer can be kept on land only. The
  // mask matches the low-poly coastline exactly, so the cut lands right at the
  // shore.
  function drawBorders(mctx, rings, v, mapW, mapH, col, lw, alpha, eps, waterMask) {
    const sx = mapW / (v.x1 - v.x0), sy = mapH / (v.y1 - v.y0);
    let layer = null, ctx = mctx;
    if (waterMask) {
      layer = document.createElement('canvas');
      layer.width = mapW; layer.height = mapH;
      ctx = layer.getContext('2d');
    }
    ctx.save();
    ctx.strokeStyle = rgb(col, alpha == null ? 0.9 : alpha);
    ctx.lineWidth = lw == null ? BORDER_LW : lw;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    for (const ring of rings) {
      const pts = simplify(ring.map(([lon, lat]) => [
        (lonToX(lon, v.z) - v.x0) * sx,
        (latToY(lat, v.z) - v.y0) * sy,
      ]), eps == null ? BORDER_SIMPLIFY : eps);
      if (pts.length < 2) continue;
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.stroke();
    ctx.restore();
    if (waterMask) {
      // erase line pixels that fall on water, then stamp the land-only lines down
      const id = ctx.getImageData(0, 0, mapW, mapH), d = id.data;
      for (let p = 0; p < waterMask.length; p++) if (waterMask[p]) d[p * 4 + 3] = 0;
      ctx.putImageData(id, 0, 0);
      mctx.drawImage(layer, 0, 0);
    }
  }

  // ---- decorative overlays ---------------------------------------------------
  const rgb = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a == null ? 1 : a})`;

  // Faint hex weave across the whole map — the "off the map" texture from the
  // example that reads strongest over flat water / lowland.
  function drawHexTexture(ctx, w, h, col) {
    const r = 17, hh = r * Math.sqrt(3);
    ctx.save();
    ctx.strokeStyle = rgb(col, 0.05);
    ctx.lineWidth = 1;
    for (let row = 0, y = 0; y < h + hh; y += hh / 2, row++) {
      const off = (row % 2) ? r * 1.5 : 0;
      for (let x = -r; x < w + r; x += r * 3) {
        hexPath(ctx, x + off, y, r);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  function hexPath(ctx, cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  // Rectangular frame with augmented-ui style corner ticks.
  function drawFrame(ctx, x, y, w, h, col) {
    ctx.save();
    ctx.strokeStyle = rgb(col, 0.85);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgb(col, 1);
    const t = 26;
    const corners = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * t); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * t, cy);
      ctx.stroke();
    }
    ctx.restore();
  }

  // (region name label removed - the bottom title is the only on-map label)

  // ---- scale bar -------------------------------------------------------------
  function niceScale(areaKm) {
    const target = areaKm * 0.45; // aim for roughly half the frame width
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    let best = pow;
    for (const m of [1, 2, 2.5, 5, 10]) if (m * pow <= target) best = m * pow;
    return best;
  }
  function fmtKm(n) { return (n % 1 === 0 ? n.toString() : n.toFixed(1)); }

  // Draws the scale bar so its whole block (number row above + bar below)
  // is vertically centred on `cy`, and its rightmost ink (the trailing unit
  // label) ends at `rightX` — so it mirrors the title's left margin instead of
  // letting the unit spill into the page margin. The area is stored in km; when
  // `units` is 'mi' the bar is sized + labelled in miles instead.
  function drawScaleBar(ctx, rightX, cy, mapW, areaKmW, col, units) {
    const mi = units === 'mi';
    const unit = mi ? 'MI' : 'KM';
    const area = mi ? areaKmW / C.KM_PER_MI : areaKmW; // map width in display units
    const total = niceScale(area);
    const pxPerUnit = mapW / area;
    const barW = total * pxPerUnit;
    const segs = 4, segW = barW / segs, h = 6;
    ctx.save();
    const labelFont = "500 15px 'JetBrains Mono', monospace";
    const unitFont = "600 22px 'JetBrains Mono', monospace"; // unit reads bigger than the numbers
    ctx.font = labelFont;
    const labelH = 15, labelGap = 4;        // number row sits above the bar
    const blockH = labelH + labelGap + h;
    const labelBase = Math.round(cy - blockH / 2) + labelH; // baseline of numbers
    const y = labelBase + labelGap;         // top of the bar
    const uGap = 12;
    ctx.font = unitFont;
    const uW = ctx.measureText(unit).width;  // reserve room for the larger unit label
    ctx.font = labelFont;
    const x = rightX - uW - uGap - barW;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    for (let i = 0; i < segs; i++) {
      ctx.fillStyle = (i % 2) ? rgb(col, 0.9) : rgb(C.COL.bg, 0.4);
      ctx.fillRect(x + i * segW, y, segW, h);
    }
    ctx.strokeStyle = rgb(col, 0.9);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, h - 1);
    ctx.fillStyle = rgb(col, 0.95);
    for (let i = 0; i <= segs; i++) {
      ctx.fillText(fmtKm(total / segs * i), x + i * segW, labelBase);
    }
    // unit label: bigger, to the right of the bar, its bottom sitting level with
    // the bottom edge of the bar
    ctx.font = unitFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(unit, x + barW + uGap, y + h);
    ctx.restore();
  }

  // Fit the km rectangle into the output canvas: the longer ground edge maps to
  // C.MAP_SIZE px, the shorter scales down to keep the aspect undistorted. A
  // minimum keeps very thin slivers from collapsing to a useless pixel count.
  function fitMapPx(areaKmW, areaKmH) {
    const cap = C.MAP_SIZE, min = 256;
    const ar = areaKmW / areaKmH; // >1 = landscape, <1 = portrait
    let mapW, mapH;
    if (ar >= 1) { mapW = cap; mapH = Math.round(cap / ar); }
    else { mapH = cap; mapW = Math.round(cap * ar); }
    return { mapW: Math.max(min, mapW), mapH: Math.max(min, mapH) };
  }

  // ---- public: render the whole thing ---------------------------------------
  // opts: { lat, lon, areaKmW, areaKmH, title, units, cityBorders, districtsLandOnly, onProgress(done,total) }
  ATLAS.renderMap = async function renderMap(opts) {
    const pad = C.PAD, strip = C.STRIP;
    const { mapW, mapH } = fitMapPx(opts.areaKmW, opts.areaKmH);
    const PAL = ATLAS.resolvePalette(), COL = PAL.COL, WATER = PAL.WATER;
    const v = computeView(opts.lat, opts.lon, opts.areaKmW, opts.areaKmH, mapW, mapH);

    // progress across the two tiled layers (hillshade, water mask) plus one tick
    // each for the region and city vector boundary fetches
    const total = tileCount(v) * 2 + 2;
    let done = 0;
    const tick = () => { if (opts.onProgress) opts.onProgress(++done, total); };
    if (opts.onProgress) opts.onProgress(0, total);

    // 1) water mask: stitch + crop the OSM water layer, derive sea pixels, then
    // snap to the shared low-poly shape so the fill, waves and coast all align
    const wmLayer = await stitch(C.TILE_WATERMASK, v, tick);
    const water = waterMask(cropTo(wmLayer, v, mapW, mapH), mapW, mapH);
    const lp = lowPolyWater(water, mapW, mapH, COAST_STEP);
    const fill = gridToMask(lp, mapW, mapH);

    // 2) terrain: stitch + crop + duotone (water pixels onto the deep ramp)
    const hsLayer = await stitch(C.TILE_HILLSHADE, v, tick);
    const mapCv = cropTo(hsLayer, v, mapW, mapH);
    const mctx = mapCv.getContext('2d');
    const hid = mctx.getImageData(0, 0, mapW, mapH);
    duotone(hid.data, COL.shadow, COL.hilight, fill, WATER, mapW, mapH);
    mctx.putImageData(hid, 0, 0);

    // 3) texture weave (+ wave pattern over the sea)
    drawHexTexture(mctx, mapW, mapH, COL.hilight);
    drawWaterWaves(mctx, mapW, mapH, fill, WATER);
    drawCoastline(mctx, lp, COL.line);

    // 4) borders: fetch admin boundaries as vector GeoJSON and stroke them
    // ourselves. The old ESRI raster boundary tiles baked place-name labels into
    // the same pixels as the lines (one fused cache, no way to split them), so
    // skeletonising them mangled the text. Vector geometry has no labels at all
    // and projects to crisp lines. See fetchBoundaries / drawBorders.
    const rings = await fetchBoundaries(v, mapW);
    tick();
    drawBorders(mctx, rings, v, mapW, mapH, COL.line);

    // 4b) finer city / district borders from OSM (admin_level 6-10), under the same
    // border colour but thinner + dimmer so they read as a sub-layer. Auto-gated to
    // city-region-scale views (see cityLevels / CITY_MAX_KM); empty otherwise. The
    // user can also switch the whole sub-layer off (opts.cityBorders === false), in
    // which case we skip the Overpass fetch entirely but still tick to keep progress.
    // When opts.districtsLandOnly is set, pass the water mask so the sub-layer lines
    // are clipped to land — district boundaries that run out over the sea are hidden.
    const cityRings = opts.cityBorders === false ? [] : await fetchCityBorders(v, opts.areaKmW);
    tick();
    drawBorders(mctx, cityRings, v, mapW, mapH, COL.line,
      CITY_BORDER_LW, CITY_BORDER_ALPHA, CITY_SIMPLIFY,
      opts.districtsLandOnly ? fill : null);

    // 5) compose final canvas (map + margins + bottom strip)
    await (document.fonts && document.fonts.ready);
    const out = document.createElement('canvas');
    out.width = mapW + pad * 2;
    // top margin (pad) + map + bottom margin (pad) + label row (strip) + a final
    // margin (pad) below the row, so the label sits between equal PAD margins
    // instead of floating below an oversized strip.
    out.height = mapH + pad * 3 + strip;
    const ctx = out.getContext('2d');
    ctx.fillStyle = rgb(COL.bg, 1);
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(mapCv, pad, pad);

    drawFrame(ctx, pad, pad, mapW, mapH, COL.frame);

    // bottom strip: title (left) + scale bar (right), both vertically centred
    // on the strip's mid-line so they read as one balanced row, with the title
    // and scale bar aligned to the map's left and right edges respectively.
    const cy = mapH + pad * 2 + strip / 2;
    if (opts.title) {
      ctx.save();
      ctx.font = "500 18px 'JetBrains Mono', monospace";
      ctx.fillStyle = rgb(COL.title, 0.95);
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.title.toUpperCase(), pad, cy + 1);
      ctx.restore();
    }
    drawScaleBar(ctx, pad + mapW, cy, mapW, opts.areaKmW, COL.frame, opts.units);

    // Stash the view geometry + map-region placement so the UI can map a
    // rectangle drawn over the map back to coordinates (draw-to-recrop).
    out._meta = { zoom: v.z, scaleKm: niceScale(opts.areaKmW), view: v, mapW, mapH, pad,
      areaKmW: opts.areaKmW, areaKmH: opts.areaKmH };
    return out;
  };

  // Re-label the bottom strip (title + scale bar) on an already-rendered canvas,
  // in place — no tiles, no border fetches. Used by the km/mi units toggle, which
  // only changes how the scale bar is sized + labelled, not the map pixels. The
  // strip sits on the flat COL.bg backdrop (bg is never user-tinted), so we can
  // clear that row and redraw it. opts: { title, units }. Returns false if the
  // canvas has no geometry meta (e.g. a restored map missing its view).
  ATLAS.redrawScaleStrip = function redrawScaleStrip(canvas, opts) {
    const m = canvas && canvas._meta;
    if (!m || m.areaKmW == null) return false;
    const COL = ATLAS.resolvePalette().COL;
    const pad = m.pad, mapW = m.mapW, mapH = m.mapH, strip = C.STRIP;
    const ctx = canvas.getContext('2d');
    // clear the label row (strip + the final margin below it) back to the backdrop
    ctx.fillStyle = rgb(COL.bg, 1);
    ctx.fillRect(0, mapH + pad * 2, canvas.width, strip + pad);
    const cy = mapH + pad * 2 + strip / 2;
    if (opts.title) {
      ctx.save();
      ctx.font = "500 18px 'JetBrains Mono', monospace";
      ctx.fillStyle = rgb(COL.title, 0.95);
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.title.toUpperCase(), pad, cy + 1);
      ctx.restore();
    }
    drawScaleBar(ctx, pad + mapW, cy, mapW, m.areaKmW, COL.frame, opts.units);
    return true;
  };
})(window.ATLAS);
