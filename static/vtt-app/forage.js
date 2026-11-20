// VTT forage client (vtt-forage plan, unit C). Plain unbundled JS, loaded by main.js.
//
// Two surfaces share the same fields:
//   - the PLAYER popup (#foragePlayerModal): pick skill/area/category, then either wait for the DM
//     (DM mode) or mark the check yourself (self-serve, room with no account GM), then the result.
//   - the GM popup (#forageModal): pre-filled from the player's picks, roll check, pass/fail, edit
//     and approve the haul. It has NO backdrop or Escape close, because closing would cancel a
//     player's request. "Hide" tucks it away without cancelling (the sidebar line reopens it).
//
// The server decides the mode and does every roll. This file only sends choices and shows what the
// server broadcasts (forage:update / forage:closed) or returns. It never asks for a full sidebar
// rebuild: it updates its own modals and two small spots in the sidebar (the Forage buttons and the
// GM's "request waiting" line) directly.
//
// "Share with party" (unit D) calls POST /vtt/api/finds/[id]/share from the result card.

import {
  addLine, addableEntries, areaOptions, canApprove, canSubmitPicks, canSubmitSelf, categoryOptions, chosenTable,
  defaultPicks, defaultSelfPicks, dmResult, errorText, forageButtonLabel, forageUnavailableReason, forageUnavailableText, LAST_GM_PICKS_KEY, LAST_PICKS_KEY,
  linesPayload, natBadgeText, canShareRecent, recentFindItemsText, recentFindStatusText, parseQty, parseSavedPicks, pickableTables, queueLabel,
  removeLine, requestSignature, resolveTable, resultHeadline, selfAreas, selfCategories,
  selfResult, setLineQty, sortedRequests, tagLabel, tableLineText, chanceLabel
} from './shared/forageView.js';

const PLAYER_API = '/vtt/api/forage';

// One small fetch helper: never throws, always { ok, status, data }. Error codes map to text via errorText.
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

