// Radius-based per-token vision, no wall/line-of-sight geometry (spec Section 4).
// Bands, in feet-from-token: 0..visionNormalFt = full color, that..visionDarkFt
// = grayscale, beyond = black. `map.brightness` shifts the calculation:
//   bright: color out to visionNormalFt, darkvision irrelevant, no gray band.
//   dim:    everyone gets grayscale out to max(normal, dark), no color band.
//   dark:   normal default — color/gray/black bands as above.
export function getTokenVisionRadii(token, brightness, pxPerFoot) {
  const normalFt = token.visionNormalFt || 0;
  const darkFt = token.visionDarkFt || 0;

  if (brightness === 'dim') {
    const maxFt = Math.max(normalFt, darkFt);
    return { colorRadius: 0, grayRadius: maxFt * pxPerFoot };
  }

  if (brightness === 'bright') {
    const r = normalFt * pxPerFoot;
    return { colorRadius: r, grayRadius: r };
  }

  // 'dark' (default ambient)
  const colorRadius = normalFt * pxPerFoot;
  const grayRadius = darkFt > normalFt ? darkFt * pxPerFoot : colorRadius;
  return { colorRadius, grayRadius };
}

export function computeVisionRadii(ownedTokens, map) {
  const pxPerFoot = map.gridSizePx / 5;
  return ownedTokens.map((token) => ({
    token,
    ...getTokenVisionRadii(token, map.brightness, pxPerFoot),
  }));
}

// A point (e.g. another token's position) is revealed to the player if it
// falls within ANY owned token's reveal radius (gray radius is always >=
// color radius, so it's the outer bound of what's revealed at all).
export function isPointRevealed(x, y, radii) {
  return radii.some(({ token, grayRadius }) => {
    if (grayRadius <= 0) return false;
    const dx = x - token.x;
    const dy = y - token.y;
    return dx * dx + dy * dy <= grayRadius * grayRadius;
  });
}

// Renders the vision-masked map for a player: black canvas, with each owned
// token's gray-band circle drawn first (grayscale map clipped to that
// circle), then each token's color-band circle drawn on top (full-color map
// clipped to the smaller circle). Doing this in two full passes across all
// tokens — rather than per-token — is what makes multi-token union correct:
// a pixel ends up in color if ANY token's color radius covers it, regardless
// of draw order or overlap with another token's gray radius.
export function renderVisionMaskedMap(ctx, mapImage, radii, map) {
  const { widthPx, heightPx } = map;

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, widthPx, heightPx);

  if (!mapImage || !mapImage.complete || !mapImage.naturalWidth) {
    ctx.restore();
    return;
  }

  for (const { token, grayRadius } of radii) {
    if (grayRadius <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.arc(token.x, token.y, grayRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.filter = 'grayscale(1)';
    ctx.drawImage(mapImage, 0, 0, widthPx, heightPx);
    ctx.restore();
  }

  for (const { token, colorRadius } of radii) {
    if (colorRadius <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.arc(token.x, token.y, colorRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(mapImage, 0, 0, widthPx, heightPx);
    ctx.restore();
  }

  ctx.restore();
}
