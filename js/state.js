// ATLAS shared namespace + tiny DOM helper. Loaded first; every other
// module attaches to window.ATLAS.
window.ATLAS = window.ATLAS || {};
ATLAS.$ = (id) => document.getElementById(id);

// Constants shared across modules. The tile services below are all free and
// key-free, and serve `Access-Control-Allow-Origin: *`, so their pixels can be
// read off a <canvas> without tainting it (PNG export stays possible).
ATLAS.const = {
  // ESRI ArcGIS Online raster tiles (no API key). {z}/{y}/{x} = level/row/col.
  TILE_HILLSHADE: 'https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
  // Country / region borders as VECTOR geometry (GeoJSON), not raster tiles. The
  // old raster boundary layers (Reference/World_Boundaries_and_Places*) bake
  // place-name labels into the same pixels as the lines, and being a single
  // fused cache there's no sublayer/export to separate them — skeletonising the
  // tiles mangled the labels into squiggles. This Esri Living Atlas FeatureServer
  // is key-free, CORS-open, and supports `?f=geojson` envelope queries, so we
  // fetch admin boundaries (admin-1: country + province/region) and stroke them
  // ourselves — no labels, crisp lines. See fetchBoundaries / drawBorders.
  BOUNDARIES: 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Administrative_Divisions/FeatureServer/0/query',
  // Finer city / district borders. The ESRI layer above stops at admin-1 (country
  // + state/province), so it has no within-city boundaries. OpenStreetMap (via the
  // Overpass API) carries the global admin hierarchy down to counties, municipal
  // districts and neighbourhoods (admin_level 6-10). It's key-free and serves
  // `Access-Control-Allow-Origin: *`, and we only ask for `out geom;` JSON (ways
  // with their node coordinates inline) — so each way drops straight into the same
  // lon/lat ring pipeline the ESRI borders use. See fetchCityBorders / drawBorders.
  CITY_BOUNDARIES: 'https://overpass-api.de/api/interpreter',
  // Used purely as a land/water mask: OpenStreetMap's standard raster paints
  // water a distinct light blue (#aad3df) at every zoom level, while land is
  // green / beige. The hillshade itself can't tell flat sea from flat land
  // (both render near-white), so we read water from here. (ESRI's ocean base
  // was unusable — it floods inland areas blue past ~z10.) Token replacement in
  // stitch() is by name, so the {z}/{x}/{y} order here is fine.
  TILE_WATERMASK: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  // OpenStreetMap Nominatim — forward (search) + reverse geocoding.
  GEOCODE:  'https://nominatim.openstreetmap.org/search',
  REVERSE:  'https://nominatim.openstreetmap.org/reverse',

  KM_PER_MI: 1.609344, // exact kilometres in one statute mile (km<->mi display)
  MAX_ZOOM: 16,    // ESRI hillshade detail cap
  MAP_SIZE: 1024,  // longer rendered map edge, in px (export resolution)
  PAD: 30,         // canvas margin around the map
  STRIP: 24,       // bottom title/scale label-row height (sits between equal PAD margins)

  // Directional relief light applied across the land in the duotone pass: the
  // terrain is brightened toward AZIMUTH and darkened toward the opposite side,
  // so flat ground still reads as "lit from one angle" rather than one flat
  // tone. AZIMUTH is the compass bearing the light comes FROM (deg, 0 = N,
  // 90 = E); STRENGTH is how far it lifts/drops the luminance ramp (0 = off).
  LIGHT: { azimuth: 315, strength: 0.22 },

  // Duotone + chrome palette, sampled from hong-kong-example.png.
  COL: {
    shadow:  [9, 26, 24],     // hillshade darkest -> deep teal
    hilight: [78, 132, 116],  // hillshade brightest -> light teal
    line:    [156, 206, 184], // country / region border lines
    frame:   [120, 178, 158], // map frame + scale bar
    region:  [120, 170, 150], // seeds the bottom title tone
    building:[175, 208, 192], // 2.5D building roof tone (walls derived darker)
    title:   [207, 234, 221], // bottom title text
    bg:      [6, 14, 13],     // canvas backdrop
  },

  // Sea / ocean styling. Water pixels are identified from the TILE_OCEAN mask
  // (sea is blue there, land is beige); we then repaint those hillshade pixels
  // onto a deep-blue ramp and stroke a wave pattern over them.
  WATER: {
    blueMin: 20,            // mask pixel is water when blue exceeds red by this
    shadow: [3, 16, 30],    // deep-water ramp: dark
    hilight:[9, 40, 64],    // deep-water ramp: light (kept dark on purpose)
    wave:   [78, 140, 170], // wave stroke colour
    waveA:  0.45,           // wave stroke alpha
  },

  // Preset swatches offered in every map-colour palette popup (the broad
  // cyberpunk set shared with the sibling apps, plus ATLAS's own teal defaults
  // at the end so each slot's default shows up as an active swatch).
  PALETTE: [
    '#fcee0a', '#00f0ff', '#ff003c', '#39ff14', '#ff8800', '#c800ff',
    '#00ff9d', '#ff10f0', '#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1',
    '#00d2d3', '#54a0ff', '#a29bfe', '#cd84f1', '#ff9ff3', '#ffffff',
    '#4e8474', '#092840', '#9cceb8', '#78b29e', '#78aa96', '#afd0c0',
  ],
};

