# TODO

Pending issues, features, and ideas for ATLAS.
Items are removed from the list once they are implemented / resolved (no archive section).

## BIG (Y version bump)

1. Auto district pins — query nearby places (Nominatim/Overpass) inside the frame
   and drop several amber district labels automatically, like the reference image.
2. Manual label mode — let the user click on the map to drop / name their own pins.
3. Islands visibility slider (hide small islands under certain threshold)

## SMALL (Z version bump)

1. Add `atlas_thumbnail.png` (1200×630) for the og:image / twitter:image social previews.
2. Set the real tagline (`tag` / `tag_alt`) and meta descriptions (the page still
   uses the generic scaffold copy).
3. The ESRI boundary overlay brings in small baked-in place labels; consider a
   cleaner boundaries-only source (or a label mask) for crisper borders.
4. Localize the transient status lines (`st_*` in `js/i18n.js`) — currently EN-only
   via fallback, while all other UI strings are translated.
5. Ability to recrop map, (+)/(-) zoom controls
6. Roll 20 advice on cells count and scale to match map's
