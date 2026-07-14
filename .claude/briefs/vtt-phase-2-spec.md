# VTT Phase 2 — Technical Spec

## Context & scale

This builds on the POC covered by `vtt-poc-spec.md` and audited in `vtt-current-state.md` (2026-07-14). Read both first — this doc assumes the POC's session model, event pattern (`validate → mutate → broadcast (filtered)`), and filtering approach (`filterSessionForRole`) as given, and only calls out where Phase 2 changes them.

**Intended scale**: a trusted group, under 10 people, using this roughly monthly. This is not being built for public/anonymous use, and nothing here should assume otherwise. However, code should be *shaped* the way it would be for wider use — clean separation between "what a client claims" and "what the server trusts," a real filtering layer, explicit field-level authorization — without actually *building* the infrastructure wider use would need (rate limiting, real authentication hardening, horizontal scaling, abuse handling). The goal is "no rework needed later," not "build it now." If a decision would take meaningfully longer specifically to support scale nobody's asked for, don't make it.

Concretely: keep in-memory session state, keep the current WS trust model (client states its `playerId`/`role`, server believes it — same posture as the POC), don't add persistence unless a specific Phase 2 feature needs it. Do add per-field authorization and GM-claim enforcement (below) — those aren't scale work, they're closing gaps that matter the moment real combat math runs through the same event a player's client sends.

---

## 0. Foundations — do first, before anything else in this doc

Two gaps identified in the current-state audit become load-bearing once combat actions (Section 3) write real game state through player-originated events. Both are small; do them before Section 3 work starts, not after.

### 0a. Field-level authorization on `token:stat:update`

Currently: `canEditToken` checks ownership only — an owning player can write to *any* field on their own token, including ones that should stay GM-controlled.

Add an explicit allowlist of fields a player may write to their own token, distinct from fields only the GM may write even on that same token:

```js
// vtt/server/handlers/token.js
const PLAYER_EDITABLE_FIELDS = new Set(['speedRemainingFt', 'visionNormalFt', 'visionDarkFt', 'x', 'y']);
const GM_ONLY_FIELDS = new Set(['hp', 'maxHp', 'defeated', 'condition', 'stats']);

function isFieldEditAllowed(role, isOwner, field) {
  if (role === 'gm') return true;
  if (!isOwner) return false;
  return PLAYER_EDITABLE_FIELDS.has(field);
}
```

