# ATLAS

A free, in-browser **cyberpunk map generator** — the newest tool in the
[cyberdeck.tools](https://cyberdeck.tools/) family (COMMLINK · CHRONOS · GRIDMAP).

Enter real-world coordinates (or search for a place), choose how big a square of
ground to capture, and ATLAS renders a stylized hillshade terrain map — recolored
to the cyberdeck teal palette, with country / region borders, a square frame,
a labelled centre pin, a region name, a title strip and a scale bar — then exports
it as a PNG.

No build step, no backend — just open `index.html`. Everything runs client-side.

## How it works

- **Coordinates + area** — type a latitude / longitude and a square edge length in
  km, or use **FIND PLACE** to geocode a name into coordinates.
- **Terrain + borders** — relief comes from ESRI's free `World_Hillshade` tiles and
  borders from ESRI's boundary tiles; both are key-free and fetched straight onto a
  `<canvas>`, recolored to the duotone teal palette.
- **Labels** — the centre point, region name and bottom title are auto-filled from a
  reverse-geocode lookup and are fully editable before export.
- **Colors** — recolor any map element (land, water, borders, frame, marker, region)
  from the **MAP COLORS** panel: each opens a palette popup of preset swatches plus a
  custom color picker, and the map restyles live without re-fetching tiles.
- **Export** — one click writes a high-resolution PNG.
- **Persistent** — your inputs, color picks and the last rendered map are saved in
  the browser (`localStorage`), so reopening the page restores the whole working area
  without re-fetching any tiles.

Geocoding uses [OpenStreetMap Nominatim](https://nominatim.org/); terrain and
boundary tiles are © Esri and its data partners.

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
