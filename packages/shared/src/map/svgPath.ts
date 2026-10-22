/** The polygon rings of a region's SVG path (M, L, H, V and Z commands, as the map generator writes them). */
export function pathRings(d: string): [number, number][][] {
  const out: [number, number][][] = [];
  let ring: [number, number][] = [];
  let x = 0;
  let y = 0;
  let cmd = "";
  const nums: number[] = [];
  const re = /([MLHVZmlhvz])|(-?\d*\.?\d+)/g;
  let m: RegExpExecArray | null;
  const flush = () => {
    while (nums.length) {
      if (cmd === "M") {
        if (ring.length) out.push(ring);
        ring = [];
        x = nums.shift()!;
        y = nums.shift()!;
        ring.push([x, y]);
        cmd = "L";
      } else if (cmd === "L") {
        x = nums.shift()!;
        y = nums.shift()!;
        ring.push([x, y]);
      } else if (cmd === "H") {
        x = nums.shift()!;
        ring.push([x, y]);
      } else if (cmd === "V") {
        y = nums.shift()!;
        ring.push([x, y]);
      } else nums.length = 0;
    }
  };
  while ((m = re.exec(d))) {
    if (m[1]) {
      flush();
      cmd = m[1].toUpperCase();
      if (cmd === "Z") {
        if (ring.length) out.push(ring);
        ring = [];
      }
    } else nums.push(Number(m[2]));
  }
  flush();
  if (ring.length) out.push(ring);
  return out.filter((r) => r.length >= 3);
}

/** Whether a point lies inside the rings (ray casting, even-odd). */
export function pointInRings(rings: readonly (readonly [number, number][])[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
  }
  return inside;
}
