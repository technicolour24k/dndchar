// VTT deck client (decks plan, unit 8). Plain unbundled JS, loaded by main.js. Mirrors forage.js's shape.
//
// Three surfaces:
//   - the PLAYER popup (#deckModal), opened from a linked token card: pick a deck, draw, choose the Ace's
//     value, read the result. Closing it never cancels anything (an undecided Ace resumes on reopen).
//   - TOASTS (#deckToasts) for everyone when a card is drawn or undone (deck:drawn / deck:undone).
//   - the GM's sidebar block "Deck": open "waiting on the DM" tasks and the last draw with Undo.
//
// The server does every roll and decides everything; this only sends choices and shows what comes back.
// SECURITY: card, outcome, character and task text is never put into innerHTML. Everything below is built
// with textContent (the el() helper), so the wording helpers in shared/deckView.js (which return UNESCAPED
// strings) are safe to use. The one innerHTML string (the token-card button) holds fixed text and escaped ids.

import {
  cardTitle, choiceOptions, drawnTitle, errorText, gmTaskLine, lastDrawLine, recentLine, resultLines, rollLines, statusTag,
  successLabel, taskLines, undoneTitle
} from './shared/deckView.js';

const API = '/vtt/api/decks';
const AVAILABILITY_TTL_MS = 60000;
const TOAST_MS = 20000;
const MAX_TOASTS = 4;

// One small fetch helper: never throws, always { ok, status, data }.
async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'network' } };
  }
}

// Builds an element with TEXT content only (never HTML).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick, disabled = false) {
  const node = el('button', className, label);
  node.type = 'button';
  node.disabled = !!disabled;
  node.addEventListener('click', onClick);
  return node;
}

