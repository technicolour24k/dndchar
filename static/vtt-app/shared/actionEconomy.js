// Display helpers for the action economy in the VTT client (docs: plans/dndchar/action-economy).
//
// Pure: no DOM, no imports. Imported by static/vtt-app/main.js (browser) and the vitest tests. The
// server stays the authority: this only words what a weapon attack will cost, from the turn view the
// roll-attack preview returns ({ profileKey, pools: [{key,label,current,max}], followups: [{cls,label,remaining}] }).
// It is a display twin of src/lib/rules/actionEconomy.ts; keep the two in step.

export const ATTACK_TIMINGS = [
  { value: 'action', label: 'Action' },
  { value: 'bonus_action', label: 'Bonus action (off-hand)' },
  { value: 'reaction', label: 'Reaction (opportunity attack)' },
];

/**
 * The pool a weapon attack drew from: 5e by timing, homebrew (Attack & Utility) always Attack.
 * @param {any} view @param {string} timing
 */
export function attackPoolKey(view, timing) {
  if (!view) return null;
  return view.profileKey === 'attack_utility' ? 'attack' : timing;
}

/**
 * The follow-up (Extra Attack) a weapon attack could use, or null. Extra Attack is part of the Attack
 * action, so only an Action-timed attack offers it, and only while some are waiting.
 * @param {any} view @param {string} timing
 */
export function attackFollowup(view, timing) {
  if (!view || timing !== 'action') return null;
  const waiting = (view.followups || []).find((/** @type {any} */ entry) => entry.cls === 'melee' && entry.remaining > 0);
  return waiting ? { label: waiting.label || 'Extra Attack', remaining: waiting.remaining } : null;
}

/**
 * "1 Action" / "2 Attack actions": the cost wording of a pool under the view's profile.
 * @param {any} view @param {string | null} poolKey @param {number} [n]
 */
export function poolCostText(view, poolKey, n = 1) {
  const pool = (view?.pools || []).find((/** @type {any} */ entry) => entry.key === poolKey);
  if (!pool) return `${n} ${poolKey}`;
  if (view.profileKey === 'attack_utility') return `${n} ${pool.label} ${n === 1 ? 'action' : 'actions'}`;
  return `${n} ${pool.label}${n === 1 ? '' : 's'}`;
}

/**
 * What the confirm card says an attack will cost: "Free - Extra Attack (1 left)" when a follow-up is
 * chosen and waiting, else "1 Attack action (1 left)". Empty when there is no turn view.
 * @param {any} view @param {string} timing @param {string} followup
 */
export function attackCostText(view, timing, followup) {
  if (!view) return '';
  const offered = attackFollowup(view, timing);
  if (offered && followup !== 'skip') return `Free - ${offered.label} (${offered.remaining} left)`;
  const key = attackPoolKey(view, timing);
  const pool = (view.pools || []).find((/** @type {any} */ entry) => entry.key === key);
  const left = pool ? ` (${pool.current} left)` : '';
  return `${poolCostText(view, key)}${left}`;
}

/**
 * The line shown with the finished roll, from the roll-attack response's `turn` ("Paid: 1 Attack").
 * @param {any} turn
 */
export function paidText(turn) {
  if (!turn) return '';
  if (turn.usedFollowup) {
    const waiting = (turn.followupsLeft || []).find((/** @type {any} */ entry) => entry.cls === 'melee');
    return `Extra Attack (${waiting ? waiting.remaining : 0} left)`;
  }
  const spent = (turn.paid || []).filter((/** @type {any} */ line) => line.delta < 0).map((/** @type {any} */ line) => `${-line.delta} ${line.label}`);
  return spent.length ? `Paid: ${spent.join(', ')}` : '';
}
