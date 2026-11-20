// Grid distance helpers shared by the browser client and the Node server.
//
// This folder is special: files in here are imported by BOTH sides, so they
// must stay pure - no DOM, no imports, no Node APIs. Importers:
//   - static/vtt-app/main.js and the render modules (browser, as ES modules)
//   - vtt/server/handlers/token.js (Node, via a relative path into static/)
//   - the vitest tests under src/lib/server/
//
// Movement uses Chebyshev distance: a diagonal step costs the same as an
// orthogonal one (5 ft per square). Distances round to the nearest foot.
// (Prone adjacency in src/lib/server/vttAttackAdvantage.ts deliberately
// rounds to whole squares instead - it wants to be forgiving for tokens that
// are placed freely rather than snapped to the grid.)

/**
 * Chebyshev distance between two points, in feet, rounded to the nearest foot.
 * `*5/g` rather than `/(g/5)` avoids float noise at exact .5 boundaries.
 * Returns null if the grid size or any coordinate is not usable.
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} gridSizePx
 * @returns {number | null}
 */
export function chebyshevFt(ax, ay, bx, by, gridSizePx) {
  if (!Number.isFinite(gridSizePx) || gridSizePx <= 0) return null;
  if (![ax, ay, bx, by].every(Number.isFinite)) return null;
  return Math.round((Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 5) / gridSizePx);
}

/**
 * Total distance of a path in feet: the sum of each leg's rounded distance.
 * `points` includes the origin. Fewer than 2 points is 0. Any invalid leg
 * (or an invalid grid size) gives null.
 * @param {{ x: number, y: number }[]} points
 * @param {number} gridSizePx
 * @returns {number | null}
 */
export function pathFt(points, gridSizePx) {
  if (!Number.isFinite(gridSizePx) || gridSizePx <= 0) return null;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const leg = chebyshevFt(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, gridSizePx);
    if (leg === null) return null;
    total += leg;
  }
  return total;
}

/**
 * Centre of the grid square containing (x, y). The grid is anchored at (0,0).
 * Client-only in practice, but it lives here so it is unit tested.
 * @param {number} x
 * @param {number} y
 * @param {number} gridSizePx
 * @returns {{ x: number, y: number }}
 */
export function snapToSquareCentre(x, y, gridSizePx) {
  const g = gridSizePx;
  return { x: (Math.floor(x / g) + 0.5) * g, y: (Math.floor(y / g) + 0.5) * g };
}
