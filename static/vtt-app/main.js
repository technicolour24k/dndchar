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
  'conditions',
  'imageUrl',
  'visionNormalFt',
  'visionDarkFt',
  'visionTrueFt',
  'visionDevilFt',
  'speedFt',
  'speedRemainingFt',
  'soundFolder',
  'characterId',
  'ac',
  'knownAc',
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
let showMovementRanges = true; // GM-only declutter toggle - purely a local view preference, not synced to session
let combatLogLines = []; // rendered combat-log text, newest last - backfilled on join/reconnect, appended live via combat:log
let rollLogLines = []; // { message, details } - separate from combatLogLines, scoped to this room rather than an encounter
let sessionNoteLines = []; // { id, displayName, message, createdAt } - Session Notes, scoped to a persisted game_sessions row

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

// ---------------------------------------------------------------------------
// Ambient music - a map can carry a musicUrl (bundled library track or a
// custom upload/URL, same choice as map/token images), synced to everyone
// via the existing map:set/state:full path since it just lives on
// session.map. Playback itself is local: browsers block un-gestured
// autoplay-with-sound, and forcing music on players who haven't opted in
// would be rude regardless, so a track change only takes over the (global,
// looping) <audio> element live if the player already had it going -
// otherwise they see the bar update and press play themselves. The bar/audio
// element live outside #sidebar/#mapWrap's re-rendered innerHTML so playback
// survives every unrelated renderSidebar()/render() call.
// ---------------------------------------------------------------------------

const musicBar = document.getElementById('musicBar');
const musicToggleBtn = document.getElementById('musicToggleBtn');
const musicTrackName = document.getElementById('musicTrackName');
const musicVolumeInput = document.getElementById('musicVolumeInput');
const musicVolumeNumberInput = document.getElementById('musicVolumeNumberInput');

// Two <audio> elements so a track swap can crossfade - the outgoing track
// fading out while the incoming one fades in over the same window, rather
// than a fade-to-silence-then-fade-back-in with a silent gap in the middle.
// activeAmbientAudio always points at whichever one is currently "the"
// track; the two ping-pong roles on every crossfade (see crossfadeAmbientMusic).
const ambientAudioA = document.getElementById('ambientAudioA');
const ambientAudioB = document.getElementById('ambientAudioB');
let activeAmbientAudio = ambientAudioA;
let inactiveAmbientAudio = ambientAudioB;

let musicLibraryIndex = []; // fetched once, cached for the session

async function ensureMusicLibraryIndex() {
  if (musicLibraryIndex.length) return musicLibraryIndex;
  try {
    const res = await fetch('/vtt/api/music-library');
    const data = await res.json();
    musicLibraryIndex = data.tracks || [];
  } catch {
    musicLibraryIndex = [];
  }
  return musicLibraryIndex;
}

function musicLibraryUrl(track) {
  return '/vtt/api/music-library/' + encodeURIComponent(track.filename);
}

function musicTrackLabel(url) {
  const match = musicLibraryIndex.find((t) => musicLibraryUrl(t) === url);
  return match ? match.friendlyName : 'Custom track';
}

// Fade engine behind fadeOutActive/crossfadeAmbientMusic below. Runs on
// requestAnimationFrame, which browsers throttle (sometimes to a full stop)
// while the tab is backgrounded - previously this drove a token counter that
// a newer fade would bump to invalidate an old rAF loop, but that only takes
// effect the next time the OLD loop actually ticks. If that tab was
// backgrounded and the loop never ticked again, the token was never
// checked - the old track kept playing forever, and (via an earlier attempt
// at fixing that by queuing every update behind the previous one's promise)
// every future update got stuck waiting on a promise that could now never
// resolve, which is why Set Map stopped working entirely after that "fix".
// activeFadeCancel fixes this at the root: it's cancelAnimationFrame'd and
// resolved directly and synchronously the instant a new fade starts,
// regardless of whether the old rAF loop is still ticking at all.
const MUSIC_FADE_MS = 600;
let activeFadeCancel = null;

function cancelActiveFade() {
  if (!activeFadeCancel) return;
  const cancel = activeFadeCancel;
  activeFadeCancel = null;
  cancel();
}

// Drives `stepFn(t)` from t=0 to t=1 over `ms`, resolving `true` on natural
// completion or `false` if cancelActiveFade() preempted it early - callers
// that swap element roles on completion (crossfadeAmbientMusic) need that
// distinction so a cancelled fade doesn't finish the role-swap a *newer*
// fade has since taken over.
function runFade(stepFn, ms) {
  return new Promise((resolve) => {
    let rafId = null;
    const start = performance.now();
    activeFadeCancel = () => {
      cancelAnimationFrame(rafId);
      activeFadeCancel = null;
      resolve(false);
    };
    function step(now) {
      // Clamped on both ends - the timestamp rAF hands the callback can
      // occasionally read as slightly *before* `start` on the very first
      // frame (sub-ms clock quirk), which without the lower clamp drove t
      // negative and threw a volume-out-of-range error that killed the
      // whole fade loop permanently (see crossfadeAmbientMusic/fadeOutActive).
      const t = Math.max(0, Math.min(1, (now - start) / ms));
      stepFn(t);
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        activeFadeCancel = null;
        resolve(true);
      }
    }
    rafId = requestAnimationFrame(step);
  });
}

// HTMLMediaElement.volume throws if set outside [0, 1] - belt-and-braces
// against any future source of a slightly-out-of-range value (float
// accumulation across repeated interrupted fades, etc.), on top of runFade
// already clamping t itself.
function clampVolume(v) {
  return Math.max(0, Math.min(1, v));
}

// Fades activeAmbientAudio alone (nothing incoming) - used when music stops
// entirely (effectiveMusicUrl() goes null), not for a track-to-track swap.
// Caller unconditionally pauses/clears the element right after awaiting
// this, so there's no completed-vs-cancelled distinction to make here.
function fadeOutActive(ms) {
  cancelActiveFade();
  const from = activeAmbientAudio.volume;
  return runFade((t) => {
    activeAmbientAudio.volume = clampVolume(from * (1 - t));
  }, ms);
}

// True crossfade: starts newSrc on the currently-inactive element at volume
// 0 and plays it immediately, then fades the outgoing element down to 0 and
// the incoming one up to targetVolume in the same loop, so they overlap
// rather than leaving a silent gap. Once done, the outgoing element is
// paused/cleared and the two swap active/inactive roles - but only on
// natural completion; if a newer transition preempted this one, that newer
// call already owns activeAmbientAudio/inactiveAmbientAudio and re-reads
// whatever volume this one left outgoing/incoming at, so this just backs
// off rather than clobbering it.
async function crossfadeAmbientMusic(newSrc, targetVolume, ms) {
  cancelActiveFade();
  const outgoing = activeAmbientAudio;
  const incoming = inactiveAmbientAudio;
  const outgoingFrom = outgoing.volume;

  incoming.src = newSrc;
  incoming.volume = 0;
  incoming.play().catch(() => {});

  const completed = await runFade((t) => {
    outgoing.volume = clampVolume(outgoingFrom * (1 - t));
    incoming.volume = clampVolume(targetVolume * t);
  }, ms);
  if (!completed) return;

  outgoing.pause();
  outgoing.removeAttribute('src');
  activeAmbientAudio = incoming;
  inactiveAmbientAudio = outgoing;
}

// Slider and number field mirror each other - whichever one the user just
// touched drives the active track's volume, and its value is copied onto
// the other. Only ever targets activeAmbientAudio - mid-crossfade this is a
// rare, brief edge case not worth extra complexity for (see
// crossfadeAmbientMusic's comment).
function setMusicVolumePercent(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  musicVolumeInput.value = clamped;
  musicVolumeNumberInput.value = clamped;
  cancelActiveFade(); // a manual volume change wins over any in-progress fade
  activeAmbientAudio.volume = clamped / 100;
}

// One-shot sound effects (hit-sound cues, creature attack roars, soundboard
// clips - see playEffectSound and the fx:play handler below) share this same
// slider rather than always playing at full volume, so the GM only has one
// dial to manage instead of the music being quiet while every attack roars
// at 100%.
function oneShotEffectVolume() {
  return Math.max(0, Math.min(100, Number(musicVolumeInput.value) || 0)) / 100;
}

setMusicVolumePercent(musicVolumeInput.value);
musicVolumeInput.addEventListener('input', () => setMusicVolumePercent(musicVolumeInput.value));
musicVolumeNumberInput.addEventListener('input', () => setMusicVolumePercent(musicVolumeNumberInput.value));
musicToggleBtn.addEventListener('click', () => {
  if (activeAmbientAudio.paused) activeAmbientAudio.play().catch(() => {});
  else activeAmbientAudio.pause();
});
// Bound to both elements - each checks it's still the active one before
// touching the button, since a crossfade briefly has both elements playing
// (the incoming track fires 'play' immediately, before the fade/role-swap
// finishes) and only the truly-active one's state should drive the icon.
for (const el of [ambientAudioA, ambientAudioB]) {
  el.addEventListener('play', () => {
    if (el !== activeAmbientAudio) return;
    musicToggleBtn.textContent = '⏸';
    musicToggleBtn.title = 'Pause ambient music';
  });
  el.addEventListener('pause', () => {
    if (el !== activeAmbientAudio) return;
    musicToggleBtn.textContent = '▶';
    musicToggleBtn.title = 'Play ambient music';
  });
}

// While combat is active (session.encounterId set) and the map has a
// battleMusicUrl configured, that track takes over from the regular ambient
// one - swapping back the moment combat ends (or if no battle track was set,
// the ambient track just keeps playing through combat, unchanged). Called
// from both updateAmbientMusic's normal triggers (state:full/map:set) and
// the 'combat:state' handler below, so the swap happens the instant Start/
// Stop Combat fires, not just on the next unrelated map update.
function effectiveMusicUrl() {
  const map = session?.map || {};
  if (session?.encounterId && map.battleMusicUrl) return map.battleMusicUrl;
  return map.musicUrl || null;
}

// Fire-and-forget from every call site (state:full/map:set/combat:state) -
// safe to call again before a previous call's fade has finished, since
// fadeOutActive/crossfadeAmbientMusic each start by synchronously preempting
// whatever fade is already running (see cancelActiveFade) rather than
// waiting for or invalidating-but-ignoring it.
async function updateAmbientMusic() {
  const musicUrl = effectiveMusicUrl();
  if (!musicUrl) {
    if (!activeAmbientAudio.paused) await fadeOutActive(MUSIC_FADE_MS);
    musicBar.style.display = 'none';
    activeAmbientAudio.pause();
    activeAmbientAudio.removeAttribute('src');
    return;
  }

  musicBar.style.display = '';
  musicTrackName.textContent = musicTrackLabel(musicUrl);

  const resolvedUrl = new URL(musicUrl, location.href).href;
  if (activeAmbientAudio.src !== resolvedUrl) {
    const wasPlaying = !activeAmbientAudio.paused;
    // Only crossfade if there's actually something audible to fade against -
    // a first-ever track pick (nothing playing yet) just sets src directly
    // on the active element, same as before, since the GM still has to
    // press play.
    if (wasPlaying) {
      const targetVolume = Number(musicVolumeInput.value) / 100;
      await crossfadeAmbientMusic(musicUrl, targetVolume, MUSIC_FADE_MS);
    } else {
      activeAmbientAudio.src = musicUrl;
    }
  }
}

