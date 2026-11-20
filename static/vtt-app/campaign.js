// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// VTT campaign table client (campaign-system plan, unit F). Plain unbundled JS, loaded by main.js.
//
// A page opened with ?campaignId= is a campaign's table, not a Quick room. Instead of typing a code,
// we ask POST /vtt/api/campaigns/<id>/ticket for a one-use join ticket (the server checks real
// membership), then join the websocket with { type: 'join', sessionId, ticket }. Who we are, which
// role we hold and whether we may sit in the GM seat all come from the ticket, never from this page.
//
// This file owns the connection story around that: fetching a fresh ticket for every (re)connect,
// the GM-seat takeover (including quietly replacing our OWN stale socket after a refresh), what to
// do after a kick or after the DM takes the seat, and the notices that go with each. The decisions
// themselves are pure and live in shared/campaignJoin.js (unit tested); this file does the fetching
// and the drawing. Quick rooms never reach it: `active` stays false and main.js uses its old path.

import {
  ACTION_LABELS, GM_REPLACED_MESSAGE, STABLE_JOIN_MS, describeJoinError, describeKick, describeTicketFailure,
  loginHref, readCampaignParams, reconnectPlan
} from './shared/campaignJoin.js';

export function createCampaignClient(deps) {
  const params = readCampaignParams(location.search);

  const loginEl = document.getElementById('login');
  const noticeEl = document.getElementById('campaignNotice');
  const noticeTitle = document.getElementById('campaignNoticeTitle');
  const noticeText = document.getElementById('campaignNoticeText');
  const noticeActions = document.getElementById('campaignNoticeActions');
  const bannerEl = document.getElementById('campaignBanner');
  const joiningText = document.getElementById('campaignJoiningText');

  const state = {
    roleWanted: params ? params.role : 'player', // what we ask the next ticket for
    lastTakeoverOf: null, // the takeover ('self' | 'co') the attempt in flight asked for; only a fresh-ticket retry of the SAME attempt reuses it
    offeredTakeoverOf: null, // the takeover the open prompt offers, sent if its button is pressed
    stableTimer: null, // fires once a join has lasted long enough to count as stable
    auto: false, // is the attempt in flight an automatic reconnect (or a reload of a tab that had the table)
    everJoined: false,
    ticketRetried: false, // one fresh-ticket retry per join, so a real fault can't loop
    attempts: 0, // automatic attempts since the last good join
    handled: false, // a message already decided what happens on this socket's close
    stopped: false, // no more automatic reconnects (kicked out, or the campaign is gone)
    attemptId: 0, // lets a slow ticket answer be ignored if a newer attempt started
    timer: null,
    pendingBanner: null,
    bannerTimer: null,
    campaignName: null
  };

  // A reload of a tab that held the table has to behave like an automatic reconnect: the old socket
  // may not have closed on the server yet, and asking "take over here?" about a page we just
  // refreshed would be silly. sessionStorage is per tab, so a genuinely new tab doesn't have it.
  const markerKey = params ? `vtt_campaign_open_${params.campaignId}` : null;
  const hadTable = () => {
    try { return !!markerKey && sessionStorage.getItem(markerKey) === '1'; } catch { return false; }
  };
  const setTableMarker = (on) => {
    try {
      if (!markerKey) return;
      if (on) sessionStorage.setItem(markerKey, '1');
      else sessionStorage.removeItem(markerKey);
    } catch { /* storage unavailable: a reload just asks the question once */ }
  };

  // --- Small UI helpers -----------------------------------------------------------------------

  function setJoiningText(text) {
    if (joiningText) joiningText.textContent = text;
  }

  // sticky = stay until the next join (e.g. "reconnecting..."); otherwise it fades after a few seconds.
  function showBanner(text, sticky = false) {
    clearTimeout(state.bannerTimer);
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    if (!sticky) state.bannerTimer = setTimeout(hideBanner, 8000);
  }
  function hideBanner() {
    clearTimeout(state.bannerTimer);
    bannerEl.hidden = true;
  }

  function hideNotice() {
    noticeEl.classList.remove('visible');
  }

  // A card with a message and buttons. `actions` are names from ACTION_LABELS.
  function showNotice(title, message, actions) {
    noticeTitle.textContent = title;
    noticeText.textContent = message;
    noticeActions.textContent = '';
    actions.forEach((name, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = ACTION_LABELS[name];
      if (index > 0) button.className = 'secondary';
      button.addEventListener('click', () => runAction(name));
      noticeActions.appendChild(button);
    });
    noticeEl.classList.add('visible');
  }

  function runAction(name) {
    if (name === 'lobby') {
      location.href = '/vtt';
    } else if (name === 'signin') {
      location.href = loginHref(params.campaignId, state.roleWanted);
    } else if (name === 'takeover') {
      connectCampaign({ takeoverOf: state.offeredTakeoverOf || 'co', auto: false });
    } else if (name === 'player') {
      state.roleWanted = 'player';
      // So a refresh of this tab stays a player view instead of asking for the seat again.
      setUrlRole('player');
      connectCampaign({ auto: false });
    } else if (name === 'retry') {
      state.stopped = false;
      state.attempts = 0;
      connectCampaign({ auto: false });
    }
  }

  // End of the line: no more automatic reconnects. `forgetTable` drops the reload marker too.
  function stop(title, message, actions, forgetTable = true) {
    state.stopped = true;
    if (forgetTable) setTableMarker(false);
    hideBanner();
    setJoiningText(message);
    showNotice(title, message, actions);
  }

  // --- Connecting -----------------------------------------------------------------------------

  // Keep the page URL's role in step with what this tab really is, so a refresh doesn't ask for more.
  function setUrlRole(role) {
    try {
      const url = new URL(location.href);
      url.searchParams.set('role', role);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch { /* not worth failing over */ }
  }

  async function fetchTicket(role, takeoverOf) {
    try {
      const res = await fetch(`/vtt/api/campaigns/${encodeURIComponent(params.campaignId)}/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, takeoverOf })
      });
      // A logged-out session is redirected to the login page (HTML, not our JSON).
      const data = await res.json().catch(() => null);
      if (!data) return { ok: false, status: res.redirected ? 401 : res.status, data: {} };
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: {} };
    }
  }

  // Ask for a fresh ticket in the wanted role and join with it. Every connect and reconnect goes
  // through here, because a ticket can only be used once.
  async function connectCampaign({ takeoverOf = null, auto = false } = {}) {
    clearTimeout(state.timer);
    clearTimeout(state.stableTimer);
    hideNotice();
    state.stopped = false; // an attempt is under way again (a button was pressed, or a timer fired)
    state.lastTakeoverOf = takeoverOf;
    state.auto = auto;
    const attemptId = ++state.attemptId;
    setJoiningText('Joining the table...');

    const result = await fetchTicket(state.roleWanted, takeoverOf);
    if (attemptId !== state.attemptId) return; // a newer attempt took over while we waited

    if (!result.ok) {
      const failure = describeTicketFailure({ status: result.status, error: result.data.error, requestedRole: state.roleWanted });
      if (failure.kind === 'fallback_player') {
        // Demoted since we last looked: join as a player and say so.
        state.roleWanted = 'player';
        setUrlRole('player');
        state.pendingBanner = failure.message;
        connectCampaign({ auto: true });
      } else if (failure.kind === 'retry') {
        scheduleRetry(failure.message);
      } else if (failure.kind === 'login') {
        stop(failure.title, failure.message, failure.actions, false);
      } else {
        stop(failure.title, failure.message, failure.actions);
      }
      return;
    }

    const data = result.data;
    state.campaignName = data.campaignName;
    state.roleWanted = data.role;
    deps.setIdentity({ roomCode: data.sessionId, role: data.role, userId: data.userId, displayName: data.displayName });
    // Only now is the previous socket's close (if it is still pending) certain to be old news, so
    // this is where `handled` resets: earlier would let that late close start a second reconnect.
    state.handled = false;
    deps.connect({ type: 'join', sessionId: data.sessionId, ticket: data.ticket });
  }

  // The next automatic attempt, with the same pacing for ticket failures and dropped sockets.
  function scheduleRetry(message) {
    const plan = reconnectPlan({ everJoined: state.everJoined, attempt: state.attempts });
    if (plan.giveUp) {
      stop("Can't reach the table", "Couldn't reach the table. Check your connection and try again.", ['retry', 'lobby'], false);
      return;
    }
    state.attempts += 1;
    showBanner(message, true);
    // Never a takeover: a drop-and-retry has to ask the server who holds the seat NOW (a co-DM may
    // have sat down meanwhile). If our own stale socket is the holder, the answer says so and the
    // quiet 'self' takeover follows from that.
    state.timer = setTimeout(() => connectCampaign({ takeoverOf: null, auto: true }), plan.delayMs);
  }

  // --- Events from main.js --------------------------------------------------------------------

  function start() {
    if (!params) return;
    // Hide the Quick room form: there is nothing to type at a campaign table.
    for (const el of loginEl.querySelectorAll('.panel, #identityKnown, #identityUnknown')) el.style.display = 'none';
    const joining = document.getElementById('campaignJoining');
    if (joining) joining.style.display = 'block';
    connectCampaign({ auto: hadTable() });
  }

  // state:full arrived: we are in.
  function onJoined() {
    state.everJoined = true;
    state.ticketRetried = false;
    // A takeover was for that one attempt; a later reconnect must not repeat it.
    state.lastTakeoverOf = null;
    // Back-off only resets once the join has held for a while, so a join-then-close flap slows
    // down instead of looping at the fastest pace.
    clearTimeout(state.stableTimer);
    state.stableTimer = setTimeout(() => { state.attempts = 0; }, STABLE_JOIN_MS);
    setTableMarker(true);
    hideNotice();
    if (state.pendingBanner) {
      showBanner(state.pendingBanner);
      state.pendingBanner = null;
    } else {
      hideBanner();
    }
  }

  function onJoinError(msg) {
    state.handled = true; // the close that follows is ours, not a dropped connection
    deps.closeSocket();
    const action = describeJoinError(msg, { auto: state.auto, ticketRetried: state.ticketRetried });
    if (action.kind === 'retry_ticket') {
      state.ticketRetried = true;
      // Same attempt, same intent: the ticket was just a bad one.
      connectCampaign({ takeoverOf: state.lastTakeoverOf, auto: true });
    } else if (action.kind === 'takeover') {
      connectCampaign({ takeoverOf: action.takeoverOf, auto: true });
    } else {
      state.offeredTakeoverOf = action.takeoverOf || null;
      // A question or a dead end. Nothing reconnects until a button is pressed; keep the reload
      // marker for a question (they are still meant to be here), drop it for a dead end.
      const isQuestion = action.kind === 'prompt';
      state.stopped = true;
      if (!isQuestion) setTableMarker(false);
      setJoiningText(action.message);
      showNotice(action.title, action.message, action.actions);
    }
  }

  function onKicked(reason) {
    state.handled = true;
    const kick = describeKick(reason);
    if (kick.kind === 'reconnect') {
      // The role changed under us: a fresh ticket will say what we may be now (the ticket route
      // refuses a GM ticket to someone who is no longer a DM, and we fall back to player).
      state.pendingBanner = kick.message;
      showBanner(kick.message, true);
      state.timer = setTimeout(() => connectCampaign({ auto: true }), 800);
    } else {
      stop(kick.title, kick.message, kick.actions, reason === 'removed_from_campaign');
    }
  }

  // The DM took the seat from us. Don't try to win it back: rejoin as a player.
  function onGmReplaced() {
    state.handled = true;
    state.roleWanted = 'player';
    // A refresh of this tab must not quietly win the seat back: forget the reload marker and make
    // the URL a player link.
    setTableMarker(false);
    setUrlRole('player');
    state.pendingBanner = GM_REPLACED_MESSAGE;
    showBanner(GM_REPLACED_MESSAGE, true);
    state.timer = setTimeout(() => connectCampaign({ auto: true }), 300);
  }

  // The socket closed. Messages above may already have decided what happens next.
  function onClose(code) {
    clearTimeout(state.stableTimer);
    if (state.stopped || state.handled) return;
    if (code === 4002) {
      // The replaced message went missing; same outcome as onGmReplaced.
      onGmReplaced();
      return;
    }
    if (code === 4001) {
      onKicked('unknown');
      return;
    }
    scheduleRetry(state.everJoined ? 'Connection lost. Reconnecting...' : 'Trying to reach the table...');
  }

  return {
    get active() { return !!params; },
    get campaignName() { return state.campaignName; },
    start,
    onJoined,
    onJoinError,
    onKicked,
    onGmReplaced,
    onClose
  };
}
