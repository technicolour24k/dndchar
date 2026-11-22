// Voice chat dock (daily-voice plan, Unit 2). Campaign tables only: main.js calls show() once the
// table has joined and never calls it for Quick rooms, so those never see the dock.
//
// The dock is a direct child of <body>, outside #sidebar/#app, so renderSidebar() rebuilds, map
// switches and socket reconnects never touch it, and the call carries on underneath them.
//
// daily-js is loaded from a pinned CDN URL on first Join (the VTT has no bundler) and used in
// call-object mode (our own UI). In that mode daily-js does not play remote audio, so we keep one
// <audio> element per remote participant. Participant names are user-controlled: everything is
// rendered with textContent.
import { SPEECH_LEVEL, dockLabel, describeVoiceError, participantRows, speakingIds } from './shared/voiceView.js';

// Daily retires old daily-js versions, so this needs bumping now and then (npm view
// @daily-co/daily-js version). dist/daily.js is the UMD build and sets window.Daily. The integrity
// hash is of that exact file (from unpkg's ?meta listing for this version): regenerate it with the
// version, or drop the attribute while testing a new one.
const DAILY_JS_VERSION = '0.95.0';
const DAILY_JS_URL = `https://unpkg.com/@daily-co/daily-js@${DAILY_JS_VERSION}/dist/daily.js`;
const DAILY_JS_INTEGRITY = 'sha256-0hXNMDasaZMD8gJWdF0v85S6vDSEIOJPTSwpZY9opTU=';
const LEVEL_INTERVAL_MS = 200;

let scriptPromise = null;
function loadDailyScript() {
  if (window.Daily) return Promise.resolve(window.Daily);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = DAILY_JS_URL;
      s.integrity = DAILY_JS_INTEGRITY;
      s.crossOrigin = 'anonymous';
      // A tag that failed or loaded without defining window.Daily is removed so retries don't stack tags.
      const fail = () => { s.remove(); reject(new Error('script_load')); };
      s.onload = () => (window.Daily ? resolve(window.Daily) : fail());
      s.onerror = fail;
      document.head.appendChild(s);
    }).catch((e) => {
      scriptPromise = null; // let a later Join retry
      throw e;
    });
  }
  return scriptPromise;
}

