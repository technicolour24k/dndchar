// Layered DOM/SVG map rendering - replaces the old canvas map draw
// (map.js drawMap / vision.js renderVisionMaskedMap). The map itself is now a
// stack of DOM elements sitting BEHIND the transparent canvas (which keeps
// tokens/markers/drag ghosts and all pointer interaction, unchanged):
//
//   #mapLayers (scaled to zoom via CSS transform, pointer-events: none)
//     #mapBackdrop      solid black (player: "unseen") / #222 (GM: no-image fallback)
//     #mapLayerGray     <img>/<video>, CSS filter: grayscale(1), clipped to the
//                       union of the viewing player's gray-band vision circles
//     #mapLayerColor    <img>/<video>, unfiltered, clipped to the union of the
//                       player's color-band circles (GM: unclipped, no gray layer)
//     #visionClipSvg    render-nothing <clipPath> defs supplying the circles
//   #canvas             everything interactive, exactly as before
//
// Why: the old approach re-drew the full map image N+1 times per render()
// (once per vision circle, grayscale-filtered) at native map resolution. That
// was tolerable event-driven, but becomes a continuous per-frame cost the
// moment the map source can animate. With DOM layers the browser's compositor
// does the per-frame work natively - a looping <video> map animates with zero
// JS render loop, and vision changes are a handful of SVG attribute writes.
//
// Layer order does the three-band compositing for free: color sits above
// gray, so inside the color clip you see full color; between color and gray
// radius only the gray layer shows; beyond both, the black backdrop.
// Multiple <circle>s inside one <clipPath> union automatically per the SVG
// spec - "vision is the union of all my tokens' circles" needs no math here.
//
// Coordinates: the media layers are laid out at the map's NATIVE pixel size
// inside #mapLayers, which carries the zoom as transform: scale(z). clip-path
// applies in the element's local (pre-transform) space, so all circle
// cx/cy/r values are plain unzoomed map pixels - same space the canvas
// drawing and vision math already use.

