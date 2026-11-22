// Voice chat dock (daily-voice plan, Units 2 and 3). Campaign tables only: main.js calls show() once
// the table has joined and never calls it for Quick rooms, so those never see the dock.
//
// The dock is a direct child of <body>, outside #sidebar/#app, so renderSidebar() rebuilds, map
// switches and socket reconnects never touch it, and the call carries on underneath them.
//
// daily-js is loaded from a pinned CDN URL on first Join (the VTT has no bundler) and used in
// call-object mode (our own UI). In that mode daily-js does not play remote audio, so we keep one
// <audio> element per remote participant. Participant names are user-controlled: everything is
// rendered with textContent.
//
// Unit 3 adds: idle auto-leave (rules in shared/voiceIdle.js), the 6 h Daily-side eject message,
// listen-only joining when the mic is blocked, mic/speaker pickers, and the "Rejoin voice" hint.
import {
  SPEECH_LEVEL, dockLabel, describeEject, describeVoiceError, isMicError, participantRows, pickDevices, rememberedDevice, speakingIds
} from './shared/voiceView.js';
import { createIdleTracker, idleTimings } from './shared/voiceIdle.js';

// Daily retires old daily-js versions, so this needs bumping now and then (npm view
// @daily-co/daily-js version). dist/daily.js is the UMD build and sets window.Daily. The integrity
// hash is of that exact file (from unpkg's ?meta listing for this version): regenerate it with the
// version, or drop the attribute while testing a new one.
const DAILY_JS_VERSION = '0.95.0';
const DAILY_JS_URL = `https://unpkg.com/@daily-co/daily-js@${DAILY_JS_VERSION}/dist/daily.js`;
const DAILY_JS_INTEGRITY = 'sha256-0hXNMDasaZMD8gJWdF0v85S6vDSEIOJPTSwpZY9opTU=';
const LEVEL_INTERVAL_MS = 200;
// Matches the server's default DAILY_SESSION_CAP_HOURS. Only used to word the eject message.
const SESSION_CAP_MS = 6 * 3600 * 1000;
const LS_INPUT = 'vtt_voice_input';
const LS_OUTPUT = 'vtt_voice_output';

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

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

