// Voice chat dock (daily-voice plan, Units 2 and 3). Campaign tables only: main.js calls show() once
// the table has joined and never calls it for Quick rooms, so those never see the dock.
//
// The dock is ONE persistent node. main.js's renderSidebar() rebuilds the sidebar with innerHTML,
// which detaches it, so main.js calls voice.mount(slot) right after every rebuild to move the same
// node into the room info box. Remote <audio> elements live in a separate hidden body child, so a
// detached dock never stops audio, and map switches and socket reconnects don't touch the call.
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
import { applyRecordingMessage, badgeText, formatElapsed, pruneRecorders, recordingFileName, recordingMessage } from './shared/voiceRecord.js';
import { createRecorder, downloadBlob } from './voiceRecorder.js';
import {
  VOLUME_BUTTON_STEP, VOLUME_DEFAULT, VOLUME_MAX, VOLUME_SLIDER_STEP,
  clampVolume, elementVolume, gainFor, needsGain, parseVolumes, serialiseVolumes, stepVolume, volumeKey, volumeText, withVolume
} from './shared/voiceVolume.js';

// Daily retires old daily-js versions, so this needs bumping now and then (npm view
// @daily-co/daily-js version). dist/daily.js is the UMD build and sets window.Daily. The integrity
// hash is of that exact file (from unpkg's ?meta listing for this version): regenerate it with the
// version, or drop the attribute while testing a new one.
const DAILY_JS_VERSION = '0.95.0';
const DAILY_JS_URL = `https://unpkg.com/@daily-co/daily-js@${DAILY_JS_VERSION}/dist/daily.js`;
const DAILY_JS_INTEGRITY = 'sha256-0hXNMDasaZMD8gJWdF0v85S6vDSEIOJPTSwpZY9opTU=';
const LEVEL_INTERVAL_MS = 200;
// How long a playback-context resume may take before we offer "Tap to enable sound".
const SOUND_PROMPT_GRACE_MS = 1500;
// Matches the server's default DAILY_SESSION_CAP_HOURS. Only used to word the eject message.
const SESSION_CAP_MS = 6 * 3600 * 1000;
const LS_INPUT = 'vtt_voice_input';
const LS_OUTPUT = 'vtt_voice_output';
const LS_VOLUMES = 'vtt_voice_volumes'; // { "<app user id>": pct }, only non-100 values

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
// getCampaignName (optional): only used to name a recording file.
export function createVoice({ getCampaignId, getCharacterId = () => null, getCampaignName = () => '' }) {
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
  const recordBtn = document.getElementById('voiceRecord');
  const badgeEl = document.getElementById('voiceBadge');
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
  // Per-person volume needs Web Audio to boost past 100%. Without it we can only attenuate via el.volume.
  const AC = window.AudioContext || window.webkitAudioContext;
  const hasWebAudio = !!AC;

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
  const audioEls = new Map(); // session_id -> { el, trackId, key, src, gain }
  let volumes = parseVolumes(lsGet(LS_VOLUMES)); // app user id -> pct (non-100 only), read once
  const sessionVolumes = new Map(); // session_id -> pct, for participants with no usable user id (not saved)
  let playback = null; // { ctx, bus, busEl }, created lazily the first time someone is routed
  let webAudioBroken = false; // creating the AudioContext threw: behave as if there is no Web Audio
  let resuming = null; // pending playback.ctx.resume() chain, so we never stack them
  let suspending = null; // pending playback.ctx.suspend() from the last call's cleanup
  const rowEls = new Map(); // session_id -> { li, name, mark, key, ctl } for the "Who's in" list
  const lastLoudAt = {}; // session_id -> ms of last sample above SPEECH_LEVEL
  let speakTimer = null;
  let idleTimer = null;
  let idle = null; // idle tracker while joined
  // Bumped by leave(). A join() that was started earlier sees the change after each await and bails,
  // so a kick/Leave during 'loading' can't go on to join with the token it already fetched.
  let joinSeq = 0;
  // Set by pagehide so the Daily leave that follows doesn't clear the "Rejoin voice" hint.
  let leavingForUnload = false;
  // Recording (Rev 4). canRecord comes from the SERVER in the voice-token response (campaign DM or
  // co-DM); the client never decides it. recorders is who is recording right now (session_id -> name),
  // from our own recorder plus Daily app messages from others.
  let canRecord = false;
  let recorders = {};
  let finishing = null;
  const recorder = createRecorder();
  const warnBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
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
    recordBtn.hidden = !(state === 'joined' && canRecord);
    recordBtn.textContent = recorder.active ? `Stop ${formatElapsed(Date.now() - recorder.startedAt)}` : 'Record';
    recordBtn.classList.toggle('voice-recording', recorder.active);
    const badge = state === 'joined' ? badgeText(recorders) : null;
    badgeEl.textContent = badge || '';
    badgeEl.hidden = !badge;
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

    // Skipped while the list is hidden (the speaking timer re-renders a few times a second); opening it
    // renders again. Rows are kept and updated in place (keyed by session_id), never rebuilt, so a
    // volume slider that's being dragged survives the re-renders.
    if (listEl.hidden) return;
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, rec] of rowEls) {
      if (!ids.has(id)) { rec.li.remove(); rowEls.delete(id); }
    }
    rows.forEach((r, i) => {
      let rec = rowEls.get(r.id);
      if (!rec) { rec = createRow(r); rowEls.set(r.id, rec); }
      updateRow(rec, r);
      // Only move a row that's misplaced, so one already in the right place is never detached.
      if (listEl.children[i] !== rec.li) listEl.insertBefore(rec.li, listEl.children[i] || null);
    });
  }

  // ---- "Who's in" rows and per-person volume controls ------------------------------------------

  const effectiveMax = () => (hasWebAudio && !webAudioBroken ? VOLUME_MAX : VOLUME_DEFAULT);

  function createRow(r) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'voice-name';
    li.appendChild(name);
    const mark = document.createElement('span');
    mark.className = 'voice-muted-mark';
    mark.textContent = 'muted';
    li.appendChild(mark);
    const rec = { li, name, mark, key: null, ctl: null };
    if (r.isLocal) return rec; // no control on your own row
    const id = r.id;
    const wrap = document.createElement('div');
    wrap.className = 'voice-vol';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'voice-vol-slider';
    slider.min = '0';
    slider.max = String(effectiveMax());
    slider.step = String(VOLUME_SLIDER_STEP);
    const mkBtn = (cls, text, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      if (label) b.setAttribute('aria-label', label);
      return b;
    };
    const minus = mkBtn('voice-vol-btn', '-', 'Quieter');
    const plus = mkBtn('voice-vol-btn', '+', 'Louder');
    const pctEl = document.createElement('span');
    pctEl.className = 'voice-vol-pct';
    const reset = mkBtn('voice-vol-reset', 'Reset');
    reset.title = 'Back to 100%';
    wrap.append(slider, minus, pctEl, plus, reset);
    li.appendChild(wrap);
    const current = () => volumeOf(id, rec.key);
    // Drag: apply live, save on release.
    slider.addEventListener('input', () => setVolume(id, slider.valueAsNumber, false));
    slider.addEventListener('change', () => setVolume(id, slider.valueAsNumber, true));
    minus.addEventListener('click', () => setVolume(id, stepVolume(current(), -1, VOLUME_BUTTON_STEP, effectiveMax()), true));
    plus.addEventListener('click', () => setVolume(id, stepVolume(current(), 1, VOLUME_BUTTON_STEP, effectiveMax()), true));
    reset.addEventListener('click', () => setVolume(id, VOLUME_DEFAULT, true));
    rec.ctl = { slider, minus, plus, pctEl, reset };
    return rec;
  }

  function updateRow(rec, r) {
    rec.li.className = 'voice-row' + (r.speaking ? ' speaking' : '') + (r.muted ? ' muted' : '');
    const text = r.name + (r.isLocal ? ' (you)' : '');
    if (rec.name.textContent !== text) rec.name.textContent = text;
    rec.mark.hidden = !r.muted;
    rec.key = volumeKey(r.userId, r.id);
    const c = rec.ctl;
    if (!c) return;
    c.slider.setAttribute('aria-label', 'Volume for ' + r.name); // attribute, never parsed as HTML
    const max = effectiveMax();
    const pct = volumeOf(r.id, rec.key);
    c.pctEl.textContent = volumeText(pct);
    if (c.slider.max !== String(max)) c.slider.max = String(max);
    // Never fight a slider that's being dragged.
    if (c.slider !== document.activeElement && c.slider.value !== String(pct)) c.slider.value = String(pct);
    c.minus.disabled = pct <= 0;
    c.plus.disabled = pct >= max;
    c.reset.hidden = pct === VOLUME_DEFAULT;
  }

  // A volume control was used (slider, -/+ or Reset). Those are user gestures, so this is also a
  // good moment to start/resume the playback context.
  function setVolume(sessionId, pct, persist) {
    const rec = rowEls.get(sessionId);
    const key = rec ? rec.key : null;
    const v = clampVolume(pct, effectiveMax());
    if (key) {
      volumes = withVolume(volumes, key, v);
      if (persist) lsSet(LS_VOLUMES, serialiseVolumes(volumes));
    } else if (v === VOLUME_DEFAULT) {
      sessionVolumes.delete(sessionId);
    } else {
      sessionVolumes.set(sessionId, v);
    }
    // Only bother with Web Audio if someone needs it (or it already exists and may need resuming).
    if (needsGain(v) || playback) ensurePlayback(true);
    applyVolumesFor(sessionId, key);
    render();
  }

  // ---- remote audio ----------------------------------------------------------------------

  function dropAudio(id) {
    const a = audioEls.get(id);
    if (!a) return;
    unroute(a);
    a.el.srcObject = null;
    a.el.remove();
    audioEls.delete(id);
  }

  function clearAudio() {
    for (const id of [...audioEls.keys()]) dropAudio(id);
    soundBtn.hidden = true;
    // Park the playback context between calls. Never closed: a new Join may have just made use of it.
    // ensurePlayback() waits for `suspending` before resuming, so a quick rejoin isn't parked by it.
    if (playback && playback.ctx.state === 'running' && !suspending) {
      suspending = playback.ctx.suspend().catch(() => {}).finally(() => { suspending = null; });
    }
  }

  function playEl(el) {
    const p = el.play();
    if (p && p.catch) p.catch(() => { soundBtn.hidden = false; }); // autoplay policy
  }

  function applySink(el) {
    if (canPickOutput && outputId && el.setSinkId) el.setSinkId(outputId).catch(() => {});
  }

  // ---- per-person volume (listener-side, this browser only) -----------------------------------
  //
  // 1. At exactly 100% a person plays as always: their own <audio> element, unmuted, volume 1.
  // 2. At any other value the element stays attached but MUTED (Chromium only feeds a remote WebRTC
  //    stream to Web Audio if it's also attached to an element), and a MediaStreamAudioSource ->
  //    GainNode feeds a shared bus in one page-wide AudioContext. Gain is the only thing that can both
  //    boost (el.volume caps at 1) and attenuate on iOS (which ignores el.volume).
  // 3. The bus is a MediaStreamDestination played by one hidden <audio> (busEl) when the speaker picker
  //    exists, so the picker moves routed and pass-through people alike. Otherwise it's ctx.destination.
  // 4. RECORDINGS ARE UNAFFECTED: a.el.srcObject stays the raw stream and the gain output only goes to
  //    the bus. The recorder has its own AudioContext. Don't share them or point srcObject at a
  //    processed stream, or the DM's local volume choices would leak into the recording.
  // Without Web Audio (or if it throws) we fall back to el.volume (no boost). Web Audio failures never
  // silence anyone: the element path is used instead.

  // Percentage for one participant: by app user id when we have one, else per session (not saved).
  function volumeOf(sessionId, key) {
    const v = key ? (volumes.get(key) ?? VOLUME_DEFAULT) : (sessionVolumes.get(sessionId) ?? VOLUME_DEFAULT);
    return clampVolume(v, effectiveMax());
  }

  // Create the playback context on first need and resume it if it's suspended. Call it synchronously
  // from a click where possible: Safari only honours resume() inside the gesture.
  function ensurePlayback(fromGesture = false) {
    if (!hasWebAudio || webAudioBroken) return null;
    if (!playback) {
      let busEl = null;
      let ctx = null;
      try {
        ctx = new AC();
        let bus = ctx.destination;
        if (canPickOutput) {
          const dest = ctx.createMediaStreamDestination();
          bus = dest;
          busEl = document.createElement('audio');
          busEl.autoplay = true;
          busEl.setAttribute('playsinline', '');
          busEl.srcObject = dest.stream;
          applySink(busEl);
          audioHost.appendChild(busEl);
        }
        // Ignored while our own resume is in flight (e.g. the previous call's suspend landing just
        // before it), so the prompt doesn't flash up for a context that's about to run again.
        ctx.onstatechange = () => { if (!resuming) updateSoundPrompt(); };
        playback = { ctx, bus, busEl };
        if (busEl) playEl(busEl);
      } catch (e) {
        console.error('[voice] Web Audio unavailable, using plain volume', e);
        if (busEl) busEl.remove();
        if (ctx) ctx.close().catch(() => {});
        webAudioBroken = true;
        return null;
      }
    }
    const { ctx } = playback;
    if (fromGesture && ctx.state !== 'running') {
      // Inside a click: always call resume() right now, even if an earlier one is still pending
      // (Safari only honours it within the gesture, and a blocked one can stay pending forever).
      ctx.resume().catch(() => {});
    }
    if (!resuming && (suspending || ctx.state !== 'running')) {
      // One resume in flight at most. If the last call's suspend() hasn't landed yet, wait for it
      // first, or it would land after us and park the new call's audio.
      resuming = (suspending || Promise.resolve())
        .then(() => ctx.resume())
        .catch(() => {})
        .finally(() => { resuming = null; updateSoundPrompt(); });
      // A resume blocked by autoplay policy can stay pending with no statechange at all, so check
      // once regardless: still not running with someone routed -> "Tap to enable sound".
      setTimeout(updateSoundPrompt, SOUND_PROMPT_GRACE_MS);
    }
    return playback;
  }

  function unroute(a) {
    try { if (a.src) a.src.disconnect(); } catch { /* already gone */ }
    try { if (a.gain) a.gain.disconnect(); } catch { /* already gone */ }
    a.src = null;
    a.gain = null;
  }

  // The single place that decides how a participant is played (see the comment block above).
  function applyVolume(id, a) {
    try {
      const pct = volumeOf(id, a.key);
      if (!a.el.srcObject || !needsGain(pct)) {
        unroute(a);
        a.el.muted = false;
        a.el.volume = 1;
        return;
      }
      const pb = ensurePlayback();
      if (!pb) {
        unroute(a);
        a.el.muted = false;
        a.el.volume = elementVolume(pct);
        return;
      }
      if (a.gain) {
        a.gain.gain.setTargetAtTime(gainFor(pct), pb.ctx.currentTime, 0.015); // smooth, no clicks
      } else {
        a.src = pb.ctx.createMediaStreamSource(a.el.srcObject);
        a.gain = pb.ctx.createGain();
        a.gain.gain.value = gainFor(pct);
        a.src.connect(a.gain);
        a.gain.connect(pb.bus);
      }
      a.el.muted = true;
    } catch (e) {
      console.error('[voice] volume routing failed, playing normally', e);
      unroute(a);
      a.el.muted = false;
      a.el.volume = 1;
    }
  }

  // Re-apply for one person. With a user id that's every row of that user (two tabs of one person).
  function applyVolumesFor(sessionId, key) {
    for (const [id, a] of audioEls) {
      if (key ? a.key === key : id === sessionId) applyVolume(id, a);
    }
  }

  // If the context can't run (autoplay policy, or iOS suspended it) while someone is routed, they'd be
  // silent: show the same "Tap to enable sound" button playEl uses. Never hides it (the click does).
  function updateSoundPrompt() {
    if (state !== 'joined' || !playback || playback.ctx.state === 'running') return;
    for (const a of audioEls.values()) {
      if (a.gain) { soundBtn.hidden = false; return; }
    }
  }

  // Every element whose speaker should follow the picker: one per person, plus the shared bus element.
  const outputEls = () => [...[...audioEls.values()].map((a) => a.el), ...(playback && playback.busEl ? [playback.busEl] : [])];

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
        a = { el, trackId: null, key: null, src: null, gain: null };
        audioEls.set(p.session_id, a);
      }
      a.key = volumeKey(p.user_id, p.session_id);
      if (a.trackId !== track.id) {
        a.trackId = track.id;
        a.el.srcObject = new MediaStream([track]);
        unroute(a); // the old source node belonged to the old stream
        playEl(a.el);
      }
      applyVolume(p.session_id, a); // idempotent, so it's fine to run on every pass
    }
    for (const id of [...audioEls.keys()]) if (!seen.has(id)) dropAudio(id);
    if (recorder.active) recorder.sync(buildSources());
  }

  // ---- recording (DM / co-DM only, in this browser) ------------------------------------------

  // Everything audible to us: each remote participant's stream (the one already playing in its
  // <audio> element, which Chromium needs before Web Audio will hear it) plus our own mic.
  // srcObject is the RAW stream; per-person volume lives only in the playback graph, so recordings
  // are unaffected by what the DM has turned up or down locally.
  function buildSources() {
    const m = new Map();
    for (const [id, a] of audioEls) if (a.el.srcObject) m.set(id, { key: a.trackId, stream: a.el.srcObject });
    const me = participantList().find((p) => p.local);
    const t = me && me.tracks && me.tracks.audio && me.tracks.audio.persistentTrack;
    if (t) m.set('local', { key: t.id, stream: new MediaStream([t]) });
    return m;
  }

  const myName = () => {
    const me = participantList().find((p) => p.local);
    return (me && me.user_name) || 'DM';
  };

  function announceRecording(on, to) {
    if (!call) return;
    try { call.sendAppMessage(recordingMessage(on, myName()), to || '*'); } catch { /* never break the call */ }
  }

  function startRecording() {
    // Not while a stop is still finishing: a quick re-Record would otherwise be killed by it.
    if (!canRecord || state !== 'joined' || recorder.active || finishing) return;
    try {
      recorder.start(buildSources());
    } catch {
      message = "Recording isn't supported in this browser.";
      render();
      return;
    }
    if (localId) recorders = { ...recorders, [localId]: myName() };
    announceRecording(true);
    window.addEventListener('beforeunload', warnBeforeUnload);
    render();
  }

  // Stop and download what was captured. Used by the Stop button AND every way of leaving the call
  // (leave, kick, auto-leave, eject), so a recording is never silently lost. Never throws.
  function finishRecording() {
    if (!recorder.active) return finishing || Promise.resolve();
    if (finishing) return finishing;
    const myId = localId;
    const startedAt = recorder.startedAt;
    announceRecording(false);
    window.removeEventListener('beforeunload', warnBeforeUnload);
    finishing = recorder.stop().then(({ blob, ext }) => {
      if (myId) { const { [myId]: _gone, ...rest } = recorders; recorders = rest; }
      if (blob) {
        try { downloadBlob(blob, recordingFileName(getCampaignName(), new Date(startedAt), ext)); } catch (e) { console.error('[voice] download failed', e); }
      }
    }).catch(() => {}).finally(() => { finishing = null; render(); });
    return finishing;
  }

  recordBtn.addEventListener('click', () => { if (recorder.active) finishRecording(); else startRecording(); });

  soundBtn.addEventListener('click', () => {
    soundBtn.hidden = true;
    ensurePlayback(true); // resumes the context if needed
    if (playback && playback.busEl) playEl(playback.busEl);
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
      for (const el of outputEls()) applySink(el);
    }
  }

  inputSel.addEventListener('change', () => {
    lsSet(LS_INPUT, inputSel.value);
    if (call && state === 'joined' && !listenOnly) call.setInputDevicesAsync({ audioDeviceId: inputSel.value }).catch(() => {});
  });
  outputSel.addEventListener('change', () => {
    outputId = outputSel.value || null;
    if (outputId) lsSet(LS_OUTPUT, outputId);
    for (const el of outputEls()) applySink(el);
  });
  devicesBtn.addEventListener('click', () => {
    devicesOpen = !devicesOpen;
    render();
    if (devicesOpen) refreshDevices();
  });

  // ---- call lifecycle ----------------------------------------------------------------------

  function resetAfterCall() {
    // Start stopping the recorder first: it flushes what it has right away. Only tear the audio
    // elements down once it has finished (bounded by the recorder's stop timeout), so the last
    // seconds aren't cut. The rest of the reset doesn't wait.
    const recording = recorder.active || !!finishing;
    const stopped = finishRecording();
    recorders = {};
    if (recording) {
      stopped.then(() => {
        // A new call may have started meanwhile and owns the audio elements now.
        if (state !== 'joined' && state !== 'joining') clearAudio();
      });
    } else {
      clearAudio();
    }
    stopTimers();
    localId = null;
    sessionVolumes.clear();
    rowEls.clear();
    listEl.textContent = '';
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
    // App messages are not stored for late joiners, so a recorder tells each newcomer again.
    c.on('participant-joined', onCall((ev) => { if (recorder.active && ev && ev.participant) announceRecording(true, ev.participant.session_id); }));
    c.on('app-message', onCall((ev) => {
      recorders = applyRecordingMessage(recorders, ev && ev.data, ev && ev.fromId);
      render();
    }));
    c.on('participant-updated', refresh);
    c.on('participant-left', refresh);
    c.on('participant-left', onCall(() => {
      // A recorder who dropped out can't clear their own badge.
      recorders = pruneRecorders(recorders, new Set(participantList().map((p) => p.session_id)));
    }));
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
      const { url, token, canRecord: serverSaysCanRecord } = await fetchToken();
      canRecord = serverSaysCanRecord === true;
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
    await finishRecording(); // announces "stopped" and downloads, while we are still in the call
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

  // ensurePlayback() runs first, synchronously, while we're still inside the click (Safari only allows
  // resume() there). Only when someone has a saved non-100 volume, so we don't start audio for nothing.
  joinBtn.addEventListener('click', () => { if (volumes.size > 0) ensurePlayback(true); join(false); });
  listenBtn.addEventListener('click', () => { if (volumes.size > 0) ensurePlayback(true); join(true); });
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
    // Move the one dock node into the sidebar slot (called after every sidebar rebuild). The node is
    // never re-created, so listeners and state survive; remote audio is outside it.
    mount(slot) {
      if (dock && slot && dock.parentNode !== slot) slot.appendChild(dock);
    },
    leave,
    // Removed from the campaign (or it was archived): the server also ejects, this is the fast path.
    onKickedRemoved() { leave(); },
    get isInCall() { return state === 'joined' || state === 'joining'; }
  };
}
