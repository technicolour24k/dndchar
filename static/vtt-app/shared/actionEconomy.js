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
 * The follow-up choice to send with a roll. The server decides and pays; this only says what the player
 * chose. `choice` is the confirm card's pick ('use' | 'skip' | 'require'):
 *  - 'require' (the result button's free repeat) is always sent as it is;
 *  - with no turn view (the preview has not come back, or failed) nothing is sent, so the server's
 *    default applies and a waiting follow-up is used rather than silently skipped;
 *  - a follow-up the card offered goes as picked; with none offered nothing is sent either.
 * @param {any} view @param {string} timing @param {string} choice
 * @returns {'use' | 'skip' | 'require' | undefined}
 */
export function followupToSend(view, timing, choice) {
  if (choice === 'require') return 'require';
  if (!view || !attackFollowup(view, timing)) return undefined;
  return choice === 'skip' ? 'skip' : 'use';
}

/**
 * The line shown with the finished roll, from the roll's `turn` ("Paid: 1 Attack", "Extra Attack (1 left)").
 * @param {any} turn
 */
export function paidText(turn) {
  if (!turn) return '';
  if (turn.usedFollowup) {
    const cls = turn.followupCls || 'melee';
    const waiting = (turn.followupsLeft || []).find((/** @type {any} */ entry) => entry.cls === cls);
    const label = waiting?.label || (cls === 'melee' ? 'Extra Attack' : 'Free repeat');
    return `${label} (${waiting ? waiting.remaining : 0} left)`;
  }
  const spent = (turn.paid || []).filter((/** @type {any} */ line) => line.delta < 0).map((/** @type {any} */ line) => `${-line.delta} ${line.label}`);
  return spent.length ? `Paid: ${spent.join(', ')}` : '';
}

/**
 * The "repeat for free" button on a finished roll: the follow-up this roll's class still has waiting, from
 * the roll response's `turn` ({ followupCls, followupsLeft }). Null when there is none (or no turn data).
 * @param {any} turn
 * @returns {{ label: string, remaining: number } | null}
 */
export function repeatOffer(turn) {
  if (!turn || !turn.followupCls) return null;
  const waiting = (turn.followupsLeft || []).find((/** @type {any} */ entry) => entry.cls === turn.followupCls && entry.remaining > 0);
  if (!waiting) return null;
  return { label: String(waiting.label || 'Extra Attack'), remaining: Number(waiting.remaining) || 0 };
}

// ---------------------------------------------------------------------------
// Turn display on the token (action economy Unit 5). token.turn is a DISPLAY copy of the character's
// turn view; every change goes through the /turn routes. The VTT server rebuilds it (sanitizeTurn),
// so this trim and that one must produce the same shape and key order or the resync would resend.
// ---------------------------------------------------------------------------

const clampInt = (/** @type {any} */ n, /** @type {number} */ max) => Math.min(max, Math.max(0, Math.round(Number(n) || 0)));

/**
 * The small, display-only copy kept on a token, or null when there is nothing to show.
 * @param {any} view a TurnView (full or already trimmed)
 */
export function trimTurnView(view) {
  if (!view || typeof view !== 'object' || typeof view.profileKey !== 'string' || !Array.isArray(view.pools)) return null;
  return {
    profileKey: String(view.profileKey).slice(0, 40),
    turnSeq: Math.min(1e9, Math.max(0, Math.round(Number(view.turnSeq) || 0))),
    pools: view.pools.slice(0, 6).map((/** @type {any} */ p) => ({ key: String(p.key).slice(0, 40), label: String(p.label || p.key).slice(0, 80), current: clampInt(p.current, 99), max: clampInt(p.max, 99) })),
    followups: (Array.isArray(view.followups) ? view.followups : []).slice(0, 4).map((/** @type {any} */ f) => ({ cls: String(f.cls).slice(0, 20), label: String(f.label || 'Extra Attack').slice(0, 80), remaining: clampInt(f.remaining, 99) }))
  };
}

/**
 * Chip texts for the token card: "Attack 1/2", "Extra Attack: 1 left" (only while some are waiting).
 * @param {any} turn
 */
export function turnChips(turn) {
  if (!turn) return [];
  const pools = (turn.pools || []).map((/** @type {any} */ p) => `${p.label} ${p.current}/${p.max}`);
  const followups = (turn.followups || []).filter((/** @type {any} */ f) => f.remaining > 0).map((/** @type {any} */ f) => `${f.label}: ${f.remaining} left`);
  return [...pools, ...followups];
}

/**
 * How many extra feet a move needs and how many dashes cover it (each dash adds one full speed).
 * No speed means no dash is on offer (count 0), though `over` is still reported.
 * @param {number} distanceFt @param {number | null | undefined} remainingFt @param {number | null | undefined} speedFt
 */
export function dashNeeded(distanceFt, remainingFt, speedFt) {
  const over = Math.max(0, (Number(distanceFt) || 0) - (Number(remainingFt) || 0));
  const speed = Number(speedFt) || 0;
  return { over, count: over > 0 && speed > 0 ? Math.ceil(over / speed) : 0 };
}

/** The pool a dash draws from: a general action, so Utility in homebrew and Action in 5e. @param {any} view */
export function dashPoolKey(view) {
  return view?.profileKey === 'attack_utility' ? 'utility' : 'action';
}

/**
 * The dash prompt sentence. `over` is null for the Dash button (no held move).
 * @param {any} view @param {number} count @param {number | null} over @param {number} speedFt
 */
export function dashPromptText(view, count, over, speedFt) {
  const key = dashPoolKey(view);
  const pool = (view?.pools || []).find((/** @type {any} */ p) => p.key === key);
  const cost = `${poolCostText(view, key, count)}${pool ? ` (you have ${pool.current})` : ''}`;
  const gain = `Adds ${count * speedFt} ft of movement.`;
  return over === null ? `Dash? Costs ${cost}. ${gain}` : `That move is ${over} ft past your movement. Dash? Costs ${cost}. ${gain}`;
}

/**
 * The note shown after a GM "Reset all", only when some characters were not theirs to reset.
 * @param {{ reset?: number, skipped?: number }} result
 */
export function resetAllNote(result) {
  const reset = Number(result?.reset) || 0;
  const skipped = Number(result?.skipped) || 0;
  if (!skipped) return '';
  return `Actions reset for ${reset} ${reset === 1 ? 'character' : 'characters'} (${skipped} skipped)`;
}
