import { drawMap } from './render/map.js';
import { drawTokens } from './render/tokens.js';
import { computeVisionRadii, isPointRevealed, renderVisionMaskedMap } from './render/vision.js';
import { drawMovementRange } from './render/movement.js';
import { drawMarkers } from './render/markers.js';
import { drawTargetRings } from './render/targeting.js';
import { getTokensInShape } from './render/shapeGeometry.js';

// Mirrors TOKEN_LEVEL_STAT_FIELDS in vtt/server/handlers/token.js - these
// token:stat:update fields write directly onto the token, not into
// token.stats (which is otherwise free-form combat stats).
const TOKEN_LEVEL_STAT_FIELDS = new Set([
  'condition',
  'imageUrl',
  'visionNormalFt',
  'visionDarkFt',
  'visionTrueFt',
  'visionDevilFt',
  'speedFt',
  'speedRemainingFt',
  'characterId',
  'ac',
  'saves',
  'actions',
  'spellSlots',
  'preparedSpells',
]);

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const sidebarEl = document.getElementById('sidebar');
const loginError = document.getElementById('loginError');
const nameInput = document.getElementById('nameInput');
const joinCodeInput = document.getElementById('joinCodeInput');

// Identity from the main app's account system, if we arrived via the "VTT"
// nav link (/vtt redirects here with ?playerId=&playerName= for the signed-in
// user). Falls back to manual name entry + a per-browser random id when the
// page is opened standalone, so the tool still works outside the main app.
const accountParams = new URLSearchParams(location.search);
const accountPlayerId = accountParams.get('playerId');
const accountPlayerName = accountParams.get('playerName');

let ws = null;
let role = null; // 'gm' | 'player'
let playerId = null;
let playerName = null;
let sessionId = null;
let session = null; // local mirror of the (already role-filtered) session state
let dragState = null; // { tokenId, originX, originY, x, y } - visual ghost only, see canvas handlers
let currentRenderedTokens = []; // whichever token list render() last actually drew, for hit-testing
let zoomLevel = 1; // CSS-only scale of the canvas; the backing pixel buffer stays at native map size
let currentTargetTokenIds = []; // tokens highlighted by the most recent target:select/target:clear seen
let shapeDrag = null; // { config, originX, originY, currentX, currentY } while dragging a cone/cube's direction+length

const imageCache = new Map();

