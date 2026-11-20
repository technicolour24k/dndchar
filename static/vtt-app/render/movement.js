// Translucent highlight showing how far a token can still move this turn.
// Movement is measured Chebyshev-style (a diagonal square costs the same 5 ft
// as an orthogonal one - see shared/gridDistance.js), so the reachable area is
// an axis-aligned square, not a circle. Same "no walls" simplification as
// vision - it's a planning aid, not a pathfinding/terrain-aware range.
export function drawMovementRange(ctx, tokens, gridSizePx) {
  const pxPerFoot = gridSizePx / 5;

  ctx.save();
  ctx.fillStyle = 'rgba(74, 127, 255, 0.15)';
  ctx.strokeStyle = 'rgba(74, 127, 255, 0.65)';
  ctx.lineWidth = 4;
  ctx.setLineDash([6, 4]);

  for (const token of tokens) {
    const remainingFt = token.speedRemainingFt || 0;
    if (remainingFt <= 0) continue;
    const half = remainingFt * pxPerFoot;
    ctx.beginPath();
    ctx.rect(token.x - half, token.y - half, half * 2, half * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}
