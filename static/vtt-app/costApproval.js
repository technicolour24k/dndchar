// VTT cost-approval client (cost-engine plan, unit 6). Plain unbundled JS, loaded by main.js.
//
// Two surfaces:
//   - the PLAYER prompt, shown inside the attack modal when roll-spell / roll-item answer 409
//     'insufficient': it asks the DM, waits, then re-runs the held attack with the approval (or an
//     override), using the same target and options because main.js keeps pendingAttack.
//   - the GM sidebar queue: a compact card per waiting request with [Approve] [Approve - spend nothing]
//     [Deny]. It has no backdrop close, so nothing is cancelled by a stray click.
//
// The server decides everything (who may override, the single-use approval, the roll-log lines). This
// file only words the prompts (shared/costApproval.js) and sends choices. Messages: cost:update (the GM
// gets the whole request, the requester their own view), cost:closed, and a detail-free cost:ping that
// just means "look again". Players only ever see their own request.

import {
  applyCostMessage, closedMessage, approvalErrorText, gmErrorText, gmRequestText, isInsufficient, mineStep, modeFrom, pendingQueue,
  promptSpec, shortfallLines, WAITING_TEXT
} from './shared/costApproval.js';

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

export function createCostApproval(deps) {
  const esc = deps.escapeHtml;
  const modalBody = deps.attackModalBody;

  // --------------------------------------------------------------------------------------------
  // PLAYER: the prompt inside the attack modal.
  // state: { stage: 'prompt'|'waiting'|'message', mode, shortfalls, label, characterId, activation, retry, requestId, busy, error }
  // --------------------------------------------------------------------------------------------
  let state = null;
  let pollTimer = null;

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function render() {
    if (!state) return;
    const lines = shortfallLines(state.shortfalls).map((line) => `<li>${esc(line)}</li>`).join('');
    let html;
    if (state.stage === 'message') {
      html = `<h2>${esc(state.label)}</h2><p>${esc(state.message)}</p>
        <div class="actions"><button type="button" data-cost-choice="close">Close</button></div>`;
    } else if (state.stage === 'waiting') {
      html = `<h2>${esc(state.label)}</h2><p>${esc(WAITING_TEXT)}</p><ul class="cost-short">${lines}</ul>
        ${state.error ? `<p class="cost-error">${esc(state.error)}</p>` : ''}
        <div class="actions"><button type="button" data-cost-choice="withdraw" data-cost-primary>Withdraw</button></div>`;
    } else {
      const spec = promptSpec(state.mode);
      html = `<h2>${esc(state.label)}</h2><p>${esc(spec.question)}</p><ul class="cost-short">${lines}</ul>
        ${state.error ? `<p class="cost-error">${esc(state.error)}</p>` : ''}
        <div class="actions">
          <button type="button" data-cost-choice="${esc(spec.primary.id)}" data-cost-primary ${state.busy ? 'disabled' : ''}>${esc(spec.primary.label)}</button>
          <button type="button" class="secondary" data-cost-choice="${esc(spec.secondary.id)}" ${state.busy ? 'disabled' : ''}>${esc(spec.secondary.label)}</button>
        </div>
        ${spec.note ? `<p class="cost-note">${esc(spec.note)}</p>` : ''}`;
    }
    modalBody.innerHTML = html;
    modalBody.querySelector('[data-cost-primary]')?.focus();
  }

  /**
   * A roll answered 409 insufficient. `body` is the server's answer (mode, shortfalls and the exact
   * activation to ask with); `retry(extra)` re-runs the same roll with { approvalId } or { override }.
   */
  function promptPlayer({ body, label, characterId, retry }) {
    stopPoll();
    state = {
      stage: 'prompt', mode: modeFrom(body) || 'no_dm', shortfalls: body.shortfalls || [], label: label || 'Not enough resources',
      characterId, activation: body.activation || null, retry, requestId: null, busy: false, error: '', message: ''
    };
    render();
  }

  function showMessage(text) {
    if (!state) return;
    stopPoll();
    state.stage = 'message';
    state.message = text;
    render();
  }

  async function ask() {
    const current = state;
    if (!current?.activation) return;
    current.busy = true;
    current.error = '';
    const result = await api('POST', '/vtt/api/cost-requests', {
      action: 'ask', characterId: current.characterId, activation: current.activation, roomId: deps.getSessionId()
    });
    if (state !== current) return;
    current.busy = false;
    if (result.ok && result.data.notNeeded) { run({}); return; } // affordable now: just run it
    const request = result.data?.request;
    if (request && (result.ok || result.data.error === 'pending')) {
      current.stage = 'waiting';
      current.requestId = request.id;
      startPoll();
      render();
      return;
    }
    if (result.status === 409 && (result.data.error === 'no_dm' || result.data.error === 'dm_self')) {
      current.mode = result.data.error;
    } else {
      current.error = 'Could not ask the DM. Try again.';
    }
    render();
  }

  // Re-runs the held roll. The prompt is dropped first: a fresh shortfall or refusal shows a new one.
  function run(extra) {
    const retry = state?.retry;
    stopPoll();
    state = null;
    if (retry) retry(extra);
  }

  async function withdraw() {
    const requestId = state?.requestId;
    if (requestId) await api('POST', '/vtt/api/cost-requests', { action: 'withdraw', requestId });
  }

  async function choose(id) {
    if (!state || state.busy) return;
    if (id === 'ask') return ask();
    if (id === 'go_ahead') return run({ override: 'dm' });
    if (id === 'self') return run({ override: 'self' }); // the server also ends a request still waiting
    if (id === 'withdraw') {
      await withdraw();
      if (state) state.requestId = null; // already withdrawn: closing the modal must not do it again
      deps.closeAttackModal();
      return;
    }
    deps.closeAttackModal(); // cancel / close: nothing was spent
  }

  // While waiting: look again every few seconds. A DM leaving sends no message.
  function startPoll() {
    stopPoll();
    pollTimer = setInterval(refresh, 8000);
  }

  async function refresh() {
    const current = state;
    if (!current || current.stage !== 'waiting') return;
    const result = await api('GET', `/vtt/api/cost-requests/mine?characterId=${encodeURIComponent(current.characterId)}&roomId=${encodeURIComponent(deps.getSessionId() || '')}`);
    if (!result.ok || state !== current) return;
    const step = mineStep(result.data, current.requestId);
    if (step === 'resume') run({ approvalId: current.requestId });
    else if (step === 'no_dm_pending') { stopPoll(); current.stage = 'prompt'; current.mode = 'no_dm_pending'; render(); }
    else if (step === 'none') showMessage(closedMessage('denied'));
  }

  // The attack modal was closed (Close, backdrop): a request still waiting goes with it.
  function onAttackClosed() {
    const requestId = state?.requestId;
    stopPoll();
    state = null;
    if (requestId) void api('POST', '/vtt/api/cost-requests', { action: 'withdraw', requestId });
  }

  modalBody.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-cost-choice]');
    if (button && state) void choose(button.dataset.costChoice);
  });
  // Clicking outside the card also picks the safe choice (only on the prompt itself, never mid-wait).
  modalBody.closest('.modal-overlay')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget && state?.stage === 'prompt' && !state.busy) void choose(promptSpec(state.mode).escape);
  });
  // Escape picks the safe choice (cancel or withdraw), never the way past.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state || state.busy) return;
    if (state.stage === 'prompt') void choose(promptSpec(state.mode).escape);
    else if (state.stage === 'message') deps.closeAttackModal();
  });

  // --------------------------------------------------------------------------------------------
  // GM: the sidebar queue.
  // --------------------------------------------------------------------------------------------
  const busy = new Set(); // request ids with a decision in flight
  let gmNotice = '';

  function queueInnerHtml() {
    const queue = pendingQueue(deps.getSession()?.costRequests);
    const notice = gmNotice ? `<div class="cost-gm-line"><span>${esc(gmNotice)}</span></div>` : '';
    if (!queue.length) return notice;
    const cards = queue.map((request, index) => {
      const disabled = busy.has(request.id) ? 'disabled' : '';
      const id = esc(request.id);
      return `<div class="cost-gm-card">
        <div class="cost-gm-title">${index === 0 ? '' : '<span class="cost-gm-more">Next: </span>'}Cost request: ${esc(gmRequestText(request))}</div>
        <div class="cost-gm-actions">
          <button type="button" data-cost-gm="approve" data-request="${id}" ${disabled}>Approve</button>
          <button type="button" class="secondary" data-cost-gm="approve_free" data-request="${id}" ${disabled}>Approve - spend nothing</button>
          <button type="button" class="secondary" data-cost-gm="deny" data-request="${id}" ${disabled}>Deny</button>
        </div>
      </div>`;
    }).join('');
    return `${notice}${cards}`;
  }

  function queueHtml() {
    if (deps.getRole() !== 'gm') return '';
    return `<div id="costQueue">${queueInnerHtml()}</div>`;
  }

  function refreshQueue() {
    const el = document.getElementById('costQueue');
    if (el) el.innerHTML = queueInnerHtml();
  }

  async function decide(action, requestId) {
    const sessionId = deps.getSessionId();
    if (!sessionId || busy.has(requestId)) return;
    busy.add(requestId);
    gmNotice = '';
    refreshQueue();
    const result = await api('POST', `/vtt/api/session/${encodeURIComponent(sessionId)}/cost-requests`, {
      action: action === 'deny' ? 'deny' : 'approve', requestId, waive: action === 'approve_free'
    });
    busy.delete(requestId);
    if (!result.ok) {
      gmNotice = gmErrorText(result.data?.error);
      // A stale or already-decided request is gone or settled: drop it so the card doesn't linger.
      if (result.data?.error === 'stale_request') applyCostMessage(deps.getSession().costRequests ||= {}, { type: 'cost:closed', requestId });
    }
    refreshQueue();
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-cost-gm]');
    if (button && deps.getRole() === 'gm') void decide(button.dataset.costGm, button.dataset.request);
  });

  // --------------------------------------------------------------------------------------------
  // Socket messages and state.
  // --------------------------------------------------------------------------------------------
  function onUpdate(msg) {
    const session = deps.getSession();
    if (!session) return;
    if (deps.getRole() === 'gm') {
      applyCostMessage((session.costRequests ||= {}), msg);
      refreshQueue();
      return;
    }
    // A player only ever receives their own request. Approved while we are waiting: run it now.
    const request = msg.request;
    if (state?.stage === 'waiting' && request?.id === state.requestId && request.status === 'approved') run({ approvalId: request.id });
  }

  function onClosed(msg) {
    const session = deps.getSession();
    if (deps.getRole() === 'gm') {
      if (session) applyCostMessage((session.costRequests ||= {}), msg);
      refreshQueue();
      return;
    }
    if (state?.requestId && state.requestId === msg.requestId) {
      const text = closedMessage(msg.outcome);
      if (text) showMessage(text);
    }
  }

  // The nudge carries nothing: a waiting player looks again.
  function onPing() {
    if (state?.stage === 'waiting') void refresh();
  }

  // A (re)join: the GM's queue comes with the state, a waiting player looks again.
  function onStateFull() {
    if (deps.getRole() === 'gm') refreshQueue();
    else if (state?.stage === 'waiting') void refresh();
  }

  return { promptPlayer, onAttackClosed, onUpdate, onClosed, onPing, onStateFull, queueHtml, refreshQueue, isInsufficient, approvalErrorText };
}
