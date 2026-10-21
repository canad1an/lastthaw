"""Knock out the white background of a generated icon: flood from the border so interior whites stay,
soften the edge, trim, pad to square and resize. Usage: cutout.py <in.jpg> <out.png> [size]"""
import sys
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

src, dst = sys.argv[1], sys.argv[2]
size = int(sys.argv[3]) if len(sys.argv) > 3 else 256
im = Image.open(src).convert("RGB")
a = np.asarray(im).astype(np.int16)
# How far from white each pixel is (0 = pure white).
dist = 255 - a.min(axis=2)
near_white = dist < 28
h, w = near_white.shape
bg = np.zeros((h, w), dtype=bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if near_white[y, x] and not bg[y, x]:
            bg[y, x] = True; q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if near_white[y, x] and not bg[y, x]:
            bg[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
        if 0 <= ny < h and 0 <= nx < w and near_white[ny, nx] and not bg[ny, nx]:
            bg[ny, nx] = True; q.append((ny, nx))
alpha = np.where(bg, 0, 255).astype(np.uint8)
# Partial alpha on the fringe so the outline does not carry a white halo.
alpha_img = Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(1.2))
alpha = np.asarray(alpha_img)
fringe = (alpha > 0) & (alpha < 255)
alpha = np.where(bg & ~fringe, 0, alpha)
rgba = np.dstack([a.astype(np.uint8), alpha])
out = Image.fromarray(rgba, "RGBA")
bbox = out.getbbox()
out = out.crop(bbox)
side = max(out.size)
pad = Image.new("RGBA", (int(side * 1.08), int(side * 1.08)), (0, 0, 0, 0))
pad.paste(out, ((pad.width - out.width) // 2, (pad.height - out.height) // 2))
pad = pad.resize((size, size), Image.LANCZOS)
pad.save(dst, optimize=True)
print(dst, pad.size, "bg share", round(bg.mean(), 3))
