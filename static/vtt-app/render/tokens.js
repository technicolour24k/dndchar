// Exported so main.js's Token Manager list (Phase 10) can reuse the exact
// same type/condition swatch colors as the canvas, rather than inventing a
// second color scheme for the same concepts.
export const TYPE_COLOR = { pc: '#4caf50', npc: '#2196f3', enemy: '#e53935', prop: '#9c7f4f' };
export const CONDITION_COLOR = { healthy: '#4caf50', bloodied: '#ff9800', critical: '#e53935' };

function colorForType(type) {
  return TYPE_COLOR[type] || '#9e9e9e';
}

// getImage() (main.js) returns either a cached <img> or, for animated token
// art, a cached <video> - readiness is a different property on each, but
// ctx.drawImage() itself accepts both once ready, no other branch needed.
function isMediaReady(media) {
  if (!media) return false;
  if (media.tagName === 'VIDEO') return media.readyState >= 2 && media.videoWidth > 0;
  return media.complete && media.naturalWidth > 0;
}

// Hidden tokens only ever reach this function on the GM's own client -
// filterSessionForRole strips them from a player's session entirely, so
// there's no risk of the transparency itself being a tell for players who
// were never sent the token in the first place. It's purely a GM-side visual
// cue for "this one's hidden," at a glance, without opening its card.
const HIDDEN_TOKEN_OPACITY = 0.5;

// viewerId is null for the GM; used below only for the AC indicator, which
// still distinguishes true AC from the coarse "AC <= known" bound for
// enemies. HP bars aren't gated on viewerId - PC stats aren't stripped
// server-side (allies' HP isn't secret), so any token with stats gets a real
// bar; enemy/npc tokens have stats stripped server-side and fall back to the
// condition badge.
export function drawTokens(ctx, tokens, gridSizePx, getImage, viewerId = null) {
  const radius = gridSizePx * 0.4;

  for (const token of tokens) {
    const img = token.imageUrl ? getImage(token.imageUrl) : null;

    ctx.save();
    ctx.globalAlpha = token.hidden ? HIDDEN_TOKEN_OPACITY : 1;

    if (isMediaReady(img)) {
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

    // Standard 5e status conditions (Poisoned, Prone, etc.) - a separate,
    // observable-to-everyone signal from the coarse health condition above,
    // so drawn independently and can appear alongside either the HP bar or
    // the health-condition badge.
    drawConditionsRow(ctx, token, radius);

    drawAcIndicator(ctx, token, radius, viewerId);

    ctx.restore();
  }
}

// AC readout under the token. The GM sees the true AC of any token. A player
// sees the true AC only for tokens whose AC isn't secret (their own / ally PCs,
// where the server never strips it); for an enemy, the real AC never reaches
// the client at all - the player only ever sees `knownAc`, the lowest attack
// roll that has actually hit it, rendered as an upper bound they tighten
// through play. Nothing shows until either is known.
//
// The two readouts are deliberately distinct and never rendered on the same
// line: the true AC uses the same `trueAc` resolution for both the GM and
// player branches (token.ac, falling back to token.stats.ac), and `knownAc`
// only ever renders when no true AC reached this client at all - it is a
// discovered upper bound, not the real AC, and must never be mistaken for
// it. It gets its own colour, its own line further down, and an unambiguous
// "Known AC <=" prefix.
function drawAcIndicator(ctx, token, radius, viewerId) {
  const trueAc = typeof token.ac === 'number' ? token.ac
    : (token.stats && typeof token.stats.ac === 'number' ? token.stats.ac : null);

  let trueText = null;
  let knownText = null;
  if (trueAc != null) {
    trueText = `AC ${trueAc}`;
  } else if (viewerId !== null && typeof token.knownAc === 'number') {
    knownText = `Known AC ≤ ${token.knownAc}`;
  }
  if (trueText == null && knownText == null) return;

  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;

  if (trueText != null) {
    ctx.fillStyle = '#9fc5ff';
    const y = token.y + radius + 26; // just below the name label
    ctx.strokeText(trueText, token.x, y);
    ctx.fillText(trueText, token.x, y);
  } else {
    ctx.fillStyle = '#ffb74d';
    const y = token.y + radius + 38; // one line below where the real-AC readout would sit
    ctx.strokeText(knownText, token.x, y);
    ctx.fillText(knownText, token.x, y);
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

// A compact abbreviated row above the token (3-letter codes, e.g. "POI PRO")
// - full names are readable in the token card/sidebar; the canvas just needs
// an at-a-glance "something's active" cue given how little space there is at
// typical token sizes.
function drawConditionsRow(ctx, token, radius) {
  if (!token.conditions || !token.conditions.length) return;
  const label = token.conditions.map((c) => c.slice(0, 3).toUpperCase()).join(' ');
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffca28';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  const y = token.y - radius - 18;
  ctx.strokeText(label, token.x, y);
  ctx.fillText(label, token.x, y);
}
