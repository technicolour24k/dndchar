// Highlight ring around currently-targeted tokens (Section 3a). Batch-drawn
// like movement range - one shared style, since every target gets the same
// highlight regardless of who selected it or why.
export function drawTargetRings(ctx, targetTokenIds, tokens, gridSizePx) {
  if (!targetTokenIds || !targetTokenIds.length) return;
  // Token radius itself is gridSizePx * 0.4 with its own ~3px stroke (see
  // tokens.js) - offset well past that so the ring reads as its own distinct
  // highlight rather than blending into the token's border.
  const radius = gridSizePx * 0.4 + 10;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 82, 82, 0.95)';
  ctx.lineWidth = 4;
  ctx.setLineDash([5, 4]);

  for (const token of tokens) {
    if (!targetTokenIds.includes(token.id)) continue;
    ctx.beginPath();
    ctx.arc(token.x, token.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}