ensureMusicLibraryIndex().then(() => {
  if (session) {
    renderSidebar();
    updateAmbientMusic();
  }
});

// ---------------------------------------------------------------------------
// Creature sound folders (assets/creature-sounds/<folder>/*) - each folder
// name doubles as the "creature type" value stored on a token's soundFolder
// field (Add Token form + per-token card, see gmSidebarHtml/gmTokenListHtml)
// and as a soundboard button the GM can trigger on demand. Fetched once and
// cached for the session, same pattern as musicLibraryIndex above.
// ---------------------------------------------------------------------------

let creatureSoundFolders = [];

async function ensureCreatureSoundFolders() {
  if (creatureSoundFolders.length) return creatureSoundFolders;
  try {
    const res = await fetch('/vtt/api/creature-sounds');
    const data = await res.json();
    creatureSoundFolders = data.folders || [];
  } catch {
    creatureSoundFolders = [];
  }
  return creatureSoundFolders;
}

ensureCreatureSoundFolders().then(() => {
  if (session && role === 'gm') renderSidebar();
});

// ---------------------------------------------------------------------------
// Creature templates ("save this goblin, spawn it again next session without
// rebuilding it by hand") - a reusable snapshot of a token's non-instance
// fields (type/ac/stats/vision/speed/imageUrl/soundFolder/actions - never
// id/x/y/hidden/ownerId), scoped to the saving GM's own account so it
// persists across sessions/restarts (see
// src/lib/server/services/creatureTemplates.ts). Unlike musicLibraryIndex/
// creatureSoundFolders (fixed bundled files), this list changes at runtime
// (save/delete), so it's refetched rather than cached forever.
// ---------------------------------------------------------------------------

let creatureTemplates = [];

async function refreshCreatureTemplates() {
  try {
    const res = await fetch('/vtt/api/creature-templates');
    const data = await res.json();
    creatureTemplates = data.templates || [];
  } catch {
    creatureTemplates = [];
  }
  return creatureTemplates;
}

refreshCreatureTemplates().then(() => {
  if (session && role === 'gm') renderSidebar();
});

// Snapshots the reusable subset of a token's fields - never id/x/y/hidden/
// ownerId, which are per-instance placement details, not part of what makes
// a "goblin" a goblin. Prompts for a name (defaulting to the token's current
// one) rather than a full modal - a rare, GM-only action, not worth more UI.
async function saveTokenAsTemplate(token) {
  if (!token) return;
  const name = prompt('Save this creature as a template named:', token.name || '');
  if (!name || !name.trim()) return;
  const tokenJson = {
    type: token.type,
    ac: token.ac ?? null,
    stats: { hp: token.stats?.hp ?? null, maxHp: token.stats?.maxHp ?? null },
    visionNormalFt: token.visionNormalFt ?? 30,
    visionDarkFt: token.visionDarkFt ?? 0,
    speedFt: token.speedFt ?? 30,
    imageUrl: token.imageUrl || null,
    soundFolder: token.soundFolder || null,
    actions: token.actions || [],
  };
  try {
    const res = await fetch('/vtt/api/creature-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), tokenJson }),
    });
    if (!res.ok) throw new Error('save_failed');
    await refreshCreatureTemplates();
    renderSidebar();
  } catch {
    alert('Could not save template.');
  }
}

// ---------------------------------------------------------------------------
// Attack/spell hit-sound effects - one bundled clip per damage type under
// assets/effects/, played table-wide (see the server's fx:play broadcast in
// vtt/server/handlers/token.js) whenever an attack lands or a spell deals
// damage. Spells already carry a real SRD damage type (fire/necrotic/force/
// etc, entered on the spell's content definition and returned by roll-spell
// as result.damageType - see ContentTypeAdmin.svelte's Damage Type field) -
// the three physical ones map to their matching clip, everything else (no
// per-element clip exists) falls back to the generic 'magic' one. Weapon
// items have no equivalent damageType field yet, so those fall back further
// to a best-effort guess from the action's name against common 5e SRD
// weapon/monster-attack words - unmatched names (homebrew weapons, "Slam"/
// "Bite" if not listed, etc.) just play nothing rather than guess wrong.
// ---------------------------------------------------------------------------

const EFFECT_DAMAGE_TYPES = new Set(['bludgeoning', 'piercing', 'slashing', 'magic']);
const PHYSICAL_DAMAGE_TYPES = new Set(['bludgeoning', 'piercing', 'slashing']);
const SLASHING_ACTION_WORDS = ['sword', 'axe', 'scimitar', 'glaive', 'halberd', 'whip', 'sickle', 'claw', 'talon', 'rake'];
const PIERCING_ACTION_WORDS = ['dagger', 'spear', 'javelin', 'trident', 'rapier', 'dart', 'pike', 'lance', 'bow', 'crossbow', 'arrow', 'bolt', 'bite', 'fang', 'tusk', 'horn', 'gore', 'sting'];
const BLUDGEONING_ACTION_WORDS = ['mace', 'club', 'hammer', 'maul', 'quarterstaff', 'staff', 'flail', 'sling', 'slam', 'smash', 'stomp', 'tail', 'fist', 'pummel'];

// Maps a real SRD damage type (from a spell's content definition) to one of
// our four clips - the physical three pass through as-is, any energy/other
// type (fire, cold, necrotic, force, ...) collapses to 'magic' since there's
// no per-element clip.
function mapSrdDamageTypeToEffect(damageType) {
  if (!damageType) return null;
  const normalized = String(damageType).toLowerCase().trim();
  if (PHYSICAL_DAMAGE_TYPES.has(normalized)) return normalized;
  return 'magic';
}

function inferDamageType(action, result) {
  const fromDamageType = mapSrdDamageTypeToEffect(result?.damageType);
  if (fromDamageType) return fromDamageType;
  if (action?.kind === 'spell') return 'magic'; // spell with an empty/unset damage type (e.g. a save-only debuff) - still magical
  const name = (action?.name || '').toLowerCase();
  if (SLASHING_ACTION_WORDS.some((w) => name.includes(w))) return 'slashing';
  if (PIERCING_ACTION_WORDS.some((w) => name.includes(w))) return 'piercing';
  if (BLUDGEONING_ACTION_WORDS.some((w) => name.includes(w))) return 'bludgeoning';
  return null;
}

function playEffectSound(damageType) {
  if (!EFFECT_DAMAGE_TYPES.has(damageType)) return;
  // A one-shot clip, not one of the persistent ambient-music elements - fire-and-forget
  // Audio() instances are fine here since nothing needs to interrupt/replace
  // them, and overlapping hits (e.g. two attacks in quick succession) should
  // just layer rather than cut each other off.
  const audio = new Audio(`/vtt/api/effects/${damageType}`);
  audio.volume = oneShotEffectVolume();
  audio.play().catch(() => {});
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
      updateAmbientMusic();
      if (role === 'player') startCharacterSync();
      // Reconnecting mid-combat: combat:log only carries entries seen live from
      // here on, so pull the backlog for whatever encounter is already active.
      if (session.encounterId) loadCombatLogBacklog(session.encounterId);
      // Roll log has no "combat active" gate - it's scoped to this room, which
      // is already known the moment we're connected, so always backfill it.
      loadRollLogBacklog();
      // Session Notes, like combat, only has history to backfill once a Game
      // Session has actually been started for this room.
      if (session.gameSessionId) loadSessionNotesBacklog(session.gameSessionId);
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
      updateAmbientMusic();
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
      // Deliberately NOT a full renderSidebar() - every other player's move
      // broadcasts here too, and wholesale-replacing the sidebar's innerHTML
      // on every single one of those was destroying/resetting whatever the
      // viewer was mid-interaction with elsewhere in that same sidebar (the
      // marker color picker being the reported case) - see
      // updateOtherTokensInViewList.
      updateOtherTokensInViewList();
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

    case 'attack:result':
      // Server's hit/miss verdict for an attack we just resolved (it decided
      // against the target's hidden AC and already applied any damage). Update
      // the open attack modal, if it's still the one awaiting this target.
      handleAttackResult(msg);
      break;

    case 'spell:result':
      // Same idea as attack:result, for a save/auto spell's applied damage -
      // see handleSpellResult().
      handleSpellResult(msg);
      break;

    case 'fx:play':
      // Table-wide hit-sound cue (everyone, not just the attacker) - see
      // playEffectSound().
      playEffectSound(msg.damageType);
      // Random per-attack creature cue (e.g. a dragon's roar) or a manual
      // soundboard trigger - the server already resolved which clip to play,
      // this is just a fire-and-forget one-shot like playEffectSound.
      if (msg.creatureSoundUrl) {
        const audio = new Audio(msg.creatureSoundUrl);
        audio.volume = oneShotEffectVolume();
        audio.play().catch(() => {});
      }
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

    case 'combat:state':
      session.encounterId = msg.encounterId;
      if (msg.active) combatLogLines = []; // a freshly-started encounter has no history yet
      renderSidebar();
      updateAmbientMusic(); // swap to/from the map's battle track, see effectiveMusicUrl()
      break;

    case 'combat:log':
      combatLogLines.push(msg.message);
      if (combatLogLines.length > 200) combatLogLines.shift();
      renderSidebar();
      break;

    case 'roll:log':
      rollLogLines.push({ message: msg.message, details: msg.details || {} });
      if (rollLogLines.length > 200) rollLogLines.shift();
      renderSidebar();
      break;

    case 'game_session:state':
      session.gameSessionId = msg.gameSessionId;
      if (msg.active) sessionNoteLines = []; // a freshly-started session has no history yet
      renderSidebar();
      break;

    case 'game_session:note':
      sessionNoteLines.push(msg.note);
      if (sessionNoteLines.length > 200) sessionNoteLines.shift();
      renderSidebar();
      break;

    default:
      break;
  }
}

// Best-effort - a failed fetch just means the log panel starts empty instead
// of backfilled; the live combat:log broadcasts still work either way.
async function loadCombatLogBacklog(encounterId) {
  try {
    const res = await fetch(`/vtt/api/log?encounterId=${encodeURIComponent(encounterId)}`);
    if (!res.ok) return;
    const data = await res.json();
    combatLogLines = (data.entries || []).map((e) => e.message);
    renderSidebar();
  } catch {
    // ignore
  }
}

