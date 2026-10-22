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

## Town slots (`src/town-slots.mjs`)

Where each region's buildings stand when the map is zoomed in: a centre for the wonder and up to 26 slots packed
round it, written to `apps/web/src/map/townSlots.json`. `node tools/mapgen/src/town-slots.mjs`; the shared test
`townSlots.test.ts` checks every slot lies inside its region. `src/grid.mjs` holds the rasteriser both this and the
lane finder use.

## Sea lanes and coasts (`src/sea-paths.mjs`, `src/dense-lanes.mjs`, `src/coast-points.mjs`)

See the comments at the top of each script.