export function createForage(deps) {
  const { escapeHtml: esc, advSourceLabel, advReadoutText, counterRowHtml } = deps;
  const getSession = deps.getSession;

  const playerModal = document.getElementById('foragePlayerModal');
  const playerBody = document.getElementById('foragePlayerBody');
  const gmModal = document.getElementById('forageModal');
  const gmBody = document.getElementById('forageModalBody');
  const gmQueue = document.getElementById('forageQueue');
  const gmNotice = document.getElementById('forageNotice');

  // The visible overlay with the highest z-index wins; on a tie, the later one in the document.
  function isTopmostModal(el) {
    const zOf = (node) => Number(getComputedStyle(node).zIndex) || 0;
    const visible = [...document.querySelectorAll('.modal-overlay.visible')];
    const top = visible.reduce((best, node) => (zOf(node) >= zOf(best) ? node : best), visible[0]);
    return top === el;
  }

  const otherModalOpen = () => !!document.querySelector('.modal-overlay.visible:not(#foragePlayerModal):not(#forageModal)');

  // ---------------------------------------------------------------------------------------------
  // Advantage panel, shared by both popups. State: { status, sources, disabled:Set, adv, dis }.
  // Every lookup is scoped to the popup's own root, so it never clashes with the attack card's panel.
  // ---------------------------------------------------------------------------------------------
  function newAdv(saved) {
    return {
      status: 'loading', sources: [], disabled: new Set(saved?.disabled || []),
      adv: saved?.situationalAdvantage || 0, dis: saved?.situationalDisadvantage || 0
    };
  }
  const advBody = (a) => ({ disabled: [...a.disabled], situationalAdvantage: a.adv, situationalDisadvantage: a.dis });

  function advPanelHtml(a) {
    return `
      <div class="adv-panel">
        <h4>Advantage</h4>
        <div class="attack-subtext" data-fg="advStatus"></div>
        <div data-fg="advSources"></div>
        ${counterRowHtml('Advantage', 'adv', a.adv)}
        ${counterRowHtml('Disadvantage', 'dis', a.dis)}
        <div class="attack-subtext">Each point counts as one source. Advantage and disadvantage cancel one for one.</div>
        <div class="adv-readout" data-fg="advReadout"></div>
      </div>`;
  }

  // Repaints only what depends on state. The tick boxes are rebuilt only when the source list itself
  // changes, so a focused checkbox keeps its focus.
  function refreshAdvPanel(root, a) {
    const status = root.querySelector('[data-fg="advStatus"]');
    if (status) status.textContent = a.status === 'loading' ? 'Checking advantage…' : a.status === 'failed' ? "Couldn't check modifiers, the roll will still apply them" : '';
    const sourcesEl = root.querySelector('[data-fg="advSources"]');
    const key = a.sources.map((s) => s.id).join('|');
    if (sourcesEl && sourcesEl.dataset.renderedKey !== key) {
      sourcesEl.dataset.renderedKey = key;
      sourcesEl.innerHTML = a.sources.map((s) => `
        <label class="adv-source"><input type="checkbox" class="fgAdvSource" data-source-id="${esc(s.id)}" ${a.disabled.has(s.id) ? '' : 'checked'} /> ${esc(advSourceLabel(s))}</label>`).join('');
    }
    const readout = root.querySelector('[data-fg="advReadout"]');
    if (readout) readout.textContent = advReadoutText(a);
    for (const kind of ['adv', 'dis']) {
      const el = root.querySelector(`[data-adv-value="${kind}"]`);
      if (el) el.textContent = String(a[kind]);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Pickers (skill, area, category, resolved table). `cur` is the live binding for a popup:
  //   { picks, adv, tables, skills, suggestedFor?(table), onSkill(), onChange() }
  // The body is rebuilt on a phase change, but typing in a field only touches the bits below.
  // ---------------------------------------------------------------------------------------------
  const withCurrent = (list, value) => (value && !list.includes(value) ? [...list, value] : list);

  function optionsHtml(values, selected, label = (v) => v) {
    return values.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
  }

  function pickerHtml(cur) {
    const areas = withCurrent(areaOptions(cur.tables), cur.picks.areaType);
    const categories = withCurrent(categoryOptions(cur.tables), cur.picks.category);
    return `
      <div class="field"><label>Skill</label>
        <select class="forage-select" data-fg-field="skillKey">${cur.skills.map((s) => `<option value="${esc(s.key)}" ${s.key === cur.picks.skillKey ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="forage-row">
        <div class="field"><label>Area type</label>
          <select class="forage-select" data-fg-field="areaType">${areas.length ? optionsHtml(areas, cur.picks.areaType) : '<option value="">(no tables yet)</option>'}</select></div>
        <div class="field"><label>Category</label>
          <select class="forage-select" data-fg-field="category">${optionsHtml(categories, cur.picks.category)}</select></div>
      </div>
      <div class="forage-table-line" data-fg="tableLine"></div>
      <div class="attack-subtext" data-fg="suggested"></div>
      <div class="field" data-fg="tableFallback"></div>
      ${advPanelHtml(cur.adv)}`;
  }

  // The SELF-SERVE player's pickers (Rev 4): a short skill list, plus an area and a category as plain
  // labels. No table name, no counts, no table picker. Any area + category can be foraged: one with
  // nothing to find looks exactly the same here, and a pass just finds nothing.
  function selfPickerHtml(cur) {
    const areas = selfAreas(cur.options);
    const categories = selfCategories(cur.options);
    return `
      <div class="field"><label>Skill</label>
        <select class="forage-select" data-fg-field="skillKey">${cur.skills.map((s) => `<option value="${esc(s.key)}" ${s.key === cur.picks.skillKey ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="forage-row">
        <div class="field"><label>Where</label>
          <select class="forage-select" data-fg-field="areaType">${optionsHtml(areas, cur.picks.areaType, tagLabel)}</select></div>
        <div class="field"><label>Looking for</label>
          <select class="forage-select" data-fg-field="category">${optionsHtml(categories, cur.picks.category, tagLabel)}</select></div>
      </div>
      ${advPanelHtml(cur.adv)}`;
  }

  function refreshSelfPicker(root, cur) {
    const submit = root.querySelector('[data-fg="submit"]');
    if (submit) submit.disabled = !canSubmitSelf(cur.options, cur.picks) || !!cur.busy || cur.adv?.status === 'loading';
  }

  // DM mode: the player sees only the adv/dis counters, so the only thing to gate is the preview.
  function refreshDmForm(root, cur) {
    const submit = root.querySelector('[data-fg="submit"]');
    if (submit) submit.disabled = !!cur.busy || cur.adv?.status === 'loading';
  }

  // GM popup: updates the resolved-table line, the "Use table" fallback, and the submit button.
  function refreshPicker(root, cur) {
    const table = chosenTable(cur.tables, cur.picks);
    const line = root.querySelector('[data-fg="tableLine"]');
    if (line) {
      line.textContent = tableLineText(table, cur.picks);
      line.classList.toggle('forage-warn', !table || table.pickableCount === 0);
    }
    const suggested = root.querySelector('[data-fg="suggested"]');
    if (suggested) {
      const text = table && cur.suggestedFor ? cur.suggestedFor(table) : '';
      suggested.textContent = text ? `Suggested check: ${text}` : '';
    }
    // Offer a manual table when there is no table for this area + category, or it is empty.
    const natural = resolveTable(cur.tables, cur.picks.areaType, cur.picks.category);
    const fallback = root.querySelector('[data-fg="tableFallback"]');
    if (fallback) {
      const needed = !natural || natural.pickableCount === 0;
      const usable = pickableTables(cur.tables);
      fallback.innerHTML = needed
        ? `<label>Use table</label><select class="forage-select" data-fg-field="manualTable"><option value="">Choose a table…</option>${usable.map((t) => `<option value="${esc(t.id)}" ${t.id === cur.picks.manualTableId ? 'selected' : ''}>${esc(t.name)} (${esc(t.areaType)} + ${esc(t.category)})</option>`).join('')}</select>`
        : '';
    }
    const submit = root.querySelector('[data-fg="submit"]');
    // Also held while the advantage preview is still loading, so a very quick tap on Roll check can't
    // race the preview request.
    if (submit) submit.disabled = !canSubmitPicks(cur.tables, cur.picks) || !!cur.busy || cur.adv?.status === 'loading';
  }

  // One delegated listener set per popup body (the body's innerHTML is replaced, the element is not).
  function attachPickerEvents(root, getCur) {
    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-adv-kind]');
      const cur = getCur();
      if (!button || !cur || !cur.adv) return;
      const kind = button.dataset.advKind;
      cur.adv[kind] = Math.max(0, Math.min(5, cur.adv[kind] + Number(button.dataset.advStep)));
      refreshAdvPanel(root, cur.adv);
    });
    root.addEventListener('change', (event) => {
      const cur = getCur();
      if (!cur) return;
      const box = event.target.closest('.fgAdvSource');
      if (box && cur.adv) {
        if (box.checked) cur.adv.disabled.delete(box.dataset.sourceId);
        else cur.adv.disabled.add(box.dataset.sourceId);
        refreshAdvPanel(root, cur.adv);
        return;
      }
      const field = event.target.closest('[data-fg-field]');
      if (!field || !cur.picks) return;
      const name = field.dataset.fgField;
      if (name === 'manualTable') {
        cur.picks.manualTableId = field.value;
      } else {
        cur.picks[name] = field.value;
        if (name !== 'skillKey') cur.picks.manualTableId = ''; // a new area or category re-resolves the table
      }
      if (name === 'skillKey' && cur.onSkill) cur.onSkill();
      (cur.refresh || refreshPicker)(root, cur);
      if (cur.onChange) cur.onChange();
    });
  }

  function checkHtml(check) {
    if (!check) return '';
    const nat = natBadgeText(check);
    return `
      <div class="forage-check">
        <div class="forage-check-total">${esc(check.skillLabel)} <strong>${check.total}</strong>${nat ? ` <span class="forage-badge ${check.nat20 ? 'good' : 'bad'}">${nat}</span>` : ''}</div>
        <div class="attack-subtext">d20: ${check.natural}${check.poolSummary ? ` · ${esc(check.poolSummary)}` : ''}</div>
        <details><summary>How it was rolled</summary><pre class="attack-roll-block">${esc(check.text)}</pre></details>
      </div>`;
  }

  const linesListHtml = (lines) => lines.map((l) => `<li><strong>${l.qty}×</strong> ${esc(l.name)}</li>`).join('');

  // ---------------------------------------------------------------------------------------------
  // PLAYER popup
  // ---------------------------------------------------------------------------------------------
  // localResult is deliberately outside resetPf: a self-serve result has no server copy in the room,
  // so it has to survive the popup closing until the player dismisses it.
  const pf = { open: false, localResult: null };
  let playerCur = null; // the picker binding while the form is showing

  function resetPf(tokenId, characterId) {
    Object.assign(pf, {
      open: true, loading: true, tokenId, characterId, options: null, skills: null, mine: null,
      picks: null, adv: null, self: null, forceForm: false, busy: false, message: '', previewSeq: 0,
      recent: { status: 'idle', finds: [], message: '' }, recentOpen: false
    });
  }

  const playerKey = () => deps.getPlayerId();
  const myPending = () => getSession()?.forage?.[playerKey()] || null;
  const myServerResult = () => getSession()?.forageResults?.[playerKey()] || null;
  const currentResult = () => pf.localResult || (myServerResult() ? dmResult(myServerResult()) : null);

  function showPlayerModal() {
    deps.bringModalToFront(playerModal);
    playerModal.classList.add('visible');
  }
  function closePlayer() {
    pf.open = false;
    playerCur = null;
    playerModal.classList.remove('visible');
    playerBody.innerHTML = '';
    refreshButtons();
  }

  async function openPlayerForage(tokenId) {
    const session = getSession();
    const token = session?.tokens?.[tokenId];
    if (!token?.characterId) return;
    resetPf(tokenId, token.characterId);
    showPlayerModal();
    renderPlayer();

    const roomId = encodeURIComponent(deps.getSessionId());
    const mineRes = await api('GET', `${PLAYER_API}/mine?characterId=${encodeURIComponent(token.characterId)}&roomId=${roomId}`);
    if (!pf.open || pf.tokenId !== tokenId) return; // closed or switched while loading
    applyMine(mineRes.ok ? mineRes.data : null);
    pf.adv = newAdv(null);
    // Find tables belong to campaigns: when forage is off for this character the popup just says why.
    if (offReason()) { pf.loading = false; renderPlayer(); refreshButtons(); return; }
    // In DM mode the player picks nothing, so the pickers' data is only fetched when there is no DM.
    if (!dmMode()) await loadSelfOptions();
    if (!pf.open || pf.tokenId !== tokenId) return;
    pf.loading = false;
    renderPlayer();
    refreshButtons();
  }

  // A DM is present and will run the check (the server still decides at submit time).
  const dmMode = () => pf.mine?.dmPresent === true;

  // Is forage off for the popup's character (no campaign, wrong room, no tables)? '' when it works, or
  // when something already started can still be finished (the server keeps those resumable).
  const offReason = () => forageUnavailableReason(pf.mine, pf.characterId);

  // The self-serve pickers' data: a short skill list and separate area and category tag lists (never
  // pairs). The server sends no table names, ids or counts to a player.
  async function loadSelfOptions() {
    // The tables are the CHARACTER'S campaign's, so the server needs to know which character (owner-checked).
    const res = await api('GET', `${PLAYER_API}/tables?roomId=${encodeURIComponent(deps.getSessionId())}&characterId=${encodeURIComponent(pf.characterId)}`);
    if (!res.ok) { pf.message = errorText(res.data); return; }
    pf.skills = res.data.skills;
    pf.options = { areas: res.data.areas || [], categories: res.data.categories || [] };
    pf.picks = defaultSelfPicks(pf.skills, pf.options, readPicks(LAST_PICKS_KEY));
  }

  // Folds the server's view of this finder (from /forage/mine) into local state.
  function applyMine(mine) {
    pf.mine = mine;
    if (!mine) return;
    rememberAvailability(pf.characterId, mine);
    const session = getSession();
    session.forage = session.forage || {};
    session.forageResults = session.forageResults || {};
    if (mine.pending && mine.pendingRoomId === deps.getSessionId() && !session.forage[playerKey()]) session.forage[playerKey()] = mine.pending;
    if (!mine.pending && session.forage[playerKey()]) delete session.forage[playerKey()]; // it ended while we were away
    if (mine.lastDm && !session.forageResults[playerKey()]) session.forageResults[playerKey()] = mine.lastDm;
    if (mine.unmarkedSelf) pf.self = { findId: mine.unmarkedSelf.findId, check: mine.unmarkedSelf.check };
  }

  // Remembered picks. A player's self-serve picks use the shared key (the character sheet reads and
  // writes the same one); the DM's own last picks use a separate GM-side key. Never throws.
  function readPicks(key) {
    try { return parseSavedPicks(localStorage.getItem(key)); } catch { return {}; }
  }
  function writePicks(key, picks) {
    try {
      localStorage.setItem(key, JSON.stringify({ skillKey: picks.skillKey, areaType: picks.areaType, category: picks.category }));
    } catch { /* storage blocked: the picks just aren't remembered */ }
  }

  function playerPhase() {
    if (pf.loading) return 'loading';
    if (myPending()) return 'waiting';
    if (pf.self) return 'mark';
    if (currentResult() && !pf.forceForm) return 'result';
    return 'form';
  }

  function canWithdrawNow(pending) {
    if (pending.stage === 'approving') return false;
    return pending.stage === 'requested' || pf.mine?.dmPresent === false;
  }

  function renderPlayer() {
    if (!pf.open) return;
    const phase = playerPhase();
    const pending = myPending();
    const result = currentResult();
    playerCur = null;

    const msg = pf.message ? `<div class="forage-msg">${esc(pf.message)}</div>` : '';
    const closeBtn = (label = 'Close') => `<button type="button" class="secondary" data-fg-act="close">${label}</button>`;
    let html = '<h2>Forage</h2>';

    if (phase === 'loading') {
      html += '<p class="attack-subtext">Loading…</p>';
    } else if (phase === 'waiting') {
      const stage = pending.stage;
      html += checkHtml(pending.check);
      html += stage === 'requested' ? '<p>Sent to the DM. Waiting…</p>'
        : stage === 'checked' ? '<p>The DM has your check and is deciding if it counts…</p>'
          : '<p>The DM is working out what you find…</p>';
      if (pf.mine?.dmPresent === false) html += '<p class="forage-warn">The DM has disconnected. You can withdraw and forage on your own.</p>';
      html += `${msg}<div class="actions">${closeBtn()}
        ${stage !== 'requested' && stage !== 'approving' ? '<button type="button" class="secondary" data-fg-act="recheck">Is the DM still here?</button>' : ''}
        ${canWithdrawNow(pending) ? '<button type="button" class="secondary" data-fg-act="withdraw">Withdraw</button>' : ''}</div>`;
    } else if (phase === 'mark') {
      const check = pf.self.check;
      html += checkHtml(check);
      html += `<p>Did you beat the DM's DC?</p>${check.nat1 ? '<p class="attack-subtext">A natural 1 always fails.</p>' : ''}`;
      html += `${msg}<div class="actions">${closeBtn('Later')}
        <button type="button" class="secondary" data-fg-act="markFail" ${pf.busy ? 'disabled' : ''}>Fail</button>
        <button type="button" data-fg-act="markPass" data-fg="primary" ${pf.busy || check.nat1 ? 'disabled' : ''}>Pass</button></div>`;
    } else if (phase === 'result') {
      html += resultHtml(result, msg);
    } else {
      // form
      const dm = dmMode();
      if (offReason()) {
        html += `<p class="forage-warn">${esc(forageUnavailableText(offReason()))}</p>${msg}<div class="actions">${closeBtn()}</div>`;
      } else if (!dm && !(pf.options && pf.picks)) {
        // No DM and the pickers' data didn't load (or there is nothing to forage for).
        html += `${msg}${recentHtml()}<div class="actions">${closeBtn()}</div>`;
      } else {
        // `busy` is a getter so the refresh functions always see the current value.
        playerCur = dm
          ? { picks: null, adv: pf.adv, refresh: refreshDmForm, get busy() { return pf.busy; } }
          : {
            picks: pf.picks, adv: pf.adv, options: pf.options, skills: pf.skills, refresh: refreshSelfPicker,
            get busy() { return pf.busy; },
            onSkill: () => { pf.adv.disabled = new Set(); pf.adv.status = 'loading'; loadPlayerPreview(); }
          };
        // DM mode: only the counters (and any of your own sources that apply). The DM picks the rest.
        html += dm
          ? `<p>The DM will call the check.</p>${advPanelHtml(pf.adv)}`
          : `<p class="attack-subtext">No DM connected, you will mark the check yourself.</p>${selfPickerHtml(playerCur)}`;
        html += `${msg}${recentHtml()}<div class="actions">${closeBtn()}<button type="button" data-fg="submit" data-fg-act="submit">Forage</button></div>`;
      }
    }

    playerBody.innerHTML = html;
    if (phase === 'form' && playerCur) {
      playerCur.refresh(playerBody, playerCur);
      refreshAdvPanel(playerBody, pf.adv);
      if (pf.adv.status === 'loading') loadPlayerPreview();
      playerBody.querySelector('[data-fg="submit"]')?.focus();
    } else {
      playerBody.querySelector('[data-fg="primary"]:not(:disabled)')?.focus();
    }
    if (phase === 'form' && pf.recentOpen && pf.recent.status === 'idle') loadRecent();
  }

  // "Recent finds": the finder's own last few finds, collapsed by default and fetched only when it is
  // opened. It lets a find be shared after its result card is gone (a self-serve find with no game
  // session has no other way). Rows carry no table names (Rev 4).
  function recentHtml() {
    return `<details class="forage-recent" data-fg="recentBox" ${pf.recentOpen ? 'open' : ''}>
      <summary>Recent finds</summary><div data-fg="recent">${recentInnerHtml()}</div></details>`;
  }

  function recentInnerHtml() {
    const r = pf.recent;
    const note = r.message ? `<div class="forage-msg">${esc(r.message)}</div>` : '';
    if (r.status === 'idle' || r.status === 'loading') return '<p class="attack-subtext">Loading…</p>';
    if (r.status === 'failed') return `${note || `<div class="forage-msg">${esc(errorText({ error: 'network' }))}</div>`}`;
    if (!r.finds.length) return `${note}<p class="attack-subtext">Nothing found yet.</p>`;
    return `${note}<ul class="forage-recent-list">${r.finds.map((find) => `
      <li><div><strong>${esc(recentFindItemsText(find))}</strong>
        <div class="attack-subtext">${esc(new Date(find.createdAt).toLocaleString())} · ${esc(recentFindStatusText(find))}</div></div>
        ${canShareRecent(find) ? `<button type="button" class="secondary" data-fg-act="shareRecent" data-find-id="${esc(find.id)}" ${pf.busy ? 'disabled' : ''}>Share</button>` : ''}</li>`).join('')}</ul>`;
  }

  function paintRecent() {
    const box = playerBody.querySelector('[data-fg="recent"]');
    if (box) box.innerHTML = recentInnerHtml();
  }

  async function loadRecent() {
    if (!pf.open || pf.recent.status === 'loading') return;
    const characterId = pf.characterId;
    pf.recent.status = 'loading';
    paintRecent();
    const res = await api('GET', `${PLAYER_API}/recent?characterId=${encodeURIComponent(characterId)}`);
    if (!pf.open || pf.characterId !== characterId) return;
    if (res.ok) { pf.recent.status = 'ready'; pf.recent.finds = res.data.finds || []; pf.recent.message = ''; }
    else { pf.recent.status = 'failed'; pf.recent.message = errorText(res.data); }
    paintRecent();
  }

  async function shareRecent(findId) {
    if (pf.busy || !findId) return;
    pf.busy = true;
    pf.recent.message = '';
    paintRecent();
    const res = await api('POST', `/vtt/api/finds/${encodeURIComponent(findId)}/share`);
    pf.busy = false;
    if (!pf.open) return;
    if (res.ok) {
      const row = pf.recent.finds.find((find) => find.id === findId);
      if (row) row.shared = true;
      const server = myServerResult();
      if (server && server.findId === findId) server.shared = true;
    } else {
      pf.recent.message = errorText(res.data);
    }
    paintRecent();
  }

  // The result step, for both modes. "Share with party" shows for a standing haul (it has a findId and
  // lines). One way: once shared it becomes a disabled "Shared with the party" note. Item names only
  // go public through this explicit share.
  function resultHtml(result, msg) {
    let html = `<p><strong>${esc(resultHeadline(result))}</strong></p>${checkHtml(result.check)}`;
    const hasHaul = !!(result.lines && result.lines.length);
    if (hasHaul) {
      html += `<ul class="forage-lines">${linesListHtml(result.lines)}</ul>
        <p class="attack-subtext">Added to your inventory. If your character sheet is open, it updates when you're not mid-edit.</p>`;
    }
    const share = hasHaul && result.findId
      ? (result.shared
        ? '<button type="button" class="secondary" disabled>Shared with the party</button>'
        : `<button type="button" class="secondary" data-fg-act="share" ${pf.busy ? 'disabled' : ''}>Share with party</button>`)
      : '';
    return `${html}${msg}<div class="actions">${share}
      <button type="button" class="secondary" data-fg-act="again">Forage again</button>
      <button type="button" data-fg-act="dismiss" data-fg="primary">Dismiss</button></div>`;
  }

  // Sources for the advantage panel, without rolling anything.
  async function loadPlayerPreview() {
    if (!pf.open) return;
    const seq = ++pf.previewSeq;
    // DM mode sends no skill (the server shows only sources that apply to any check).
    const res = await api('POST', PLAYER_API, {
      action: 'preview', characterId: pf.characterId, roomId: deps.getSessionId(), tokenId: pf.tokenId,
      ...(dmMode() ? {} : { skillKey: pf.picks.skillKey }), advantage: advBody(pf.adv)
    });
    if (seq !== pf.previewSeq || !pf.open || !playerCur) return; // stale, or the form is gone
    pf.adv.status = res.ok ? 'ready' : 'failed';
    pf.adv.sources = res.ok ? (res.data.sources || []).filter((s) => s.origin !== 'situational') : [];
    refreshAdvPanel(playerBody, pf.adv);
    playerCur.refresh(playerBody, playerCur);
  }

  async function submitPlayer() {
    const dm = dmMode();
    if (pf.busy || (!dm && !canSubmitSelf(pf.options, pf.picks))) return;
    pf.busy = true;
    pf.message = '';
    playerBody.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    // DM mode sends only the counters. Self-serve sends skill, area and category, never a table.
    if (!dm) writePicks(LAST_PICKS_KEY, pf.picks);
    const res = await api('POST', PLAYER_API, {
      action: 'start', characterId: pf.characterId, roomId: deps.getSessionId(), tokenId: pf.tokenId,
      ...(dm ? {} : { skillKey: pf.picks.skillKey, areaType: pf.picks.areaType, category: pf.picks.category }),
      advantage: advBody(pf.adv)
    });
    pf.busy = false;
    if (!pf.open) return;
    if (res.ok) {
      pf.localResult = null;
      pf.forceForm = false; // the new forage's own result must show when it closes
      // A new forage replaces any old DM-mode result: drop the client copy and clear the room's too.
      const session0 = getSession();
      const old = session0.forageResults?.[playerKey()];
      if (old) {
        api('POST', PLAYER_API, { action: 'dismiss', requestId: old.requestId });
        delete session0.forageResults[playerKey()];
      }
      if (res.data.mode === 'dm') {
        const session = getSession();
        session.forage = session.forage || {};
        session.forage[playerKey()] = res.data.request;
        if (session.forageResults) delete session.forageResults[playerKey()];
      } else {
        pf.self = { findId: res.data.findId, check: res.data.check };
      }
    } else if (res.status === 409 && res.data.error === 'resume') {
      // Something is already in flight: reopen it instead of erroring.
      const session = getSession();
      if (res.data.pending && res.data.roomId === deps.getSessionId()) {
        session.forage = session.forage || {};
        session.forage[playerKey()] = res.data.pending;
        pf.message = 'You already had a forage waiting, so here it is.';
      } else if (res.data.pending) {
        pf.message = `You already have a forage waiting in another room (${res.data.roomId}). Finish or withdraw it there first.`;
      } else if (res.data.unmarkedSelf) {
        const u = res.data.unmarkedSelf;
        pf.self = { findId: u.findId, check: u.check };
        pf.message = 'You already had a check waiting to be marked, so here it is.';
      }
    } else if (res.data.error === 'skill_not_allowed' && dm) {
      // The DM left between the hint and the submit, so the server wants self-serve picks. Switch.
      pf.mine = { ...(pf.mine || {}), dmPresent: false };
      pf.adv = newAdv(pf.adv);
      await loadSelfOptions();
      if (!pf.open) return;
      pf.message = "The DM isn't here after all. Choose what you're looking for.";
    } else {
      pf.message = errorText(res.data);
    }
    renderPlayer();
    refreshButtons();
  }

  async function markSelf(passed) {
    if (pf.busy || !pf.self) return;
    pf.busy = true;
    pf.message = '';
    playerBody.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const findId = pf.self.findId;
    const res = await api('POST', PLAYER_API, { action: 'self_mark', findId, passed });
    pf.busy = false;
    if (res.ok) {
      pf.localResult = selfResult(res.data, findId, pf.characterId); // characterId: only that token's button says (result)
      pf.self = null;
      pf.recent.status = 'idle'; // the list is stale now (it refetches when next shown)
    } else if (res.data.error === 'stale') {
      pf.self = null; // already marked elsewhere
      pf.message = errorText(res.data);
    } else {
      pf.message = errorText(res.data);
    }
    renderPlayer();
    refreshButtons();
  }

  async function withdrawPlayer() {
    const pending = myPending();
    if (!pending || pf.busy) return;
    pf.busy = true;
    const res = await api('POST', PLAYER_API, { action: 'withdraw', requestId: pending.id });
    pf.busy = false;
    if (res.ok || res.data.error === 'stale_request') {
      delete getSession().forage[playerKey()];
      pf.message = '';
      closePlayer();
      return;
    }
    pf.message = errorText(res.data);
    // The DM may have just reconnected: refresh what we know about them.
    await recheckDm();
  }

  // `fromButton` is true only for the "Is the DM still here?" button, so that press always gets
  // visible feedback - otherwise, with the DM still connected, nothing on screen would change.
  async function recheckDm(fromButton = false) {
    const res = await api('GET', `${PLAYER_API}/mine?characterId=${encodeURIComponent(pf.characterId)}&roomId=${encodeURIComponent(deps.getSessionId())}`);
    if (!pf.open) return;
    applyMine(res.ok ? res.data : null);
    if (fromButton) {
      pf.message = !res.ok ? "Couldn't check right now. Try again in a moment."
        : pf.mine?.dmPresent ? 'The DM is still connected, so it is in their hands.'
          : '';
    }
    if (!dmMode() && !pf.options) await loadSelfOptions(); // the DM has gone: the pickers are needed now
    if (!pf.open) return;
    renderPlayer();
  }

  function dismissResult() {
    const result = currentResult();
    if (result && result.mode === 'dm' && result.requestId) {
      // Clears the room's copy so it doesn't come back on a reconnect. Fire and forget.
      api('POST', PLAYER_API, { action: 'dismiss', requestId: result.requestId });
      const session = getSession();
      if (session.forageResults) delete session.forageResults[playerKey()];
    }
    pf.localResult = null;
    closePlayer();
  }

  // Shares the finder's standing haul with the party (one way, no undo). Works for both modes: the
  // result carries the finds row id either way.
  async function shareResult() {
    const result = currentResult();
    if (pf.busy || !result || !result.findId) return;
    pf.busy = true;
    pf.message = '';
    renderPlayer();
    const res = await api('POST', `/vtt/api/finds/${encodeURIComponent(result.findId)}/share`);
    pf.busy = false;
    if (!pf.open) return;
    if (res.ok) {
      // Mark the underlying copy (a self-serve result, or the room's DM-mode result) as shared.
      const target = pf.localResult && pf.localResult.findId === result.findId ? pf.localResult : myServerResult();
      if (target) target.shared = true;
    } else {
      pf.message = errorText(res.data);
    }
    renderPlayer();
  }

  playerBody.addEventListener('click', (event) => {
    const act = event.target.closest('[data-fg-act]')?.dataset.fgAct;
    if (!act) return;
    if (act === 'close') closePlayer();
    else if (act === 'submit') submitPlayer();
    else if (act === 'markPass') markSelf(true);
    else if (act === 'markFail') markSelf(false);
    else if (act === 'withdraw') withdrawPlayer();
    else if (act === 'recheck') recheckDm(true);
    else if (act === 'dismiss') dismissResult();
    else if (act === 'share') shareResult();
    else if (act === 'shareRecent') shareRecent(event.target.closest('[data-find-id]')?.dataset.findId);
    else if (act === 'again') { pf.forceForm = true; pf.message = ''; renderPlayer(); }
  });
  attachPickerEvents(playerBody, () => playerCur);
  // <details> doesn't bubble 'toggle', so listen in the capture phase.
  playerBody.addEventListener('toggle', (event) => {
    if (!event.target.matches('[data-fg="recentBox"]')) return;
    pf.recentOpen = event.target.open;
    if (pf.recentOpen && pf.recent.status === 'idle') loadRecent();
  }, true);
  // Closing a player popup loses nothing (a request stays in flight), so backdrop and Escape are fine.
  deps.closeOnBackdropPress(playerModal, closePlayer);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && playerModal.classList.contains('visible') && isTopmostModal(playerModal)) closePlayer();
  });
  // Waiting players can't be pushed "the DM left", so check again when the tab comes back to the front
  // (no timers): Withdraw then appears without an extra tap.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pf.open && !pf.loading && myPending()) recheckDm();
  });

  // ---------------------------------------------------------------------------------------------
  // GM popup
  // ---------------------------------------------------------------------------------------------
  const gm = { open: false, activeId: null, seen: new Set(), drafts: {}, tables: null, skills: null, loadingTables: false, renderedSig: '', notice: '', busy: false, handled: new Set() };
  let gmCur = null;

  const gmUrl = () => `/vtt/api/session/${encodeURIComponent(deps.getSessionId())}/forage`;
  const gmRequests = () => sortedRequests(getSession()?.forage);
  const activeRequest = () => gmRequests().find((r) => r.id === gm.activeId) || null;

  function initDraft(request) {
    const choice = request.choice;
    // The player no longer picks skill, area, category or table (Rev 4). The DM's popup starts from
    // the DM's own last-used values; only the player's adv/dis counters travel with the request.
    const picks = defaultPicks(gm.skills, gm.tables, readPicks(LAST_GM_PICKS_KEY));
    return { picks, adv: newAdv(choice.advantage), lines: null, linesKey: '', needTable: false, changeTableId: '', message: '', previewSeq: 0 };
  }

  function showGm() {
    gm.open = true;
    deps.bringModalToFront(gmModal);
    gmModal.classList.add('visible');
  }
  function hideGm() {
    gm.open = false;
    gmCur = null;
    gmModal.classList.remove('visible');
    gmBody.innerHTML = '';
    gm.renderedSig = '';
    refreshSidebarLine();
  }

  // Brings the popup, the sidebar line and the local state in line with session.forage.
  //   autoOpen: open the popup (if no other modal is showing) for a new request or a reconnect.
  function gmSync({ autoOpen = false } = {}) {
    if (deps.getRole() !== 'gm') return;
    const reqs = gmRequests();
    refreshSidebarLine();
    if (!reqs.length) {
      if (gm.open) renderGm(); // shows a notice-only state if there is a notice, else hides
      return;
    }
    if (!reqs.some((r) => r.id === gm.activeId)) { gm.activeId = reqs[0].id; gm.renderedSig = ''; }
    if (!gm.open) {
      if (!(autoOpen && !otherModalOpen())) return;
      showGm();
      gm.tables = null; // refetch on every open: tables and suggested checks may have been edited
      gm.renderedSig = '';
    }
    renderGm();
  }

  async function ensureGmTables() {
    if (gm.tables || gm.loadingTables) return;
    gm.loadingTables = true;
    const res = await api('GET', `${PLAYER_API}/tables?roomId=${encodeURIComponent(deps.getSessionId())}`);
    gm.loadingTables = false;
    if (res.ok) { gm.tables = res.data.tables; gm.skills = res.data.skills; }
    else { gm.notice = errorText(res.data); }
    gm.renderedSig = '';
    if (gm.open) renderGm();
  }

  function renderQueue() {
    const reqs = gmRequests();
    gmQueue.innerHTML = reqs.length > 1
      ? `<div class="forage-queue">${reqs.map((r) => `<button type="button" class="secondary ${r.id === gm.activeId ? 'active' : ''}" data-fg-queue="${esc(r.id)}">${esc(queueLabel(r))}</button>`).join('')}</div>`
      : '';
    gmNotice.textContent = gm.notice;
    gmNotice.hidden = !gm.notice;
  }

  function renderGm() {
    if (!gm.open) return;
    renderQueue();
    const request = activeRequest();
    if (!request) {
      // Nothing left. Keep the popup up if there is something the GM should read (a withdrawn or
      // already-handled request), with a Dismiss button, instead of hiding it silently.
      if (!gm.notice) { hideGm(); return; }
      gmBody.innerHTML = '<h2>Forage</h2><div class="actions"><button type="button" data-fg-act="dismissNotice">Dismiss</button></div>';
      gm.renderedSig = '';
      return;
    }
    if (!gm.tables) {
      gmBody.innerHTML = '<h2>Forage request</h2><p class="attack-subtext">Loading…</p>';
      gm.renderedSig = '';
      ensureGmTables();
      return;
    }
    const draft = (gm.drafts[request.id] ||= initDraft(request));
    const sig = requestSignature(request);
    if (sig === gm.renderedSig) return; // a repeat of what is already showing: leave the inputs alone
    gm.renderedSig = sig;
    buildGmBody(request, draft);
  }

  const gmTableById = (id) => (gm.tables || []).find((t) => t.id === id) || null;

  function buildGmBody(request, draft) {
    gmCur = null;
    const who = `${esc(request.playerName)} (${esc(request.characterName)})`;
    const msg = draft.message ? `<div class="forage-msg">${esc(draft.message)}</div>` : '';
    const actions = (inner) => `<div class="actions">${inner}</div>`;
    const cancelBtn = '<button type="button" class="secondary" data-fg-act="cancel">Cancel request</button>';
    const hideBtn = '<button type="button" class="secondary" data-fg-act="hide">Hide</button>';
    const suggested = request.suggestedCheck ? `<div class="attack-subtext">Suggested check: ${esc(request.suggestedCheck)}</div>` : '';
    let html = '';

    if (request.stage === 'requested') {
      gmCur = {
        picks: draft.picks, adv: draft.adv, tables: gm.tables, skills: gm.skills,
        get busy() { return gm.busy; },
        suggestedFor: (table) => table.suggestedCheck || '',
        onSkill: () => { draft.adv.disabled = new Set(); draft.adv.status = 'loading'; loadGmPreview(request, draft); }
      };
      html = `<h2>Forage request</h2><p>${who} wants to forage. You call the check and pick the table.</p>${pickerHtml(gmCur)}${msg}
        ${actions(`${cancelBtn}${hideBtn}<button type="button" data-fg="submit" data-fg-act="check">Roll check</button>`)}`;
    } else if ((request.stage === 'checked' || request.stage === 'preview') && !(request.check && (request.stage !== 'preview' || request.preview))) {
      // Shouldn't happen (the server sets check and preview with the stage), but never throw while building.
      html = `<h2>Forage</h2><p>${who}</p><p class="attack-subtext">Waiting for the latest state\u2026</p>`;
    } else if (request.stage === 'checked') {
      const table = gmTableById(request.choice.tableId);
      const tableSelect = draft.needTable
        ? `<div class="field"><label>That table is empty. Use table</label><select class="forage-select" data-fg-field="passTable"><option value="">Choose a table…</option>${pickableTables(gm.tables).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div>`
        : '';
      html = `<h2>Forage check</h2><p>${who}</p>${checkHtml(request.check)}
        <div class="attack-subtext">Table: ${esc(table ? table.name : 'unknown')}</div>${suggested}${tableSelect}${msg}
        ${request.check.nat1 ? '<div class="attack-subtext">A natural 1 always fails.</div>' : ''}
        ${actions(`${cancelBtn}${hideBtn}<button type="button" class="secondary" data-fg-act="fail">Fail</button><button type="button" data-fg-act="pass" ${request.check.nat1 ? 'disabled' : ''}>Pass</button>`)}`;
    } else if (request.stage === 'preview') {
      const p = request.preview;
      const key = `${p.tableId}|${p.lines.map((l) => `${l.itemId}:${l.qty}`).join(',')}`;
      if (draft.linesKey !== key) { draft.lines = p.lines.map((l) => ({ ...l })); draft.linesKey = key; }
      const usable = pickableTables(gm.tables);
      html = `<h2>Forage haul</h2><p>${who}</p>
        <div class="attack-subtext">${esc(request.check.skillLabel)} ${request.check.total} · table: ${esc(p.tableName)}${p.nat20 ? ' · natural 20, two runs' : ''}</div>${suggested}
        <ul class="forage-lines" data-fg="lines"></ul>
        <div class="forage-row"><select class="forage-select" data-fg="addSelect"></select><button type="button" class="secondary" data-fg-act="addLine">Add item</button></div>
        <div class="forage-row"><select class="forage-select" data-fg-field="changeTable">${usable.map((t) => `<option value="${esc(t.id)}" ${t.id === p.tableId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button type="button" class="secondary" data-fg-act="changeTable">Change table (rerolls)</button></div>
        ${noGameHint()}${msg}
        ${actions(`${cancelBtn}${hideBtn}<button type="button" class="secondary" data-fg-act="reroll">Reroll</button><button type="button" data-fg="approve" data-fg-act="approve">Approve</button>`)}`;
    } else {
      html = `<h2>Forage haul</h2><p>${who}</p><p class="attack-subtext">Adding the haul…</p>`;
    }

    gmBody.innerHTML = html;
    if (request.stage === 'requested') {
      refreshPicker(gmBody, gmCur);
      refreshAdvPanel(gmBody, draft.adv);
      if (draft.adv.status === 'loading') loadGmPreview(request, draft);
      gmBody.querySelector('[data-fg="submit"]')?.focus(); // Roll check is one tap
    } else if (request.stage === 'preview') {
      refreshGmLines(draft, request);
    }
  }

  const noGameHint = () => (getSession()?.gameSessionId
    ? ''
    : `<div class="attack-subtext">No game session is running, so this find won't appear in a session summary.</div>`);

  // Redraws just the editable lines, the "Add item" select and the Approve state.
  function refreshGmLines(draft, request) {
    const list = gmBody.querySelector('[data-fg="lines"]');
    if (!list) return;
    list.innerHTML = draft.lines.length
      ? draft.lines.map((l) => `<li><span class="forage-line-name">${esc(l.name)}</span>
          <input type="number" min="1" max="999" inputmode="numeric" class="forage-qty" data-fg-qty="${esc(l.itemId)}" value="${l.qty}" aria-label="Quantity of ${esc(l.name)}" />
          <button type="button" class="secondary" data-fg-remove="${esc(l.itemId)}" aria-label="Remove ${esc(l.name)}">×</button></li>`).join('')
      : '<li class="attack-subtext">Nothing found this roll. Add an item, reroll, or approve as nothing found.</li>';
    const addable = addableEntries(request.preview.tableEntries, draft.lines);
    const select = gmBody.querySelector('[data-fg="addSelect"]');
    select.innerHTML = addable.length
      ? addable.map((e) => `<option value="${esc(e.itemId)}">${esc(e.name)} (${esc(chanceLabel(e.chance))})</option>`).join('')
      : '<option value="">Nothing else on this table</option>';
    gmBody.querySelector('[data-fg-act="addLine"]').disabled = !addable.length;
    const approveBtn = gmBody.querySelector('[data-fg="approve"]');
    approveBtn.disabled = !canApprove(draft.lines) || gm.busy;
    approveBtn.textContent = draft.lines.length ? 'Approve' : 'Approve (nothing found)';
  }

  // A reroll or table change must replace the GM's edits with the fresh server lines.
  function dropEdits(draft) {
    draft.lines = null;
    draft.linesKey = '';
  }

  // Copies what is typed in the quantity boxes into the draft. Returns false if any is not 1..999.
  function syncQuantities(draft) {
    let ok = true;
    gmBody.querySelectorAll('[data-fg-qty]').forEach((input) => {
      const qty = parseQty(input.value);
      if (qty === null) { ok = false; input.classList.add('invalid'); return; }
      input.classList.remove('invalid');
      draft.lines = setLineQty(draft.lines, input.dataset.fgQty, qty);
    });
    return ok;
  }

  async function loadGmPreview(request, draft) {
    const seq = ++draft.previewSeq;
    const res = await api('POST', gmUrl(), {
      action: 'preview', requestId: request.id, skillKey: draft.picks.skillKey, advantage: advBody(draft.adv)
    });
    if (seq !== draft.previewSeq || !gm.open || gm.activeId !== request.id || !gmCur) return;
    draft.adv.status = res.ok ? 'ready' : 'failed';
    draft.adv.sources = res.ok ? (res.data.sources || []).filter((s) => s.origin !== 'situational') : [];
    refreshAdvPanel(gmBody, draft.adv);
    refreshPicker(gmBody, gmCur);
  }

  // One GM action. Locks the buttons while it runs, then rebuilds from whatever state we end up in.
  async function gmAct(action, extra = {}) {
    const request = activeRequest();
    if (!request || gm.busy) return;
    const draft = gm.drafts[request.id];
    gm.busy = true;
    draft.message = '';
    gmBody.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    gm.handled.add(request.id);
    const res = await api('POST', gmUrl(), { action, requestId: request.id, ...extra });
    gm.busy = false;
    const session = getSession();

    if (res.ok) {
      if (res.data.request) {
        session.forage[request.playerId] = res.data.request; // the broadcast says the same, this is just quicker
      } else {
        delete session.forage[request.playerId]; // cancel, fail or approve: the request is closed
        delete gm.drafts[request.id];
      }
    } else if (res.data.error === 'stale_request') {
      delete session.forage[request.playerId];
      delete gm.drafts[request.id];
      gm.notice = `${request.playerName}'s request has gone (withdrawn or already handled).`;
    } else if (res.data.error === 'wrong_stage') {
      // Don't patch the request locally: show the message, re-enable the buttons (the rebuild below)
      // and let the broadcast carry the real state.
      draft.message = errorText(res.data);
    } else if (res.data.error === 'table_empty') {
      draft.needTable = true;
      draft.message = 'That table has nothing to find. Pick another.';
    } else {
      gm.handled.delete(request.id);
      draft.message = errorText(res.data);
    }
    gm.renderedSig = '';
    refreshSidebarLine();
    const left = gmRequests();
    if (left.length && !left.some((r) => r.id === gm.activeId)) gm.activeId = left[0].id;
    renderGm(); // with nothing left this hides, or shows the notice-only state
  }

  gmBody.addEventListener('click', (event) => {
    if (event.target.closest('[data-fg-act="dismissNotice"]')) { gm.notice = ''; hideGm(); return; }
    const request = activeRequest();
    if (!request) return;
    const draft = gm.drafts[request.id];
    const remove = event.target.closest('[data-fg-remove]');
    if (remove) {
      syncQuantities(draft);
      draft.lines = removeLine(draft.lines, remove.dataset.fgRemove);
      refreshGmLines(draft, request);
      return;
    }
    const act = event.target.closest('[data-fg-act]')?.dataset.fgAct;
    if (!act) return;
    if (act === 'hide') hideGm();
    else if (act === 'cancel') gmAct('cancel');
    else if (act === 'check') {
      if (!canSubmitPicks(gm.tables, draft.picks)) return;
      const table = chosenTable(gm.tables, draft.picks);
      writePicks(LAST_GM_PICKS_KEY, draft.picks); // the DM's own last-used values
      gmAct('check', {
        skillKey: draft.picks.skillKey, areaType: draft.picks.areaType, category: draft.picks.category,
        tableId: table.id, advantage: advBody(draft.adv)
      });
    } else if (act === 'fail') gmAct('mark', { passed: false });
    else if (act === 'pass') {
      const tableId = gmBody.querySelector('[data-fg-field="passTable"]')?.value;
      gmAct('mark', { passed: true, ...(tableId ? { tableId } : {}) });
    } else if (act === 'reroll') { dropEdits(draft); gmAct('reroll'); }
    else if (act === 'changeTable') {
      const tableId = gmBody.querySelector('[data-fg-field="changeTable"]')?.value;
      if (tableId) { dropEdits(draft); gmAct('reroll', { tableId }); }
    } else if (act === 'addLine') {
      const itemId = gmBody.querySelector('[data-fg="addSelect"]').value;
      const entry = request.preview.tableEntries.find((e) => e.itemId === itemId);
      if (!entry) return;
      syncQuantities(draft);
      draft.lines = addLine(draft.lines, entry);
      refreshGmLines(draft, request);
    } else if (act === 'approve') {
      if (!syncQuantities(draft)) { draft.message = 'Quantities must be whole numbers from 1 to 999.'; gm.renderedSig = ''; renderGm(); return; }
      if (!canApprove(draft.lines)) return;
      gmAct('approve', { lines: linesPayload(draft.lines) });
    }
  });
  attachPickerEvents(gmBody, () => gmCur);

  // The queue buttons live outside the body, so they have their own listener.
  gmQueue.addEventListener('click', (event) => {
    const id = event.target.closest('[data-fg-queue]')?.dataset.fgQueue;
    if (!id || id === gm.activeId || gm.busy) return;
    gm.activeId = id;
    gm.notice = '';
    gm.renderedSig = '';
    renderGm();
  });
  // No backdrop press and no Escape for the GM popup: closing it would cancel a player's request.

  // ---------------------------------------------------------------------------------------------
  // Sidebar touch points (targeted updates only, never a renderSidebar)
  // ---------------------------------------------------------------------------------------------
  function forageButtonHtml(token) {
    if (!token.characterId || token.type === 'prop' || !deps.isAccountLinked()) return '';
    const state = buttonState(token);
    const title = state.unavailable ? forageUnavailableText(state.unavailable) : 'Look for plants, ore and other finds';
    return `<button type="button" class="secondary forageBtn" data-forage-token="${esc(token.id)}" title="${esc(title)}">${forageButtonLabel(state)}</button>`;
  }

  // Per-character "is forage off?" for the token-card buttons, learned from GET /forage/mine (the same
  // answer the sheet uses). Unknown or stale (over a minute) entries are fetched when a button is drawn.
  // An in-flight forage or a waiting result keeps the button live, so a started forage can be finished.
  const availability = new Map(); // "room|characterId" -> { reason, at }
  const availKey = (characterId) => `${deps.getSessionId()}|${characterId}`;
  const asking = new Set();
  const AVAILABILITY_TTL_MS = 60000;

  function rememberAvailability(characterId, mine) {
    if (characterId) availability.set(availKey(characterId), { reason: forageUnavailableReason(mine, characterId), at: Date.now() });
  }

  async function askAvailability(characterId, force = false) {
    if (asking.has(characterId) && !force) return;
    asking.add(characterId);
    const res = await api('GET', `${PLAYER_API}/mine?characterId=${encodeURIComponent(characterId)}&roomId=${encodeURIComponent(deps.getSessionId())}`);
    asking.delete(characterId);
    if (res.ok) rememberAvailability(characterId, res.data);
    refreshButtons();
  }

  function unavailableFor(characterId) {
    const known = availability.get(availKey(characterId));
    if (!known || Date.now() - known.at > AVAILABILITY_TTL_MS) setTimeout(() => askAvailability(characterId), 0);
    return known ? known.reason : '';
  }

  function buttonState(token) {
    const pending = myPending();
    const result = currentResult();
    const hasResult = !!result && (!result.characterId || result.characterId === token.characterId);
    return {
      pending: !!pending, // the finder only ever has one in flight
      hasResult,
      unavailable: !pending && !hasResult && !pf.self ? unavailableFor(token.characterId) : ''
    };
  }

  function applyButtonState(button, token) {
    const state = buttonState(token);
    button.textContent = forageButtonLabel(state);
    // Never hard-disabled: the answer is cached, so a click re-checks with the server (see the click handler).
    button.classList.toggle('forage-off', !!state.unavailable);
    button.title = state.unavailable ? forageUnavailableText(state.unavailable) : 'Look for plants, ore and other finds';
  }

  function refreshButtons() {
    const session = getSession();
    if (!session || deps.getRole() !== 'player') return;
    document.querySelectorAll('.forageBtn').forEach((button) => {
      const token = session.tokens?.[button.dataset.forageToken];
      if (token) applyButtonState(button, token);
    });
  }

  // GM side: whether this room can be foraged at all. Find tables belong to campaigns, so a Quick room
  // has none and a campaign with no table that has something pickable has foraging off. Fetched at most
  // once a minute, when the sidebar is drawn (the list is the room's campaign's tables, GM only).
  const gmInfo = { quick: false, pickable: null, at: 0, asking: false };
  async function refreshGmInfo() {
    if (gmInfo.asking || Date.now() - gmInfo.at < 60000) return;
    gmInfo.asking = true;
    const res = await api('GET', `${PLAYER_API}/tables?roomId=${encodeURIComponent(deps.getSessionId())}`);
    gmInfo.asking = false;
    gmInfo.at = Date.now();
    if (!res.ok || !Array.isArray(res.data.tables)) return;
    gmInfo.quick = res.data.unavailableReason === 'wrong_room';
    gmInfo.pickable = pickableTables(res.data.tables).length;
    refreshSidebarLine();
  }
  function gmInfoHtml() {
    const text = gmInfo.quick ? "Foraging isn't available in Quick rooms."
      : gmInfo.pickable === 0 ? 'No find tables for this campaign yet. <a href="/forage/tables" target="_blank" rel="noopener">Set them up</a>'
        : '';
    return text ? `<div class="forage-sidebar-line"><span class="attack-subtext">${text}</span></div>` : '';
  }

  function forageControlHtml() {
    if (deps.getRole() !== 'gm') return '';
    refreshGmInfo();
    return `<div id="forageControl">${sidebarLineHtml()}</div>`;
  }
  function sidebarLineHtml() {
    const reqs = gmRequests();
    // A notice (e.g. "X withdrew") is shown here while the popup is hidden, so it isn't lost.
    const notice = gm.notice && !gm.open
      ? `<div class="forage-sidebar-line"><span>${esc(gm.notice)}</span><button type="button" data-forage-dismiss>Dismiss</button></div>`
      : '';
    if (!reqs.length) return `${notice}${gmInfoHtml()}`;
    const more = reqs.length > 1 ? ` (+${reqs.length - 1} more waiting)` : '';
    return `${notice}<div class="forage-sidebar-line"><span>Forage request from ${esc(reqs[0].playerName)}${more}</span><button type="button" data-forage-open>Open</button></div>`;
  }
  function refreshSidebarLine() {
    const el = document.getElementById('forageControl');
    if (el) el.innerHTML = sidebarLineHtml();
  }

  // One delegated listener on the sidebar element (which is never replaced, only its contents).
  deps.sidebarEl.addEventListener('click', (event) => {
    if (event.target.closest('[data-forage-dismiss]')) {
      gm.notice = '';
      refreshSidebarLine();
      return;
    }
    if (event.target.closest('[data-forage-open]')) {
      const reqs = gmRequests();
      if (!reqs.length) return;
      if (!reqs.some((r) => r.id === gm.activeId)) gm.activeId = reqs[0].id;
      if (!gm.open) { showGm(); gm.tables = null; gm.renderedSig = ''; }
      gm.notice = '';
      renderGm();
      return;
    }
    const button = event.target.closest('.forageBtn');
    if (button) clickForage(button);
  });

  // A button that looks unavailable may be stale (the cache is up to a minute old), so a click asks the
  // server again. Now available: open forage. Still off: show the reason on the button's card.
  async function clickForage(button) {
    const tokenId = button.dataset.forageToken;
    if (!button.classList.contains('forage-off')) { openPlayerForage(tokenId); return; }
    const token = getSession()?.tokens?.[tokenId];
    if (!token?.characterId) return;
    await askAvailability(token.characterId, true);
    if (unavailableFor(token.characterId)) {
      button.title = forageUnavailableText(unavailableFor(token.characterId));
      showOffNotice(button, button.title);
    } else openPlayerForage(tokenId);
  }
  function showOffNotice(button, text) {
    let note = button.parentElement?.querySelector('.forage-off-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'attack-subtext forage-off-note';
      button.insertAdjacentElement('afterend', note);
    }
    note.textContent = text;
  }

  // ---------------------------------------------------------------------------------------------
  // Message hooks (called from main.js's handleMessage)
  // ---------------------------------------------------------------------------------------------
  function onStateFull() {
    const session = getSession();
    if (!session) return;
    session.forage = session.forage || {};
    session.forageResults = session.forageResults || {};
    if (deps.getRole() === 'gm') {
      // Reconnect: every pending request comes back at its stored stage (local edits to a preview
      // are lost, which is accepted).
      gm.renderedSig = '';
      gmRequests().forEach((r) => gm.seen.add(r.id));
      gmSync({ autoOpen: true });
      return;
    }
    if (pf.open && pf.characterId) recheckDm(); // the DM may have come or gone while we were away
    refreshButtons();
  }

  function onUpdate(msg) {
    const session = getSession();
    if (!session || !msg.request) return;
    session.forage = session.forage || {};
    if (deps.getRole() === 'gm') {
      const request = msg.request;
      session.forage[request.playerId] = request;
      const isNew = !gm.seen.has(request.id);
      gm.seen.add(request.id);
      if (isNew) gm.notice = ''; // a later popup must not show an old "X withdrew"
      gmSync({ autoOpen: isNew });
      return;
    }
    session.forage[playerKey()] = msg.request;
    if (pf.open) renderPlayer();
    refreshButtons();
  }

  function onClosed(msg) {
    const session = getSession();
    if (!session) return;
    session.forage = session.forage || {};
    if (deps.getRole() === 'gm') {
      const gone = session.forage[msg.playerId];
      delete session.forage[msg.playerId];
      delete gm.drafts[msg.requestId];
      // A cancel the GM didn't press themselves is the finder withdrawing.
      if (gone && msg.outcome === 'cancelled' && !gm.handled.has(msg.requestId)) {
        gm.notice = `${gone.playerName} withdrew their forage request.`;
      }
      if (gm.activeId === msg.requestId) { gm.activeId = null; gm.renderedSig = ''; }
      gmSync();
      return;
    }
    delete session.forage[playerKey()];
    if (msg.result) {
      session.forageResults = session.forageResults || {};
      session.forageResults[playerKey()] = msg.result;
      pf.localResult = null;
    }
    if (pf.open) renderPlayer();
    else if (msg.result && !otherModalOpen()) {
      // Show the result straight away, unless something else is on screen (the button says "result").
      const token = Object.values(session.tokens || {}).find((t) => t.ownerId === playerKey() && t.characterId === msg.result.characterId);
      if (token) openPlayerForage(token.id);
    }
    refreshButtons();
  }

  return { onStateFull, onUpdate, onClosed, forageButtonHtml, forageControlHtml, refreshButtons };
}