Reject (don't silently drop) a `token:stat:update` for a disallowed field with an error event back to the sender, so a legitimate client bug is visible instead of silently no-opping.

**Why now**: combat actions (Section 3) will have player clients sending `token:stat:update` for HP changes on *enemy* tokens (their attack landing). That's a deliberate exception to "players write their own tokens only" — it needs to go through a distinct, narrower path (see 3b) rather than loosening `canEditToken` generally. Get the allowlist in place first so that narrower path has something to plug into.

### 0b. Enforce single-GM claim

Currently: `gmSocketId` is set once and never checked again — a second client sending `join` with `role: 'gm'` gets full GM broadcast rights on an already-claimed session.

Fix: if `session.gmSocketId` is already set and belongs to a still-connected socket, reject a second `role: 'gm'` join with `join:error` / `reason: 'gm_already_claimed'`. If the existing GM's socket has disconnected (see 0c), allow reclaim.

### 0c. Clean up on socket disconnect

Currently: a disconnected player stays in the sidebar list indefinitely and still "owns" their tokens; a departed GM leaves `gmSocketId` stale.

On socket close: mark the player as disconnected (don't delete outright — they should reappear correctly on reconnect, same as the POC's existing reconnect path) and broadcast a `player:left` event so other clients can reflect it in the UI. If the departing socket was the GM, clear `gmSocketId` so 0b's reclaim logic can pick up a new GM.

---

## 1. Character Sheet Pull-Through

The dependency for both "clickable token info" and "combat actions knowing what's available" — sequence this first among the feature work.

### 1a. Character combobox on VTT entry

When a player joins a session, before (or alongside) placing a token, show a combobox populated from their existing characters in the main app (however characters are currently listed/queried there — reuse that, don't build a parallel character list). Selecting a character is what creates their token, pre-populated per 1b below, rather than the player manually typing stats into a blank token as the POC currently requires.

Server-side: this needs a read endpoint the VTT client can call — `GET /vtt/api/characters` (SvelteKit route, reuses the existing authenticated session, same pattern as `api/session/+server.ts`) returning the logged-in user's characters in a minimal shape (id, name, portrait if available). Keep this endpoint read-only and scoped to "characters belonging to the logged-in user" — no cross-user lookup needed at this scale.

### 1b. Populate token fields from sheet data on creation

When a token is created from a selected character, pull:
- `hp` / `maxHp` — current values from the sheet
- `speedFt` (and reset `speedRemainingFt` to match)
- `visionNormalFt` / `visionDarkFt` — derived from feats/race (see below)

**Feat → vision field translation**: don't have the VTT parse feat text at render time. Instead, at token-creation time, translate known feats into the corresponding token field — e.g. a character with Darkvision sets `visionDarkFt` to the appropriate range (60ft is standard, but pull the actual value if the sheet stores one) at creation. This is a small explicit mapping table (`featEffects.js` or similar), not a general rules engine — add entries as you hit feats that matter for VTT purposes, not proactively for every feat in the book. Sharpshooter and similar combat feats don't need a *token field* yet, since they don't currently affect the VTT's visual/vision state — they'll matter once the mini-sheet (Section 2) surfaces available actions, at which point they inform what shows up there instead.

**Re-sync note**: for Phase 2, pulling sheet data happens once, at token creation. If a player's sheet changes mid-session (leveling, a feat added), the token doesn't auto-update — that's an acceptable Phase 2 limitation, not a bug to fix now. Note it as a known limitation in whatever current-state doc follows this phase, rather than silently letting people assume it's live-synced.

---

## 2. Mini Character Sheet In-VTT

A panel (sidebar or modal) showing, for the player's own token(s):
- Combat stats: AC, current HP / max HP, saves
- Available actions (attack options, tied to equipped weapons)
- Spell slots remaining, prepared spells (if the character is a caster)

This is a **read/display surface plus a trigger point**, not a second copy of the character sheet's math engine — it displays values pulled the same way as Section 1b, and *initiates* combat actions (Section 3) rather than resolving them itself. Resolution (the actual damage math, save DCs, etc.) should call into the same math engine the main character sheet uses, not a VTT-local reimplementation — if that's not cleanly callable from the VTT's context yet, that's the actual blocker for this section, worth checking before starting rather than discovering mid-build.

HP shown here is the player's own real number (this is their own token, not an enemy's — Section 5's enemy-hiding rule doesn't apply to a player's own data).

Keep this panel's own state (which spell's selected, which action's expanded) as local UI state, not synced across clients — only the *results* of an action (damage applied, a slot consumed) need to go out as the existing `token:stat:update` event.

---

## 3. Combat Actions & Targeting

### 3a. Target selection

A thin pass-through, as anticipated in the original spec: `target:select` broadcasts a token ID (or set of IDs, for AoE) to the room so all clients can render a highlight. No new server-side model — server validates the sender is a connected participant and rebroadcasts, same shape as any other event in the current pattern.

```json
{ "type": "target:select", "sourceTokenId": "token-1", "targetTokenIds": ["token-5", "token-6"] }
```

Clear selection with `target:clear` (or a `targetTokenIds: []` payload — pick whichever's less fiddly to implement given the existing render loop).

### 3b. Applying results (attack/damage/heal)

This is the piece that needs the narrower authorization path flagged in Section 0a. A player's client is now allowed to send `token:stat:update` affecting an *enemy* token's `hp` — something the current ownership check would reject outright. Rather than loosening ownership checks generally, add a distinct, narrower allowance:

- A player may update `hp` on a **non-owned** token only when that token is currently a valid target (i.e. present in a `target:select` the same player most recently sent, or within some short time window — pick whichever's simpler to implement correctly) — not arbitrary.
- The update is still filtered exactly as today: the *result* (new HP) is never sent back to any player, including the one who caused it (Section 5's existing enemy-hiding rule already covers this — worth explicitly re-verifying it still holds once this path exists, since it's new enough to be worth a manual check rather than assuming).
- `defeated`/`condition` stay GM-only regardless of targeting (per 0a) — a player's attack can reduce HP, but doesn't itself flag a kill. The GM decides that, on their own timeline, same as the original spec's intent.

Whether the actual damage number is computed client-side (player's mini-sheet does the math, sends the result) or server-side (player sends "I attack with X," server computes) is a real design choice worth deciding explicitly rather than defaulting into one: client-side is simpler and matches "the character sheet's math engine already runs client-side," but means trusting the client's arithmetic (acceptable at this trust level/scale, per the framing at the top of this doc) — server-side is more correct but means porting damage math server-side, which is a bigger lift than this phase probably warrants. **Recommendation: client-side**, consistent with the scale this doc opens with — revisit only if this group's actual usage ever surfaces a reason not to trust it.

---

## 4. AoE Shape Types

Extends the existing `marker.js` / `markers.js` — new shape types on the existing collection, not a new system.

### 4a. Shapes to add

- **Cone** — origin point, direction (angle), length, cone angle (60° is 5e-standard; make it a parameter, not hardcoded, since exact rules vary by spell)
- **Cube/cuboid** — origin, size, rotation
- **Sphere/burst** — functionally a circle anchored to an arbitrary placed point rather than a token (distinct from the existing radial vision/movement circles, which are always token-anchored) — this is the cheapest of the three to add, since it reuses existing circle math with a different anchor

### 4b. Shared shape-intersection utility

Build `getTokensInShape(shape, tokens)` as a standalone function (not embedded in render code) returning which token centers fall inside a given shape. This is the piece that serves two purposes:
- Rendering which tokens are visually caught by a placed AoE marker (immediate, this phase)
- Feeding `target:select` (Section 3a) automatically when an AoE is placed, rather than requiring manual multi-select — worth wiring this up in this phase too, since the utility exists either way and manual multi-target-select for a 5-enemy fireball is exactly the kind of friction the whole VTT project is trying to remove

### 4c. Rotation UI

Cone and cube both need a facing/rotation control the existing circle-only marker tool doesn't have. Simplest approach: place the origin with a click, then drag to set direction/rotation before confirming placement (drag distance can also set cone length, if that's not fixed per-spell). Doesn't need to be fancier than that for this phase.

---

## 5. Sequencing

1. **Section 0** (foundations) — small, do first, nothing else in this doc should build on the current unpatched behavior.
2. **Section 1** (character sheet pull-through) — unlocks real data for both 2 and the token-info-click feature discussed but not detailed in this doc (that one's largely UI work once real data exists — a details panel on token click, reusing the same data Section 1 pulls — and doesn't need its own spec section).
3. **Section 2** (mini sheet) — depends on 1.
4. **Section 3** (combat actions/targeting) — depends on 1 (needs available actions/spells) and 0a (needs the narrower authorization path).
5. **Section 4** (AoE shapes) — independent of 1–3, can be built in parallel by anyone not blocked on character-sheet data, and its shape-intersection utility feeds back into 3a once both exist.

---

## Notes for whoever picks this up in Claude Code

- Same event-pattern discipline as the POC: every new capability should be a small event through the existing `validate → mutate → broadcast (filtered)` handler shape, not a bespoke subsystem. Section 3 in particular is a strong temptation to over-build (a "combat engine") — resist it; it's meant to be a thin layer over existing events plus one authorization change.
- Scale reminder from the top of this doc: don't add auth hardening, persistence, rate limiting, or anything else load-bearing for public/scaled use as part of this phase. The two foundation fixes in Section 0 are about correctness (a player shouldn't be able to self-buff HP, a session shouldn't silently gain two GMs), not about defending against hostile actors — the trust model stays the same as the POC.
- Produce an updated "current state" doc (same format as `vtt-current-state.md`) at the end of this phase, same as before.
