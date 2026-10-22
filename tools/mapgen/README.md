# Map tooling

One-time generators for the world map. Outputs are committed; the inputs under `data/` are not.

## Terrain relief (`src/relief.py`)

The shaded-relief background the map draws under the regions comes from Natural Earth I with shaded relief, land
cover and water (public domain, equirectangular, which matches the map's 2000x1000 viewBox exactly).

1. Download NE1_HR_LC_SR_W.zip (about 320 MB) from https://www.naturalearthdata.com/downloads/10m-raster-data/10m-natural-earth-1/
   and unzip it into `data/relief-src/` (ignored by git).
2. `npm run relief` here (needs Python with Pillow and numpy). It writes `apps/web/public/map/earth/relief/relief-4000.webp`
   and the 32 zoomed-in tiles under `relief-8000/`, muted and with the sea recoloured to the map's own dark blue.

The output is deterministic, so rerunning it changes nothing unless the script or the source does.

## Pangaea (`src/generate-pangaea.ts`)

The second map: the supercontinent of 250 million years ago, cut into ~400 regions with invented names.

1. Download `paleocoastlines_v7_shapefiles.zip` (17.5 MB, CC BY 4.0: Kocsis & Scotese 2021, PaleoMAP PaleoCoastlines)
   from https://zenodo.org/records/7994000 and unzip the `CS/250Ma_CS_v7.*` files into `data/pangaea-src/CS/` (ignored by git).
2. `npm run pangaea` here: generates `packages/shared/src/map/pangaea.json` (the server loads it through `loadMap`),
   densifies and traces the sea lanes, writes the coast points, and publishes `world.json`, `lanePaths.json` and
   `coastPoints.json` under `apps/web/public/map/pangaea/` (the web app fetches them when a Pangaea match opens).

The post-steps take `--map=<id>`; without it they work on Earth. Pangaea has no relief tiles, so it is painted flat.

## Sea lanes and coasts (`src/sea-paths.mjs`, `src/dense-lanes.mjs`, `src/coast-points.mjs`)

See the comments at the top of each script.
