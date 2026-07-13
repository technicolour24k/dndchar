import { drawMap } from './render/map.js';
import { drawTokens } from './render/tokens.js';
import { computeVisionRadii, isPointRevealed, renderVisionMaskedMap } from './render/vision.js';

// Mirrors TOKEN_LEVEL_STAT_FIELDS in vtt/server/handlers/token.js — these
// token:stat:update fields write directly onto the token, not into
// token.stats (which is otherwise free-form combat stats).
const TOKEN_LEVEL_STAT_FIELDS = new Set([
  'condition',
  'imageUrl',
  'visionNormalFt',
  'visionDarkFt',
  'visionTrueFt',
  'visionDevilFt',
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
let dragState = null; // { tokenId, x, y } — visual ghost only, see canvas handlers
let currentRenderedTokens = []; // whichever token list render() last actually drew, for hit-testing
let zoomLevel = 1; // CSS-only scale of the canvas; the backing pixel buffer stays at native map size

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
    // Only auto-retry after a successful join — a bad room code shouldn't loop.
    if (session) setTimeout(() => connect(joinPayload), 1500);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'join:error':
      loginError.textContent = msg.reason === 'session_not_found' ? 'Room not found.' : msg.reason;
      session = null;
      if (ws) ws.close();
      break;

    case 'state:full':
      session = msg.session;
      showApp();
      renderSidebar();
      render();
      break;

    case 'player:joined':
      if (session) {
        session.players[msg.playerId] = {
          id: msg.playerId,
          name: msg.playerName,
          tokenIds: session.players[msg.playerId]?.tokenIds || [],
        };
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
      break;
    }

    case 'token:stat:update': {
      const t = session.tokens[msg.tokenId];
      if (t) {
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
    loginError.textContent = 'Could not create room — is the server running?';
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

  if (role === 'gm') {
    drawMap(ctx, mapImage, map);
    drawTokens(ctx, allTokens, map.gridSizePx, getImage);
    currentRenderedTokens = allTokens;
  } else {
    const ownedTokens = allTokens.filter((t) => t.ownerId === playerId);
    const radii = computeVisionRadii(ownedTokens, map);
    renderVisionMaskedMap(ctx, mapImage, radii, map);
    const visibleTokens = allTokens.filter((t) => isPointRevealed(t.x, t.y, radii));
    drawTokens(ctx, visibleTokens, map.gridSizePx, getImage);
    currentRenderedTokens = visibleTokens;
  }

  if (dragState) {
    const radius = map.gridSizePx * 0.4;
    ctx.save();
    ctx.beginPath();
    ctx.arc(dragState.x, dragState.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.stroke();
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

// Clicking a token you can move drags the token; clicking empty space (or a
// token you don't control) pans the map instead — same click-and-drag
// gesture, disambiguated by what's under the cursor.
let panState = null; // { startClientX, startClientY, startScrollLeft, startScrollTop }

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault(); // avoid native text-selection/drag-ghost while panning
  const { x, y } = canvasCoords(e);
  const token = hitTestToken(x, y);
  const canDragToken = token && (role === 'gm' || token.ownerId === playerId);

  if (canDragToken) {
    dragState = { tokenId: token.id, x, y };
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
// bounds — easy to do while panning a zoomed-out map — keeps tracking.
window.addEventListener('mousemove', (e) => {
  if (dragState) {
    const { x, y } = canvasCoords(e);
    dragState.x = x;
    dragState.y = y;
    render();
  } else if (panState) {
    mapWrap.scrollLeft = panState.startScrollLeft - (e.clientX - panState.startClientX);
    mapWrap.scrollTop = panState.startScrollTop - (e.clientY - panState.startClientY);
  }
});

window.addEventListener('mouseup', (e) => {
  if (dragState) {
    const { x, y } = canvasCoords(e);
    const { tokenId } = dragState;
    send({ type: 'token:move', tokenId, x, y });
    // dragState itself is cleared once the server echoes the move back (see
    // handleMessage's token:move case) — the token doesn't actually move on
    // screen until then, per the "server is the only writer" rule.
  }
  panState = null;
  canvas.classList.remove('dragging');
});

// ---------------------------------------------------------------------------
// Zoom — pure CSS scale of the canvas (backing pixel buffer stays at the
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
// what trackpad pinch-to-zoom sends) — plain wheel still scrolls/pans.
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
// Image upload (map + token art) — POST /upload, returns a URL to use
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
// Token image picker — browse the bundled art library (fetched once and
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
  const category = pickerCategorySelect.value;
  const search = pickerSearchInput.value.trim().toLowerCase();

  if (!category && !search) {
    pickerResults.innerHTML = '';
    pickerStatus.textContent = 'Pick a category or type to search the library…';
    return;
  }

  const matches = (tokenLibraryIndex || []).filter((entry) => {
    if (category && entry.category !== category) return false;
    if (search && !entry.friendlyName.toLowerCase().includes(search)) return false;
    return true;
  });

  const shown = matches.slice(0, PICKER_RESULT_LIMIT);
  pickerStatus.textContent =
    matches.length > shown.length
      ? `Showing ${shown.length} of ${matches.length} matches — refine your search to narrow further.`
      : `${matches.length} match${matches.length === 1 ? '' : 'es'}`;

  pickerResults.innerHTML = shown
    .map((entry) => {
      const url = libraryImageUrl(entry);
      return `
        <div class="picker-item" data-url="${escapeHtml(url)}" title="${escapeHtml(entry.friendlyName)}">
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
// Advanced Vision modal — normal/darkvision/truesight/devil's sight ranges,
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
// Sidebar
// ---------------------------------------------------------------------------

function renderSidebar() {
  if (!session) return;
  sidebarEl.innerHTML = role === 'gm' ? gmSidebarHtml() : playerSidebarHtml();
  role === 'gm' ? wireGmSidebar() : wirePlayerSidebar();
}

function playerListHtml() {
  const names = Object.values(session.players).map((p) => escapeHtml(p.name));
  return names.length ? names.join(', ') : '(none yet)';
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
        <select id="tokenOwnerSelect"><option value="">— none —</option>${ownerOptions}</select>
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
    <div class="field"><button type="button" id="tokenBrowseLibraryBtn" class="secondary">Browse Token Library…</button></div>
    <div class="field"><label>Or upload a custom image</label><input type="file" id="tokenFileInput" accept="image/*" /></div>
    <img id="tokenThumb" class="thumb" />
    <div class="field"><label>Image URL</label><input type="text" id="tokenImageUrlInput" placeholder="/uploads/... or paste a URL" /></div>
    <div class="field"><label><input type="checkbox" id="tokenHiddenInput" /> Hidden from players</label></div>
    <button id="addTokenBtn">Add token</button>

    <h2>Tokens</h2>
    <div id="tokenList">${gmTokenListHtml()}</div>
  `;
}

function gmTokenListHtml() {
  const tokens = Object.values(session.tokens);
  if (!tokens.length) return '<p style="color:#666;font-size:12px;">No tokens yet.</p>';

  return tokens
    .map((t) => {
      const hp = t.stats?.hp ?? '';
      const maxHp = t.stats?.maxHp ?? '';
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
              <option value="" ${!t.condition ? 'selected' : ''}>—</option>
              <option value="healthy" ${t.condition === 'healthy' ? 'selected' : ''}>Healthy</option>
              <option value="bloodied" ${t.condition === 'bloodied' ? 'selected' : ''}>Bloodied</option>
              <option value="critical" ${t.condition === 'critical' ? 'selected' : ''}>Critical</option>
            </select>
          </div>
          <div class="field"><label><input type="checkbox" class="darkvisionToggle" ${(t.visionDarkFt || 0) > 0 ? 'checked' : ''} /> Darkvision</label></div>
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
    }
  });
}

// --- Player sidebar ------------------------------------------------------

function playerSidebarHtml() {
  const allTokens = Object.values(session.tokens);
  const ownTokens = allTokens.filter((t) => t.ownerId === playerId);
  const otherTokens = allTokens.filter((t) => t.ownerId !== playerId);

  return `
    ${roomInfoHtml('Player')}

    <h2>My tokens</h2>
    <div id="ownTokenList">${ownTokenListHtml(ownTokens)}</div>

    <h2>Other tokens in view</h2>
    <div id="otherTokenList">${otherTokenListHtml(otherTokens)}</div>
  `;
}

function ownTokenListHtml(tokens) {
  if (!tokens.length) return '<p style="color:#666;font-size:12px;">You don\'t control any tokens yet — ask the GM to assign one.</p>';
  return tokens
    .map((t) => {
      const hp = t.stats?.hp ?? '';
      const maxHp = t.stats?.maxHp ?? '';
      return `
        <div class="token-card" data-token-id="${escapeHtml(t.id)}">
          <div class="title"><span>${t.imageUrl ? `<img class="token-thumb" src="${escapeHtml(t.imageUrl)}" alt="" />` : ''}${escapeHtml(t.name)} <span class="tag">${t.type}</span></span></div>
          <div class="field row">
            <div><label>HP</label><input type="number" class="hpInput" value="${hp}" /></div>
            <div><label>Max HP</label><input type="number" class="maxHpInput" value="${maxHp}" /></div>
          </div>
          <div class="actions">
            <button class="secondary changeImageBtn">Change Image…</button>
          </div>
        </div>
      `;
    })
    .join('');
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
    }
  });
  ownList.addEventListener('click', (e) => {
    const card = e.target.closest('.token-card');
    if (!card) return;
    const tokenId = card.dataset.tokenId;
    if (e.target.classList.contains('changeImageBtn')) {
      openImagePicker((url) => send({ type: 'token:stat:update', tokenId, stat: 'imageUrl', value: url }));
    }
  });
}
