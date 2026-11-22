// In-browser session recorder (daily-voice plan, Rev 4). Mixes every audio source it is given (the
// remote participants' tracks plus our own mic) through one Web Audio graph into a MediaRecorder.
// Nothing leaves the browser: no Daily recording, no upload. Chunks are held in memory (about 70 MB
// for 5 hours at 32 kbps) and handed back as one Blob on stop().
//
// The caller (voice.js) passes sources as Map id -> { key, stream }: key changes when the track
// does, stream is a MediaStream. Remote streams MUST be ones that are also playing in an <audio>
// element (voice.js's own elements): Chromium delivers silence from a remote WebRTC stream to
// Web Audio unless it is attached to a media element too.
//
// Everything here is best effort and must never throw into the call: start() reports failure by
// throwing (the caller shows it), but sync()/stop() swallow errors.
import { RECORDING_BITRATE, RECORDING_TIMESLICE_MS, diffSources, pickRecordingMime } from './shared/voiceRecord.js';

const STOP_TIMEOUT_MS = 5000;

export function createRecorder() {
  let ctx = null;
  let dest = null;
  let rec = null;
  let pick = null;
  let chunks = [];
  let startedAt = 0;
  const nodes = new Map(); // id -> { node, key }

  const active = () => !!rec && rec.state !== 'inactive';

  function sync(wanted) {
    if (!ctx || !dest) return;
    try {
      const current = new Map([...nodes].map(([id, n]) => [id, n.key]));
      const { add, remove } = diffSources(current, wanted);
      for (const id of remove) {
        const n = nodes.get(id);
        if (n) { try { n.node.disconnect(); } catch { /* already gone */ } }
        nodes.delete(id);
      }
      for (const id of add) {
        const w = wanted.get(id);
        if (!w || !w.stream) continue;
        const node = ctx.createMediaStreamSource(w.stream);
        node.connect(dest);
        nodes.set(id, { node, key: w.key });
      }
    } catch (e) {
      console.error('[voice] recorder sync failed', e);
    }
  }

  function cleanup() {
    for (const { node } of nodes.values()) { try { node.disconnect(); } catch { /* ignore */ } }
    nodes.clear();
    if (ctx) ctx.close().catch(() => {});
    ctx = null;
    dest = null;
    rec = null;
  }

  return {
    get active() { return active(); },
    get startedAt() { return startedAt; },
    /** Throws Error('unsupported') if this browser can't record, otherwise starts. */
    start(wanted) {
      if (active()) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || typeof MediaRecorder === 'undefined') throw new Error('unsupported');
      pick = pickRecordingMime((t) => MediaRecorder.isTypeSupported(t));
      if (!pick) throw new Error('unsupported');
      ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      dest = ctx.createMediaStreamDestination();
      chunks = [];
      sync(wanted);
      rec = new MediaRecorder(dest.stream, { mimeType: pick.mime, audioBitsPerSecond: RECORDING_BITRATE });
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.start(RECORDING_TIMESLICE_MS);
      startedAt = Date.now();
    },
    sync,
    /**
     * Resolves { blob, ext } (blob null if nothing was captured). Never rejects, and never takes
     * longer than STOP_TIMEOUT_MS: if the recorder doesn't confirm in time we finish with the chunks
     * already in memory, so Leave can't hang.
     */
    stop() {
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          const ext = pick ? pick.ext : 'webm';
          const type = pick ? pick.mime.split(';')[0] : 'audio/webm';
          const blob = chunks.length ? new Blob(chunks, { type }) : null;
          chunks = [];
          cleanup();
          resolve({ blob, ext });
        };
        try {
          if (!rec || rec.state === 'inactive') return finish();
          timer = setTimeout(finish, STOP_TIMEOUT_MS);
          rec.onstop = finish;
          rec.stop(); // flushes the last chunk through ondataavailable before onstop
        } catch {
          finish();
        }
      });
    }
  };
}

/** Save a blob as a file via a temporary link. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
