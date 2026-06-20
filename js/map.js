// ATLAS — map rendering engine. Pure canvas + fetch (no map library), so the
// result is a single styled bitmap we can export as PNG, the same way the other
// cyberdeck.tools apps export their working area.
//
// Pipeline: coords + area -> Web-Mercator tile range -> stitch ESRI hillshade
// tiles -> recolor to the teal duotone -> composite ESRI country/region borders
// as light lines -> draw the square frame, region name, center pin, title and
// scale bar. Exposes ATLAS.renderMap(opts) -> Promise<canvas>.
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

  // ---- geometry: square ground area -> bbox + best zoom ---------------------
  // A km-square on the ground maps to an (almost) pixel-square in Web Mercator
  // near the centre, because the projection is locally conformal — so we can
  // render straight into a square canvas without distortion.
  function computeView(lat, lon, areaKm, mapSize) {
    const halfM = areaKm * 1000 / 2;
    const dLat = halfM / 111320;
    const dLon = halfM / (111320 * Math.cos(lat * Math.PI / 180));
    const north = lat + dLat, south = lat - dLat, west = lon - dLon, east = lon + dLon;
    // Largest zoom whose bbox pixel-width is ~1:1 with the target, capped.
    let z = Math.round(Math.log2(mapSize * 360 / ((east - west) * worldPx(0))));
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

  // Crop the stitched layer down to exactly the bbox, scaled to mapSize square.
  function cropTo(layer, v, mapSize) {
    const out = document.createElement('canvas');
    out.width = out.height = mapSize;
    out.getContext('2d').drawImage(
      layer.cv,
      v.x0 - layer.ox, v.y0 - layer.oy, v.x1 - v.x0, v.y1 - v.y0,
      0, 0, mapSize, mapSize
    );
    return out;
  }

  // ---- pixel recolouring -----------------------------------------------------
  const lerp = (a, b, t) => a + (b - a) * t;

  // Map hillshade luminance onto the shadow->highlight teal ramp, in place.
  function duotone(data, sh, hi) {
    for (let i = 0; i < data.length; i += 4) {
      let L = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      L = Math.min(1, Math.max(0, (L - 0.5) * 1.18 + 0.5)); // gentle contrast
      data[i]     = lerp(sh[0], hi[0], L);
      data[i + 1] = lerp(sh[1], hi[1], L);
      data[i + 2] = lerp(sh[2], hi[2], L);
    }
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
  function drawHexTexture(ctx, size, col) {
    const r = 17, h = r * Math.sqrt(3);
    ctx.save();
    ctx.strokeStyle = rgb(col, 0.05);
    ctx.lineWidth = 1;
    for (let row = 0, y = 0; y < size + h; y += h / 2, row++) {
      const off = (row % 2) ? r * 1.5 : 0;
      for (let x = -r; x < size + r; x += r * 3) {
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

  // Square frame with augmented-ui style corner ticks.
  function drawFrame(ctx, x, y, size, col) {
    ctx.save();
    ctx.strokeStyle = rgb(col, 0.85);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgb(col, 1);
    const t = 26;
    const corners = [[x, y, 1, 1], [x + size, y, -1, 1], [x, y + size, 1, -1], [x + size, y + size, -1, -1]];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * t); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * t, cy);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Amber center pin + label, marking the entered coordinates (map centre).
  function drawCenterPin(ctx, cx, cy, text, col) {
    ctx.save();
    ctx.strokeStyle = rgb(col, 0.95);
    ctx.fillStyle = rgb(col, 0.95);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 1.4, 0, Math.PI * 2); ctx.fill();
    if (text) {
      ctx.font = "700 15px 'JetBrains Mono', monospace";
      const label = text.toUpperCase();
      const w = ctx.measureText(label).width;
      const bx = cx + 10, by = cy - 9, pad = 6, bh = 18;
      ctx.fillStyle = rgb(C.COL.bg, 0.6);
      ctx.fillRect(bx, by, w + pad * 2, bh);
      ctx.strokeStyle = rgb(col, 0.9);
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, w + pad * 2 - 1, bh - 1);
      ctx.fillStyle = rgb(col, 1);
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + pad, by + bh / 2 + 1);
    }
    ctx.restore();
  }

  // Big faint region name across the top, letter-spaced like the example.
  function drawRegionName(ctx, x, y, size, text, col) {
    if (!text) return;
    ctx.save();
    ctx.font = "500 30px 'JetBrains Mono', monospace";
    ctx.fillStyle = rgb(col, 0.28);
    ctx.textBaseline = 'top';
    const spaced = text.toUpperCase().split('').join(' ');
    ctx.fillText(spaced, x + 26, y + 22);
    ctx.restore();
  }

  // ---- scale bar -------------------------------------------------------------
  function niceScale(areaKm) {
    const target = areaKm * 0.45; // aim for roughly half the frame width
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    let best = pow;
    for (const m of [1, 2, 2.5, 5, 10]) if (m * pow <= target) best = m * pow;
    return best;
  }
  function fmtKm(n) { return (n % 1 === 0 ? n.toString() : n.toFixed(1)); }

  function drawScaleBar(ctx, rightX, baseY, mapSize, areaKm, col) {
    const total = niceScale(areaKm);
    const pxPerKm = mapSize / areaKm;
    const barW = total * pxPerKm;
    const segs = 4, segW = barW / segs, h = 6;
    const x = rightX - barW, y = baseY;
    ctx.save();
    ctx.font = "500 11px 'JetBrains Mono', monospace";
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
      ctx.fillText(fmtKm(total / segs * i), x + i * segW, y - 4);
    }
    ctx.textAlign = 'left';
    ctx.fillText('km', x + barW + 6, y - 4);
    ctx.restore();
  }

  // ---- public: render the whole thing ---------------------------------------
  // opts: { lat, lon, areaKm, title, region, center, onProgress(done,total) }
  ATLAS.renderMap = async function renderMap(opts) {
    const mapSize = C.MAP_SIZE, pad = C.PAD, strip = C.STRIP;
    const v = computeView(opts.lat, opts.lon, opts.areaKm, mapSize);

    // progress across both tiled layers
    const total = tileCount(v) * 2;
    let done = 0;
    const tick = () => { if (opts.onProgress) opts.onProgress(++done, total); };
    if (opts.onProgress) opts.onProgress(0, total);

    // 1) terrain: stitch + crop + duotone
    const hsLayer = await stitch(C.TILE_HILLSHADE, v, tick);
    const mapCv = cropTo(hsLayer, v, mapSize);
    const mctx = mapCv.getContext('2d');
    const hid = mctx.getImageData(0, 0, mapSize, mapSize);
    duotone(hid.data, C.COL.shadow, C.COL.hilight);
    mctx.putImageData(hid, 0, 0);

    // 2) texture weave
    drawHexTexture(mctx, mapSize, C.COL.hilight);

    // 3) borders: stitch, recolour to light lines, composite
    const bdLayer = await stitch(C.TILE_BOUNDS, v, tick);
    const bdctx = bdLayer.cv.getContext('2d');
    const bid = bdctx.getImageData(0, 0, bdLayer.cv.width, bdLayer.cv.height);
    tintAlpha(bid.data, C.COL.line);
    bdctx.putImageData(bid, 0, 0);
    mctx.save();
    mctx.globalAlpha = 0.55;
    mctx.drawImage(
      bdLayer.cv,
      v.x0 - bdLayer.ox, v.y0 - bdLayer.oy, v.x1 - v.x0, v.y1 - v.y0,
      0, 0, mapSize, mapSize
    );
    mctx.restore();

    // 4) compose final canvas (map + margins + bottom strip)
    await (document.fonts && document.fonts.ready);
    const out = document.createElement('canvas');
    out.width = mapSize + pad * 2;
    out.height = mapSize + pad * 2 + strip;
    const ctx = out.getContext('2d');
    ctx.fillStyle = rgb(C.COL.bg, 1);
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(mapCv, pad, pad);

    drawRegionName(ctx, pad, pad, mapSize, opts.region, C.COL.region);
    drawCenterPin(ctx, pad + mapSize / 2, pad + mapSize / 2, opts.center, C.COL.amber);
    drawFrame(ctx, pad, pad, mapSize, C.COL.frame);

    // bottom strip: title (left) + scale bar (right)
    const baseY = mapSize + pad * 2 + strip / 2 + 4;
    if (opts.title) {
      ctx.save();
      ctx.font = "500 18px 'JetBrains Mono', monospace";
      ctx.fillStyle = rgb(C.COL.title, 0.95);
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.title.toUpperCase(), pad, baseY);
      ctx.restore();
    }
    drawScaleBar(ctx, pad + mapSize, baseY + 6, mapSize, opts.areaKm, C.COL.frame);

    out._meta = { zoom: v.z, scaleKm: niceScale(opts.areaKm) };
    return out;
  };
})(window.ATLAS);
