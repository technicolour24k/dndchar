// Radius-based per-token vision, no wall/line-of-sight geometry (spec Section 4).
// Bands, in feet-from-token: 0..visionNormalFt = full color, that..visionDarkFt
// = grayscale, beyond = black. `map.brightness` shifts the calculation, per 5e
// RAW's darkvision text: "you can see in dim light within [range] as if it
// were bright light, and in darkness as if it were dim light. You can't
// discern color in darkness, only shades of gray."
//   bright: color out to BRIGHT_LIGHT_RADIUS_FT (or the token's own
//           visionNormalFt if that's larger), darkvision irrelevant, no gray
//           band. 5e doesn't actually cap unaided daylight sight at a fixed
//           radius the way it does darkvision - visionNormalFt is a POC
//           fog-of-war convenience, not a RAW distance, so bright light
//           (where fog-of-war typically isn't wanted at all) uses a much
//           larger flat radius instead of the same short indoor-scale number
//           dim/dark use, where vision actually is the meaningful constraint.
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
const BRIGHT_LIGHT_RADIUS_FT = 150;

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
    colorRadius = Math.max(normalFt, BRIGHT_LIGHT_RADIUS_FT) * pxPerFoot;
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

// The vision mask itself is no longer rendered here. The old
// renderVisionMaskedMap() drew the full map image once per vision circle
// (grayscale pass + color pass) into the canvas - replaced by DOM layers
// with SVG clip-paths (see render/mapLayers.js), which consume the radii
// computed above unchanged. This module keeps the vision *math*: radii and
// point-reveal tests are still used for token visibility filtering, the
// sidebar's "other tokens in view" list, and the clip-circle geometry.
