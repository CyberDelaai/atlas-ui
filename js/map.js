// ATLAS — map rendering engine. Pure canvas + fetch (no map library), so the
// result is a single styled bitmap we can export as PNG, the same way the other
// cyberdeck.tools apps export their working area.
//
// Pipeline: coords + area -> Web-Mercator tile range -> stitch ESRI hillshade
// tiles -> recolor to the teal duotone -> composite ESRI country/region borders
// as light lines -> draw the rectangular frame, title and scale
// bar. Exposes ATLAS.renderMap(opts) -> Promise<canvas>.
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
    return { cv, ox: tx0 * TILE, oy: ty0 * TILE };
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
    ctx.lineWidth = 1.5;
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

  // Repaint every visible pixel of a transparent overlay one flat colour,
  // preserving its alpha — turns ESRI's dark border lines into light teal ones.
  function tintAlpha(data, col) {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 8) { data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; }
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
  // is vertically centred on `cy`, and its rightmost ink (the trailing "km"
  // label) ends at `rightX` — so it mirrors the title's left margin instead of
  // letting "km" spill into the page margin.
  function drawScaleBar(ctx, rightX, cy, mapW, areaKmW, col) {
    const total = niceScale(areaKmW);
    const pxPerKm = mapW / areaKmW;
    const barW = total * pxPerKm;
    const segs = 4, segW = barW / segs, h = 6;
    ctx.save();
    ctx.font = "500 11px 'JetBrains Mono', monospace";
    const labelH = 11, labelGap = 4;        // number row sits above the bar
    const blockH = labelH + labelGap + h;
    const labelBase = Math.round(cy - blockH / 2) + labelH; // baseline of numbers
    const y = labelBase + labelGap;         // top of the bar
    const kmGap = 6, kmW = ctx.measureText('km').width;
    const x = rightX - kmW - kmGap - barW;  // reserve room for the "km" label
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
    ctx.textAlign = 'left';
    ctx.fillText('km', x + barW + kmGap, labelBase);
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
  // opts: { lat, lon, areaKmW, areaKmH, title, onProgress(done,total) }
  ATLAS.renderMap = async function renderMap(opts) {
    const pad = C.PAD, strip = C.STRIP;
    const { mapW, mapH } = fitMapPx(opts.areaKmW, opts.areaKmH);
    const PAL = ATLAS.resolvePalette(), COL = PAL.COL, WATER = PAL.WATER;
    const v = computeView(opts.lat, opts.lon, opts.areaKmW, opts.areaKmH, mapW, mapH);

    // progress across all three tiled layers (hillshade, water mask, borders)
    const total = tileCount(v) * 3;
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

    // 4) borders: stitch, recolour to light lines, composite
    const bdLayer = await stitch(C.TILE_BOUNDS, v, tick);
    const bdctx = bdLayer.cv.getContext('2d');
    const bid = bdctx.getImageData(0, 0, bdLayer.cv.width, bdLayer.cv.height);
    tintAlpha(bid.data, COL.line);
    bdctx.putImageData(bid, 0, 0);
    mctx.save();
    mctx.globalAlpha = 0.55;
    mctx.drawImage(
      bdLayer.cv,
      v.x0 - bdLayer.ox, v.y0 - bdLayer.oy, v.x1 - v.x0, v.y1 - v.y0,
      0, 0, mapW, mapH
    );
    mctx.restore();

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
    drawScaleBar(ctx, pad + mapW, cy, mapW, opts.areaKmW, COL.frame);

    out._meta = { zoom: v.z, scaleKm: niceScale(opts.areaKmW) };
    return out;
  };
})(window.ATLAS);
