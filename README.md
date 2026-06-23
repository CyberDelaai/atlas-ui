# ATLAS

A free, in-browser **cyberpunk map generator** — the newest tool in the
[cyberdeck.tools](https://cyberdeck.tools/) family (COMMLINK · CHRONOS · GRIDMAP).

Enter real-world coordinates (or search for a place), choose how big a rectangle of
ground to capture, and ATLAS renders a stylized hillshade terrain map — recolored
to the cyberdeck teal palette, with country, region and city-district borders, a frame,
a labelled centre pin, a region name, a title strip and a scale bar — then exports
it as a PNG.

No build step, no backend — just open `index.html`. Everything runs client-side.

## How it works

- **Coordinates + area** — type a latitude / longitude and the area's width and
  height, or use **FIND PLACE** to geocode a name into coordinates. The **UNITS**
  toggle switches the area inputs and the rendered scale bar between **KM** and
  **MI** (the map itself is unchanged — only what's shown and entered).
- **Recrop / zoom** — the **+ / −** controls on the map recrop it around the same
  centre (zoom in for more detail, out for a wider view) and re-render.
- **Terrain + borders** — relief comes from ESRI's free `World_Hillshade` tiles;
  country / region borders come from ESRI's vector administrative-divisions service,
  and finer city / district borders (auto-shown once you zoom into a city-scale view)
  from OpenStreetMap's Overpass API. All sources are key-free; the lines are stroked
  straight onto the `<canvas>` in the duotone teal palette. The city / district
  sub-layer can be switched off with the **CITY DISTRICTS** toggle in the OUTPUT
  panel, and the **DISTRICTS: LAND ONLY** toggle clips those finer lines to land so
  boundaries that run out over the sea aren't drawn on the water.
- **Buildings** — once you zoom into a street-scale view (the shorter captured edge
  under 10 km), OpenStreetMap building footprints are drawn as faux-3D **2.5D**
  blocks, extruded by each building's tagged height (or an estimate), shaded walls
  under lit roofs. Wider views skip them entirely. Toggle the layer with the
  **BUILDINGS** switch in the OUTPUT panel.
- **Labels** — the region name and bottom title are auto-filled from a
  reverse-geocode lookup and are fully editable before export.
- **Land markers** — drop your own annotation pins with **+ ADD MARKER** in the
  OUTPUT panel. The pin and its label are independent: drag the pin to re-anchor
  it, or drag the label to move it apart — a connector line (straight or
  right-angled, toggled per marker) keeps them linked. Click either to edit the
  multi-line, centered label, switch the label to a bare style where
  the connector line runs on under the text as its underline instead of a box,
  set the label font size, pick the pin shape (diamond, circle, square,
  triangle, star, or none), recolor that one marker from its own palette (or
  leave it on the default), or delete it. Markers are anchored to
  real coordinates, so they stay put through pan / zoom / recrop / recolor, are
  saved with the rest of your working area, and are drawn into the exported PNG.
- **Colors** — recolor any map element (land, land shade, water, borders, frame,
  region, buildings, and the default marker accent) from the slide-out **COLORS** panel (open
  it with the tab on the right edge): each row opens a palette popup of preset
  swatches plus a custom color picker, and the map restyles live without
  re-fetching tiles.
- **Export** — one click writes a high-resolution PNG. The OUTPUT panel also shows
  a **ROLL20** hint — the page size (in cells) and per-cell real-world scale to set
  in a virtual tabletop so its square grid matches this map's footprint.
- **Persistent** — your inputs, color picks and the last rendered map are saved in
  the browser (`localStorage`), so reopening the page restores the whole working area
  without re-fetching any tiles.

Geocoding uses [OpenStreetMap Nominatim](https://nominatim.org/) and city / district
borders the [Overpass API](https://overpass-api.de/); terrain and country / region
boundaries are © Esri and its data partners. OSM data © OpenStreetMap contributors (ODbL).

## Running

Open `index.html` in any modern browser, or serve the folder:

```
python3 -m http.server 8765
```

## Versioning

`X.Y.Z`, bumped with the helper script (keeps all three in-file version spots
in sync — the line-1 comment, the `#tagVersion` span, and the `VER` constant):

```
python3 bump_version.py {x|y|z}
```

## Built with

- [augmented-ui](https://augmented-ui.com/) — clipped/beveled cyberpunk panel styling
- [JetBrains Mono](https://www.jetbrains.com/lp/mono/) — UI typeface

## Support

If you find these tools useful, you can support development here: [boosty.to/cyberdelaai/donate](https://boosty.to/cyberdelaai/donate)

## License

[MIT](LICENSE) © 2026 CyberDelaai