function getImage(url) {
  if (!url) return null;
  let img = imageCache.get(url);
  if (!img) {
    img = new Image();
    img.onload = () => render();
    img.src = url;
    imageCache.set(url, img);
  }
  return img;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function getPersistentPlayerId() {
  if (accountPlayerId) return accountPlayerId;
  let id = localStorage.getItem('vtt_playerId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('vtt_playerId', id);
  }
  return id;
}

function getPersistentPlayerName() {
  if (accountPlayerName) return accountPlayerName;
  return nameInput.value.trim();
}

// ---------------------------------------------------------------------------
// Connection & join
// ---------------------------------------------------------------------------

function connect(joinPayload) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/vtt-ws`);

  ws.addEventListener('open', () => ws.send(JSON.stringify(joinPayload)));
  ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
  ws.addEventListener('close', () => {
    // Only auto-retry after a successful join - a bad room code shouldn't loop.
    if (session) setTimeout(() => connect(joinPayload), 1500);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'join:error':
      if (msg.reason === 'session_not_found') loginError.textContent = 'Room not found.';
      else if (msg.reason === 'gm_already_claimed') loginError.textContent = 'This room already has a GM connected.';
      else loginError.textContent = msg.reason;
      session = null;
      if (ws) ws.close();
      break;

    case 'state:full':
      session = msg.session;
      session.markers = session.markers || {}; // guard against a session created before markers existed
      showApp();
      // render() first - it computes currentRenderedTokens (vision-filtered
      // for a player), which renderSidebar()'s "other tokens in view" list
      // now reads from; the reverse order would show a stale/empty list
      // until the next unrelated event happened to re-render.
      render();
      renderSidebar();
      if (role === 'player') startCharacterSync();
      break;

    case 'player:joined':
      if (session) {
        session.players[msg.playerId] = {
          id: msg.playerId,
          name: msg.playerName,
          tokenIds: session.players[msg.playerId]?.tokenIds || [],
          connected: true,
        };
      }
      renderSidebar();
      break;

    case 'player:left':
      if (session && session.players[msg.playerId]) {
        session.players[msg.playerId].connected = false;
      }
      renderSidebar();
      break;

    case 'map:set':
      session.map = msg.map;
      render();
      renderSidebar();
      break;

    case 'token:add':
      session.tokens[msg.token.id] = msg.token;
      render();
      renderSidebar();
      break;

    case 'token:remove':
      delete session.tokens[msg.tokenId];
      render();
      renderSidebar();
      break;

    case 'token:move': {
      const t = session.tokens[msg.tokenId];
      if (t) { t.x = msg.x; t.y = msg.y; }
      if (dragState && dragState.tokenId === msg.tokenId) dragState = null;
      render();
      // A move can push a token into or out of vision range, which changes
      // the player sidebar's "other tokens in view" list - this was
      // previously missing, so that list only ever updated on unrelated
      // events (a stat change, a new token) rather than on the move itself.
      renderSidebar();
      break;
    }

    case 'token:stat:update': {
      const t = session.tokens[msg.tokenId];
      // value is omitted by the server for filtered fields (e.g. an enemy's
      // hp, per the server-side comment in handlers/token.js) - nothing to
      // apply in that case, since we were never sent the number.
      if (t && msg.value !== undefined) {
        if (TOKEN_LEVEL_STAT_FIELDS.has(msg.stat)) t[msg.stat] = msg.value;
        else { t.stats = t.stats || {}; t.stats[msg.stat] = msg.value; }
      }
      render();
      renderSidebar();
      break;
    }

    case 'token:hidden:toggle': {
      const t = session.tokens[msg.tokenId];
      if (t) t.hidden = msg.hidden;
      render();
      renderSidebar();
      break;
    }

    case 'token:stat:update:error':
      // Server rejected a write our own UI shouldn't have offered in the
      // first place - surface it without tearing down the session.
      console.warn(`token:stat:update rejected for ${msg.stat} on ${msg.tokenId}: ${msg.reason}`);
      break;

    case 'target:select':
      currentTargetTokenIds = msg.targetTokenIds || [];
      render();
      break;

    case 'target:clear':
      currentTargetTokenIds = [];
      render();
      break;

    case 'marker:add':
      session.markers[msg.marker.id] = msg.marker;
      render();
      renderSidebar();
      break;

    case 'marker:remove':
      delete session.markers[msg.markerId];
      render();
      renderSidebar();
      break;

    case 'marker:visibility:toggle': {
      const m = session.markers[msg.markerId];
      if (m) m.visibleToAll = msg.visibleToAll;
      renderSidebar();
      break;
    }

    default:
      break;
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').classList.add('active');
}

const identityKnown = document.getElementById('identityKnown');
const identityUnknown = document.getElementById('identityUnknown');
const identityName = document.getElementById('identityName');

if (accountPlayerName) {
  identityKnown.style.display = 'block';
  identityUnknown.style.display = 'none';
  identityName.textContent = accountPlayerName;
} else {
  nameInput.value = localStorage.getItem('vtt_playerName') || '';
}

document.getElementById('createRoomBtn').addEventListener('click', async () => {
  const name = getPersistentPlayerName() || 'GM';
  if (!accountPlayerName) localStorage.setItem('vtt_playerName', name);
  loginError.textContent = '';
  try {
    const res = await fetch('/vtt/api/session', { method: 'POST' });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    sessionId = data.sessionId;
    role = 'gm';
    playerName = name;
    connect({ type: 'join', sessionId, role: 'gm', playerId: accountPlayerId, playerName: name });
  } catch {
    loginError.textContent = 'Could not create room - is the server running?';
  }
});

document.getElementById('joinRoomBtn').addEventListener('click', () => {
  const name = getPersistentPlayerName();
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!name || !code) {
    loginError.textContent = 'Enter your name and a room code.';
    return;
  }
  if (!accountPlayerName) localStorage.setItem('vtt_playerName', name);
  loginError.textContent = '';
  sessionId = code;
  role = 'player';
  playerId = getPersistentPlayerId();
  playerName = name;
  connect({ type: 'join', sessionId, role: 'player', playerId, playerName: name });
});

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------

function render() {
  if (!session || !session.map) {
    canvas.style.width = '';
    canvas.style.height = '';
    canvas.width = 800;
    canvas.height = 500;
    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#666';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      role === 'gm' ? 'Upload and set a map to begin' : 'Waiting for the GM to set a map…',
      canvas.width / 2,
      canvas.height / 2,
    );
    currentRenderedTokens = [];
    return;
  }

  const map = session.map;
  canvas.width = map.widthPx;
  canvas.height = map.heightPx;
  canvas.style.width = `${map.widthPx * zoomLevel}px`;
  canvas.style.height = `${map.heightPx * zoomLevel}px`;
  const mapImage = getImage(map.imageUrl);
  const allTokens = Object.values(session.tokens);

  // session.markers is already server-filtered to whatever this client is
  // allowed to see (own markers + anything the GM has toggled visible-to-all)
  // - no client-side owner/vision gating needed, unlike tokens.
  const visibleMarkers = Object.values(session.markers || {});

  if (role === 'gm') {
    drawMap(ctx, mapImage, map);
    drawMovementRange(ctx, allTokens, map.gridSizePx);
    drawMarkers(ctx, visibleMarkers, map.gridSizePx);
    drawTokens(ctx, allTokens, map.gridSizePx, getImage);
    drawTargetRings(ctx, currentTargetTokenIds, allTokens, map.gridSizePx);
    currentRenderedTokens = allTokens;
  } else {
    const ownedTokens = allTokens.filter((t) => t.ownerId === playerId);
    const radii = computeVisionRadii(ownedTokens, map);
    renderVisionMaskedMap(ctx, mapImage, radii, map);
    const visibleTokens = allTokens.filter((t) => isPointRevealed(t.x, t.y, radii));
    drawMovementRange(ctx, visibleTokens, map.gridSizePx);
    drawMarkers(ctx, visibleMarkers, map.gridSizePx);
    drawTokens(ctx, visibleTokens, map.gridSizePx, getImage);
    drawTargetRings(ctx, currentTargetTokenIds, visibleTokens, map.gridSizePx);
    currentRenderedTokens = visibleTokens;
  }

  if (shapeDrag) {
    drawMarkers(ctx, [markerFromShapeDrag(shapeDrag)], map.gridSizePx);
  }

  if (dragState) {
    const radius = map.gridSizePx * 0.4;
    const pxPerFoot = map.gridSizePx / 5;
    const distanceFt = Math.round(Math.hypot(dragState.x - dragState.originX, dragState.y - dragState.originY) / pxPerFoot);
    const token = session.tokens[dragState.tokenId];
    const remainingFt = token ? token.speedRemainingFt ?? token.speedFt ?? null : null;
    const overBudget = remainingFt !== null && distanceFt > remainingFt;

    ctx.save();
    ctx.beginPath();
    ctx.arc(dragState.x, dragState.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = overBudget ? 'rgba(229,57,53,0.9)' : 'rgba(255,255,255,0.85)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.stroke();

    // A line back to the token's actual starting point makes "distance
    // between these two points" legible even after dragging far from it.
    ctx.beginPath();
    ctx.moveTo(dragState.originX, dragState.originY);
    ctx.lineTo(dragState.x, dragState.y);
    ctx.strokeStyle = overBudget ? 'rgba(229,57,53,0.6)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    const label = remainingFt !== null ? `${distanceFt} ft (of ${remainingFt} ft)` : `${distanceFt} ft`;
    ctx.save();
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = overBudget ? '#ff8a80' : '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText(label, dragState.x, dragState.y - radius - 10);
    ctx.fillText(label, dragState.x, dragState.y - radius - 10);
    ctx.restore();
  }
}

function canvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

function hitTestToken(x, y) {
  if (!session || !session.map) return null;
  const radius = session.map.gridSizePx * 0.4;
  for (const token of currentRenderedTokens) {
    const dx = x - token.x;
    const dy = y - token.y;
    if (dx * dx + dy * dy <= radius * radius) return token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Marker placement - "click the map to place your marker" mode, armed by the
// Place on Map button in either sidebar (see wireGmSidebar/wirePlayerSidebar).
// ---------------------------------------------------------------------------

const markerPlacementBanner = document.getElementById('markerPlacementBanner');
let pendingMarkerPlacement = null; // { radiusFt, color, label } or null while armed

function armMarkerPlacement(config) {
  disarmActionTargeting(); // only one click-the-map mode armed at a time
  pendingMarkerPlacement = config;
  markerPlacementBanner.classList.add('visible');
  canvas.style.cursor = 'crosshair';
}

function disarmMarkerPlacement() {
  pendingMarkerPlacement = null;
  markerPlacementBanner.classList.remove('visible');
  canvas.style.cursor = '';
}

document.getElementById('markerPlacementCancelBtn').addEventListener('click', disarmMarkerPlacement);

// ---------------------------------------------------------------------------
// Action targeting (Section 3) - click a weapon/spell action in the mini
// sheet, then click a token on the map to resolve it against. Same
// arm/disarm-banner pattern as marker placement. Damage is rolled
// client-side per the phase-2 spec's explicit recommendation (the character
// sheet's math engine already runs client-side; porting it server-side is a
// bigger lift the trust level at this scale doesn't need).
// ---------------------------------------------------------------------------

const actionTargetBanner = document.getElementById('actionTargetBanner');
const actionTargetBannerText = document.getElementById('actionTargetBannerText');
let pendingActionTarget = null; // { sourceTokenId, action } or null while armed

function armActionTargeting(sourceTokenId, action) {
  disarmMarkerPlacement();
  pendingActionTarget = { sourceTokenId, action };
  actionTargetBannerText.textContent = `Click a token to attack with ${action.name}`;
  actionTargetBanner.classList.add('visible');
  canvas.style.cursor = 'crosshair';
}

function disarmActionTargeting() {
  pendingActionTarget = null;
  actionTargetBanner.classList.remove('visible');
  canvas.style.cursor = '';
}

document.getElementById('actionTargetCancelBtn').addEventListener('click', disarmActionTargeting);

// Minimal 'XdY+Z' dice roller - the vanilla VTT client has no build step and
// can't import $lib/rules/dnd5e's rollDiceExpression (SvelteKit-only
// aliases/imports), so this is a small standalone equivalent covering just
// the "roll a weapon's damage dice" case the mini-sheet needs.
function rollDamageDice(damageRolls, damageBonus) {
  let total = Number(damageBonus) || 0;
  const rolls = [];
  for (const term of String(damageRolls || '').split(/\s*\+\s*/)) {
    const match = term.trim().match(/^(\d*)d(\d+)$/i);
    if (!match) continue;
    const count = Math.max(1, Number(match[1]) || 1);
    const sides = Math.max(1, Number(match[2]) || 1);
    for (let i = 0; i < count; i++) {
      const roll = Math.floor(Math.random() * sides) + 1;
      rolls.push(roll);
      total += roll;
    }
  }
  return { total: Math.max(0, total), rolls };
}

// Clicking a token you can move drags the token; clicking empty space (or a
// token you don't control) pans the map instead - same click-and-drag
// gesture, disambiguated by what's under the cursor.
let panState = null; // { startClientX, startClientY, startScrollLeft, startScrollTop }

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault(); // avoid native text-selection/drag-ghost while panning

  if (pendingActionTarget) {
    const { x, y } = canvasCoords(e);
    const target = hitTestToken(x, y);
    const { sourceTokenId, action } = pendingActionTarget;
    disarmActionTargeting();
    if (!target) return;

    send({ type: 'target:select', sourceTokenId, targetTokenIds: [target.id] });

    const { total, rolls } = rollDamageDice(action.damageRolls, action.damageBonus);
    send({ type: 'token:stat:update', tokenId: target.id, stat: 'hp', delta: -total });
    alert(`${action.name} hits ${target.name} for ${total} damage (${rolls.join(' + ') || total}).`);
    return;
  }

  if (pendingMarkerPlacement) {
    const { x, y } = canvasCoords(e);
    const config = pendingMarkerPlacement;

    if (config.shape === 'cone' || config.shape === 'cube') {
      // Directional shapes need a second point to set facing/length - start
      // a drag instead of placing immediately. Confirmed on mouseup below.
      shapeDrag = { config, originX: x, originY: y, currentX: x, currentY: y };
      render();
      return;
    }

    placeMarker({
      shape: config.shape,
      x,
      y,
      radiusFt: config.radiusFt,
      color: config.color,
      label: config.label,
    });
    disarmMarkerPlacement();
    return;
  }

  const { x, y } = canvasCoords(e);
  const token = hitTestToken(x, y);
  const canDragToken = token && (role === 'gm' || token.ownerId === playerId);

  if (canDragToken) {
    // originX/originY are the token's actual pre-drag position - that's the
    // true distance the token will travel, not the (possibly off-center)
    // point clicked within its radius. x/y track the live cursor for the
    // ghost circle.
    dragState = { tokenId: token.id, originX: token.x, originY: token.y, x, y };
  } else {
    panState = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScrollLeft: mapWrap.scrollLeft,
      startScrollTop: mapWrap.scrollTop,
    };
  }
  canvas.classList.add('dragging');
});

// window-level (not canvas-level) so a fast drag that leaves the canvas
// bounds - easy to do while panning a zoomed-out map - keeps tracking.
window.addEventListener('mousemove', (e) => {
  if (shapeDrag) {
    const { x, y } = canvasCoords(e);
    shapeDrag.currentX = x;
    shapeDrag.currentY = y;
    render();
  } else if (dragState) {
    const { x, y } = canvasCoords(e);
    dragState.x = x;
    dragState.y = y;
    render();
  } else if (panState) {
    mapWrap.scrollLeft = panState.startScrollLeft - (e.clientX - panState.startClientX);
    mapWrap.scrollTop = panState.startScrollTop - (e.clientY - panState.startClientY);
  }
});

// Turns a shapeDrag's origin+current cursor position into the marker's
// facing (angleDeg) and length (lengthFt, rounded to the nearest 5ft like
// the rest of the app's distance readouts) - shared by the live preview
// (render()) and the final placement on mouseup.
function markerFromShapeDrag(drag) {
  const pxPerFoot = (session?.map?.gridSizePx || 50) / 5;
  const dx = drag.currentX - drag.originX;
  const dy = drag.currentY - drag.originY;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const lengthFt = Math.max(5, Math.round(Math.hypot(dx, dy) / pxPerFoot / 5) * 5);
  return {
    shape: drag.config.shape,
    x: drag.originX,
    y: drag.originY,
    angleDeg,
    lengthFt,
    widthFt: drag.config.widthFt,
    coneAngleDeg: drag.config.coneAngleDeg,
    color: drag.config.color,
    label: drag.config.label,
  };
}

// Sends marker:add, then auto-selects whichever tokens the placed shape
// catches (Section 4b's second bullet) - removes the need to manually
// multi-select targets for an AoE, which is exactly the friction this
// feature exists to cut. Circle/sphere and cone/cube all go through this one
// path; there's nothing shape-specific about the auto-targeting step itself.
function placeMarker(marker) {
  const id = `marker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const fullMarker = { id, ownerId: role === 'player' ? playerId : null, ...marker };
  send({ type: 'marker:add', marker: fullMarker });

  const pxPerFoot = (session?.map?.gridSizePx || 50) / 5;
  const caughtTokens = getTokensInShape(fullMarker, Object.values(session.tokens), pxPerFoot);
  if (caughtTokens.length) {
    send({ type: 'target:select', sourceTokenId: null, targetTokenIds: caughtTokens.map((t) => t.id) });
  }
}

