// Radius-based per-token vision, no wall/line-of-sight geometry (spec Section 4).
// Bands, in feet-from-token: 0..visionNormalFt = full color, that..visionDarkFt
// = grayscale, beyond = black. `map.brightness` shifts the calculation, per 5e
// RAW's darkvision text: "you can see in dim light within [range] as if it
// were bright light, and in darkness as if it were dim light. You can't
// discern color in darkness, only shades of gray."
//   bright: color out to visionNormalFt, darkvision irrelevant, no gray band.
//   dim:    darkvision sees dim light AS bright light - full color out to
//           visionDarkFt for tokens that have it. Tokens without darkvision
//           still get grayscale out to visionNormalFt (a POC simplification
//           of "lightly obscured" rather than true blindness/disadvantage).
//   dark:   normal default - color/gray/black bands as above. Darkvision
//           never restores color in true darkness (RAW is explicit on this),
//           only grayscale out to visionDarkFt.
//
// Truesight and devil's sight both mean "see clearly even in darkness" -
// unlike darkvision they aren't degraded to grayscale by ambient darkness, so
// they simply extend the full-color radius out to their own range regardless
// of `brightness`. This POC doesn't model magical darkness/illusions/
// invisibility separately, so the two are mechanically identical here; kept
// as separate fields on the token for clarity/future distinction.
export function getTokenVisionRadii(token, brightness, pxPerFoot) {
  const normalFt = token.visionNormalFt || 0;
  const darkFt = token.visionDarkFt || 0;
  const specialFt = Math.max(token.visionTrueFt || 0, token.visionDevilFt || 0);

  let colorRadius;
  let grayRadius;

  if (brightness === 'dim') {
    // Darkvision treats dim light as bright light, so it gets full color out
    // to its own range (0 if the token has none) - not just grayscale like
    // the original POC simplification had it.
    colorRadius = darkFt * pxPerFoot;
    grayRadius = Math.max(normalFt, darkFt) * pxPerFoot;
  } else if (brightness === 'bright') {
    colorRadius = normalFt * pxPerFoot;
    grayRadius = colorRadius;
  } else {
    // 'dark' (default ambient)
    colorRadius = normalFt * pxPerFoot;
    grayRadius = darkFt > normalFt ? darkFt * pxPerFoot : colorRadius;
  }

  const specialRadius = specialFt * pxPerFoot;
  colorRadius = Math.max(colorRadius, specialRadius);
  grayRadius = Math.max(grayRadius, specialRadius);

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
// tokens - rather than per-token - is what makes multi-token union correct:
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
