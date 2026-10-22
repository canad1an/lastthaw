/**
 * The map as a grid: every region's outline rasterised so a cell knows which region (or the sea) it belongs to.
 * Shared by the lane finder (sea-paths.mjs) and the town slot picker (town-slots.mjs).
 */

/** The polygon rings of an SVG path made of M, L, H, V and Z commands (what the map generator writes). */
export function rings(d) {
  const out = [];
  let ring = [];
  let x = 0, y = 0, cmd = "";
  const nums = [];
  const re = /([MLHVZmlhvz])|(-?\d*\.?\d+)/g;
  let m;
  const flush = () => {
    while (nums.length) {
      if (cmd === "M") { if (ring.length) out.push(ring); ring = []; x = nums.shift(); y = nums.shift(); ring.push([x, y]); cmd = "L"; }
      else if (cmd === "L") { x = nums.shift(); y = nums.shift(); ring.push([x, y]); }
      else if (cmd === "H") { x = nums.shift(); ring.push([x, y]); }
      else if (cmd === "V") { y = nums.shift(); ring.push([x, y]); }
      else nums.length = 0;
    }
  };
  while ((m = re.exec(d))) {
    if (m[1]) { flush(); cmd = m[1].toUpperCase(); if (cmd === "Z") { if (ring.length) out.push(ring); ring = []; } }
    else nums.push(Number(m[2]));
  }
  flush();
  if (ring.length) out.push(ring);
  return out.filter((r) => r.length >= 3);
}

/**
 * Rasterise the world at `scale` cells per map unit: owner[cell] = region index + 1, or 0 where no region's outline
 * covers (the sea). Even-odd scanline fill, one ring at a time (holes in these outlines are rare and small).
 */
export function rasterise(world, scale) {
  const W = Math.round(world.width * scale);
  const H = Math.round(world.height * scale);
  const owner = new Uint16Array(W * H);
  world.regions.forEach((r, idx) => {
    for (const ring of rings(r.path)) {
      const ys = ring.map((p) => p[1] * scale);
      const y0 = Math.max(0, Math.floor(Math.min(...ys)));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
      for (let y = y0; y <= y1; y++) {
        const cy = y + 0.5;
        const xs = [];
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = [ring[i][0] * scale, ring[i][1] * scale];
          const [xj, yj] = [ring[j][0] * scale, ring[j][1] * scale];
          if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const xa = Math.max(0, Math.round(xs[k]));
          const xb = Math.min(W - 1, Math.round(xs[k + 1]) - 1);
          for (let x = xa; x <= xb; x++) owner[y * W + x] = idx + 1;
        }
      }
    }
  });
  return { owner, W, H };
}

/** The eight neighbours of a cell, x wrapping at the map's edge. */
export function neighbours(c, W, H) {
  const x = c % W, y = (c - x) / W;
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const ny = y + dy;
    if (ny < 0 || ny >= H) continue;
    out.push(ny * W + ((x + dx + W) % W));
  }
  return out;
}

/** Whether a point lies inside any of the rings (ray casting; a hole ring would flip it back out). */
export function pointInRings(rs, x, y) {
  let inside = false;
  for (const ring of rs) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
  }
  return inside;
}