window.addEventListener('mouseup', (e) => {
  if (shapeDrag) {
    placeMarker(markerFromShapeDrag(shapeDrag));
    shapeDrag = null;
    disarmMarkerPlacement();
    render();
    return;
  }
  if (dragState) {
    const { x, y } = canvasCoords(e);
    const { tokenId } = dragState;
    send({ type: 'token:move', tokenId, x, y });
    // dragState itself is cleared once the server echoes the move back (see
    // handleMessage's token:move case) - the token doesn't actually move on
    // screen until then, per the "server is the only writer" rule.
  }
  panState = null;
  canvas.classList.remove('dragging');
});

// ---------------------------------------------------------------------------
// Zoom - pure CSS scale of the canvas (backing pixel buffer stays at the
// map's native size, see render()). canvasCoords() already derives its scale
// factor from getBoundingClientRect(), so drag/hit-testing need no changes.
// ---------------------------------------------------------------------------

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const mapWrap = document.getElementById('mapWrap');
const zoomResetBtn = document.getElementById('zoomResetBtn');

function setZoom(nextZoom, anchor) {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
  if (clamped === zoomLevel) return;

  const rect = mapWrap.getBoundingClientRect();
  const anchorX = anchor?.clientX ?? rect.left + rect.width / 2;
  const anchorY = anchor?.clientY ?? rect.top + rect.height / 2;
  // Point under the anchor, in unzoomed map-space, before we change zoomLevel.
  const mapX = (mapWrap.scrollLeft + (anchorX - rect.left)) / zoomLevel;
  const mapY = (mapWrap.scrollTop + (anchorY - rect.top)) / zoomLevel;

  zoomLevel = clamped;
  render();

  // Re-anchor scroll so the same map point stays under the cursor/center.
  mapWrap.scrollLeft = mapX * zoomLevel - (anchorX - rect.left);
  mapWrap.scrollTop = mapY * zoomLevel - (anchorY - rect.top);

  zoomResetBtn.textContent = `${Math.round(zoomLevel * 100)}%`;
}

document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(zoomLevel * 1.25));
document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(zoomLevel / 1.25));
zoomResetBtn.addEventListener('click', () => setZoom(1));

// Ctrl/Cmd+wheel to zoom (matches the Figma/Google Maps convention, and is
// what trackpad pinch-to-zoom sends) - plain wheel still scrolls/pans.
mapWrap.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoomLevel * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { clientX: e.clientX, clientY: e.clientY });
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Image upload (map + token art) - POST /upload, returns a URL to use
// ---------------------------------------------------------------------------

async function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch('/vtt/api/upload', { method: 'POST', body: formData });
  if (!res.ok) throw new Error('upload_failed');
  const data = await res.json();
  return data.url;
}

// ---------------------------------------------------------------------------
// Token image picker - browse the bundled art library (fetched once and
// filtered client-side; ~1400 entries is small enough for that) or upload a
// custom image, same as before. Used both when adding a new token and when
// changing an existing one's art, via the onSelect callback: the caller
// decides whether that means "fill in a form field" or "apply immediately".
// ---------------------------------------------------------------------------

const imagePickerModal = document.getElementById('imagePickerModal');
const pickerTabLibraryBtn = document.getElementById('pickerTabLibraryBtn');
const pickerTabUploadBtn = document.getElementById('pickerTabUploadBtn');
const pickerLibraryPane = document.getElementById('pickerLibraryPane');
const pickerUploadPane = document.getElementById('pickerUploadPane');
const pickerSourceSelect = document.getElementById('pickerSourceSelect');
const pickerCategorySelect = document.getElementById('pickerCategorySelect');
const pickerSearchInput = document.getElementById('pickerSearchInput');
const pickerStatus = document.getElementById('pickerStatus');
const pickerResults = document.getElementById('pickerResults');
const pickerFileInput = document.getElementById('pickerFileInput');
const pickerUploadThumb = document.getElementById('pickerUploadThumb');

const PICKER_RESULT_LIMIT = 60;
let tokenLibraryIndex = null; // fetched lazily, cached for the session
let pickerOnSelect = null;
let pickerSearchDebounce = null;

async function ensureTokenLibraryIndex() {
  if (tokenLibraryIndex) return tokenLibraryIndex;
  const res = await fetch('/vtt/api/token-library');
  const data = await res.json();
  tokenLibraryIndex = data.tokens || [];

  const sources = [...new Set(tokenLibraryIndex.map((t) => t.source))].sort();
  pickerSourceSelect.innerHTML =
    '<option value="">All sources</option>' +
    sources.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

  const categories = [...new Set(tokenLibraryIndex.map((t) => t.category))].sort();
  pickerCategorySelect.innerHTML =
    '<option value="">All categories</option>' +
    categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

  return tokenLibraryIndex;
}