export function createVoice({ getCampaignId }) {
  const dock = document.getElementById('voiceDock');
  const statusEl = document.getElementById('voiceStatus');
  const joinBtn = document.getElementById('voiceJoin');
  const muteBtn = document.getElementById('voiceMute');
  const leaveBtn = document.getElementById('voiceLeave');
  const listBtn = document.getElementById('voiceListToggle');
  const listEl = document.getElementById('voiceList');
  const soundBtn = document.getElementById('voiceSound');
  const audioHost = document.getElementById('voiceAudioHost');

  let state = 'idle';
  let message = '';
  let call = null;
  let localId = null;
  let listOpen = false;
  const audioEls = new Map(); // session_id -> { el, trackId }
  const lastLoudAt = {}; // session_id -> ms of last sample above SPEECH_LEVEL
  let speakTimer = null;
  // Bumped by leave(). A join() that was started earlier sees the change after each await and bails,
  // so a kick/Leave during 'loading' can't go on to join with the token it already fetched.
  let joinSeq = 0;

  const participantList = () => (call ? Object.values(call.participants()) : []);

  function setState(next, msg = '') {
    state = next;
    message = msg;
    render();
  }

  function render() {
    if (!dock) return;
    const list = state === 'joined' ? participantList() : [];
    const local = list.find((p) => p.local);
    const rows = participantRows(list, speakingIds(lastLoudAt, Date.now()), localId);
    const me = rows.find((r) => r.isLocal);
    const label = dockLabel(state, { count: rows.length, muted: me ? me.muted : false, message });
    statusEl.textContent = label.text;
    joinBtn.textContent = label.joinText;
    joinBtn.hidden = !label.canJoin;
    muteBtn.hidden = !label.canMute;
    muteBtn.textContent = label.muteText || 'Mute';
    leaveBtn.hidden = !label.canLeave;
    listBtn.hidden = state !== 'joined';
    listEl.hidden = state !== 'joined' || !listOpen;
    listBtn.setAttribute('aria-expanded', String(listOpen));
    listBtn.textContent = listOpen ? 'Hide list' : "Who's in";
    dock.classList.toggle('voice-in-call', state === 'joined');
    if (local && local.session_id) localId = local.session_id;

    // The list is small and rebuilt whole; names go in via textContent. Skipped while it's hidden
    // (the speaking timer re-renders a few times a second); opening it renders again.
    if (listEl.hidden) return;
    listEl.textContent = '';
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = 'voice-row' + (r.speaking ? ' speaking' : '') + (r.muted ? ' muted' : '');
      const name = document.createElement('span');
      name.className = 'voice-name';
      name.textContent = r.name + (r.isLocal ? ' (you)' : '');
      li.appendChild(name);
      if (r.muted) {
        const m = document.createElement('span');
        m.className = 'voice-muted-mark';
        m.textContent = 'muted';
        li.appendChild(m);
      }
      listEl.appendChild(li);
    }
  }

  // ---- remote audio ----------------------------------------------------------------------

  function dropAudio(id) {
    const a = audioEls.get(id);
    if (!a) return;
    a.el.srcObject = null;
    a.el.remove();
    audioEls.delete(id);
  }

  function clearAudio() {
    for (const id of [...audioEls.keys()]) dropAudio(id);
    soundBtn.hidden = true;
  }

  function playEl(el) {
    const p = el.play();
    if (p && p.catch) p.catch(() => { soundBtn.hidden = false; }); // autoplay policy
  }

  function syncAudio() {
    const seen = new Set();
    for (const p of participantList()) {
      if (p.local) continue;
      const track = p.tracks && p.tracks.audio && p.tracks.audio.persistentTrack;
      if (!track) continue;
      seen.add(p.session_id);
      let a = audioEls.get(p.session_id);
      if (!a) {
        const el = document.createElement('audio');
        el.autoplay = true;
        el.setAttribute('playsinline', '');
        audioHost.appendChild(el);
        a = { el, trackId: null };
        audioEls.set(p.session_id, a);
      }
      if (a.trackId !== track.id) {
        a.trackId = track.id;
        a.el.srcObject = new MediaStream([track]);
        playEl(a.el);
      }
    }
    for (const id of [...audioEls.keys()]) if (!seen.has(id)) dropAudio(id);
  }

  soundBtn.addEventListener('click', () => {
    soundBtn.hidden = true;
    for (const { el } of audioEls.values()) playEl(el);
  });

  // ---- speaking ----------------------------------------------------------------------------

  function noteLevel(id, level) {
    if (id && level > SPEECH_LEVEL) lastLoudAt[id] = Date.now();
  }

  function startSpeakingTimer() {
    stopSpeakingTimer();
    // Re-render a few times a second while joined so rings fade after the hold time.
    speakTimer = setInterval(() => { if (state === 'joined') render(); }, 300);
  }
  function stopSpeakingTimer() {
    if (speakTimer) clearInterval(speakTimer);
    speakTimer = null;
    for (const k of Object.keys(lastLoudAt)) delete lastLoudAt[k];
  }

  // ---- call lifecycle ----------------------------------------------------------------------

  function resetAfterCall() {
    clearAudio();
    stopSpeakingTimer();
    localId = null;
  }

  function onCall(fn) {
    return (ev) => { try { fn(ev); } catch (e) { console.error('[voice]', e); } };
  }

  function makeCall(Daily) {
    const c = Daily.createCallObject({ audioSource: true, videoSource: false, subscribeToTracksAutomatically: true });
    c.on('joined-meeting', onCall(() => {
      // A camera-error during join (mic blocked) must win over a late joined-meeting.
      if (state !== 'joining') return;
      setState('joined');
      syncAudio();
      startSpeakingTimer();
      // Levels drive the speaking ring. Failures just mean no ring.
      c.startLocalAudioLevelObserver(LEVEL_INTERVAL_MS).catch(() => {});
      c.startRemoteParticipantsAudioLevelObserver(LEVEL_INTERVAL_MS).catch(() => {});
    }));
    const refresh = onCall(() => { if (state === 'joined') { syncAudio(); render(); } });
    c.on('participant-joined', refresh);
    c.on('participant-updated', refresh);
    c.on('participant-left', refresh);
    c.on('local-audio-level', onCall((ev) => noteLevel(localId, ev.audioLevel)));
    c.on('remote-participants-audio-level', onCall((ev) => {
      for (const [id, level] of Object.entries(ev.participantsAudioLevel || {})) noteLevel(id, level);
    }));
    c.on('left-meeting', onCall(() => {
      resetAfterCall();
      if (state !== 'error') setState('idle');
    }));
    c.on('camera-error', onCall((ev) => {
      // Mic problems arrive here. If we're not in yet, stop; if we are, the call carries on listen-only.
      const text = describeVoiceError(ev && ev.error && ev.error.type);
      if (state === 'joined') { message = text; render(); return; }
      resetAfterCall();
      setState('error', text);
      c.leave().catch(() => {});
    }));
    c.on('error', onCall(() => {
      resetAfterCall();
      setState('error', describeVoiceError('voice_unavailable'));
      // A fatal error leaves the call object unusable: drop it, the next Join builds a fresh one.
      const dead = call;
      call = null;
      if (dead) dead.destroy().catch(() => {});
    }));
    return c;
  }

  async function fetchToken() {
    let res;
    try {
      res = await fetch(`/vtt/api/campaigns/${encodeURIComponent(getCampaignId())}/voice-token`, { method: 'POST' });
    } catch {
      throw new Error('network');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'voice_unavailable');
    return body;
  }

  async function join() {
    if ((state !== 'idle' && state !== 'error') || !getCampaignId()) return;
    const seq = ++joinSeq;
    setState('loading');
    try {
      const { url, token } = await fetchToken();
      if (seq !== joinSeq) return;
      const Daily = await loadDailyScript();
      if (seq !== joinSeq) return;
      if (!call) {
        if (typeof Daily.supportedBrowser === 'function' && !Daily.supportedBrowser().supported) throw new Error('unsupported');
        call = makeCall(Daily);
      }
      setState('joining');
      await call.join({ url, token });
      // Left (or kicked) while the join was in flight: make sure we're out.
      if (seq !== joinSeq && call) call.leave().catch(() => {});
    } catch (e) {
      if (seq !== joinSeq) return;
      // 'error' event handling may already have set the state; don't overwrite a more specific one.
      if (state === 'loading' || state === 'joining') {
        resetAfterCall();
        setState('error', describeVoiceError(e && e.message));
        if (call) call.leave().catch(() => {});
      }
    }
  }

  async function leave() {
    joinSeq++; // cancels any join still waiting on the token or the script
    if (state === 'loading') { setState('idle'); return; }
    if (!call || state === 'idle' || state === 'leaving') return;
    setState('leaving');
    try {
      await call.leave();
    } catch { /* fall through to the reset */ }
    resetAfterCall();
    if (state === 'leaving') setState('idle');
  }

  function toggleMute() {
    if (!call || state !== 'joined') return;
    // Read the real state from the call, not a local guess; the participant-updated event re-renders.
    call.setLocalAudio(!call.localAudio());
  }

  joinBtn.addEventListener('click', () => { join(); });
  leaveBtn.addEventListener('click', () => { leave(); });
  muteBtn.addEventListener('click', toggleMute);
  listBtn.addEventListener('click', () => { listOpen = !listOpen; render(); });
  // Best effort: Daily drops a vanished participant on its own shortly after anyway.
  window.addEventListener('pagehide', () => { if (call) call.leave().catch(() => {}); });

  render();

  return {
    // Idempotent and never resets an active call (state:full fires again on every reconnect).
    show() { if (dock) dock.hidden = false; },
    hide() { if (dock) dock.hidden = true; },
    leave,
    // Removed from the campaign (or it was archived): the server also ejects, this is the fast path.
    onKickedRemoved() { leave(); },
    get isInCall() { return state === 'joined' || state === 'joining'; }
  };
}
