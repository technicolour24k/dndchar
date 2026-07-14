// Standalone shape-intersection math (Phase 2, Section 4b) - deliberately not
// embedded in render code, since it serves two purposes: (1) rendering which
// tokens a placed AoE marker visually catches, (2) feeding target:select
// automatically when a shape is placed, so a 5-enemy fireball doesn't need
// manual multi-select. All marker coordinates/dimensions are in map pixels
// except *Ft fields, which are feet and need pxPerFoot to compare against
// token x/y (also map pixels).

function angleTo(fromX, fromY, toX, toY) {
  return (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI;
}

function angleDiff(a, b) {
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

// Point-in-circle, shared by 'circle' (token-agnostic, still anchored to a
// placed point same as always) and 'sphere' (explicitly point-anchored per
// spec 4a - reuses identical math, cheapest shape to add).
function pointInCircle(px, py, marker, pxPerFoot) {
  const radius = (marker.radiusFt || 0) * pxPerFoot;
  const dx = px - marker.x;
  const dy = py - marker.y;
  return dx * dx + dy * dy <= radius * radius;
}

function pointInCone(px, py, marker, pxPerFoot) {
  const length = (marker.lengthFt || 0) * pxPerFoot;
  const dx = px - marker.x;
  const dy = py - marker.y;
  const distance = Math.hypot(dx, dy);
  if (distance > length) return false;
  if (distance === 0) return true; // the origin point itself is always inside
  const pointAngle = angleTo(marker.x, marker.y, px, py);
  return angleDiff(pointAngle, marker.angleDeg || 0) <= (marker.coneAngleDeg || 60) / 2;
}

// Cube/cuboid is modeled as a rotated rectangle anchored at the midpoint of
// its near edge (the origin the player clicked), extending lengthFt "deep"
// in the facing direction and widthFt "wide" perpendicular to it - the same
// anchor convention as a cone (origin is where the effect starts, not its
// center), so the click-then-drag placement UI (Section 4c) works
// identically for both.
function pointInCube(px, py, marker, pxPerFoot) {
  const lengthPx = (marker.lengthFt || 0) * pxPerFoot;
  const widthPx = (marker.widthFt || 0) * pxPerFoot;
  const angleRad = ((marker.angleDeg || 0) * Math.PI) / 180;
  const dx = px - marker.x;
  const dy = py - marker.y;
  // Rotate the point into the shape's local space (forward = +x, side = +y).
  const forward = dx * Math.cos(angleRad) + dy * Math.sin(angleRad);
  const side = -dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
  return forward >= 0 && forward <= lengthPx && Math.abs(side) <= widthPx / 2;
}

export function isPointInShape(px, py, marker, pxPerFoot) {
  switch (marker.shape) {
    case 'cone':
      return pointInCone(px, py, marker, pxPerFoot);
    case 'cube':
      return pointInCube(px, py, marker, pxPerFoot);
    case 'circle':
    case 'sphere':
    default:
      return pointInCircle(px, py, marker, pxPerFoot);
  }
}

// Returns the subset of `tokens` whose center falls inside `marker`'s shape.
export function getTokensInShape(marker, tokens, pxPerFoot) {
  return tokens.filter((token) => isPointInShape(token.x, token.y, marker, pxPerFoot));
}