// hex <-> [r,g,b] helpers, shared by the palette UI and the renderer.
ATLAS.hexToArr = (hex) => {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
ATLAS.arrToHex = (c) =>
  '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// localStorage setter (silent if storage is blocked).
ATLAS.save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// The single source of mutable working-area state. Feature modules alias this
// as `const S = ATLAS.state;` and read/write S.<field>. Defaults below are the
// initial values; a restore pass in app.js can override them from localStorage.
ATLAS.state = {
  lat: 22.2819,     // default view: Hong Kong (the example location)
  lon: 114.1583,
  areaKmW: 40,      // width of the rectangular area of interest, in km
  areaKmH: 40,      // height of the rectangular area of interest, in km
  title: '',        // bottom title strip (auto-filled from geocode, editable)
  rendering: false, // guard against overlapping renders
  units: 'km',      // display unit for area + scale bar ('km' | 'mi'); storage stays km
  cityBorders: true, // draw the finer OSM city/district sub-layer (area-gated)
  districtsLandOnly: true, // clip the city/district sub-layer to land (hide lines over water)
  buildings: true, // draw the 2.5D OSM building layer (gated to street-scale views, <10km)

  // Land markers: draggable annotation pins anchored to geographic coordinates,
  // so they stay put through pan / zoom / recrop / recolour. The pin and its
  // label are disjointed — the label floats at offset { ldx, ldy } (fraction of
  // the map) and a connector line (line: 'straight' | 'elbow') links them. Each
  // is { id, lat, lon, label, ldx, ldy, line, color }, where
  // color is a per-marker override (null = use the colors.marker default below).
  // Managed by js/markers.js, persisted under atlas:markers, drawn onto the canvas
  // on export.
  markers: [],

  // User-pickable map colours (hex). Each drives one element of the render;
  // land / water seed a derived light->dark ramp (see ATLAS.resolvePalette in
  // map.js). Defaults mirror ATLAS.const.COL so the out-of-box look is unchanged.
  colors: {
    land:   '#4e8474', // terrain lit tone (highlight end of the relief ramp)
    landShade: '#101a17', // terrain shaded tone (dark end; ~land x 0.20)
    water:  '#092840', // sea / lakes (deep tone; ramp + waves derived)
    border: '#9cceb8', // country / region border lines
    frame:  '#78b29e', // map frame + scale bar
    region: '#78aa96', // seeds the bottom title tone
    building: '#afd0c0', // 2.5D building roof tone (walls derived darker)
    marker: '#00f0ff', // default annotation-marker accent (per-marker overridable)
  },
  // Last custom (non-preset) pick per slot, so the palette popup can re-offer it.
  customColors: {},
};