// getCharacterId (optional): the character the player is controlling on the table right now, or null.
// It is only a hint for the display name; the server checks ownership and builds the name itself.
export function createVoice({ getCampaignId, getCharacterId = () => null }) {
  const dock = document.getElementById('voiceDock');
  const statusEl = document.getElementById('voiceStatus');
  const joinBtn = document.getElementById('voiceJoin');
  const muteBtn = document.getElementById('voiceMute');
  const leaveBtn = document.getElementById('voiceLeave');
  const listBtn = document.getElementById('voiceListToggle');
  const listEl = document.getElementById('voiceList');
  const soundBtn = document.getElementById('voiceSound');
  const audioHost = document.getElementById('voiceAudioHost');
  const listenBtn = document.getElementById('voiceListen');
  const noteEl = document.getElementById('voiceNote');
  const promptEl = document.getElementById('voicePrompt');
  const promptText = document.getElementById('voicePromptText');
  const stayBtn = document.getElementById('voiceStay');
  const promptLeaveBtn = document.getElementById('voicePromptLeave');
  const devicesBtn = document.getElementById('voiceDevicesToggle');
  const devicesEl = document.getElementById('voiceDevices');
  const inputSel = document.getElementById('voiceInputSel');
  const outputRow = document.getElementById('voiceOutputRow');
  const outputSel = document.getElementById('voiceOutputSel');

  // ?voiceIdleTest=1 divides the idle timings by 60 so the rules can be tried by hand.
  const timings = idleTimings(new URLSearchParams(location.search).get('voiceIdleTest') === '1' ? 60 : 1);
  const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  let state = 'idle';
  let message = '';
  let offerListenOnly = false; // set with an error state when the mic was the problem
  let listenOnly = false; // the current/last join is without a mic
  let call = null;
  let callListenOnly = false; // which mode `call` was built for
  let localId = null;
  let listOpen = false;
  let devicesOpen = false;
  let joinedAt = 0;
  let rejoinHint = false;
  let outputId = null;
  const audioEls = new Map(); // session_id -> { el, trackId }
  const lastLoudAt = {}; // session_id -> ms of last sample above SPEECH_LEVEL
  let speakTimer = null;
  let idleTimer = null;
  let idle = null; // idle tracker while joined
  // Bumped by leave(). A join() that was started earlier sees the change after each await and bails,
  // so a kick/Leave during 'loading' can't go on to join with the token it already fetched.
  let joinSeq = 0;
  // Set by pagehide so the Daily leave that follows doesn't clear the "Rejoin voice" hint.
  let leavingForUnload = false;
  const TITLE_CUE = '(!) Still in voice? ';

  const participantList = () => (call ? Object.values(call.participants()) : []);

  // The reload hint: sessionStorage survives a reload of this tab only. Set while joined, cleared on
  // every deliberate or automatic leave, but NOT by pagehide (that is the reload we want to remember).
  const hintKey = () => `vtt_voice_${getCampaignId()}`;
  function setHint(on) {
    rejoinHint = false;
    try {
      if (on) sessionStorage.setItem(hintKey(), '1');
      else sessionStorage.removeItem(hintKey());
    } catch { /* storage blocked: no hint, nothing else lost */ }
  }
  function readHint() {
    try { rejoinHint = sessionStorage.getItem(hintKey()) === '1'; } catch { rejoinHint = false; }
  }

  function setState(next, msg = '', opts = {}) {
    state = next;
    message = msg;
    offerListenOnly = !!opts.offerListenOnly;
    render();
  }

  function render() {
    if (!dock) return;
    const list = state === 'joined' ? participantList() : [];
    const local = list.find((p) => p.local);
    const rows = participantRows(list, speakingIds(lastLoudAt, Date.now()), localId);
    const me = rows.find((r) => r.isLocal);
    const label = dockLabel(state, { count: rows.length, muted: me ? me.muted : false, message, listenOnly, offerListenOnly, rejoin: rejoinHint });
    statusEl.textContent = label.text;
    joinBtn.textContent = label.joinText;
    joinBtn.hidden = !label.canJoin;
    joinBtn.classList.toggle('voice-rejoin', !!label.highlightJoin);
    listenBtn.hidden = !label.canListenOnly;
    muteBtn.hidden = !label.canMute;
    muteBtn.textContent = label.muteText || 'Mute';
    leaveBtn.hidden = !label.canLeave;
    listBtn.hidden = state !== 'joined';
    listEl.hidden = state !== 'joined' || !listOpen;
    listBtn.setAttribute('aria-expanded', String(listOpen));
    listBtn.textContent = listOpen ? 'Hide list' : "Who's in";
    devicesBtn.hidden = state !== 'joined';
    devicesEl.hidden = state !== 'joined' || !devicesOpen;
    devicesBtn.setAttribute('aria-expanded', String(devicesOpen));
    // A mid-call problem (e.g. the mic failing) stays visible while joined.
    noteEl.textContent = state === 'joined' ? message : '';
    noteEl.hidden = !(state === 'joined' && message);
    const prompting = state === 'joined' && !!idle && idle.promptShown;
    promptEl.hidden = !prompting;
    // Cue for a hidden tab: the prompt shows in the tab title too, restored when it clears.
    if (prompting && !document.title.startsWith(TITLE_CUE)) document.title = TITLE_CUE + document.title;
    else if (!prompting && document.title.startsWith(TITLE_CUE)) document.title = document.title.slice(TITLE_CUE.length);
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

  function applySink(el) {
    if (canPickOutput && outputId && el.setSinkId) el.setSinkId(outputId).catch(() => {});
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
        applySink(el);
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

  // ---- speaking and idle -------------------------------------------------------------------

  function noteLevel(id, level) {
    // Any sample at all proves the observers work (so the silence rule may apply); loud ones are speech.
    if (idle) idle.noteSignal();
    if (id && level > SPEECH_LEVEL) {
      lastLoudAt[id] = Date.now();
      if (idle) idle.noteSpeech();
    }
  }

  function startTimers() {
    stopTimers();
    idle = createIdleTracker({ timings });
    idle.noteCount(participantList().length);
    // Re-render a few times a second while joined so rings fade after the hold time.
    speakTimer = setInterval(() => { if (state === 'joined') render(); }, 300);
    // Idle rules. A hidden tab is deliberately not consulted: people alt-tab while talking. Browsers
    // throttle this timer in a background tab, which only makes the rules lazier.
    idleTimer = setInterval(idleTick, 1000);
  }
  function stopTimers() {
    if (speakTimer) clearInterval(speakTimer);
    if (idleTimer) clearInterval(idleTimer);
    speakTimer = null;
    idleTimer = null;
    idle = null;
    for (const k of Object.keys(lastLoudAt)) delete lastLoudAt[k];
  }

  function idleTick() {
    if (state !== 'joined' || !idle) return;
    const action = idle.tick();
    if (action === 'leave_alone') autoLeave('Left voice: nobody else was in the call.');
    else if (action === 'leave_silent') autoLeave('Left voice after a long silence.');
    else {
      if (idle.promptShown) {
        promptText.textContent = `Still in voice? Leaving in ${idle.promptSecondsLeft()} s`;
      }
      if (action === 'prompt' || action === 'clear_prompt') render();
    }
  }

  async function autoLeave(msg) {
    await leave();
    setState('idle', msg);
  }

  stayBtn.addEventListener('click', () => {
    if (idle) idle.stay();
    render();
  });
  promptLeaveBtn.addEventListener('click', () => { leave(); });

  // ---- devices -----------------------------------------------------------------------------

  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let all;
    try { all = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    fillSelect(inputSel, pickDevices(all, 'audioinput'), lsGet(LS_INPUT));
    outputRow.hidden = !canPickOutput;
    if (canPickOutput) fillSelect(outputSel, pickDevices(all, 'audiooutput'), outputId);
  }

  function fillSelect(sel, list, wanted) {
    sel.textContent = '';
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label;
      sel.appendChild(o);
    }
    const keep = rememberedDevice(wanted, list);
    if (keep) sel.value = keep;
  }

  // On join: apply the remembered mic/speaker if they still exist (stale ids are ignored).
  async function applyRememberedDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let all;
    try { all = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    if (!listenOnly) {
      const inId = rememberedDevice(lsGet(LS_INPUT), pickDevices(all, 'audioinput'));
      if (inId && call) call.setInputDevicesAsync({ audioDeviceId: inId }).catch(() => {});
    }
    if (canPickOutput) {
      outputId = rememberedDevice(lsGet(LS_OUTPUT), pickDevices(all, 'audiooutput'));
      for (const { el } of audioEls.values()) applySink(el);
    }
  }

  inputSel.addEventListener('change', () => {
    lsSet(LS_INPUT, inputSel.value);
    if (call && state === 'joined' && !listenOnly) call.setInputDevicesAsync({ audioDeviceId: inputSel.value }).catch(() => {});
  });
  outputSel.addEventListener('change', () => {
    outputId = outputSel.value || null;
    if (outputId) lsSet(LS_OUTPUT, outputId);
    for (const { el } of audioEls.values()) applySink(el);
  });
  devicesBtn.addEventListener('click', () => {
    devicesOpen = !devicesOpen;
    render();
    if (devicesOpen) refreshDevices();
  });

  // ---- call lifecycle ----------------------------------------------------------------------

  function resetAfterCall() {
    clearAudio();
    stopTimers();
    localId = null;
  }

  function onCall(fn) {
    return (ev) => { try { fn(ev); } catch (e) { console.error('[voice]', e); } };
  }

  function dropCall() {
    const dead = call;
    call = null;
    if (dead) dead.destroy().catch(() => {});
  }

  function makeCall(Daily, noMic) {
    const c = Daily.createCallObject({ audioSource: !noMic, videoSource: false, subscribeToTracksAutomatically: true });
    c.on('joined-meeting', onCall(() => {
      // A camera-error during join (mic blocked) must win over a late joined-meeting.
      if (state !== 'joining') return;
      joinedAt = Date.now();
      setHint(true);
      setState('joined');
      syncAudio();
      startTimers();
      applyRememberedDevices();
      // Levels drive the speaking ring and the silence rule. If they never arrive the silence rule
      // never fires (unknown counts as active); active-speaker-change is a coarser fallback signal.
      c.startLocalAudioLevelObserver(LEVEL_INTERVAL_MS).catch(() => {});
      c.startRemoteParticipantsAudioLevelObserver(LEVEL_INTERVAL_MS).catch(() => {});
    }));
    const refresh = onCall(() => {
      if (state !== 'joined') return;
      if (idle) idle.noteCount(participantList().length);
      syncAudio();
      render();
    });
    c.on('participant-joined', refresh);
    c.on('participant-updated', refresh);
    c.on('participant-left', refresh);
    c.on('active-speaker-change', onCall(() => { if (idle) idle.noteSpeech(); }));
    c.on('local-audio-level', onCall((ev) => noteLevel(localId, ev.audioLevel)));
    c.on('remote-participants-audio-level', onCall((ev) => {
      for (const [id, level] of Object.entries(ev.participantsAudioLevel || {})) noteLevel(id, level);
    }));
    c.on('left-meeting', onCall(() => {
      // Our own leave()/autoLeave() already manage state and messages; this only covers a leave we
      // didn't ask for.
      if (state === 'joined' || state === 'joining') {
        resetAfterCall();
        if (!leavingForUnload) setHint(false);
        setState('idle');
      }
    }));
    c.on('camera-error', onCall((ev) => {
      // Mic problems arrive here. If we're not in yet, stop and offer listen-only; if we are, the call
      // carries on and we just say why there's no mic.
      const type = ev && ev.error && ev.error.type;
      const text = describeVoiceError(type);
      if (state === 'joined') { message = text; render(); return; }
      resetAfterCall();
      setState('error', text, { offerListenOnly: isMicError(type) && !callListenOnly });
      c.leave().catch(() => {});
    }));
    c.on('error', onCall((ev) => {
      const type = ev && ev.error && ev.error.type;
      const wasJoined = state === 'joined';
      const joinedFor = Date.now() - joinedAt;
      resetAfterCall();
      setHint(false);
      if (type === 'ejected') {
        // Daily ejected us: the session cap (eject_after_elapsed) or a server-side removal.
        setState('idle', wasJoined ? describeEject(joinedFor, SESSION_CAP_MS) : describeVoiceError('voice_unavailable'));
      } else {
        setState('error', describeVoiceError(type === 'meeting-full' ? 'meeting-full' : 'voice_unavailable'));
      }
      // A fatal error leaves the call object unusable: drop it, the next Join builds a fresh one.
      dropCall();
    }));
    return c;
  }

  async function fetchToken() {
    let res;
    try {
      const characterId = getCharacterId();
      const init = { method: 'POST' };
      if (typeof characterId === 'string' && characterId) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify({ characterId });
      }
      res = await fetch(`/vtt/api/campaigns/${encodeURIComponent(getCampaignId())}/voice-token`, init);
    } catch {
      throw new Error('network');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'voice_unavailable');
    return body;
  }

  async function join(noMic = false) {
    if ((state !== 'idle' && state !== 'error') || !getCampaignId()) return;
    const seq = ++joinSeq;
    listenOnly = noMic;
    rejoinHint = false;
    setState('loading');
    try {
      const { url, token } = await fetchToken();
      if (seq !== joinSeq) return;
      const Daily = await loadDailyScript();
      if (seq !== joinSeq) return;
      // A call object is built for one mode (mic or no mic); switching modes needs a fresh one.
      if (call && callListenOnly !== noMic) dropCall();
      if (!call) {
        if (typeof Daily.supportedBrowser === 'function' && !Daily.supportedBrowser().supported) throw new Error('unsupported');
        callListenOnly = noMic;
        call = makeCall(Daily, noMic);
      }
      setState('joining');
      await call.join({ url, token });
      // Left (or kicked) while the join was in flight: make sure we're out.
      if (seq !== joinSeq && call) call.leave().catch(() => {});
    } catch (e) {
      if (seq !== joinSeq) return;
      // 'error'/'camera-error' handling may already have set the state; don't overwrite a more specific one.
      if (state === 'loading' || state === 'joining') {
        resetAfterCall();
        setState('error', describeVoiceError(e && e.message));
        if (call) call.leave().catch(() => {});
      }
    }
  }

  async function leave() {
    joinSeq++; // cancels any join still waiting on the token or the script
    setHint(false); // a deliberate or automatic leave: no "Rejoin voice" after a reload
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
    if (!call || state !== 'joined' || listenOnly) return;
    // Read the real state from the call, not a local guess; the participant-updated event re-renders.
    call.setLocalAudio(!call.localAudio());
  }

  joinBtn.addEventListener('click', () => { join(false); });
  listenBtn.addEventListener('click', () => { join(true); });
  leaveBtn.addEventListener('click', () => { leave(); });
  muteBtn.addEventListener('click', toggleMute);
  listBtn.addEventListener('click', () => { listOpen = !listOpen; render(); });
  // Best effort: Daily drops a vanished participant on its own shortly after anyway. Deliberately
  // does not clear the rejoin hint: a reload is exactly when it is wanted.
  window.addEventListener('pagehide', () => {
    leavingForUnload = true;
    if (call) call.leave().catch(() => {});
  });
  // Restored from the back/forward cache instead of reloaded: we are a normal page again.
  window.addEventListener('pageshow', () => { leavingForUnload = false; });

  render();

  return {
    // Idempotent and never resets an active call (state:full fires again on every reconnect).
    show() {
      if (!dock) return;
      if (dock.hidden && state === 'idle') { readHint(); render(); }
      dock.hidden = false;
    },
    hide() { if (dock) dock.hidden = true; },
    leave,
    // Removed from the campaign (or it was archived): the server also ejects, this is the fast path.
    onKickedRemoved() { leave(); },
    get isInCall() { return state === 'joined' || state === 'joining'; }
  };
}
