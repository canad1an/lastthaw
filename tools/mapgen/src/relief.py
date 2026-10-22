"""
Shaded-relief background for the world map.

Turns Natural Earth I (shaded relief, land cover and water; public domain) into the tiles the map draws under the
regions. The source is the 21600x10800 equirectangular TIFF NE1_HR_LC_SR_W, which maps 1:1 onto the map's
2000x1000 viewBox (x = (lon + 180) / 360 * 2000, y = (90 - lat) / 180 * 1000), so no reprojection is needed.

Usage:
    python -P tools/mapgen/src/relief.py <path to NE1_HR_LC_SR_W.tif> apps/web/public/map/relief

Writes:
    relief-4000.webp            4000x2000, always loaded
    relief-8000/{col}_{row}.webp  8x4 tiles of 1000x1000 px (250x250 map units each), loaded when zoomed in

Deterministic: fixed resampling, tone and quality, no randomness. Download: https://www.naturalearthdata.com/downloads/10m-raster-data/10m-natural-earth-1/
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance

Image.MAX_IMAGE_PIXELS = None

SEA = (0x0B, 0x1A, 0x2B)  # the map's sea colour (svg background)
SEA_SHADING = 0.25  # how much of Natural Earth's ocean-depth shading shows through the dark sea
SATURATION = 0.85  # player colours are tinted over the relief, so the land is muted a little
GAMMA = 0.85  # lifts the dark forests and jungles so they read as land, not holes in the map
QUALITY = 70
HI = (8000, 4000)
LO = (4000, 2000)
TILE = 1000


def tone(img: Image.Image) -> Image.Image:
    """Dark sea in the map's own blue (keeping a hint of depth shading), land lifted out of its shadows and muted."""
    px = np.asarray(img, dtype=np.float32)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    water = (b - r > 20) & (b >= g)  # Natural Earth paints every sea and lake blue; land is beige, green or white
    out = 255 * (px / 255) ** GAMMA
    sea = np.asarray(SEA, dtype=np.float32)
    out[water] = sea * (1 - SEA_SHADING) + px[water] * SEA_SHADING
    toned = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")
    return ImageEnhance.Color(toned).enhance(SATURATION)


def build(src: Path, out: Path) -> None:
    img = Image.open(src).convert("RGB")
    hi = img.resize(HI, Image.LANCZOS)
    img.close()
    hi = tone(hi)
    tiles = out / "relief-8000"
    tiles.mkdir(parents=True, exist_ok=True)
    cols, rows = HI[0] // TILE, HI[1] // TILE
    for row in range(rows):
        for col in range(cols):
            box = (col * TILE, row * TILE, (col + 1) * TILE, (row + 1) * TILE)
            hi.crop(box).save(tiles / f"{col}_{row}.webp", "WEBP", quality=QUALITY, method=6)
    lo = hi.resize(LO, Image.LANCZOS)
    lo.save(out / "relief-4000.webp", "WEBP", quality=QUALITY, method=6)
    total = sum(p.stat().st_size for p in out.rglob("*.webp"))
    print(f"wrote {out / 'relief-4000.webp'} ({(out / 'relief-4000.webp').stat().st_size // 1024} KB) and {cols * rows} tiles; {total // 1024} KB in all")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    build(Path(sys.argv[1]), Path(sys.argv[2]))