export function createDeck(deps) {
  const modal = document.getElementById('deckModal');
  const body = document.getElementById('deckModalBody');
  const toasts = document.getElementById('deckToasts');

  // ---------------------------------------------------------------------------------------------
  // Which characters can draw at all: GET ?characterId= (decks the campaign enabled, an undecided Ace,
  // recent draws). Cached per room + character so the token-card button is drawn synchronously.
  // ---------------------------------------------------------------------------------------------
  const availability = new Map(); // "room|characterId" -> { decks, choosing, at }
  const asking = new Set();
  const availKey = (characterId) => `${deps.getSessionId()}|${characterId}`;

  async function askAvailability(characterId) {
    if (asking.has(characterId)) return;
    asking.add(characterId);
    const res = await api('GET', `${API}?characterId=${encodeURIComponent(characterId)}`);
    asking.delete(characterId);
    availability.set(availKey(characterId), {
      decks: res.ok && Array.isArray(res.data.decks) ? res.data.decks : [],
      choosing: res.ok ? res.data.choosing ?? null : null,
      at: Date.now()
    });
    refreshButtons();
  }

  function knownFor(characterId) {
    const known = availability.get(availKey(characterId));
    if (!known || Date.now() - known.at > AVAILABILITY_TTL_MS) setTimeout(() => askAvailability(characterId), 0);
    return known || null;
  }

  const buttonLabel = (known) => (known?.choosing ? 'Finish your card' : 'Draw a card');

  // The token-card button. Hidden until we know the character has an enabled deck, so campaigns without
  // decks (and Quick rooms) never see a dead button. The characterId is a uuid from our own session data,
  // but it still goes through the escape helper.
  function deckButtonHtml(token) {
    if (!token.characterId || token.type === 'prop' || !deps.isAccountLinked()) return '';
    const known = knownFor(token.characterId);
    const hidden = known && known.decks.length ? '' : ' hidden';
    return `<button type="button" class="secondary deckBtn" data-deck-token="${deps.escapeHtml(token.id)}"${hidden}>${known ? deps.escapeHtml(buttonLabel(known)) : 'Draw a card'}</button>`;
  }

  function refreshButtons() {
    const session = deps.getSession();
    if (!session || deps.getRole() !== 'player') return;
    document.querySelectorAll('.deckBtn').forEach((node) => {
      const token = session.tokens?.[node.dataset.deckToken];
      const known = token?.characterId ? availability.get(availKey(token.characterId)) : null;
      node.hidden = !(known && known.decks.length);
      if (known) node.textContent = buttonLabel(known);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Draw card DOM, shared by the popup result and the toasts.
  // ---------------------------------------------------------------------------------------------
  function badge(success) {
    return el('span', `deck-badge${success ? ' good' : ''}`, successLabel(success));
  }

  function appendDrawDetails(parent, draw) {
    if (draw.outcome?.name) {
      const p = el('p');
      p.appendChild(el('strong', null, draw.outcome.name));
      if (draw.outcome.text) p.appendChild(document.createTextNode(`: ${draw.outcome.text}`));
      parent.appendChild(p);
    }
    for (const line of rollLines(draw)) parent.appendChild(el('p', 'deck-muted', line));
    const lines = resultLines(draw);
    if (lines.length) {
      const list = el('ul', 'deck-lines');
      for (const line of lines) list.appendChild(el('li', null, line));
      parent.appendChild(list);
    }
    for (const line of taskLines(draw)) parent.appendChild(el('p', 'forage-warn', line));
    if (draw.status === 'reverted') parent.appendChild(el('p', 'deck-muted', `Undone by the DM${draw.revertNote ? `: ${draw.revertNote}` : ''}`));
  }

  // ---------------------------------------------------------------------------------------------
  // PLAYER popup. State lives in `pd`; render() rebuilds the body from it (no typed fields, so a
  // rebuild never loses input). loadSeq drops stale GETs, exactly like the sheet's DeckModal.
  // ---------------------------------------------------------------------------------------------
  const pd = {
    openAbout: false, openRecent: false, open: false, characterId: null, decks: [], deckId: '', loading: true, busy: false,
    message: '', choosing: null, result: null, recent: [], loadSeq: 0, focusDraw: false
  };

  const currentDeck = () => pd.decks.find((entry) => entry.id === pd.deckId) || pd.decks[0] || null;

  function render() {
    if (!pd.open) return;
    body.replaceChildren();

    const head = el('div', 'deck-head');
    head.appendChild(el('h2', null, 'Decks'));
    head.appendChild(button('Close', 'secondary deck-close', closePlayer));
    body.appendChild(head);

    if (pd.loading) {
      body.appendChild(el('p', 'deck-muted', 'Loading...'));
    } else if (pd.choosing) {
      // An Ace: nothing has been applied yet. Closing leaves it here to finish later.
      const section = el('section', 'deck-section');
      const title = el('h3', null, `${cardTitle(pd.choosing.card)} `);
      title.appendChild(badge(pd.choosing.success));
      section.appendChild(title);
      section.appendChild(el('p', null, 'An Ace counts as 1 or 11. Pick one: nothing happens until you do.'));
      for (const option of choiceOptions(pd.choosing)) {
        const row = el('div', 'deck-choice');
        row.appendChild(button(option.label, 'deck-choice-btn', () => choose(option.value), pd.busy));
        if (option.preview) row.appendChild(el('span', 'deck-muted', option.preview));
        section.appendChild(row);
      }
      body.appendChild(section);
    } else {
      if (pd.decks.length > 1) {
        const label = el('label', 'deck-field', 'Deck');
        const select = el('select', 'forage-select');
        for (const entry of pd.decks) {
          const option = el('option', null, entry.name);
          option.value = entry.id;
          option.selected = entry.id === currentDeck()?.id;
          select.appendChild(option);
        }
        select.addEventListener('change', () => { pd.deckId = select.value; render(); });
        label.appendChild(select);
        body.appendChild(label);
      } else if (currentDeck()) {
        body.appendChild(el('p', null, currentDeck().name)).style.fontWeight = '700';
      }
      if (currentDeck()?.description) {
        const details = el('details', 'deck-about');
        details.open = pd.openAbout; // survives re-renders
        details.addEventListener('toggle', () => { pd.openAbout = details.open; });
        details.appendChild(el('summary', null, 'About this deck'));
        details.appendChild(el('p', 'deck-muted deck-description', currentDeck().description));
        body.appendChild(details);
      }
      if (pd.result) {
        const section = el('section', 'deck-section');
        const title = el('h3', null, `${cardTitle(pd.result.card)} `);
        title.appendChild(badge(pd.result.success));
        section.appendChild(title);
        appendDrawDetails(section, pd.result);
        body.appendChild(section);
      }
      const actions = el('div', 'actions deck-actions');
      const drawBtn = button(pd.result ? 'Draw another card' : 'Draw a card', 'deck-draw-btn', draw, pd.busy || !currentDeck());
      actions.appendChild(drawBtn);
      body.appendChild(actions);
      if (pd.focusDraw) { pd.focusDraw = false; drawBtn.focus(); }
    }

    if (pd.message) {
      const note = el('p', 'forage-msg', pd.message);
      note.setAttribute('role', 'alert');
      body.appendChild(note);
    }

    if (pd.recent.length) {
      const details = el('details', 'deck-recent');
      details.open = pd.openRecent; // survives re-renders
      details.addEventListener('toggle', () => { pd.openRecent = details.open; });
      details.appendChild(el('summary', null, `Recent draws (${pd.recent.length})`));
      for (const entry of pd.recent) {
        const row = el('div', 'deck-recent-row');
        const line = el('p', null, recentLine(entry));
        if (statusTag(entry)) { line.appendChild(document.createTextNode(' ')); line.appendChild(el('span', 'deck-badge', statusTag(entry))); }
        row.appendChild(line);
        if (entry.status === 'resolved') for (const text of resultLines(entry)) row.appendChild(el('p', 'deck-muted', text));
        details.appendChild(row);
      }
      body.appendChild(details);
    }
  }

  // Only the latest load may write state: an older GET that returns after an action must not flip the
  // popup back (e.g. to the Ace screen after choose()). Every action bumps loadSeq too.
  async function load() {
    const seq = ++pd.loadSeq;
    const characterId = pd.characterId;
    const res = await api('GET', `${API}?characterId=${encodeURIComponent(characterId)}`);
    if (seq !== pd.loadSeq || !pd.open || pd.characterId !== characterId) return;
    pd.loading = false;
    if (!res.ok) { pd.message = errorText(res.data?.error); render(); return; }
    pd.decks = res.data.decks || [];
    if (!pd.decks.some((entry) => entry.id === pd.deckId)) pd.deckId = pd.decks[0]?.id || '';
    pd.choosing = res.data.choosing ?? null;
    pd.recent = res.data.recent || [];
    availability.set(availKey(characterId), { decks: pd.decks, choosing: pd.choosing, at: Date.now() });
    refreshButtons();
    render();
  }

  async function draw() {
    const deck = currentDeck();
    if (!deck || pd.busy) return;
    pd.busy = true; pd.loadSeq += 1; pd.message = ''; pd.result = null; // busy is set before the first await
    render();
    const { ok, status, data } = await api('POST', `${API}/draw`, { characterId: pd.characterId, deckId: deck.id });
    if (ok) {
      if (data.status === 'choosing') pd.choosing = data.draw; else pd.result = data.draw;
    } else {
      // 409 'choosing' carries the undecided draw: resume at the Ace choice.
      if (status === 409 && data?.draw) pd.choosing = data.draw;
      pd.message = errorText(data?.error);
    }
    pd.busy = false;
    render();
    await load();
  }

  async function choose(value) {
    if (!pd.choosing || pd.busy) return;
    pd.busy = true; pd.loadSeq += 1; pd.message = '';
    render();
    const { ok, data } = await api('POST', `${API}/draws/${encodeURIComponent(pd.choosing.id)}/choose`, { value });
    if (ok) { pd.result = data.draw; pd.choosing = null; } else pd.message = errorText(data?.error);
    pd.busy = false;
    render();
    await load();
  }

  function openPlayer(tokenId) {
    const token = deps.getSession()?.tokens?.[tokenId];
    if (!token?.characterId) return;
    Object.assign(pd, {
      open: true, openAbout: false, openRecent: false, characterId: token.characterId, decks: availability.get(availKey(token.characterId))?.decks || [],
      deckId: '', loading: true, busy: false, message: '', choosing: null, result: null, recent: [], focusDraw: true
    });
    pd.deckId = pd.decks[0]?.id || '';
    modal.classList.add('visible');
    deps.bringModalToFront(modal);
    render();
    load();
  }

  function closePlayer() {
    pd.open = false;
    pd.loadSeq += 1; // a GET still in flight must not touch the closed popup
    modal.classList.remove('visible');
    body.replaceChildren();
  }

  // Closing loses nothing, so backdrop press and Escape are fine.
  deps.closeOnBackdropPress(modal, closePlayer);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !modal.classList.contains('visible')) return;
    const zOf = (node) => Number(getComputedStyle(node).zIndex) || 0;
    const higher = [...document.querySelectorAll('.modal-overlay.visible')].some((node) => node !== modal && zOf(node) > zOf(modal));
    if (!higher) closePlayer();
  });

  // One delegated listener on the sidebar (its contents are replaced, the element is not).
  deps.sidebarEl.addEventListener('click', (event) => {
    const open = event.target.closest('.deckBtn');
    if (open) openPlayer(open.dataset.deckToken);
  });

  // ---------------------------------------------------------------------------------------------
  // TOASTS: a dismissable card for everyone. The drawer's own open popup already shows the result,
  // so it is skipped there.
  // ---------------------------------------------------------------------------------------------
  function showToast(titleText, draw, showDetails) {
    const toast = el('div', 'deck-toast');
    toast.setAttribute('role', 'status');
    const head = el('div', 'deck-toast-head');
    head.appendChild(el('strong', null, titleText));
    const dismiss = button('Close', 'secondary deck-toast-close', () => toast.remove());
    dismiss.setAttribute('aria-label', 'Dismiss');
    head.appendChild(dismiss);
    toast.appendChild(head);
    if (showDetails) appendDrawDetails(toast, draw);
    else if (draw.revertNote) toast.appendChild(el('p', 'deck-muted', draw.revertNote));
    toasts.appendChild(toast);
    while (toasts.children.length > MAX_TOASTS) toasts.firstElementChild.remove();
    setTimeout(() => toast.remove(), TOAST_MS);
  }

  // ---------------------------------------------------------------------------------------------
  // GM block. State: open tasks (from GET ?tasks=1 and deck:tasks) and the last resolved draw.
  // ---------------------------------------------------------------------------------------------
  const gm = { campaignId: null, tasks: [], last: null, busy: false, message: '', loadSeq: 0 };
  const campaignId = () => deps.getCampaignId();

  function gmBlockNodes() {
    const nodes = [];
    if (!gm.tasks.length && !gm.last && !gm.message) return nodes;
    nodes.push(el('h2', null, 'Deck'));
    for (const task of gm.tasks) {
      const row = el('div', 'deck-gm-row');
      row.appendChild(el('span', 'deck-gm-text', gmTaskLine(task)));
      const done = button('Done', 'secondary deck-gm-btn', () => taskDone(task.drawId, task.taskId), gm.busy);
      row.appendChild(done);
      nodes.push(row);
    }
    if (gm.last) {
      const row = el('div', 'deck-gm-row');
      row.appendChild(el('span', 'deck-gm-text', lastDrawLine(gm.last)));
      const undo = button('Undo', 'secondary deck-gm-btn', undoLast, gm.busy);
      row.appendChild(undo);
      nodes.push(row);
    }
    if (gm.message) nodes.push(el('p', 'forage-msg', gm.message));
    return nodes;
  }

  // Called from main.js's room info; the block is redrawn in place by refreshGmBlock, never by renderSidebar.
  function deckControlHtml() {
    if (deps.getRole() !== 'gm' || !campaignId()) return '';
    return '<div id="deckControl"></div>';
  }

  function refreshGmBlock() {
    const host = document.getElementById('deckControl');
    if (host) host.replaceChildren(...gmBlockNodes());
  }

  // The sidebar calls this after it rebuilds (deckControl is a fresh empty div each time).
  function afterSidebarRender() {
    refreshGmBlock();
    refreshButtons();
  }

  async function loadGm() {
    if (deps.getRole() !== 'gm' || !campaignId()) return;
    // A GM who moved to another campaign's room must never see the old room's tasks.
    if (gm.campaignId !== campaignId()) Object.assign(gm, { campaignId: campaignId(), tasks: [], last: null, message: '' });
    const seq = ++gm.loadSeq;
    const id = encodeURIComponent(campaignId());
    const [tasks, draws] = await Promise.all([api('GET', `${API}?campaignId=${id}&tasks=1`), api('GET', `${API}?campaignId=${id}`)]);
    if (seq !== gm.loadSeq) return;
    if (tasks.ok && Array.isArray(tasks.data.tasks)) gm.tasks = tasks.data.tasks;
    if (draws.ok && Array.isArray(draws.data.draws)) gm.last = draws.data.draws.find((entry) => entry.status === 'resolved') || null;
    refreshGmBlock();
  }

  async function taskDone(drawId, taskId) {
    if (gm.busy) return;
    gm.busy = true; gm.loadSeq += 1; gm.message = ''; // busy before the first await
    refreshGmBlock();
    const { ok, data } = await api('POST', `${API}/draws/${encodeURIComponent(drawId)}/tasks`, { taskId, done: true });
    gm.busy = false;
    if (!ok) gm.message = errorText(data?.error);
    await loadGm();
    refreshGmBlock();
  }

  async function undoLast() {
    const last = gm.last;
    if (!last || gm.busy) return;
    if (!window.confirm(`Undo ${recentLine(last)}? This reverses what it changed.`)) return;
    gm.busy = true; gm.loadSeq += 1; gm.message = '';
    refreshGmBlock();
    const { ok, data } = await api('POST', `${API}/draws/${encodeURIComponent(last.id)}/undo`);
    gm.busy = false;
    if (!ok) gm.message = errorText(data?.error);
    await loadGm();
    refreshGmBlock();
  }

  // ---------------------------------------------------------------------------------------------
  // Message hooks (called from main.js's handleMessage)
  // ---------------------------------------------------------------------------------------------
  function onStateFull() {
    // A reconnect may follow a DM enabling or disabling a deck: re-ask for every character we know of.
    for (const key of [...availability.keys()]) if (key.startsWith(`${deps.getSessionId()}|`)) askAvailability(key.slice(key.indexOf('|') + 1));
    if (pd.open && !pd.busy) load();
    loadGm();
    refreshButtons();
  }

  function onDrawn(msg) {
    const draw = msg.draw;
    if (!draw) return;
    const mine = pd.open && pd.characterId === draw.drawerCharacterId;
    if (!mine) showToast(drawnTitle(draw), draw, true);
    if (deps.getRole() === 'gm' && draw.status === 'resolved') { gm.last = draw; refreshGmBlock(); }
    // Another party member's draw changes the recent list in an open popup (not mid-action).
    if (pd.open && !pd.busy) load();
  }

  function onUndone(msg) {
    const draw = msg.draw;
    if (!draw) return;
    showToast(undoneTitle(draw), draw, false);
    if (deps.getRole() === 'gm') loadGm();
    if (pd.open && !pd.busy) load();
  }

  function onTasks(msg) {
    if (deps.getRole() !== 'gm' || msg.campaignId !== campaignId() || !Array.isArray(msg.open)) return;
    gm.tasks = msg.open;
    refreshGmBlock();
  }

  return { deckButtonHtml, deckControlHtml, afterSidebarRender, refreshButtons, onStateFull, onDrawn, onUndone, onTasks };
}