function libraryImageUrl(entry) {
  return '/vtt/api/token-library/' + entry.path.split('/').map(encodeURIComponent).join('/');
}

function renderPickerResults() {
  const source = pickerSourceSelect.value;
  const category = pickerCategorySelect.value;
  const search = pickerSearchInput.value.trim().toLowerCase();

  if (!source && !category && !search) {
    pickerResults.innerHTML = '';
    pickerStatus.textContent = 'Pick a source/category or type to search the library…';
    return;
  }

  const matches = (tokenLibraryIndex || []).filter((entry) => {
    if (source && entry.source !== source) return false;
    if (category && entry.category !== category) return false;
    if (search && !entry.friendlyName.toLowerCase().includes(search)) return false;
    return true;
  });

  const shown = matches.slice(0, PICKER_RESULT_LIMIT);
  pickerStatus.textContent =
    matches.length > shown.length
      ? `Showing ${shown.length} of ${matches.length} matches - refine your search to narrow further.`
      : `${matches.length} match${matches.length === 1 ? '' : 'es'}`;

  pickerResults.innerHTML = shown
    .map((entry) => {
      const url = libraryImageUrl(entry);
      const title = `${entry.friendlyName} - ${entry.source}`;
      return `
        <div class="picker-item" data-url="${escapeHtml(url)}" title="${escapeHtml(title)}">
          <img src="${url}" loading="lazy" alt="${escapeHtml(entry.friendlyName)}" />
          <span>${escapeHtml(entry.friendlyName)}</span>
        </div>
      `;
    })
    .join('');
}

function setPickerTab(tab) {
  const isLibrary = tab === 'library';
  pickerTabLibraryBtn.classList.toggle('active', isLibrary);
  pickerTabUploadBtn.classList.toggle('active', !isLibrary);
  pickerLibraryPane.style.display = isLibrary ? '' : 'none';
  pickerUploadPane.style.display = isLibrary ? 'none' : '';
}

async function openImagePicker(onSelect) {
  pickerOnSelect = onSelect;
  pickerSourceSelect.value = '';
  pickerCategorySelect.value = '';
  pickerSearchInput.value = '';
  pickerFileInput.value = '';
  pickerUploadThumb.classList.remove('visible');
  setPickerTab('library');
  imagePickerModal.classList.add('visible');

  pickerStatus.textContent = 'Loading library…';
  await ensureTokenLibraryIndex();
  renderPickerResults();
}

function closeImagePicker() {
  imagePickerModal.classList.remove('visible');
  pickerOnSelect = null;
}

pickerTabLibraryBtn.addEventListener('click', () => setPickerTab('library'));
pickerTabUploadBtn.addEventListener('click', () => setPickerTab('upload'));
pickerSourceSelect.addEventListener('change', renderPickerResults);
pickerCategorySelect.addEventListener('change', renderPickerResults);
pickerSearchInput.addEventListener('input', () => {
  clearTimeout(pickerSearchDebounce);
  pickerSearchDebounce = setTimeout(renderPickerResults, 150);
});

pickerResults.addEventListener('click', (e) => {
  const item = e.target.closest('.picker-item');
  if (!item) return;
  const url = item.dataset.url;
  const onSelect = pickerOnSelect;
  closeImagePicker();
  if (onSelect) onSelect(url);
});

pickerFileInput.addEventListener('change', async () => {
  const file = pickerFileInput.files[0];
  if (!file) return;
  pickerUploadThumb.src = URL.createObjectURL(file);
  pickerUploadThumb.classList.add('visible');
  try {
    const url = await uploadImage(file);
    const onSelect = pickerOnSelect;
    closeImagePicker();
    if (onSelect) onSelect(url);
  } catch {
    alert('Image upload failed.');
  }
});

document.getElementById('pickerCancelBtn').addEventListener('click', closeImagePicker);
imagePickerModal.addEventListener('click', (e) => {
  if (e.target === imagePickerModal) closeImagePicker();
});

// ---------------------------------------------------------------------------
// Character picker (Phase 2, Section 1a) - a player selects one of their own
// characters, pulling live combat stats (Section 1b) into a token created on
// their behalf, instead of manually typing stats into a blank token. Same
// modal-overlay/callback-free pattern as the image picker, simplified since
// there's only one thing this modal ever does (unlike the image picker,
// which is reused from multiple call sites via onSelect).
// ---------------------------------------------------------------------------

const characterPickerModal = document.getElementById('characterPickerModal');
const characterPickerStatus = document.getElementById('characterPickerStatus');
const characterPickerList = document.getElementById('characterPickerList');

async function openCharacterPicker() {
  characterPickerModal.classList.add('visible');
  characterPickerList.innerHTML = '';
  characterPickerStatus.textContent = 'Loading your characters…';
  try {
    const res = await fetch('/vtt/api/characters');
    if (!res.ok) throw new Error('failed');
    const characters = await res.json();
    if (!characters.length) {
      characterPickerStatus.textContent = 'No characters found - create one in the main app first.';
      return;
    }
    characterPickerStatus.textContent = '';
    characterPickerList.innerHTML = characters
      .map((c) => {
        const classSummary = (c.classes || []).map((cls) => `${cls.className} ${cls.level}`).join(' / ') || 'No class';
        return `
          <div class="character-picker-item" data-character-id="${escapeHtml(c.id)}">
            <div class="name">${escapeHtml(c.name)}</div>
            <div class="summary">${escapeHtml(classSummary)} - HP ${c.hpCurrent}/${c.hpMax}</div>
          </div>
        `;
      })
      .join('');
  } catch {
    characterPickerStatus.textContent = 'Could not load characters.';
  }
}

function closeCharacterPicker() {
  characterPickerModal.classList.remove('visible');
}

document.getElementById('characterPickerCancelBtn').addEventListener('click', closeCharacterPicker);
characterPickerModal.addEventListener('click', (e) => {
  if (e.target === characterPickerModal) closeCharacterPicker();
});