// Roll log is scoped to this room (sessionId), not an encounter - see
// docs/vtt-current-state.md's roll-log section for why.
async function loadRollLogBacklog() {
  try {
    const res = await fetch(`/vtt/api/roll-log?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    rollLogLines = (data.entries || []).map((e) => ({ message: e.message, details: e.details || {} }));
    renderSidebar();
  } catch {
    // ignore
  }
}

// Session Notes is scoped to a persisted game_sessions row (session.gameSessionId),
// not the room itself - unlike the roll log, there's genuinely no history until
// a GM has clicked Start Session for this room.
async function loadSessionNotesBacklog(gameSessionId) {
  try {
    const res = await fetch(`/vtt/api/session-notes?gameSessionId=${encodeURIComponent(gameSessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    sessionNoteLines = data.notes || [];
    renderSidebar();
  } catch {
    // ignore
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
    if (showMovementRanges) drawMovementRange(ctx, allTokens, map.gridSizePx);
    drawMarkers(ctx, visibleMarkers, map.gridSizePx);
    drawTokens(ctx, allTokens, map.gridSizePx, getImage, null);
    drawTargetRings(ctx, currentTargetTokenIds, allTokens, map.gridSizePx);
    currentRenderedTokens = allTokens;
  } else {
    const ownedTokens = allTokens.filter((t) => t.ownerId === playerId);
    const radii = computeVisionRadii(ownedTokens, map);
    renderVisionMaskedMap(ctx, mapImage, radii, map);
    const visibleTokens = allTokens.filter((t) => isPointRevealed(t.x, t.y, radii));
    // Only the player's own tokens' remaining-movement circle is shown - how
    // far an enemy or another player's token can still move is tactical
    // information a player shouldn't see, same trust boundary as HP.
    drawMovementRange(ctx, ownedTokens, map.gridSizePx);
    drawMarkers(ctx, visibleMarkers, map.gridSizePx);
    drawTokens(ctx, visibleTokens, map.gridSizePx, getImage, playerId);
    drawTargetRings(ctx, currentTargetTokenIds, visibleTokens, map.gridSizePx);
    currentRenderedTokens = visibleTokens;
  }

  if (pendingActionTarget) {
    drawArmedTargetHighlights(ctx, currentRenderedTokens, map.gridSizePx, pendingActionTarget.sourceTokenId);
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

// A token's x/y is the center of its drag circle - clamping a drag/drop
// position to the map's actual pixel bounds stops a token from ending up
// somewhere the canvas won't render it. Before this, a fast drag past the
// map's edge (easy to do while zoomed out, since the drag tracks the mouse
// at window level - see the mousemove/touchmove listeners below) could
// commit a position outside [0, widthPx]x[0, heightPx]; the token would
// then render off-canvas and become permanently unreachable, since your
// cursor can only ever map back to in-bounds canvas coordinates to hit-test
// it again. Only applied to token drags, not marker/shape placement -
// markers stay reachable via their sidebar list regardless of position.
function clampToMapBounds(x, y) {
  const map = session?.map;
  if (!map) return { x, y };
  return {
    x: Math.max(0, Math.min(map.widthPx, x)),
    y: Math.max(0, Math.min(map.heightPx, y)),
  };
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
// Action targeting (Section 3, extended in Phase 3 for spells) - click a
// weapon or spell action in the mini sheet, then click a token on the map to
// resolve it against. Same arm/disarm-banner pattern as marker placement.
// Rolling happens server-side (Phase 2.5/3) - the vanilla client can't import
// $lib, and only the server has the character's full modifier graph (and,
// for weapons/attack-resolution spells, the target's hidden AC to compare
// against), so this file only ever orchestrates the flow, never the math.
// ---------------------------------------------------------------------------

const actionTargetBanner = document.getElementById('actionTargetBanner');
const actionTargetBannerText = document.getElementById('actionTargetBannerText');
let pendingActionTarget = null; // { sourceTokenId, action } while an action is armed for targeting

// Step 1: arm targeting. Valid targets get a highlight ring (drawn in render()),
// the banner names the action, and the cursor changes - no more silent "click and hope."
// `action` is either a flattened weapon action ({name, toHitBonus, damageRolls, damageBonus})
// or a spell descriptor ({kind:'spell', instanceId, name, slotLevel}) - action.kind defaults
// to 'weapon' wherever it's read, so every pre-existing call site (weapon rows, GM manual
// attacks) needs no change.
function armActionTargeting(sourceTokenId, action) {
  disarmMarkerPlacement();
  pendingActionTarget = { sourceTokenId, action };
  actionTargetBannerText.textContent = action.kind === 'spell'
    ? `Casting ${action.name} — select a target`
    : `Attacking with ${action.name} — select a target`;
  actionTargetBanner.classList.add('visible');
  canvas.style.cursor = 'crosshair';
  render(); // draw the valid-target highlight rings
}

function disarmActionTargeting() {
  pendingActionTarget = null;
  actionTargetBanner.classList.remove('visible');
  canvas.style.cursor = '';
  render();
}

document.getElementById('actionTargetCancelBtn').addEventListener('click', disarmActionTargeting);

// ---------------------------------------------------------------------------
// Attack/spell confirm + roll-result modal (Phase 2.5, extended in Phase 3 for
// spells). Clicking a target no longer resolves instantly - it shows an
// explicit Attack/Cast button (confirm step), then rolls via the shared
// SERVER-SIDE roll (roll-attack / roll-manual / roll-spell) so the VTT
// displays the exact same breakdown the character sheet produces
// (advantage/disadvantage dice-pool, Bless/extra dice, crit outcomes,
// modifier-sourced spell damage) - the vanilla client can't import $lib and
// the token only carries flattened data, so this is the one place the full
// roll can actually happen. One modal shell, one flow, branching on
// `action.kind` only where the mechanics genuinely differ (which endpoint to
// call, and - for spells - how the result gets applied to the target).
// ---------------------------------------------------------------------------
const attackModal = document.getElementById('attackModal');
const attackModalBody = document.getElementById('attackModalBody');
let pendingAttack = null; // { sourceTokenId, action, targetId, targetName }

function closeAttackModal() {
  attackModal.classList.remove('visible');
  attackModalBody.innerHTML = '';
  if (awaitingAttackResult) {
    clearTimeout(awaitingAttackResult.timeoutId);
    awaitingAttackResult = null;
  }
  if (awaitingSpellResult) {
    clearTimeout(awaitingSpellResult.timeoutId);
    awaitingSpellResult = null;
  }
  if (pendingAttack) {
    send({ type: 'target:clear' });
    currentTargetTokenIds = [];
    render();
  }
  pendingAttack = null;
}

// Step 2 -> 3: a target was clicked; show the confirm card with an explicit Attack/Cast button.
// The chosen target gets ringed for everyone (target:select) as immediate visible feedback.
function openAttackConfirm(sourceTokenId, action, target) {
  const isSpell = action.kind === 'spell';
  pendingAttack = { sourceTokenId, action, targetId: target.id, targetName: target.name };
  send({ type: 'target:select', sourceTokenId, targetTokenIds: [target.id] });
  currentTargetTokenIds = [target.id];
  render();

  attackModalBody.innerHTML = `
    <h2>${isSpell ? 'Cast Spell' : 'Attack'}</h2>
    <div class="attack-target-name">${isSpell ? 'Casting' : 'Attacking'} <strong>${escapeHtml(target.name)}</strong> with <span class="attack-weapon-name">${escapeHtml(action.name)}</span></div>
    <div class="actions">
      <button type="button" class="secondary" id="attackCancelBtn">Cancel</button>
      <button type="button" id="attackConfirmBtn">${isSpell ? 'Cast' : 'Attack'}</button>
    </div>
  `;
  attackModal.classList.add('visible');
  document.getElementById('attackCancelBtn').addEventListener('click', closeAttackModal);
  document.getElementById('attackConfirmBtn').addEventListener('click', resolveAttack);
}

function attackModalError(message) {
  attackModalBody.innerHTML = `<h2>Attack</h2><p style="color:#e57373;font-size:13px;">${escapeHtml(message)}</p><div class="actions"><button type="button" id="attackCloseBtn">Close</button></div>`;
  document.getElementById('attackCloseBtn').addEventListener('click', closeAttackModal);
}

// Which token is awaiting a server hit/miss verdict, so the async attack:result
// message can be matched back to the open modal. { targetId, targetName, result, timeoutId }
let awaitingAttackResult = null;
// Same idea for a save/auto spell awaiting its spell:result verdict. { targetId, timeoutId }
let awaitingSpellResult = null;

// Rolls the armed action via whichever server endpoint applies: a character's
// equipped weapon, a GM's manual stat-block attack, or (Phase 3) a character's
// prepared spell.
async function rollManualAction(action) {
  const res = await fetch('/vtt/api/roll-manual', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: action.name, toHitBonus: action.toHitBonus,
      damageRolls: action.damageRolls, damageBonus: action.damageBonus,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('roll request failed (' + res.status + ')'));
  return body;
}

async function rollPendingAction(action, source) {
  if (action.kind === 'spell') {
    const res = await fetch('/vtt/api/characters/' + source.characterId + '/roll-spell', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: action.instanceId, slotLevel: action.slotLevel }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('roll request failed (' + res.status + ')'));
    return body;
  }

  if (!source?.characterId) return rollManualAction(action); // enemy/npc stat-block attack

  const res = await fetch('/vtt/api/characters/' + source.characterId + '/roll-attack', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemName: action.name }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;

  // item_not_found means this action was added directly on the token (the
  // GM's "Add attack" form on a PC token) rather than being a real equipped
  // item on the character's sheet - roll-attack always re-derives from the
  // live sheet, so there's nothing there for it to match. Rather than a
  // dead end, fall back to a flat roll-manual using the numbers already
  // stored on the action itself (same as an enemy/npc attack) - loses the
  // sheet's rich advantage/disadvantage-aware roll, but a homebrew extra
  // attack was never going to have that anyway.
  if (body.error === 'item_not_found') return rollManualAction(action);

  // Any other reason (not_found, missing_item) is a real failure - surface
  // the server's actual reason rather than just a bare status code.
  throw new Error(body.error || ('roll request failed (' + res.status + ')'));
}

// Step 3 -> roll, then hand off to the server for anything that mutates a
// target's HP (attack:resolve for weapons and attack-resolution spells alike -
// a spell attack roll vs. AC is mechanically identical once you have a to-hit
// total; spell:resolve for save/auto spells, see renderSpellResolutionControls).
async function resolveAttack() {
  if (!pendingAttack) return;
  const { sourceTokenId, action, targetId, targetName } = pendingAttack;
  const source = session.tokens[sourceTokenId];
  const isSpell = action.kind === 'spell';

  attackModalBody.innerHTML = `<h2>${isSpell ? 'Cast Spell' : 'Attack'}</h2><p class="attack-subtext">${isSpell ? 'Casting' : 'Rolling'} ${escapeHtml(action.name)}…</p>`;
  let result;
  try {
    result = await rollPendingAction(action, source);
  } catch (err) {
    console.error('[VTT] roll failed', err);
    attackModalError(`Couldn't ${isSpell ? 'cast the spell' : 'roll the attack'}: ${String(err.message || err)}`);
    return;
  }

  const usesAttackRoll = !isSpell || result.resolution === 'attack';
  renderAttackBreakdown(targetName, result, usesAttackRoll
    ? '<span class="attack-subtext">Resolving hit/miss…</span>'
    : '<span class="attack-subtext">Loading…</span>');

  if (usesAttackRoll) {
    const outcome = (result.outcomes || []).includes('critical_hit') ? 'critical_hit'
      : (result.outcomes || []).includes('critical_miss') ? 'critical_miss' : null;

    const timeoutId = setTimeout(() => {
      if (awaitingAttackResult && awaitingAttackResult.targetId === targetId) {
        setAttackVerdict('<div class="attack-outcome unknown">No response from server — try again.</div>');
        awaitingAttackResult = null;
      }
    }, 5000);
    awaitingAttackResult = { targetId, targetName, result, timeoutId };

    send({
      type: 'attack:resolve',
      targetTokenId: targetId,
      sourceTokenId,
      toHit: result.attackTotal,
      damage: result.damageTotal,
      outcome,
      damageType: inferDamageType(action, result),
      title: result.title || action.name || null,
    });
    return;
  }

  // Save/auto spell: no hidden value to compare against (the caster's own Spell
  // Save DC isn't secret), so the pass/fail check happens here, not on the
  // server - see renderSpellResolutionControls()/vtt/server/handlers/token.js's
  // spell:resolve case for why that's a safe simplification.
  renderSpellResolutionControls(result, sourceTokenId, targetId);
}

// Renders the to-hit (if any) + damage breakdown (identical whichever roll
// source), with a verdict slot filled once the server responds or (for
// save/auto spells) once renderSpellResolutionControls wires its own prompt.
function renderAttackBreakdown(targetName, result, verdictHtml) {
  const hasAttackRoll = Boolean(result.attack);
  const saveLine = result.resolution === 'save'
    ? `<div class="attack-roll-block"><h4>Saving Throw</h4>DC ${result.saveDc} ${escapeHtml(String(result.saveAbility || '').toUpperCase())} — ${result.saveEffect === 'negate' ? 'no damage' : 'half damage'} on a success</div>`
    : '';
  attackModalBody.innerHTML = `
    <h2>${escapeHtml(result.title || 'Attack')}</h2>
    <div class="attack-target-name">vs <strong>${escapeHtml(targetName)}</strong></div>
    ${hasAttackRoll ? `<div class="attack-roll-block"><h4>To hit</h4>${escapeHtml(result.attack || '')}</div>` : ''}
    ${saveLine}
    <div id="attackVerdict">${verdictHtml}</div>
    <div class="attack-roll-block"><h4>Damage${hasAttackRoll ? ' (on a hit)' : ''}</h4>${escapeHtml((result.damage || []).join('\n'))}</div>
    <div class="actions">
      <button type="button" class="secondary" id="attackDoneBtn">Close</button>
    </div>
  `;
  document.getElementById('attackDoneBtn').addEventListener('click', closeAttackModal);
}

function setAttackVerdict(html) {
  const el = document.getElementById('attackVerdict');
  if (el) el.innerHTML = html;
}

// Fills the verdict slot with the spec's "lightweight type-in-the-result
// prompt" for a save spell (DC is already shown above, not secret), or a
// simple confirm for an auto-hit spell - either way nothing applies to the
// target's HP until the player explicitly clicks, same discipline as the
// weapon flow's explicit Attack button.
function renderSpellResolutionControls(result, sourceTokenId, targetId) {
  const verdictEl = document.getElementById('attackVerdict');
  if (!verdictEl) return;
  if (result.resolution === 'save') {
    verdictEl.innerHTML = `
      <div class="spell-save-prompt">
        <label>Target's save total <input type="number" id="spellSaveResultInput" /></label>
        <button type="button" id="spellSaveApplyBtn">Apply</button>
      </div>
    `;
    document.getElementById('spellSaveApplyBtn').addEventListener('click', () => {
      const value = Number(document.getElementById('spellSaveResultInput').value);
      const saveSuccess = Number.isFinite(value) && value >= result.saveDc;
      sendSpellResolve(sourceTokenId, targetId, result, saveSuccess);
    });
  } else {
    verdictEl.innerHTML = `<button type="button" id="spellApplyBtn">Apply Damage</button>`;
    document.getElementById('spellApplyBtn').addEventListener('click', () => sendSpellResolve(sourceTokenId, targetId, result, null));
  }
}

function sendSpellResolve(sourceTokenId, targetId, result, saveSuccess) {
  setAttackVerdict('<span class="attack-subtext">Applying…</span>');
  const timeoutId = setTimeout(() => {
    if (awaitingSpellResult && awaitingSpellResult.targetId === targetId) {
      setAttackVerdict('<div class="attack-outcome unknown">No response from server — try again.</div>');
      awaitingSpellResult = null;
    }
  }, 5000);
  awaitingSpellResult = { targetId, timeoutId };
  send({
    type: 'spell:resolve',
    targetTokenId: targetId,
    sourceTokenId,
    damage: result.damageTotal,
    resolution: result.resolution,
    saveSuccess,
    saveEffect: result.saveEffect,
    damageType: mapSrdDamageTypeToEffect(result.damageType) || 'magic', // this path is only ever reached for a spell (see resolveAttack)
    title: result.title || null,
  });
}

// Server's verdict for an applied save/auto spell - mirrors handleAttackResult
// below, just without a hit/miss/crit concept (no roll was made against a
// hidden value; the server only confirms the write was authorized and applied).
function handleSpellResult(msg) {
  if (!awaitingSpellResult || msg.targetTokenId !== awaitingSpellResult.targetId) return;
  clearTimeout(awaitingSpellResult.timeoutId);
  awaitingSpellResult = null;

  const label = msg.resolution === 'save'
    ? (msg.saveSuccess ? `Saved! ${msg.damageApplied} damage dealt` : `Failed save — ${msg.damageApplied} damage dealt`)
    : `${msg.damageApplied} damage dealt`;
  setAttackVerdict(`<div class="attack-outcome ${msg.damageApplied > 0 ? 'hit' : 'miss'}">${label}</div>`);
}

// Server's verdict for the in-flight attack (it decided vs the hidden AC and
// already applied any damage). We only learn hit/miss + damage dealt, never AC.
function handleAttackResult(msg) {
  if (!awaitingAttackResult || msg.targetTokenId !== awaitingAttackResult.targetId) return;
  clearTimeout(awaitingAttackResult.timeoutId);
  awaitingAttackResult = null;

  let cls, label;
  if (msg.fumble) { cls = 'miss'; label = 'Critical miss!'; }
  else if (msg.critical) { cls = 'crit'; label = `Critical hit! ${msg.damage} damage dealt`; }
  else if (msg.hit) {
    cls = 'hit';
    label = msg.acKnown
      ? `Hit! ${msg.damage} damage dealt`
      : `Hit (no AC set) — ${msg.damage} damage dealt`;
  } else { cls = 'miss'; label = 'Miss'; }

  setAttackVerdict(`<div class="attack-outcome ${cls}">${label}</div>`);
}

// Yellow highlight ring around every valid target while a weapon is armed (step 1's visible
// "targeting is on" cue). The attacker's own token is skipped - you can't target yourself.
function drawArmedTargetHighlights(ctx, tokens, gridSizePx, sourceTokenId) {
  const radius = gridSizePx * 0.5;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,193,7,0.9)';
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  for (const token of tokens) {
    if (token.id === sourceTokenId) continue;
    ctx.beginPath();
    ctx.arc(token.x, token.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
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
    // Clicking empty space or your own token cancels targeting instead of resolving.
    if (!target || target.id === sourceTokenId) return;
    // Step 2 -> confirm step: no instant resolve, show the Attack button first.
    openAttackConfirm(sourceTokenId, action, target);
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
    const raw = canvasCoords(e);
    const { x, y } = clampToMapBounds(raw.x, raw.y);
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
    const raw = canvasCoords(e);
    const { x, y } = clampToMapBounds(raw.x, raw.y);
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
// Touch: #mapWrap is a plain `overflow: auto` div, so on a touchscreen the
// browser pans it natively before any JS runs - there's no JS pan gesture to
// out-race for touch the way desktop's mousedown handler above does. Any
// gesture that's normally a mouse drag (move a token, drag out a cone/cube's
// facing+length) needs to preventDefault to opt that one touch out of native
// scrolling and drive it through the same dragState/shapeDrag the mouse path
// already uses; a touch that misses both is left alone and native scroll
// keeps panning exactly as it already does. Tap-to-target and tap-to-place
// (circle/sphere, which place immediately with no drag step) aren't touched
// here - a simple tap (no scroll) still reaches the mousedown handler above
// via the browser's synthesized click, which is why those already work.
// ---------------------------------------------------------------------------

function findTouchById(touchList, id) {
  for (let i = 0; i < touchList.length; i++) {
    if (touchList[i].identifier === id) return touchList[i];
  }
  return null;
}

let activeTouch = null; // { id, kind: 'token' | 'shape' } - which touch owns whichever of dragState/shapeDrag is currently live

canvas.addEventListener('touchstart', (e) => {
  if (pendingActionTarget) return; // tap-to-target has no drag step, synthesized click already handles it
  if (e.touches.length !== 1) return; // multi-touch - not a drag gesture

  const touch = e.touches[0];
  const { x, y } = canvasCoords(touch);

  if (pendingMarkerPlacement) {
    const config = pendingMarkerPlacement;
    if (config.shape !== 'cone' && config.shape !== 'cube') return; // immediate placement, synthesized click already handles it

    e.preventDefault();
    shapeDrag = { config, originX: x, originY: y, currentX: x, currentY: y };
    activeTouch = { id: touch.identifier, kind: 'shape' };
    canvas.classList.add('dragging');
    render();
    return;
  }

  const token = hitTestToken(x, y);
  const canDragToken = token && (role === 'gm' || token.ownerId === playerId);
  if (!canDragToken) return; // miss - let native pan handle it, unchanged

  e.preventDefault(); // now that we know it's a token drag, opt this gesture out of native scroll
  dragState = { tokenId: token.id, originX: token.x, originY: token.y, x, y };
  activeTouch = { id: touch.identifier, kind: 'token' };
  canvas.classList.add('dragging');
}, { passive: false });

window.addEventListener('touchmove', (e) => {
  if (!activeTouch) return;
  const touch = findTouchById(e.touches, activeTouch.id);
  if (!touch) return;

  if (e.touches.length > 1) {
    // a second finger came down mid-gesture - bail out cleanly rather than
    // leave a stuck drag fighting whatever that second touch turns out to be
    if (activeTouch.kind === 'token') dragState = null;
    else { shapeDrag = null; disarmMarkerPlacement(); }
    activeTouch = null;
    canvas.classList.remove('dragging');
    render();
    return;
  }

  e.preventDefault();
  const raw = canvasCoords(touch);
  if (activeTouch.kind === 'token') {
    const { x, y } = clampToMapBounds(raw.x, raw.y);
    dragState.x = x;
    dragState.y = y;
  } else {
    shapeDrag.currentX = raw.x;
    shapeDrag.currentY = raw.y;
  }
  render();
}, { passive: false });

function endTouchDrag(e, commit) {
  if (!activeTouch) return;
  const touch = findTouchById(e.changedTouches, activeTouch.id);
  if (!touch) return;

  if (commit && activeTouch.kind === 'token') {
    const raw = canvasCoords(touch);
    const { x, y } = clampToMapBounds(raw.x, raw.y);
    const { tokenId } = dragState;
    send({ type: 'token:move', tokenId, x, y });
    // dragState itself clears once the server echoes the move back (see
    // handleMessage's token:move case), same as the mouse path above.
  } else if (commit && activeTouch.kind === 'shape') {
    const { x, y } = canvasCoords(touch);
    shapeDrag.currentX = x;
    shapeDrag.currentY = y;
    placeMarker(markerFromShapeDrag(shapeDrag));
    shapeDrag = null;
    disarmMarkerPlacement();
    render();
  } else {
    if (activeTouch.kind === 'token') dragState = null;
    else { shapeDrag = null; disarmMarkerPlacement(); }
  }
  activeTouch = null;
  canvas.classList.remove('dragging');
}

window.addEventListener('touchend', (e) => endTouchDrag(e, true));
window.addEventListener('touchcancel', (e) => endTouchDrag(e, false));

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
// require removing and re-adding the token. Only syncs fields with NO
// editable control anywhere in the VTT session (ac, saves, actions,
// preparedSpells) - not just hp/spellSlots as originally scoped. The first
// version also synced speedFt/vision*/maxHp, which are each editable by the
// GM or player during a session (the Speed field, the Darkvision checkbox,
// the Advanced Vision modal, Max HP) - a poll landing after a GM manually
// granted a player temporary darkvision (a spell, a potion) would silently
// revert it back to the sheet's baseline on the very next tick, which is
// exactly the "reverts to unchecked and 0" bug this was found from. The
// dividing line is simple: if a human can edit it in the VTT, the poll must
// never touch it - only genuinely read-only-in-VTT reference data is safe to
// auto-sync. This is the interim, self-contained version; a real push-based
// system (sheet save -> VTT) is the longer-term direction once there's a
// real realtime layer to hang it on (see the current-state doc's Known
// Fragility notes).
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
  // hp, maxHp, ac, speedFt, and all four vision fields are deliberately excluded -
  // each now has an editable control somewhere in the VTT (HP/Max HP/Speed
  // inputs, the mini-sheet AC input, the Darkvision checkbox, the Advanced
  // Vision modal) and must stay session-authoritative once set, the same way
  // hp/spellSlots already are. (ac joined this list when the mini-sheet AC field
  // became editable - polling it would revert a manual in-session AC change on
  // the next tick, the same clobber the vision fields hit earlier.)
  const updates = {
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
// Conditions modal - standard 5e status conditions (Poisoned, Prone, etc.),
// a multi-select array (token.conditions) distinct from the existing single-
// value token.condition ("healthy"/"bloodied"/"critical" - the coarse HP
// signal). Conditions are visible battlefield state, not secret like HP, so
// they aren't stripped from enemy/npc tokens the way stats are - anyone who
// can see a token can see what conditions are on it. Editing follows the
// same ownership rule as everything else: GM can edit any token's, a player
// only their own (see PLAYER_EDITABLE_FIELDS in vtt/server/handlers/token.js).
// ---------------------------------------------------------------------------

const STANDARD_CONDITIONS = [
  'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone',
  'restrained', 'stunned', 'unconscious',
];

const conditionsModal = document.getElementById('conditionsModal');
const conditionsModalList = document.getElementById('conditionsModalList');
let conditionsModalTokenId = null;

function openConditionsModal(tokenId) {
  const token = session.tokens[tokenId];
  if (!token) return;
  conditionsModalTokenId = tokenId;
  const active = new Set(token.conditions || []);
  conditionsModalList.innerHTML = STANDARD_CONDITIONS.map((key) => `
    <div class="field">
      <label>
        <input type="checkbox" class="conditionCheckbox" value="${key}" ${active.has(key) ? 'checked' : ''} />
        ${key.charAt(0).toUpperCase()}${key.slice(1)}
      </label>
    </div>
  `).join('');
  conditionsModal.classList.add('visible');
}

function closeConditionsModal() {
  conditionsModal.classList.remove('visible');
  conditionsModalTokenId = null;
}

document.getElementById('conditionsModalCancel').addEventListener('click', closeConditionsModal);
document.getElementById('conditionsModalSave').addEventListener('click', () => {
  if (!conditionsModalTokenId) return;
  const tokenId = conditionsModalTokenId;
  const value = [...conditionsModalList.querySelectorAll('.conditionCheckbox:checked')].map((el) => el.value);
  send({ type: 'token:stat:update', tokenId, stat: 'conditions', value });
  closeConditionsModal();
});
conditionsModal.addEventListener('click', (e) => {
  if (e.target === conditionsModal) closeConditionsModal();
});

// ---------------------------------------------------------------------------
// Soundboard modal - GM-only manual trigger, one button per
// assets/creature-sounds/ folder. Wired once here (top-level, like every
// other modal) since the modal itself lives outside #sidebar's re-rendered
// innerHTML; only the button that opens it (openSoundboardBtn) is inside the
// sidebar and gets re-wired on every renderSidebar(), same as
// tokenBrowseLibraryBtn opening imagePickerModal.
// ---------------------------------------------------------------------------

const soundboardModal = document.getElementById('soundboardModal');
const soundboardModalList = document.getElementById('soundboardModalList');

function openSoundboardModal() {
  soundboardModalList.innerHTML = soundboardHtml();
  soundboardModal.classList.add('visible');
}

function closeSoundboardModal() {
  soundboardModal.classList.remove('visible');
}

soundboardModalList.addEventListener('click', (e) => {
  if (!e.target.classList.contains('soundboardBtn')) return;
  send({ type: 'soundboard:play', folder: e.target.dataset.folder });
});
document.getElementById('soundboardModalCloseBtn').addEventListener('click', closeSoundboardModal);
soundboardModal.addEventListener('click', (e) => {
  if (e.target === soundboardModal) closeSoundboardModal();
});

// ---------------------------------------------------------------------------
// Creature Library modal - GM-only saved-creature picker (see
// saveTokenAsTemplate). Same callback shape as openImagePicker: the caller
// (openCreatureLibraryBtn's click handler in wireGmSidebar) decides what
// "picked a template" means - filling the Add Token form, in this case.
// ---------------------------------------------------------------------------

const creatureLibraryModal = document.getElementById('creatureLibraryModal');
const creatureLibraryModalList = document.getElementById('creatureLibraryModalList');
let creatureLibraryOnSelect = null;

function renderCreatureLibraryModalList() {
  creatureLibraryModalList.innerHTML = creatureLibraryModalListHtml();
}

function openCreatureLibraryModal(onSelect) {
  creatureLibraryOnSelect = onSelect;
  renderCreatureLibraryModalList();
  creatureLibraryModal.classList.add('visible');
}

function closeCreatureLibraryModal() {
  creatureLibraryModal.classList.remove('visible');
  creatureLibraryOnSelect = null;
}

creatureLibraryModalList.addEventListener('click', async (e) => {
  const card = e.target.closest('.token-card');
  if (!card) return;
  const templateId = card.dataset.templateId;

  if (e.target.classList.contains('deleteTemplateBtn')) {
    const template = creatureTemplates.find((t) => t.id === templateId);
    if (!template || !confirm(`Delete the "${template.name}" template? This can't be undone.`)) return;
    await fetch(`/vtt/api/creature-templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
    await refreshCreatureTemplates();
    renderCreatureLibraryModalList(); // stays open, list just shrinks
    return;
  }

  const template = creatureTemplates.find((t) => t.id === templateId);
  const onSelect = creatureLibraryOnSelect;
  closeCreatureLibraryModal();
  if (template && onSelect) onSelect(template);
});
document.getElementById('creatureLibraryModalCloseBtn').addEventListener('click', closeCreatureLibraryModal);
creatureLibraryModal.addEventListener('click', (e) => {
  if (e.target === creatureLibraryModal) closeCreatureLibraryModal();
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

// Rescue for a token dragged somewhere unreachable (see clampToMapBounds's
// comment) - a plain token:move to the map's center, same as any other
// drag-drop, so a token stuck from before that fix shipped (or however else
// it might end up off-canvas) can be recovered with a click instead of
// needing a database edit.
function recenterToken(tokenId) {
  const token = session.tokens[tokenId];
  const map = session?.map;
  if (!token || !map) return;
  send({ type: 'token:move', tokenId, x: map.widthPx / 2, y: map.heightPx / 2 });
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
  return `<div id="roomInfo"><strong>${escapeHtml(sessionId)}</strong><br/>Role: ${roleLabel}<br/>Players: ${playerListHtml()}</div>
    ${combatControlHtml()}
    ${combatLogHtml()}
    ${rollLogHtml()}
    ${sessionNotesControlHtml()}
    ${sessionNotesHtml()}`;
}

// Combat/session-notes activity is derived automatically from room membership
// now (see docs/vtt-current-state.md's room-join-unification write-up) - a
// player only ever needs the Room Code, already visible in the sidebar header,
// to get pulled into whichever of these the GM has started. No Encounter ID to
// copy anymore, just status text. Only the GM gets the Start/Stop buttons.
function combatControlHtml() {
  const active = !!session.encounterId;
  const statusLine = active ? `<div class="combat-encounter-id">Combat is active in this room.</div>` : '';
  const gmButton = role !== 'gm' ? '' : active
    ? `<button type="button" id="stopCombatBtn" class="secondary">Stop Combat</button>`
    : `<button type="button" id="startCombatBtn">Start Combat</button>`;
  if (!gmButton && !statusLine) return '';
  return `<div class="field" id="combatControl">${gmButton}${statusLine}</div>`;
}

function combatLogHtml() {
  if (!session.encounterId && !combatLogLines.length) return '';
  const lines = combatLogLines.map((line) => `<div class="combat-log-line">${escapeHtml(line)}</div>`).join('')
    || '<span style="color:#666;">No combat activity yet.</span>';
  return `<h2>Combat Log</h2><div id="combatLog" class="combat-log">${lines}</div>`;
}

// Separate from the Combat Log - scoped to this room rather than an encounter,
// so it has entries whether or not combat has ever been started. Roll entries
// get a native <details>/<summary> for a free, no-JS expand/collapse "[?]".
function rollLogHtml() {
  if (!rollLogLines.length) return '';
  const lines = rollLogLines.map((entry) => {
    const breakdown = entry.details?.breakdown;
    return breakdown
      ? `<details class="combat-log-line"><summary>${escapeHtml(entry.message)}</summary><pre>${escapeHtml(String(breakdown))}</pre></details>`
      : `<div class="combat-log-line">${escapeHtml(entry.message)}</div>`;
  }).join('');
  return `<h2>Roll Log</h2><div id="rollLog" class="combat-log">${lines}</div>`;
}

// Session Notes is independent of Start/Stop Combat - a Game Session (a real,
// persisted, reviewable record - see /sessions) is meant to span the whole
// night, not just a fight. Like combat, a player is pulled in automatically by
// room membership - no Game Session ID to copy, just status text plus a direct
// link to the full reviewable log.
function sessionNotesControlHtml() {
  const active = !!session.gameSessionId;
  const statusLine = active
    ? `<div class="combat-encounter-id">Session notes are active - <a href="/sessions/${escapeHtml(session.gameSessionId)}" target="_blank">open the full log</a>.</div>`
    : '';
  const gmButton = role !== 'gm' ? '' : active
    ? `<button type="button" id="endGameSessionBtn" class="secondary">End Session</button>`
    : `<button type="button" id="startGameSessionBtn">Start Session</button>`;
  if (!gmButton && !statusLine) return '';
  return `<div class="field" id="gameSessionControl">${gmButton}${statusLine}</div>`;
}

function sessionNotesHtml() {
  if (!session.gameSessionId) return '';
  const lines = sessionNoteLines
    .map((note) => `<div class="combat-log-line"><strong>${escapeHtml(note.displayName)}:</strong> ${escapeHtml(note.message)}</div>`)
    .join('') || '<span style="color:#666;">No notes yet.</span>';
  return `
    <h2>Session Notes</h2>
    <div id="sessionNotes" class="combat-log">${lines}</div>
    <div class="field row">
      <input type="text" id="sessionNoteInput" placeholder="Type a note and press Enter..." autocomplete="off" />
      <button type="button" id="postSessionNoteBtn" class="secondary">Post</button>
    </div>
  `;
}

async function startGameSession() {
  try {
    const res = await fetch(`/vtt/api/session/${sessionId}/game-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }),
    });
    if (!res.ok) throw new Error('start_failed');
  } catch {
    alert('Could not start session.');
  }
}

async function endGameSession() {
  try {
    const res = await fetch(`/vtt/api/session/${sessionId}/game-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }),
    });
    if (!res.ok) throw new Error('stop_failed');
  } catch {
    alert('Could not end session.');
  }
}

async function postSessionNoteFromVtt() {
  const input = document.getElementById('sessionNoteInput');
  const message = input?.value.trim();
  if (!message || !session.gameSessionId) return;
  input.value = '';
  try {
    await fetch('/vtt/api/session-notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameSessionId: session.gameSessionId, message }),
    });
    // No local append here - the server's game_session:note broadcast (sent to
    // the whole room, including us) is what actually appends and re-renders.
  } catch {
    alert('Could not post note.');
  }
}

function wireSessionNotesControls() {
  document.getElementById('startGameSessionBtn')?.addEventListener('click', startGameSession);
  document.getElementById('endGameSessionBtn')?.addEventListener('click', endGameSession);
  document.getElementById('postSessionNoteBtn')?.addEventListener('click', postSessionNoteFromVtt);
  document.getElementById('sessionNoteInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      postSessionNoteFromVtt();
    }
  });
}

async function startCombat() {
  try {
    const res = await fetch(`/vtt/api/session/${sessionId}/combat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }),
    });
    if (!res.ok) throw new Error('start_failed');
    // The server's combat:state broadcast (sent to the whole session, including
    // us) is what actually updates session.encounterId and re-renders - no
    // local mutation here avoids a race with that broadcast.
  } catch {
    alert('Could not start combat.');
  }
}

async function stopCombat() {
  try {
    const res = await fetch(`/vtt/api/session/${sessionId}/combat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }),
    });
    if (!res.ok) throw new Error('stop_failed');
  } catch {
    alert('Could not stop combat.');
  }
}

// --- GM sidebar --------------------------------------------------------

// Shared by the Add Token form and each token card's edit row - folder names
// from assets/creature-sounds/ double as both the option value and label
// (see creatureSoundLibrary.js), so there's no separate friendly-name lookup
// the way musicLibraryIndex needs one.
// Creature Library modal content - one clickable card per saved template
// (click anywhere but Delete to load it into the Add Token form and close
// the modal, see openCreatureLibraryModal). Kept as a modal rather than an
// inline sidebar dropdown since this list only grows over time.
function creatureLibraryModalListHtml() {
  if (!creatureTemplates.length) {
    return '<p style="color:#666;font-size:12px;">No saved creatures yet - build a token, then use its "Save as Template…" button.</p>';
  }
  return creatureTemplates
    .map((t) => `
      <div class="token-card clickable" data-template-id="${escapeHtml(t.id)}">
        <div class="title"><span>${escapeHtml(t.name)}</span></div>
        <div class="actions"><button type="button" class="danger deleteTemplateBtn">Delete</button></div>
      </div>
    `)
    .join('');
}

function soundFolderOptionsHtml(selected) {
  const options = creatureSoundFolders
    .map((folder) => `<option value="${escapeHtml(folder)}" ${selected === folder ? 'selected' : ''}>${escapeHtml(folder)}</option>`)
    .join('');
  return `<option value="">- none -</option>${options}`;
}

// GM-only manual trigger, one button per assets/creature-sounds/ folder - each
// click sends soundboard:play and the server broadcasts a random clip from
// that folder table-wide (see fx:play/creatureSoundUrl), same mechanism as
// the automatic per-attack cue.
function soundboardHtml() {
  if (!creatureSoundFolders.length) {
    return '<p style="color:#666;font-size:12px;">No creature-sound folders bundled yet - add some under assets/creature-sounds/&lt;folder&gt;/.</p>';
  }
  return creatureSoundFolders
    .map((folder) => `<button type="button" class="secondary soundboardBtn" data-folder="${escapeHtml(folder)}">${escapeHtml(folder)}</button>`)
    .join('');
}

// Shared by the ambient-music and battle-music dropdowns - same bundled
// library (assets/music/), just a different selected track per dropdown.
function musicOptionsHtml(selectedUrl) {
  return musicLibraryIndex
    .map((t) => {
      const url = musicLibraryUrl(t);
      return `<option value="${escapeHtml(url)}" ${selectedUrl === url ? 'selected' : ''}>${escapeHtml(t.friendlyName)}</option>`;
    })
    .join('');
}

function gmSidebarHtml() {
  const map = session.map || {};
  const isCustomMusic = !!map.musicUrl && !musicLibraryIndex.some((t) => musicLibraryUrl(t) === map.musicUrl);
  const musicOptions = musicOptionsHtml(map.musicUrl || null);
  const isCustomBattleMusic = !!map.battleMusicUrl && !musicLibraryIndex.some((t) => musicLibraryUrl(t) === map.battleMusicUrl);
  const battleMusicOptions = musicOptionsHtml(map.battleMusicUrl || null);
  const ownerOptions = Object.values(session.players)
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join('');

  return `
    ${roomInfoHtml('GM')}

    <div class="field"><button type="button" id="openSoundboardBtn" class="secondary">Soundboard…</button></div>

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
    <div class="field">
      <label>Ambient music</label>
      <select id="mapMusicSelect">
        <option value="">No music</option>
        ${musicOptions}
        <option value="__custom__" ${isCustomMusic ? 'selected' : ''}>Custom track…</option>
      </select>
    </div>
    <div class="field" id="mapMusicCustomField" style="${isCustomMusic ? '' : 'display:none;'}">
      <label>Upload or paste a track URL</label>
      <input type="file" id="mapMusicFileInput" accept="audio/*" />
      <input type="text" id="mapMusicUrlInput" value="${escapeHtml(isCustomMusic ? map.musicUrl : '')}" placeholder="/uploads/... or paste a URL" style="margin-top:6px;" />
    </div>
    <div class="field">
      <label>Battle music (plays instead, while combat is active)</label>
      <select id="mapBattleMusicSelect">
        <option value="">Same as ambient</option>
        ${battleMusicOptions}
        <option value="__custom__" ${isCustomBattleMusic ? 'selected' : ''}>Custom track…</option>
      </select>
    </div>
    <div class="field" id="mapBattleMusicCustomField" style="${isCustomBattleMusic ? '' : 'display:none;'}">
      <label>Upload or paste a track URL</label>
      <input type="file" id="mapBattleMusicFileInput" accept="audio/*" />
      <input type="text" id="mapBattleMusicUrlInput" value="${escapeHtml(isCustomBattleMusic ? map.battleMusicUrl : '')}" placeholder="/uploads/... or paste a URL" style="margin-top:6px;" />
    </div>
    <button id="setMapBtn">Set map</button>

    <h2>Add token</h2>
    <div class="field row">
      <div><button type="button" id="openCreatureLibraryBtn" class="secondary">Load from Creature Library…</button></div>
      <div id="creatureLibraryLoadedLabel" style="align-self:center;font-size:12px;color:#888;"></div>
    </div>
    <div class="field row">
      <div><label>Name</label><input type="text" id="tokenNameInput" placeholder="Goblin" /></div>
      <div><label>Quantity</label><input type="number" id="tokenQuantityInput" value="1" min="1" max="50" /></div>
    </div>
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
    <div class="field"><label>Sound folder (attack cue)</label>
      <select id="tokenSoundFolderSelect">${soundFolderOptionsHtml(null)}</select>
    </div>
    <div class="field row">
      <div><label>Normal vision (ft)</label><input type="number" id="tokenVisionNormalInput" value="30" /></div>
      <div><label>Darkvision (ft)</label><input type="number" id="tokenVisionDarkInput" value="0" /></div>
    </div>
    <div class="field row">
      <div><label>HP</label><input type="number" id="tokenHpInput" value="10" /></div>
      <div><label>Max HP</label><input type="number" id="tokenMaxHpInput" value="10" /></div>
      <div><label>AC</label><input type="number" id="tokenAcInput" value="10" /></div>
    </div>
    <div class="field"><label>Speed (ft)</label><input type="number" id="tokenSpeedInput" value="30" /></div>
    <div class="field"><button type="button" id="tokenBrowseLibraryBtn" class="secondary">Browse Token Library…</button></div>
    <div class="field"><label>Or upload a custom image</label><input type="file" id="tokenFileInput" accept="image/*" /></div>
    <img id="tokenThumb" class="thumb" />
    <div class="field"><label>Image URL</label><input type="text" id="tokenImageUrlInput" placeholder="/uploads/... or paste a URL" /></div>
    <div class="field"><label><input type="checkbox" id="tokenHiddenInput" /> Hidden from players</label></div>
    <button id="addTokenBtn">Add token</button>

    <h2>Tokens</h2>
    <div class="field"><label><input type="checkbox" id="showMovementRangesToggle" ${showMovementRanges ? 'checked' : ''} /> Show movement ranges</label></div>
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

// A GM token's manual stat-block attacks (Phase 2.5 follow-up). Enemies aren't
// full characters, so the GM enters attacks directly (name + to-hit + damage
// dice); clicking a row arms the same attack-targeting flow a player's weapon
// uses, just rolled via /vtt/api/roll-manual instead of a character sheet.
function gmAttacksHtml(t) {
  const rows = (t.actions || [])
    .map((a, idx) => `
      <div class="mini-sheet-action gm-attack-row" data-action-index="${idx}">
        <span>${escapeHtml(a.name || 'Attack')}</span>
        <span style="color:#aaa;">${signedVtt(a.toHitBonus)}${a.damageRolls ? ` · ${escapeHtml(a.damageRolls)}${a.damageBonus ? ' ' + signedVtt(a.damageBonus) : ''}` : ''} <button type="button" class="gm-attack-del" title="Delete attack" data-action-index="${idx}">✕</button></span>
      </div>
    `)
    .join('');
  return `
    <label style="font-size:11px;color:#888;">Attacks</label>
    ${rows || '<p style="color:#666;font-size:11px;margin:2px 0 0;">No attacks yet.</p>'}
    <div class="gm-attack-add">
      <input class="atkName" placeholder="Name" />
      <input class="atkHit" type="number" placeholder="+hit" />
      <input class="atkDmg" placeholder="1d8" />
      <input class="atkDmgBonus" type="number" placeholder="+dmg" />
      <button type="button" class="secondary addAttackBtn">Add attack</button>
    </div>
  `;
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
            <div><label>AC</label><input type="number" class="acInput" value="${t.ac ?? ''}" /></div>
          </div>
          ${gmAttacksHtml(t)}
          <div class="field"><label>Condition</label>
            <select class="conditionSelect">
              <option value="" ${!t.condition ? 'selected' : ''}>-</option>
              <option value="healthy" ${t.condition === 'healthy' ? 'selected' : ''}>Healthy</option>
              <option value="bloodied" ${t.condition === 'bloodied' ? 'selected' : ''}>Bloodied</option>
              <option value="critical" ${t.condition === 'critical' ? 'selected' : ''}>Critical</option>
            </select>
          </div>
          <div class="field"><label>Sound folder (attack cue)</label>
            <select class="soundFolderSelect">${soundFolderOptionsHtml(t.soundFolder || null)}</select>
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
          <div class="field">${conditionTagsHtml(t.conditions)}</div>
          <div class="actions">
            <button class="secondary changeImageBtn">Change Image…</button>
            <button class="secondary advancedVisionBtn">Advanced Vision…</button>
            <button class="secondary conditionsBtn">Conditions…</button>
            <button class="secondary saveTemplateBtn">Save as Template…</button>
            <button class="secondary recenterTokenBtn" title="Snap back to the middle of the map - use if a token ever gets dragged somewhere unreachable">Recenter on Map</button>
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

// Small read-only tag row for a token card - shows which standard conditions
// are currently active (set via the Conditions… modal). Not secret info
// (unlike stats), so this same markup is safe to use in both the GM's and a
// player's own token card.
function conditionTagsHtml(conditions) {
  if (!conditions || !conditions.length) return '<span style="color:#666;font-size:12px;">No conditions</span>';
  return conditions.map((c) => `<span class="tag">${escapeHtml(c.charAt(0).toUpperCase() + c.slice(1))}</span>`).join(' ');
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
  document.getElementById('startCombatBtn')?.addEventListener('click', startCombat);
  document.getElementById('stopCombatBtn')?.addEventListener('click', stopCombat);
  wireSessionNotesControls();

  document.getElementById('openSoundboardBtn').addEventListener('click', openSoundboardModal);

  document.getElementById('showMovementRangesToggle').addEventListener('change', (e) => {
    showMovementRanges = e.target.checked;
    render(); // a view preference only - doesn't touch session state, no renderSidebar() needed
  });

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

  const mapMusicSelect = document.getElementById('mapMusicSelect');
  const mapMusicCustomField = document.getElementById('mapMusicCustomField');
  const mapMusicFileInput = document.getElementById('mapMusicFileInput');
  const mapMusicUrlInput = document.getElementById('mapMusicUrlInput');

  mapMusicSelect.addEventListener('change', () => {
    mapMusicCustomField.style.display = mapMusicSelect.value === '__custom__' ? '' : 'none';
  });

  mapMusicFileInput.addEventListener('change', async () => {
    const file = mapMusicFileInput.files[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('audio', file);
      const res = await fetch('/vtt/api/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('upload_failed');
      const data = await res.json();
      mapMusicUrlInput.value = data.url;
    } catch {
      alert('Music track upload failed.');
    }
  });

  const mapBattleMusicSelect = document.getElementById('mapBattleMusicSelect');
  const mapBattleMusicCustomField = document.getElementById('mapBattleMusicCustomField');
  const mapBattleMusicFileInput = document.getElementById('mapBattleMusicFileInput');
  const mapBattleMusicUrlInput = document.getElementById('mapBattleMusicUrlInput');

  mapBattleMusicSelect.addEventListener('change', () => {
    mapBattleMusicCustomField.style.display = mapBattleMusicSelect.value === '__custom__' ? '' : 'none';
  });

  mapBattleMusicFileInput.addEventListener('change', async () => {
    const file = mapBattleMusicFileInput.files[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('audio', file);
      const res = await fetch('/vtt/api/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('upload_failed');
      const data = await res.json();
      mapBattleMusicUrlInput.value = data.url;
    } catch {
      alert('Battle music upload failed.');
    }
  });

  document.getElementById('setMapBtn').addEventListener('click', () => {
    const imageUrl = mapImageUrlInput.value.trim();
    if (!imageUrl) return alert('Upload or enter a map image URL first.');
    const musicUrl = mapMusicSelect.value === '__custom__' ? mapMusicUrlInput.value.trim() || null : mapMusicSelect.value || null;
    const battleMusicUrl = mapBattleMusicSelect.value === '__custom__' ? mapBattleMusicUrlInput.value.trim() || null : mapBattleMusicSelect.value || null;
    send({
      type: 'map:set',
      map: {
        imageUrl,
        widthPx: Number(mapWidthInput.value) || 1600,
        heightPx: Number(mapHeightInput.value) || 1200,
        gridSizePx: Number(document.getElementById('mapGridSizeInput').value) || 50,
        brightness: document.getElementById('mapBrightnessSelect').value,
        musicUrl,
        battleMusicUrl,
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

  const creatureLibraryLoadedLabel = document.getElementById('creatureLibraryLoadedLabel');
  // Attacks/actions have no field on the Add Token form (they're only
  // editable once a token already exists, via gmAttacksHtml) - a template's
  // actions are snapshotted here at load time instead, and carried into
  // baseToken.actions below. A snapshot (not a re-lookup by id at
  // addTokenBtn time) so deleting the template afterward can't silently
  // drop the attacks that were already loaded into the form.
  let pendingTemplateActions = [];

  document.getElementById('openCreatureLibraryBtn').addEventListener('click', () => {
    openCreatureLibraryModal((template) => {
      const t = template.tokenJson || {};
      pendingTemplateActions = t.actions || [];
      creatureLibraryLoadedLabel.textContent = `Loaded: ${template.name}`;
      document.getElementById('tokenNameInput').value = template.name;
      document.getElementById('tokenTypeSelect').value = t.type || 'enemy';
      document.getElementById('tokenSoundFolderSelect').value = t.soundFolder || '';
      document.getElementById('tokenVisionNormalInput').value = t.visionNormalFt ?? 30;
      document.getElementById('tokenVisionDarkInput').value = t.visionDarkFt ?? 0;
      document.getElementById('tokenHpInput').value = t.stats?.hp ?? '';
      document.getElementById('tokenMaxHpInput').value = t.stats?.maxHp ?? '';
      document.getElementById('tokenAcInput').value = t.ac ?? '';
      document.getElementById('tokenSpeedInput').value = t.speedFt ?? 30;
      tokenImageUrlInput.value = t.imageUrl || '';
      tokenThumb.src = t.imageUrl || '';
      tokenThumb.classList.toggle('visible', !!t.imageUrl);
    });
  });

  document.getElementById('addTokenBtn').addEventListener('click', () => {
    const name = document.getElementById('tokenNameInput').value.trim();
    if (!name) return alert('Give the token a name.');
    const quantity = Math.max(1, Math.min(50, Number(document.getElementById('tokenQuantityInput').value) || 1));
    const map = session.map || { widthPx: 800, heightPx: 600 };
    const baseToken = {
      type: document.getElementById('tokenTypeSelect').value,
      ownerId: document.getElementById('tokenOwnerSelect').value || null,
      soundFolder: document.getElementById('tokenSoundFolderSelect').value || null,
      imageUrl: tokenImageUrlInput.value.trim() || null,
      visionNormalFt: Number(document.getElementById('tokenVisionNormalInput').value) || 0,
      visionDarkFt: Number(document.getElementById('tokenVisionDarkInput').value) || 0,
      visionTrueFt: 0,
      visionDevilFt: 0,
      speedFt: Number(document.getElementById('tokenSpeedInput').value) || 0,
      speedRemainingFt: Number(document.getElementById('tokenSpeedInput').value) || 0,
      hidden: document.getElementById('tokenHiddenInput').checked,
      // Top-level ac (not stats.ac) so the same field works for PCs and enemies;
      // the server strips it from players for enemy/npc tokens (store.js filter).
      ac: Number(document.getElementById('tokenAcInput').value) || 0,
      stats: {
        hp: Number(document.getElementById('tokenHpInput').value) || 0,
        maxHp: Number(document.getElementById('tokenMaxHpInput').value) || 0,
      },
      // Not a form field (attacks are only editable once a token exists,
      // via gmAttacksHtml) - carried over directly from the selected
      // Creature Library template, if any.
      actions: pendingTemplateActions,
    };

    // Quantity > 1 spawns a small grid of tokens centered on the map, named
    // "Name 1", "Name 2", etc., rather than stacking them all on the exact
    // same square - each still just a separate token:add, no new event or
    // server-side concept needed. Quantity 1 keeps the original bare name
    // (no " 1" suffix) so existing single-token behavior is unchanged.
    const spacingPx = map.gridSizePx || 50;
    const perRow = Math.ceil(Math.sqrt(quantity));
    const rows = Math.ceil(quantity / perRow);
    for (let i = 0; i < quantity; i++) {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const offsetX = (col - (perRow - 1) / 2) * spacingPx;
      const offsetY = (row - (rows - 1) / 2) * spacingPx;
      send({
        type: 'token:add',
        token: {
          ...baseToken,
          id: `token-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          name: quantity > 1 ? `${name} ${i + 1}` : name,
          x: Math.round(map.widthPx / 2 + offsetX),
          y: Math.round(map.heightPx / 2 + offsetY),
        },
      });
    }
  });

  document.getElementById('tokenList').addEventListener('change', (e) => {
    const card = e.target.closest('.token-card');
    if (!card) return;
    const tokenId = card.dataset.tokenId;
    if (e.target.classList.contains('hpInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'hp', value: Number(e.target.value) });
    } else if (e.target.classList.contains('maxHpInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'maxHp', value: Number(e.target.value) });
    } else if (e.target.classList.contains('acInput')) {
      // Enemy/npc AC is stripped from players by the server filter; the GM sets
      // the true value here, and players only ever discover the `knownAc` bound.
      send({ type: 'token:stat:update', tokenId, stat: 'ac', value: Number(e.target.value) });
    } else if (e.target.classList.contains('conditionSelect')) {
      send({ type: 'token:stat:update', tokenId, stat: 'condition', value: e.target.value || null });
    } else if (e.target.classList.contains('soundFolderSelect')) {
      send({ type: 'token:stat:update', tokenId, stat: 'soundFolder', value: e.target.value || null });
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
    const token = session.tokens[tokenId];
    // --- Manual stat-block attacks (checked before the row, since the delete
    // ✕ lives inside a .gm-attack-row) ---
    if (e.target.classList.contains('gm-attack-del')) {
      const idx = Number(e.target.dataset.actionIndex);
      const next = (token?.actions || []).filter((_, i) => i !== idx);
      send({ type: 'token:stat:update', tokenId, stat: 'actions', value: next });
      return;
    }
    if (e.target.classList.contains('addAttackBtn')) {
      const box = e.target.closest('.gm-attack-add');
      const name = box.querySelector('.atkName').value.trim();
      if (!name) return alert('Give the attack a name.');
      const action = {
        name,
        toHitBonus: Number(box.querySelector('.atkHit').value) || 0,
        damageRolls: box.querySelector('.atkDmg').value.trim(),
        damageBonus: Number(box.querySelector('.atkDmgBonus').value) || 0,
      };
      send({ type: 'token:stat:update', tokenId, stat: 'actions', value: [...(token?.actions || []), action] });
      return;
    }
    const attackRow = e.target.closest('.gm-attack-row');
    if (attackRow && token) {
      const action = (token.actions || [])[Number(attackRow.dataset.actionIndex)];
      if (action) armActionTargeting(tokenId, action);
      return;
    }
    if (e.target.classList.contains('toggleHiddenBtn')) {
      send({ type: 'token:hidden:toggle', tokenId });
    } else if (e.target.classList.contains('removeBtn')) {
      if (confirm('Remove this token?')) send({ type: 'token:remove', tokenId });
    } else if (e.target.classList.contains('advancedVisionBtn')) {
      openVisionModal(tokenId);
    } else if (e.target.classList.contains('conditionsBtn')) {
      openConditionsModal(tokenId);
    } else if (e.target.classList.contains('changeImageBtn')) {
      openImagePicker((url) => send({ type: 'token:stat:update', tokenId, stat: 'imageUrl', value: url }));
    } else if (e.target.classList.contains('saveTemplateBtn')) {
      saveTokenAsTemplate(token);
    } else if (e.target.classList.contains('recenterTokenBtn')) {
      recenterToken(tokenId);
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

// Refreshes just the #otherTokenList div (see playerSidebarHtml) rather than
// the whole sidebar - otherTokenListHtml's markup is pure display (no
// buttons/inputs), so there's nothing to re-wire, and doing only this avoids
// the token:move handler's full renderSidebar() nuking whatever else the
// player had open in the sidebar (a marker color picker, mid-edit) every
// time some other player's token moved anywhere on the map.
function updateOtherTokensInViewList() {
  if (role !== 'player') return; // GM's sidebar has no position-dependent list to refresh
  const list = document.getElementById('otherTokenList');
  if (!list) return; // sidebar not showing this yet (e.g. still on the login screen)
  const otherTokens = currentRenderedTokens.filter((t) => t.ownerId !== playerId);
  list.innerHTML = otherTokenListHtml(otherTokens);
}

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
          <div class="field">${conditionTagsHtml(t.conditions)}</div>
          <div class="actions">
            <button class="secondary changeImageBtn">Change Image…</button>
            <button class="secondary conditionsBtn">Conditions…</button>
            <button class="secondary recenterTokenBtn" title="Snap back to the middle of the map - use if your token ever gets dragged somewhere unreachable">Recenter on Map</button>
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

  // Slot-level rows double as the spell-casting entry point (Phase 3): clicking
  // the row's label (not the Use/Reset buttons, which remain the manual-override
  // path) opens a picker of prepared spells castable at that level - see
  // openSpellPicker(). Which row you click IS the upcast choice: picking a
  // lower-level spell from a higher slot row casts it upcast at that slot level,
  // no separate level selector needed.
  const slotsHtml = (t.spellSlots || []).length
    ? (t.spellSlots || [])
        .map(
          (s) => `
        <div class="mini-sheet-slot" data-slot-type="${escapeHtml(s.type)}" data-slot-level="${s.level}">
          <span class="mini-sheet-slot-label">${s.type === 'pact' ? 'Pact' : 'Level'} ${s.level}: ${s.current}/${s.max}</span>
          <button type="button" class="secondary slotUseBtn" ${s.current <= 0 ? 'disabled' : ''}>Use</button>
          <button type="button" class="secondary slotResetBtn">Reset</button>
        </div>
      `
        )
        .join('')
    : '';

  const cantripCount = (t.preparedSpells || []).filter((s) => (s.spellLevel ?? 0) === 0).length;
  const cantripsHtml = cantripCount
    ? `
      <div class="mini-sheet-slot" data-slot-level="0">
        <span class="mini-sheet-slot-label">Cantrips (${cantripCount})</span>
      </div>
    `
    : '';

  return `
    <div class="mini-sheet">
      <div class="field row">
        <div><label>AC</label><input type="number" class="acInput" value="${t.ac ?? ''}" /></div>
        <div><label>Saves</label><div style="padding-top:4px;">${savesHtml}</div></div>
      </div>
      <label style="font-size:11px;color:#888;">Actions</label>
      ${actionsHtml}
      ${(cantripsHtml || slotsHtml) ? `<label style="font-size:11px;color:#888;">Spells</label>${cantripsHtml}${slotsHtml}` : ''}
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
      // Never show a raw HP number for a token that isn't the viewer's own -
      // condition (if the GM has set one) or nothing, same rule already
      // applied to enemy/npc, now applied uniformly regardless of type. PC
      // stats aren't stripped server-side (allies' HP isn't secret at the
      // protocol level, per the original spec), so this is a client-side
      // display choice on top of that, not a security boundary.
      const detail = t.condition ? `Condition: ${escapeHtml(t.condition)}` : 'No status known';
      return `
        <div class="token-card">
          <div class="title"><span>${escapeHtml(t.name)} <span class="tag">${t.type}</span></span></div>
          <div style="font-size:12px;color:#aaa;">${detail}</div>
          ${t.conditions && t.conditions.length ? `<div class="field">${conditionTagsHtml(t.conditions)}</div>` : ''}
        </div>
      `;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Spell picker (Phase 3) - opened by clicking a slot-level row (or the
// Cantrips row) in the mini-sheet. Lists prepared spells castable at that
// level; picking one closes the picker and arms targeting exactly like a
// weapon action, tagged action.kind='spell' so the shared confirm/roll flow
// above (openAttackConfirm/resolveAttack) branches correctly.
// ---------------------------------------------------------------------------
const spellPickerModal = document.getElementById('spellPickerModal');
const spellPickerTitle = document.getElementById('spellPickerTitle');
const spellPickerList = document.getElementById('spellPickerList');
document.getElementById('spellPickerCancelBtn').addEventListener('click', () => spellPickerModal.classList.remove('visible'));

function openSpellPicker(tokenId, clickedLevel) {
  const token = session.tokens[tokenId];
  if (!token) return;
  const spells = (token.preparedSpells || []).filter((s) =>
    clickedLevel === 0 ? (s.spellLevel ?? 0) === 0 : (s.spellLevel ?? 0) > 0 && (s.spellLevel ?? 0) <= clickedLevel
  );

  spellPickerTitle.textContent = clickedLevel === 0 ? 'Cast a Cantrip' : `Cast a Level ${clickedLevel} Spell`;
  spellPickerList.innerHTML = spells.length
    ? spells
        .map(
          (s) => `
        <div class="mini-sheet-action spell-picker-row" data-spell-id="${escapeHtml(s.id)}" data-spell-name="${escapeHtml(s.name)}">
          <span>${escapeHtml(s.name)}</span>
          <span style="color:#aaa;">Lvl ${s.spellLevel ?? 0}</span>
        </div>
      `
        )
        .join('')
    : '<p style="color:#666;font-size:12px;">No prepared spells at this level.</p>';

  spellPickerList.querySelectorAll('.spell-picker-row').forEach((row) => {
    row.addEventListener('click', () => {
      spellPickerModal.classList.remove('visible');
      armActionTargeting(tokenId, {
        kind: 'spell',
        instanceId: row.dataset.spellId,
        name: row.dataset.spellName,
        slotLevel: clickedLevel,
      });
    });
  });

  spellPickerModal.classList.add('visible');
}

function wirePlayerSidebar() {
  document.getElementById('addCharacterTokenBtn').addEventListener('click', openCharacterPicker);
  wireSessionNotesControls();

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
    } else if (e.target.classList.contains('acInput')) {
      send({ type: 'token:stat:update', tokenId, stat: 'ac', value: Number(e.target.value) });
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
    } else if (e.target.classList.contains('conditionsBtn')) {
      openConditionsModal(tokenId);
    } else if (e.target.classList.contains('recenterTokenBtn')) {
      recenterToken(tokenId);
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
    } else if (e.target.classList.contains('mini-sheet-slot-label')) {
      const slotRow = e.target.closest('.mini-sheet-slot');
      if (slotRow) openSpellPicker(tokenId, Number(slotRow.dataset.slotLevel));
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
