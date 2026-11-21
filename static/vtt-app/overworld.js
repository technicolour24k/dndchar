// Overworld maps inside the VTT (overworld-map plan, Unit F).
//
// The overworld itself is a normal SvelteKit page (/campaigns/<id>/overworld). From a campaign table
// this module opens it in a full-screen overlay iframe with ?embed=1 (no app top bar), and shows a
// passing "New map" banner when the DM shares one while players are at the table. Quick rooms have no
// campaign, so they get no button at all.
//
// The iframe is same-origin, so the login cookie just works, and it is REMOVED on close, which frees
// the decoded map image (a big deal on phones).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANNER_MS = 15000;

export function createOverworld({ getCampaignId }) {
  const overlay = document.getElementById('overworldOverlay');
  const host = document.getElementById('overworldFrameHost');
  const newTab = document.getElementById('overworldNewTab');
  const closeButton = document.getElementById('overworldClose');
  const banner = document.getElementById('overworldBanner');
  let bannerTimer = null;

  const base = () => `/campaigns/${encodeURIComponent(getCampaignId())}/overworld`;
  const isOpen = () => !!overlay && !overlay.hidden;

  // The list (or straight to one map). mapId is only used when it is a real uuid.
  function open(mapId) {
    if (!overlay || !getCampaignId()) return;
    const path = mapId && UUID.test(mapId) ? `${base()}/${mapId}` : base();
    hideBanner();
    host.textContent = '';
    const frame = document.createElement('iframe');
    frame.title = 'Overworld';
    frame.src = `${path}?embed=1`;
    host.appendChild(frame);
    newTab.href = path;
    overlay.hidden = false;
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    host.textContent = ''; // removes the iframe and its decoded image
  }

  function hideBanner() {
    clearTimeout(bannerTimer);
    if (banner) banner.hidden = true;
  }

  // 'overworld:granted' { mapId, mapName } from the server when a DM shares a map.
  function onGranted(msg) {
    if (!banner || !getCampaignId()) return;
    banner.textContent = '';
    const text = document.createElement('span');
    text.textContent = `New map: ${String(msg.mapName ?? '').slice(0, 80)}`;
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = 'Open';
    openButton.addEventListener('click', () => open(msg.mapId));
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'secondary';
    dismiss.textContent = 'x';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.addEventListener('click', hideBanner);
    banner.append(text, openButton, dismiss);
    banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, BANNER_MS);
  }

  closeButton?.addEventListener('click', close);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) close();
  });

  return {
    isOpen,
    open,
    close,
    onGranted,
    // Campaign tables only: a Quick room has no campaign id, so no button.
    buttonHtml: () => (getCampaignId() ? '<div class="field"><button type="button" id="openOverworldBtn" class="secondary">Overworld</button></div>' : ''),
    wire: () => document.getElementById('openOverworldBtn')?.addEventListener('click', () => open())
  };
}