characterPickerList.addEventListener('click', async (e) => {
  const item = e.target.closest('.character-picker-item');
  if (!item) return;
  const characterId = item.dataset.characterId;
  const characterName = item.querySelector('.name').textContent;
  closeCharacterPicker();

  const res = await fetch('/vtt/api/characters/' + characterId);
  if (!res.ok) return alert('Could not load that character.');
  const snapshot = await res.json();
  const map = session.map || { widthPx: 800, heightPx: 600 };

  send({
    type: 'token:add',
    token: {
      id: `token-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: characterName,
      type: 'pc',
      ownerId: playerId,
      x: Math.round(map.widthPx / 2),
      y: Math.round(map.heightPx / 2),
      imageUrl: null,
      visionNormalFt: snapshot.vision.normalFt,
      visionDarkFt: snapshot.vision.darkFt,
      visionTrueFt: snapshot.vision.trueFt,
      visionDevilFt: snapshot.vision.devilFt,
      speedFt: snapshot.speedFt,
      speedRemainingFt: snapshot.speedFt,
      hidden: false,
      characterId,
      ac: snapshot.ac,
      saves: snapshot.saves,
      actions: snapshot.actions,
      spellSlots: snapshot.spellSlots,
      preparedSpells: snapshot.preparedSpells,
      stats: { hp: snapshot.hp, maxHp: snapshot.maxHp },
    },
  });
});

// ---------------------------------------------------------------------------
// Character resync polling - re-pulls each owned token's source character
// periodically and pushes any changed reference fields through the existing
// token:stat:update event, so leveling up / re-equipping mid-session doesn't
// require removing and re-adding the token. Deliberately narrower than "sync
// everything": hp and spellSlots stay VTT-session-authoritative once pulled
// (the whole point of tracking them live during play) - a poll landing
// mid-fight must not silently overwrite in-progress damage or spent slots
// with the sheet's at-rest values. This is the interim, self-contained
// version; a real push-based system (sheet save -> VTT) is the longer-term
// direction once there's a real realtime layer to hang it on (see the
// current-state doc's Known Fragility notes).
// ---------------------------------------------------------------------------

const CHARACTER_SYNC_INTERVAL_MS = 30000;
let characterSyncTimer = null;

function startCharacterSync() {
  if (characterSyncTimer) clearInterval(characterSyncTimer);
  characterSyncTimer = setInterval(syncOwnedCharacterTokens, CHARACTER_SYNC_INTERVAL_MS);
}

async function syncOwnedCharacterTokens() {
  if (!session || role !== 'player') return;
  const tokens = Object.values(session.tokens).filter((t) => t.ownerId === playerId && t.characterId);
  for (const token of tokens) {
    try {
      const res = await fetch('/vtt/api/characters/' + token.characterId);
      if (!res.ok) continue; // character deleted, or a transient error - try again next tick
      const snapshot = await res.json();
      applyCharacterSyncFields(token, snapshot);
    } catch {
      // A single character's fetch failing (network blip) shouldn't stop
      // the rest of this player's tokens from syncing on this tick.
    }
  }
}

function applyCharacterSyncFields(token, snapshot) {
  const updates = {
    maxHp: snapshot.maxHp,
    speedFt: snapshot.speedFt,
    visionNormalFt: snapshot.vision.normalFt,
    visionDarkFt: snapshot.vision.darkFt,
    visionTrueFt: snapshot.vision.trueFt,
    visionDevilFt: snapshot.vision.devilFt,
    ac: snapshot.ac,
    saves: snapshot.saves,
    actions: snapshot.actions,
    preparedSpells: snapshot.preparedSpells,
  };
  for (const [stat, value] of Object.entries(updates)) {
    if (JSON.stringify(token[stat]) !== JSON.stringify(value)) {
      send({ type: 'token:stat:update', tokenId: token.id, stat, value });
    }
  }
}

// ---------------------------------------------------------------------------
// Advanced Vision modal - normal/darkvision/truesight/devil's sight ranges,
// pulled out of the token card itself since these are edited rarely.
// ---------------------------------------------------------------------------

const visionModal = document.getElementById('visionModal');
const visionModalNormal = document.getElementById('visionModalNormal');
const visionModalDark = document.getElementById('visionModalDark');
const visionModalTrue = document.getElementById('visionModalTrue');
const visionModalDevil = document.getElementById('visionModalDevil');
let visionModalTokenId = null;

function openVisionModal(tokenId) {
  const token = session.tokens[tokenId];
  if (!token) return;
  visionModalTokenId = tokenId;
  visionModalNormal.value = token.visionNormalFt || 0;
  visionModalDark.value = token.visionDarkFt || 0;
  visionModalTrue.value = token.visionTrueFt || 0;
  visionModalDevil.value = token.visionDevilFt || 0;
  visionModal.classList.add('visible');
}

function closeVisionModal() {
  visionModal.classList.remove('visible');
  visionModalTokenId = null;
}

document.getElementById('visionModalCancel').addEventListener('click', closeVisionModal);
document.getElementById('visionModalSave').addEventListener('click', () => {
  if (!visionModalTokenId) return;
  const tokenId = visionModalTokenId;
  send({ type: 'token:stat:update', tokenId, stat: 'visionNormalFt', value: Number(visionModalNormal.value) || 0 });
  send({ type: 'token:stat:update', tokenId, stat: 'visionDarkFt', value: Number(visionModalDark.value) || 0 });
  send({ type: 'token:stat:update', tokenId, stat: 'visionTrueFt', value: Number(visionModalTrue.value) || 0 });
  send({ type: 'token:stat:update', tokenId, stat: 'visionDevilFt', value: Number(visionModalDevil.value) || 0 });
  closeVisionModal();
});
visionModal.addEventListener('click', (e) => {
  if (e.target === visionModal) closeVisionModal(); // click on the overlay (outside the box) closes it
});

// ---------------------------------------------------------------------------
// Movement quick-adjust - shared between the GM's card for any token and a
// player's card for their own token (Section 3: same event, different sender).
// ---------------------------------------------------------------------------

function adjustTokenSpeedRemaining(tokenId, delta) {
  const token = session.tokens[tokenId];
  if (!token) return;
  const current = token.speedRemainingFt ?? token.speedFt ?? 0;
  const value = Math.max(0, current + delta);
  send({ type: 'token:stat:update', tokenId, stat: 'speedRemainingFt', value });
}

function resetTokenSpeedRemaining(tokenId) {
  const token = session.tokens[tokenId];
  if (!token) return;
  send({ type: 'token:stat:update', tokenId, stat: 'speedRemainingFt', value: token.speedFt || 0 });
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function renderSidebar() {
  if (!session) return;
  sidebarEl.innerHTML = role === 'gm' ? gmSidebarHtml() : playerSidebarHtml();
  role === 'gm' ? wireGmSidebar() : wirePlayerSidebar();
}

function playerListHtml() {
  const entries = Object.values(session.players).map((p) =>
    p.connected === false
      ? `<span style="color:#666;">${escapeHtml(p.name)} (disconnected)</span>`
      : escapeHtml(p.name),
  );
  return entries.length ? entries.join(', ') : '(none yet)';
}

function roomInfoHtml(roleLabel) {
  return `<div id="roomInfo"><strong>${escapeHtml(sessionId)}</strong><br/>Role: ${roleLabel}<br/>Players: ${playerListHtml()}</div>`;
}

// --- GM sidebar --------------------------------------------------------

function gmSidebarHtml() {
  const map = session.map || {};
  const ownerOptions = Object.values(session.players)
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join('');

  return `
    ${roomInfoHtml('GM')}

    <h2>Map</h2>
    <div class="field"><label>Upload map image</label><input type="file" id="mapFileInput" accept="image/*" /></div>
    <img id="mapThumb" class="thumb ${map.imageUrl ? 'visible' : ''}" src="${map.imageUrl || ''}" />
    <div class="field"><label>Image URL</label><input type="text" id="mapImageUrlInput" value="${escapeHtml(map.imageUrl || '')}" placeholder="/uploads/... or paste a URL" /></div>
    <div class="field row">
      <div><label>Width (px)</label><input type="number" id="mapWidthInput" value="${map.widthPx || 1600}" /></div>
      <div><label>Height (px)</label><input type="number" id="mapHeightInput" value="${map.heightPx || 1200}" /></div>
    </div>
    <div class="field row">
      <div>
        <label>Grid size (px/square)</label>
        <div class="row">
          <input type="number" id="mapGridSizeInput" value="${map.gridSizePx || 50}" />
          <button type="button" id="gridSizeStandardBtn" class="secondary" title="Standard tabletop scale: 1 inch = 5ft, using the web's 96px-per-inch reference. Exact on-screen size can vary slightly by monitor/browser zoom.">1in=5ft</button>
        </div>
      </div>
      <div><label>Ambient light</label>
        <select id="mapBrightnessSelect">
          <option value="bright" ${map.brightness === 'bright' ? 'selected' : ''}>Bright</option>
          <option value="dim" ${map.brightness === 'dim' ? 'selected' : ''}>Dim</option>
          <option value="dark" ${(!map.brightness || map.brightness === 'dark') ? 'selected' : ''}>Dark</option>
        </select>
      </div>
    </div>
    <button id="setMapBtn">Set map</button>

    <h2>Add token</h2>
    <div class="field"><label>Name</label><input type="text" id="tokenNameInput" placeholder="Goblin" /></div>
    <div class="field row">
      <div><label>Type</label>
        <select id="tokenTypeSelect">
          <option value="pc">PC</option>
          <option value="npc">NPC</option>
          <option value="enemy">Enemy</option>
        </select>
      </div>
      <div><label>Owner (for PCs)</label>
        <select id="tokenOwnerSelect"><option value="">- none -</option>${ownerOptions}</select>
      </div>
    </div>
    <div class="field row">
      <div><label>Normal vision (ft)</label><input type="number" id="tokenVisionNormalInput" value="30" /></div>
      <div><label>Darkvision (ft)</label><input type="number" id="tokenVisionDarkInput" value="0" /></div>
    </div>
    <div class="field row">
      <div><label>HP</label><input type="number" id="tokenHpInput" value="10" /></div>
      <div><label>Max HP</label><input type="number" id="tokenMaxHpInput" value="10" /></div>
    </div>
    <div class="field"><label>Speed (ft)</label><input type="number" id="tokenSpeedInput" value="30" /></div>
    <div class="field"><button type="button" id="tokenBrowseLibraryBtn" class="secondary">Browse Token Library…</button></div>
    <div class="field"><label>Or upload a custom image</label><input type="file" id="tokenFileInput" accept="image/*" /></div>
    <img id="tokenThumb" class="thumb" />
    <div class="field"><label>Image URL</label><input type="text" id="tokenImageUrlInput" placeholder="/uploads/... or paste a URL" /></div>
    <div class="field"><label><input type="checkbox" id="tokenHiddenInput" /> Hidden from players</label></div>
    <button id="addTokenBtn">Add token</button>

    <h2>Tokens</h2>
    <div id="tokenList">${gmTokenListHtml()}</div>

    ${markerFormHtml()}
    <div id="markerList">${markerListHtml(true)}</div>
  `;
}

// Shared by both sidebars (Phase 2, Section 4) - shape select plus the
// fields each shape needs. Circle/sphere only use radius; cone/cube only use
// length/width/cone-angle - shown/hidden by wireMarkerForm() based on the
// selected shape, rather than building four near-identical forms.
function markerFormHtml() {
  return `
    <h2>Markers</h2>
    <div class="field">
      <label>Shape</label>
      <select id="markerShapeSelect">
        <option value="circle">Circle (token-anchored point)</option>
        <option value="sphere">Sphere/Burst (placed point)</option>
        <option value="cone">Cone</option>
        <option value="cube">Cube/Line</option>
      </select>
    </div>
    <div class="field row" id="markerRadiusField">
      <div><label>Radius (ft)</label><input type="number" id="markerRadiusInput" value="20" /></div>
      <div><label>Color</label><input type="color" id="markerColorInput" value="#ff5252" /></div>
    </div>
    <div class="field row" id="markerShapeFields" style="display:none;">
      <div><label>Width (ft)</label><input type="number" id="markerWidthInput" value="10" /></div>
      <div><label>Cone angle (deg)</label><input type="number" id="markerConeAngleInput" value="60" /></div>
    </div>
    <p id="markerShapeHint" style="color:#666;font-size:12px;display:none;">Click the map to place the origin, then drag to aim and set length - release to confirm.</p>
    <div class="field"><label>Label (optional)</label><input type="text" id="markerLabelInput" placeholder="Fireball" /></div>
    <button id="placeMarkerBtn">Place on Map</button>
  `;
}

// Shared wiring for markerFormHtml() - shape-field show/hide plus the
// Place on Map click handler, called from both wireGmSidebar and
// wirePlayerSidebar.
function wireMarkerForm() {
  const shapeSelect = document.getElementById('markerShapeSelect');
  const radiusField = document.getElementById('markerRadiusField');
  const shapeFields = document.getElementById('markerShapeFields');
  const shapeHint = document.getElementById('markerShapeHint');

  function syncShapeFields() {
    const isDirectional = shapeSelect.value === 'cone' || shapeSelect.value === 'cube';
    radiusField.style.display = isDirectional ? 'none' : '';
    shapeFields.style.display = isDirectional ? '' : 'none';
    shapeHint.style.display = isDirectional ? '' : 'none';
  }
  shapeSelect.addEventListener('change', syncShapeFields);
  syncShapeFields();

  document.getElementById('placeMarkerBtn').addEventListener('click', () => {
    armMarkerPlacement({
      shape: shapeSelect.value,
      radiusFt: Number(document.getElementById('markerRadiusInput').value) || 0,
      widthFt: Number(document.getElementById('markerWidthInput').value) || 0,
      coneAngleDeg: Number(document.getElementById('markerConeAngleInput').value) || 60,
      color: document.getElementById('markerColorInput').value || '#ff5252',
      label: document.getElementById('markerLabelInput').value.trim(),
    });
  });
}

function gmTokenListHtml() {
  const tokens = Object.values(session.tokens);
  if (!tokens.length) return '<p style="color:#666;font-size:12px;">No tokens yet.</p>';

  return tokens
    .map((t) => {
      const hp = t.stats?.hp ?? '';
      const maxHp = t.stats?.maxHp ?? '';
      const speed = t.speedFt ?? '';
      const speedRemaining = t.speedRemainingFt ?? '';
      return `
        <div class="token-card" data-token-id="${escapeHtml(t.id)}">
          <div class="title">
            <span>${t.imageUrl ? `<img class="token-thumb" src="${escapeHtml(t.imageUrl)}" alt="" />` : ''}${escapeHtml(t.name)} <span class="tag">${t.type}</span>${t.hidden ? ' <span class="tag">hidden</span>' : ''}</span>
          </div>
          <div class="field row">
            <div><label>HP</label><input type="number" class="hpInput" value="${hp}" /></div>
            <div><label>Max HP</label><input type="number" class="maxHpInput" value="${maxHp}" /></div>
          </div>
          <div class="field"><label>Condition</label>
            <select class="conditionSelect">
              <option value="" ${!t.condition ? 'selected' : ''}>-</option>
              <option value="healthy" ${t.condition === 'healthy' ? 'selected' : ''}>Healthy</option>
              <option value="bloodied" ${t.condition === 'bloodied' ? 'selected' : ''}>Bloodied</option>
              <option value="critical" ${t.condition === 'critical' ? 'selected' : ''}>Critical</option>
            </select>
          </div>
          <div class="field"><label><input type="checkbox" class="darkvisionToggle" ${(t.visionDarkFt || 0) > 0 ? 'checked' : ''} /> Darkvision</label></div>
          <div class="field row">
            <div><label>Speed (ft)</label><input type="number" class="speedInput" value="${speed}" /></div>
            <div><label>Remaining (ft)</label><input type="number" class="speedRemainingInput" value="${speedRemaining}" /></div>
          </div>
          <div class="actions">
            <button class="secondary speedMinusBtn">−5 ft</button>
            <button class="secondary speedPlusBtn">+5 ft</button>
            <button class="secondary speedResetBtn">Reset move</button>
          </div>
          <div class="actions">
            <button class="secondary changeImageBtn">Change Image…</button>
            <button class="secondary advancedVisionBtn">Advanced Vision…</button>
            <button class="secondary toggleHiddenBtn">${t.hidden ? 'Unhide' : 'Hide'}</button>
            <button class="danger removeBtn">Remove</button>
          </div>
        </div>
      `;
    })
    .join('');
}

// Shared by both sidebars - session.markers is already server-filtered to
// whatever this client is allowed to see, so no client-side filtering here.
// isGm controls whether the "visible to all" toggle shows (GM-only control)
// and whether Remove shows for markers the viewer doesn't own.
function markerSizeLabel(marker) {
  if (marker.shape === 'cone') return `${marker.lengthFt}ft cone`;
  if (marker.shape === 'cube') return `${marker.lengthFt}x${marker.widthFt}ft`;
  return `${marker.radiusFt} ft`;
}

function markerListHtml(isGm) {
  const markers = Object.values(session.markers || {});
  if (!markers.length) return '<p style="color:#666;font-size:12px;">No markers placed.</p>';

  return markers
    .map((m) => {
      const isOwn = isGm || m.ownerId === playerId;
      const canRemove = isGm || isOwn;
      return `
        <div class="token-card" data-marker-id="${escapeHtml(m.id)}">
          <div class="title">
            <span>
              <span class="marker-swatch" style="background:${escapeHtml(m.color)}"></span>
              ${escapeHtml(m.label || 'Marker')} <span class="tag">${markerSizeLabel(m)}</span>${!isOwn ? ' <span class="tag">shared</span>' : ''}
            </span>
          </div>
          ${
            isGm
              ? `<div class="field"><label><input type="checkbox" class="markerVisibleToAllToggle" ${m.visibleToAll ? 'checked' : ''} /> Visible to all players</label></div>`
              : ''
          }
          ${canRemove ? `<div class="actions"><button class="danger removeMarkerBtn">Remove</button></div>` : ''}
        </div>
      `;
    })
    .join('');
}

function wireGmSidebar() {
  const mapFileInput = document.getElementById('mapFileInput');
  const mapImageUrlInput = document.getElementById('mapImageUrlInput');
  const mapWidthInput = document.getElementById('mapWidthInput');
  const mapHeightInput = document.getElementById('mapHeightInput');
  const mapThumb = document.getElementById('mapThumb');

  mapFileInput.addEventListener('change', async () => {
    const file = mapFileInput.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file);
      mapImageUrlInput.value = url;
      const img = new Image();
      img.onload = () => {
        mapWidthInput.value = img.naturalWidth;
        mapHeightInput.value = img.naturalHeight;
        mapThumb.src = url;
        mapThumb.classList.add('visible');
      };
      img.src = url;
    } catch {
      alert('Map image upload failed.');
    }
  });

  document.getElementById('gridSizeStandardBtn').addEventListener('click', () => {
    document.getElementById('mapGridSizeInput').value = 96;
  });

  document.getElementById('setMapBtn').addEventListener('click', () => {
    const imageUrl = mapImageUrlInput.value.trim();
    if (!imageUrl) return alert('Upload or enter a map image URL first.');
    send({
      type: 'map:set',
      map: {
        imageUrl,
        widthPx: Number(mapWidthInput.value) || 1600,
        heightPx: Number(mapHeightInput.value) || 1200,
        gridSizePx: Number(document.getElementById('mapGridSizeInput').value) || 50,
        brightness: document.getElementById('mapBrightnessSelect').value,
      },
    });
  });

  const tokenFileInput = document.getElementById('tokenFileInput');
  const tokenImageUrlInput = document.getElementById('tokenImageUrlInput');
  const tokenThumb = document.getElementById('tokenThumb');

  tokenFileInput.addEventListener('change', async () => {
    const file = tokenFileInput.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file);
      tokenImageUrlInput.value = url;
      tokenThumb.src = url;
      tokenThumb.classList.add('visible');
    } catch {
      alert('Token image upload failed.');
    }
  });

  document.getElementById('tokenBrowseLibraryBtn').addEventListener('click', () => {
    openImagePicker((url) => {
      tokenImageUrlInput.value = url;
      tokenThumb.src = url;
      tokenThumb.classList.add('visible');
    });
  });

  document.getElementById('addTokenBtn').addEventListener('click', () => {
    const name = document.getElementById('tokenNameInput').value.trim();
    if (!name) return alert('Give the token a name.');
    const map = session.map || { widthPx: 800, heightPx: 600 };
    const token = {
      id: `token-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      type: document.getElementById('tokenTypeSelect').value,
      ownerId: document.getElementById('tokenOwnerSelect').value || null,
      x: Math.round(map.widthPx / 2),
      y: Math.round(map.heightPx / 2),
      imageUrl: tokenImageUrlInput.value.trim() || null,
      visionNormalFt: Number(document.getElementById('tokenVisionNormalInput').value) || 0,
      visionDarkFt: Number(document.getElementById('tokenVisionDarkInput').value) || 0,
      visionTrueFt: 0,
      visionDevilFt: 0,
      speedFt: Number(document.getElementById('tokenSpeedInput').value) || 0,
      speedRemainingFt: Number(document.getElementById('tokenSpeedInput').value) || 0,
      hidden: document.getElementById('tokenHiddenInput').checked,
      stats: {
        hp: Number(document.getElementById('tokenHpInput').value) || 0,
        maxHp: Number(document.getElementById('tokenMaxHpInput').value) || 0,
      },
    };
    send({ type: 'token:add', token });
  });

  document.getElementById('tokenList').addEventListener('change', (e) => {
    const card = e.target.closest('.token-card');
    if (!card) return;
    const tokenId = card.dataset.tokenId;
    if (e.target.classList.contains('hpInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'hp', value: Number(e.target.value) });
    } else if (e.target.classList.contains('maxHpInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'maxHp', value: Number(e.target.value) });
    } else if (e.target.classList.contains('conditionSelect')) {
      send({ type: 'token:stat:update', tokenId, stat: 'condition', value: e.target.value || null });
    } else if (e.target.classList.contains('darkvisionToggle')) {
      // Quick on/off for the common 60ft case; Advanced Vision… below lets
      // the GM dial in a non-standard range without losing the checkbox's
      // on/off reading (it just reflects visionDarkFt > 0).
      send({ type: 'token:stat:update', tokenId, stat: 'visionDarkFt', value: e.target.checked ? 60 : 0 });
    } else if (e.target.classList.contains('speedInput')) {
      // Editing base Speed resets remaining movement to match - it's the
      // "this creature now has a fresh X ft to work with" control; the
      // Remaining field and +/- buttons are for adjusting mid-turn.
      const value = Number(e.target.value) || 0;
      send({ type: 'token:stat:update', tokenId, stat: 'speedFt', value });
      send({ type: 'token:stat:update', tokenId, stat: 'speedRemainingFt', value });
    } else if (e.target.classList.contains('speedRemainingInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'speedRemainingFt', value: Number(e.target.value) || 0 });
    }
  });

  document.getElementById('tokenList').addEventListener('click', (e) => {
    const card = e.target.closest('.token-card');
    if (!card) return;
    const tokenId = card.dataset.tokenId;
    if (e.target.classList.contains('toggleHiddenBtn')) {
      send({ type: 'token:hidden:toggle', tokenId });
    } else if (e.target.classList.contains('removeBtn')) {
      if (confirm('Remove this token?')) send({ type: 'token:remove', tokenId });
    } else if (e.target.classList.contains('advancedVisionBtn')) {
      openVisionModal(tokenId);
    } else if (e.target.classList.contains('changeImageBtn')) {
      openImagePicker((url) => send({ type: 'token:stat:update', tokenId, stat: 'imageUrl', value: url }));
    } else if (e.target.classList.contains('speedMinusBtn')) {
      adjustTokenSpeedRemaining(tokenId, -5);
    } else if (e.target.classList.contains('speedPlusBtn')) {
      adjustTokenSpeedRemaining(tokenId, 5);
    } else if (e.target.classList.contains('speedResetBtn')) {
      resetTokenSpeedRemaining(tokenId);
    }
  });

  wireMarkerForm();

  document.getElementById('markerList').addEventListener('change', (e) => {
    const card = e.target.closest('[data-marker-id]');
    if (!card) return;
    const markerId = card.dataset.markerId;
    if (e.target.classList.contains('markerVisibleToAllToggle')) {
      send({ type: 'marker:visibility:toggle', markerId });
    }
  });

  document.getElementById('markerList').addEventListener('click', (e) => {
    const card = e.target.closest('[data-marker-id]');
    if (!card) return;
    const markerId = card.dataset.markerId;
    if (e.target.classList.contains('removeMarkerBtn')) {
      send({ type: 'marker:remove', markerId });
    }
  });
}

// --- Player sidebar ------------------------------------------------------

function playerSidebarHtml() {
  const allTokens = Object.values(session.tokens);
  const ownTokens = allTokens.filter((t) => t.ownerId === playerId);
  // currentRenderedTokens is whatever render() last actually drew - for a
  // player that's already the vision-filtered set (see render()'s isPointRevealed
  // pass), so "other tokens" here matches what's actually visible on the map
  // instead of every token that merely isn't the player's own. Previously this
  // read straight from allTokens, so a token's HP/status kept showing here
  // (and stayed live-updating) even after it moved out of vision.
  const otherTokens = currentRenderedTokens.filter((t) => t.ownerId !== playerId);

  return `
    ${roomInfoHtml('Player')}

    <h2>My tokens</h2>
    <button type="button" id="addCharacterTokenBtn" class="secondary">Add My Character…</button>
    <div id="ownTokenList">${ownTokenListHtml(ownTokens)}</div>

    <h2>Other tokens in view</h2>
    <div id="otherTokenList">${otherTokenListHtml(otherTokens)}</div>

    ${markerFormHtml()}
    <div id="markerList">${markerListHtml(false)}</div>
  `;
}

function ownTokenListHtml(tokens) {
  if (!tokens.length) return '<p style="color:#666;font-size:12px;">You don\'t control any tokens yet - ask the GM to assign one.</p>';
  return tokens
    .map((t) => {
      const hp = t.stats?.hp ?? '';
      const maxHp = t.stats?.maxHp ?? '';
      const speed = t.speedFt ?? '';
      const speedRemaining = t.speedRemainingFt ?? '';
      return `
        <div class="token-card" data-token-id="${escapeHtml(t.id)}">
          <div class="title"><span>${t.imageUrl ? `<img class="token-thumb" src="${escapeHtml(t.imageUrl)}" alt="" />` : ''}${escapeHtml(t.name)} <span class="tag">${t.type}</span></span></div>
          <div class="field row">
            <div><label>HP</label><input type="number" class="hpInput" value="${hp}" /></div>
            <div><label>Max HP</label><input type="number" class="maxHpInput" value="${maxHp}" /></div>
          </div>
          <div class="field row">
            <div><label>Speed (ft)</label><input type="number" class="speedInput" value="${speed}" /></div>
            <div><label>Remaining (ft)</label><input type="number" class="speedRemainingInput" value="${speedRemaining}" /></div>
          </div>
          <div class="actions">
            <button class="secondary speedMinusBtn">−5 ft</button>
            <button class="secondary speedPlusBtn">+5 ft</button>
            <button class="secondary speedResetBtn">Reset move</button>
          </div>
          <div class="actions">
            <button class="secondary changeImageBtn">Change Image…</button>
          </div>
          ${miniSheetHtml(t)}
        </div>
      `;
    })
    .join('');
}

// Mini character sheet (Phase 2, Section 2) - only renders for tokens that
// carry a character-sheet pull-through (characterId set, from the character
// picker in Section 1a). Manually-created tokens (the POC's original blank
// "Add token" flow, still used by the GM) simply don't have this data, so
// there's nothing to show. Everything here reads straight off the token
// object - it's already synced via the normal token broadcast plumbing, no
// separate fetch, same "populate once at creation, don't auto-resync"
// limitation as the rest of Section 1.
function miniSheetHtml(t) {
  if (!t.characterId) return '';

  const savesHtml = Object.entries(t.saves || {})
    .map(([key, value]) => `<span class="tag">${key.toUpperCase()} ${signedVtt(value)}</span>`)
    .join(' ') || '<span style="color:#666;">None</span>';

  const actionsHtml = (t.actions || []).length
    ? (t.actions || [])
        .map(
          (a) => `
        <div class="mini-sheet-action" data-action-name="${escapeHtml(a.name)}">
          <span>${escapeHtml(a.name)}</span>
          <span style="color:#aaa;">${signedVtt(a.toHitBonus)} to hit, ${a.damageRolls || ''}${a.damageRolls && a.damageBonus ? ' ' : ''}${a.damageBonus ? signedVtt(a.damageBonus) : ''}</span>
        </div>
      `
        )
        .join('')
    : '<p style="color:#666;font-size:12px;">No equipped weapons.</p>';

  const slotsHtml = (t.spellSlots || []).length
    ? (t.spellSlots || [])
        .map(
          (s) => `
        <div class="mini-sheet-slot" data-slot-type="${escapeHtml(s.type)}" data-slot-level="${s.level}">
          <span>${s.type === 'pact' ? 'Pact' : 'Level'} ${s.level}: ${s.current}/${s.max}</span>
          <button type="button" class="secondary slotUseBtn" ${s.current <= 0 ? 'disabled' : ''}>Use</button>
          <button type="button" class="secondary slotResetBtn">Reset</button>
        </div>
      `
        )
        .join('')
    : '';

  const spellsHtml = (t.preparedSpells || []).length
    ? (t.preparedSpells || []).map((s) => `<div class="mini-sheet-action" data-spell-name="${escapeHtml(s.name)}"><span>${escapeHtml(s.name)}</span><span style="color:#aaa;">Lvl ${s.spellLevel ?? 0}</span></div>`).join('')
    : '';

  return `
    <div class="mini-sheet">
      <div class="field row">
        <div><label>AC</label><input type="number" value="${t.ac ?? ''}" readonly /></div>
        <div><label>Saves</label><div style="padding-top:4px;">${savesHtml}</div></div>
      </div>
      <label style="font-size:11px;color:#888;">Actions</label>
      ${actionsHtml}
      ${slotsHtml ? `<label style="font-size:11px;color:#888;">Spell slots</label>${slotsHtml}` : ''}
      ${spellsHtml ? `<label style="font-size:11px;color:#888;">Prepared spells</label>${spellsHtml}` : ''}
    </div>
  `;
}

function signedVtt(value) {
  const n = Number(value) || 0;
  return n >= 0 ? `+${n}` : `${n}`;
}

function otherTokenListHtml(tokens) {
  if (!tokens.length) return '<p style="color:#666;font-size:12px;">None visible right now.</p>';
  return tokens
    .map((t) => {
      const hasStats = t.stats && typeof t.stats.hp === 'number';
      const detail = hasStats
        ? `HP ${t.stats.hp}/${t.stats.maxHp}`
        : t.condition
          ? `Condition: ${escapeHtml(t.condition)}`
          : 'No status known';
      return `
        <div class="token-card">
          <div class="title"><span>${escapeHtml(t.name)} <span class="tag">${t.type}</span></span></div>
          <div style="font-size:12px;color:#aaa;">${detail}</div>
        </div>
      `;
    })
    .join('');
}

function wirePlayerSidebar() {
  document.getElementById('addCharacterTokenBtn').addEventListener('click', openCharacterPicker);

  const ownList = document.getElementById('ownTokenList');
  if (!ownList) return;
  ownList.addEventListener('change', (e) => {
    const card = e.target.closest('.token-card');
    if (!card) return;
    const tokenId = card.dataset.tokenId;
    if (e.target.classList.contains('hpInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'hp', value: Number(e.target.value) });
    } else if (e.target.classList.contains('maxHpInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'maxHp', value: Number(e.target.value) });
    } else if (e.target.classList.contains('speedInput')) {
      const value = Number(e.target.value) || 0;
      send({ type: 'token:stat:update', tokenId, stat: 'speedFt', value });
      send({ type: 'token:stat:update', tokenId, stat: 'speedRemainingFt', value });
    } else if (e.target.classList.contains('speedRemainingInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'speedRemainingFt', value: Number(e.target.value) || 0 });
    }
  });
  ownList.addEventListener('click', (e) => {
    const card = e.target.closest('.token-card');
    if (!card) return;
    const tokenId = card.dataset.tokenId;
    if (e.target.classList.contains('changeImageBtn')) {
      openImagePicker((url) => send({ type: 'token:stat:update', tokenId, stat: 'imageUrl', value: url }));
    } else if (e.target.classList.contains('speedMinusBtn')) {
      adjustTokenSpeedRemaining(tokenId, -5);
    } else if (e.target.classList.contains('speedPlusBtn')) {
      adjustTokenSpeedRemaining(tokenId, 5);
    } else if (e.target.classList.contains('speedResetBtn')) {
      resetTokenSpeedRemaining(tokenId);
    } else if (e.target.classList.contains('slotUseBtn') || e.target.classList.contains('slotResetBtn')) {
      const slotRow = e.target.closest('.mini-sheet-slot');
      const token = session.tokens[tokenId];
      if (!slotRow || !token) return;
      const type = slotRow.dataset.slotType;
      const level = Number(slotRow.dataset.slotLevel);
      const useSlot = e.target.classList.contains('slotUseBtn');
      const value = (token.spellSlots || []).map((s) => {
        if (s.type !== type || s.level !== level) return s;
        return { ...s, current: useSlot ? Math.max(0, s.current - 1) : s.max };
      });
      send({ type: 'token:stat:update', tokenId, stat: 'spellSlots', value });
    } else {
      const actionRow = e.target.closest('.mini-sheet-action');
      const token = session.tokens[tokenId];
      if (actionRow && token && actionRow.dataset.actionName) {
        const action = (token.actions || []).find((a) => a.name === actionRow.dataset.actionName);
        if (action) armActionTargeting(tokenId, action);
      }
    }
  });

  wireMarkerForm();

  document.getElementById('markerList').addEventListener('click', (e) => {
    const card = e.target.closest('[data-marker-id]');
    if (!card) return;
    const markerId = card.dataset.markerId;
    if (e.target.classList.contains('removeMarkerBtn')) {
      send({ type: 'marker:remove', markerId });
    }
  });
}
