const TYPE_COLOR = { pc: '#4caf50', npc: '#2196f3', enemy: '#e53935' };
const CONDITION_COLOR = { healthy: '#4caf50', bloodied: '#ff9800', critical: '#e53935' };

function colorForType(type) {
  return TYPE_COLOR[type] || '#9e9e9e';
}

// Hidden tokens only ever reach this function on the GM's own client -
// filterSessionForRole strips them from a player's session entirely, so
// there's no risk of the transparency itself being a tell for players who
// were never sent the token in the first place. It's purely a GM-side visual
// cue for "this one's hidden," at a glance, without opening its card.
const HIDDEN_TOKEN_OPACITY = 0.5;

export function drawTokens(ctx, tokens, gridSizePx, getImage) {
  const radius = gridSizePx * 0.4;

  for (const token of tokens) {
    const img = token.imageUrl ? getImage(token.imageUrl) : null;

    ctx.save();
    ctx.globalAlpha = token.hidden ? HIDDEN_TOKEN_OPACITY : 1;

    if (img && img.complete && img.naturalWidth) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(token.x, token.y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, token.x - radius, token.y - radius, radius * 2, radius * 2);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(token.x, token.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = colorForType(token.type);
      ctx.lineWidth = 3;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(token.x, token.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = colorForType(token.type);
      ctx.fill();
    }

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeText(token.name || '', token.x, token.y + radius + 14);
    ctx.fillText(token.name || '', token.x, token.y + radius + 14);

    if (token.stats && typeof token.stats.hp === 'number' && typeof token.stats.maxHp === 'number') {
      drawHpBar(ctx, token, radius);
    } else if (token.condition) {
      drawConditionBadge(ctx, token, radius);
    }

    ctx.restore();
  }
}

function drawHpBar(ctx, token, radius) {
  const w = radius * 2;
  const h = 5;
  const x = token.x - radius;
  const y = token.y - radius - h - 4;
  const pct = Math.max(0, Math.min(1, token.stats.hp / Math.max(1, token.stats.maxHp)));

  ctx.fillStyle = '#400';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ff9800' : '#e53935';
  ctx.fillRect(x, y, w * pct, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

function drawConditionBadge(ctx, token, radius) {
  const color = CONDITION_COLOR[token.condition] || '#9e9e9e';
  ctx.beginPath();
  ctx.arc(token.x + radius * 0.7, token.y - radius * 0.7, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();
}