const VIDEO_EXT_RE = /\.(mp4|webm|m4v|ogv)(?:[?#]|$)/i;

// Inferred from the URL's extension - map.imageUrl stays a plain string, no
// new mapType field needed. An extensionless external video URL won't be
// detected; uploads always keep their extension so the in-app flow is safe.
export function isVideoUrl(url) {
  return VIDEO_EXT_RE.test(url || '');
}

const layersEl = document.getElementById('mapLayers');
const backdropEl = document.getElementById('mapBackdrop');
const grayLayerEl = document.getElementById('mapLayerGray');
const colorLayerEl = document.getElementById('mapLayerColor');
const grayClipEl = document.getElementById('vttGrayClip');
const colorClipEl = document.getElementById('vttColorClip');

const SVG_NS = 'http://www.w3.org/2000/svg';

function createMediaElement(url) {
  if (isVideoUrl(url)) {
    const video = document.createElement('video');
    // muted is mandatory: it's what lets autoplay through the browser's
    // gesture requirement, and it's the deliberate policy that any audio
    // track inside an uploaded map video is inert by design - ambient music
    // (the two <audio> elements in index.html) is the only sound system,
    // and it knows nothing about other audio sources.
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true; // tablets/iOS: never go fullscreen on play
    video.src = url;
    video.play().catch(() => {}); // muted autoplay is allowed; failure just means a paused first frame
    return video;
  }
  const img = document.createElement('img');
  img.src = url;
  return img;
}

// Pause + drop the source BEFORE removing, or a detached playing <video>
// keeps decoding invisibly - the classic slow leak from repeated map
// switches within a session. (For <img> the remove alone is fine.)
function destroyMediaElement(el) {
  if (el.tagName === 'VIDEO') {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
  el.remove();
}

// One media child per layer container, swapped only when the URL actually
// changes - render() calls this on every state change, so an unchanged map
// must be a cheap no-op that never restarts a playing video. Passing a null
// url tears the layer down entirely (used for the GM's absent gray layer and
// for players whose vision currently has no gray band - a display:none video
// would keep decoding, so it's removed, not hidden).
function ensureMedia(container, url) {
  if (container.__mediaUrl === (url || null)) return;
  const existing = container.firstElementChild;
  if (existing) destroyMediaElement(existing);
  container.__mediaUrl = url || null;
  if (url) container.appendChild(createMediaElement(url));
}

// Reuse existing <circle> children where possible - on token:move this is
// just cx/cy attribute writes on circles that already exist.
function syncClipCircles(clipEl, entries) {
  while (clipEl.children.length > entries.length) clipEl.lastElementChild.remove();
  while (clipEl.children.length < entries.length) {
    clipEl.appendChild(document.createElementNS(SVG_NS, 'circle'));
  }
  for (let i = 0; i < entries.length; i++) {
    const circle = clipEl.children[i];
    circle.setAttribute('cx', entries[i].x);
    circle.setAttribute('cy', entries[i].y);
    circle.setAttribute('r', entries[i].r);
  }
}

// The no-map state (and leaving a room): hide everything and release any
// playing video.
export function hideMapLayers() {
  layersEl.style.display = 'none';
  ensureMedia(colorLayerEl, null);
  ensureMedia(grayLayerEl, null);
}

// Called from render() every time - must be idempotent and cheap when
// nothing relevant changed. `radii` is computeVisionRadii()'s output for the
// viewing player's owned tokens (null for the GM, whose map is unclipped).
export function updateMapLayers({ map, role, radii, zoomLevel }) {
  layersEl.style.display = '';
  layersEl.style.width = `${map.widthPx}px`;
  layersEl.style.height = `${map.heightPx}px`;
  layersEl.style.transform = `scale(${zoomLevel})`;

  const url = map.imageUrl || null;

  if (role === 'gm') {
    // GM: single unclipped color layer, no gray layer, no clip geometry.
    // #222 backdrop matches the old drawMap() no-image fallback fill.
    backdropEl.style.background = '#222';
    colorLayerEl.style.clipPath = 'none';
    ensureMedia(colorLayerEl, url);
    grayLayerEl.style.display = 'none';
    ensureMedia(grayLayerEl, null);
    return;
  }

  backdropEl.style.background = '#000';
  colorLayerEl.style.clipPath = ''; // fall back to the stylesheet's url(#vttColorClip)
  ensureMedia(colorLayerEl, url);

  // All brightness/darkvision/truesight logic already lives in
  // getTokenVisionRadii() - by the time radii reach here they're plain
  // per-token color/gray pixel radii, so e.g. "bright" mode simply arrives
  // as grayRadius === colorRadius and the gray layer drops out below.
  const colorEntries = [];
  const grayEntries = [];
  for (const { token, colorRadius, grayRadius } of radii) {
    if (colorRadius > 0) colorEntries.push({ x: token.x, y: token.y, r: colorRadius });
    // The gray layer only matters where it extends beyond the color circle -
    // inside colorRadius the color layer paints over it anyway.
    if (grayRadius > colorRadius) grayEntries.push({ x: token.x, y: token.y, r: grayRadius });
  }
  // An empty <clipPath> clips everything away - a player with no owned
  // tokens (or no vision) correctly sees only the black backdrop.
  syncClipCircles(colorClipEl, colorEntries);
  syncClipCircles(grayClipEl, grayEntries);

  const needGray = grayEntries.length > 0;
  grayLayerEl.style.display = needGray ? '' : 'none';
  // Torn down (not just hidden) when unused so a video map isn't decoding
  // twice for nothing. Tradeoff: when a gray band reappears, its video
  // restarts from 0 while the color layer is mid-loop - two <video> elements
  // on the same file are independent decodes and were never frame-locked
  // anyway; ambient loops don't need tight sync (same stance as reconnect).
  ensureMedia(grayLayerEl, needGray ? url : null);
}
