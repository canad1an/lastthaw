/** The map's pan and zoom: the world is drawn translated by (x, y) and scaled by k, in viewBox units. */
export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The part of the world (in unscaled viewBox units) the viewport shows. */
export function visibleRect(view: View, width: number, height: number): Rect {
  return { x: -view.x / view.k, y: -view.y / view.k, w: width / view.k, h: height / view.k };
}

/** Whether two rectangles overlap, with an optional margin round the first. */
export function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return a.x - margin < b.x + b.w && a.x + a.w + margin > b.x && a.y - margin < b.y + b.h && a.y + a.h + margin > b.y;
}
