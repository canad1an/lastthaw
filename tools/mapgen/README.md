# Map tooling

One-time generators for the world map. Outputs are committed; the inputs under `data/` are not.

## Terrain relief (`src/relief.py`)

The shaded-relief background the map draws under the regions comes from Natural Earth I with shaded relief, land
cover and water (public domain, equirectangular, which matches the map's 2000x1000 viewBox exactly).

1. Download NE1_HR_LC_SR_W.zip (about 320 MB) from https://www.naturalearthdata.com/downloads/10m-raster-data/10m-natural-earth-1/
   and unzip it into `data/relief-src/` (ignored by git).
2. `npm run relief` here (needs Python with Pillow and numpy). It writes `apps/web/public/map/relief/relief-4000.webp`
   and the 32 zoomed-in tiles under `relief-8000/`, muted and with the sea recoloured to the map's own dark blue.

The output is deterministic, so rerunning it changes nothing unless the script or the source does.

## Sea lanes and coasts (`src/sea-paths.mjs`, `src/dense-lanes.mjs`, `src/coast-points.mjs`)

See the comments at the top of each script.
