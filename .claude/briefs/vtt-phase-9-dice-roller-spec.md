# VTT Phase 9 — Dice Roller + Roll Log

## Why

A standalone freeform roller (d4/d6/d8/d10/d12/d20, quantity per die type, sum the results) — not tied to the character sheet's math engine, not resolving any specific check. Genuinely simple, and fully independent of every other item currently in flight (Phase 8, map reveal, props) — safe to build in any order relative to those.

---

## 0. Confirm the logging mechanism before assuming its shape

Before wiring the Roll Log broadcast, confirm exactly what "triggers whenever a session is marked as active" refers to in the existing code — this project has an established combat/activity log from earlier phases, and the Roll Log should almost certainly plug into that same mechanism rather than becoming a third, parallel logging system. Specifically:

- Find the actual session/encounter "active" flag (likely something like `session.encounterId` or a similar field, referenced in the ambient-music system's battle-track auto-swap logic) and confirm what "active" means precisely — is it encounter-scoped, or session-wide?
- Confirm how existing log entries (combat log, activity log) are structured and broadcast today — same event pattern (`validate → mutate → broadcast`), a shared log-entry shape, a shared UI panel? Reuse that shape for roll entries rather than inventing a new one, so the Roll Log can potentially just be another entry type in the same panel rather than a wholly separate UI surface.

**Report back what's actually there before Section 2.**

---

## 1. Dice roller modal — UI

A small modal, opened from wherever makes sense alongside the other new modals (Combat Actions, Token Manager, Map Settings) — a dice icon in the main toolbar is the obvious spot.

Contents: one column per die type (d4, d6, d8, d10, d12, d20), each with a quantity input (default 0). A single **Roll** button. On roll:

- For each die type with quantity > 0, roll that many of that die (e.g. quantity 2 on d6 → two independent 1-6 rolls).
- Sum everything across all die types into one total.
- Display the full breakdown, not just the total — e.g. `2d6 + 1d4: [4, 2] + [3] = 9` — same transparency principle the existing damage-roll display already uses. Don't collapse this to just the number.

No modifier/bonus field for this pass — the request was explicitly "simple," and a flat sum of raw dice covers the stated need. If a "+N" flat modifier turns out to matter in practice, it's a small addition later, not a redesign.

---

## 2. Roll event + Roll Log

A single WS event, following the existing thin-broadcast pattern:

```json
{ "type": "dice:roll", "dice": [{ "type": "d6", "count": 2 }, { "type": "d4", "count": 1 }], "results": [4, 2, 3], "total": 9, "public": true }
```

Server validates the sender is a connected participant, timestamps it, and — depending on Section 0's findings — either appends it to the existing log mechanism (preferred, if one already exists in a reusable shape) or broadcasts it directly to a dedicated Roll Log panel if no shared mechanism exists yet.

**Visibility rule**:
- **Players**: every roll broadcasts publicly by default — no private-roll option for players in this pass (not asked for, and secret player rolls raise the same "who sees what" questions as everything else in this project — worth a deliberate future decision, not a default to slip in unasked).
- **GM**: rolls default to **GM-only** (not broadcast to players at all), with an explicit toggle to make a given roll public before rolling — matches a GM secretly rolling for an NPC or a call they don't want telegraphed. This is the one asymmetry in the feature; make sure the toggle is visible and its default state (private) is obvious, so a GM doesn't accidentally reveal something by assuming the default was public.

Roll Log entries should show who rolled (or "GM" for a private-then-later-revealed context — out of scope for this pass, don't build a reveal-after-the-fact mechanism unless it turns out to be wanted) and the same breakdown shown in the modal, not just the total — consistency between what you see when you roll and what everyone sees in the log.

---

## 3. What's explicitly not this pass

- No modifiers/bonuses on rolls.
- No secret player rolls.
- No "reveal a previously private GM roll" mechanism.
- No integration with the character sheet's math engine or any specific check type (attack rolls, saves, etc. already have their own resolution paths elsewhere — this is purely a freeform utility roller).

---

## Verification

Live check, both roles: GM rolls privately (confirm players see nothing), GM rolls publicly (confirm players see it with correct breakdown), a player rolls (confirm it's public by default and the GM/other players see it). Confirm the breakdown display matches the actual random results rolled, not just that a total number appears.

## Sequencing

0 (confirm logging mechanism) → 1 (modal UI, can be built in parallel with 0 since the UI itself doesn't depend on the answer) → 2 (event + log wiring, depends on 0's findings for exactly how it plugs in).
