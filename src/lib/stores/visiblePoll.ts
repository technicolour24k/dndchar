// Interval poller that only ticks while the tab is actually visible. A plain
// setInterval keeps firing in background tabs, and a sheet left open overnight
// was quietly hammering the DB (and its network quota) every few seconds for
// nobody. Runs one immediate catch-up tick when the tab comes back into view,
// so the panel doesn't sit stale for a full interval.
//
// Returns a cleanup function - hand it straight back from an $effect.
export function pollWhileVisible(tick: () => void, intervalMs: number, { immediate = true } = {}): () => void {
  let interval: ReturnType<typeof setInterval> | undefined;

  function start() {
    if (interval) return;
    interval = setInterval(tick, intervalMs);
  }

  function stop() {
    clearInterval(interval);
    interval = undefined;
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      tick();
      start();
    } else {
      stop();
    }
  }

  if (document.visibilityState === 'visible') {
    if (immediate) tick();
    start();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
