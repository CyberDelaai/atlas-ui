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
  TILE_BOUNDS:    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places_Alternate/MapServer/tile/{z}/{y}/{x}',
  // OpenStreetMap Nominatim — forward (search) + reverse geocoding.
  GEOCODE:  'https://nominatim.openstreetmap.org/search',
  REVERSE:  'https://nominatim.openstreetmap.org/reverse',

  MAX_ZOOM: 16,    // ESRI hillshade detail cap
  MAP_SIZE: 1024,  // rendered map square, in px (export resolution)
  PAD: 30,         // canvas margin around the map square
  STRIP: 64,       // bottom title/scale strip height

  // Duotone + chrome palette, sampled from hong-kong-example.png.
  COL: {
    shadow:  [9, 26, 24],     // hillshade darkest -> deep teal
    hilight: [78, 132, 116],  // hillshade brightest -> light teal
    line:    [156, 206, 184], // country / region border lines
    frame:   [120, 178, 158], // square frame + scale bar
    amber:   [232, 184, 64],  // center label pin (matches example districts)
    region:  [120, 170, 150], // big faint region name
    title:   [207, 234, 221], // bottom title text
    bg:      [6, 14, 13],     // canvas backdrop
  },
};

// localStorage setter (silent if storage is blocked).
ATLAS.save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// The single source of mutable working-area state. Feature modules alias this
// as `const S = ATLAS.state;` and read/write S.<field>. Defaults below are the
// initial values; a restore pass in app.js can override them from localStorage.
ATLAS.state = {
  lat: 22.2819,     // default view: Hong Kong (the example location)
  lon: 114.1583,
  areaKm: 40,       // edge length of the square area of interest, in km
  title: '',        // bottom title strip (auto-filled from geocode, editable)
  region: '',       // big faint region name (auto-filled, editable)
  center: '',       // amber center-point label (auto-filled, editable)
  rendering: false, // guard against overlapping renders
};
