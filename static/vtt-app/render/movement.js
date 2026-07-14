// Translucent highlight showing how far a token can still move this turn.
// Drawn as a plain radius circle, same "no walls" simplification as vision -
// it's a planning aid, not a pathfinding/terrain-aware range.
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
    const radius = remainingFt * pxPerFoot;
    ctx.beginPath();
    ctx.arc(token.x, token.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}
