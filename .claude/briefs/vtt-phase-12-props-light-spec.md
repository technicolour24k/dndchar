# VTT Phase 12 — Prop Tokens & Light Emission

## Why

Two related additions: a new token `type: 'prop'` for scenery with no combat stats (torches in sconces, braziers, glowing runes), and a light-emission field usable by *any* token (a PC carrying a torch is exactly as valid a light source as a prop one). The genuinely new mechanic here is **reveal-on-approach**: a light source's glow should be invisible to a player until that player's own vision already reaches the light's position — you don't see a torch's glow through darkness you haven't looked at yet, you only discover it once you're already looking there. This is a real addition to the vision-rendering model built for the map rework, not a simple radius bump, and deserves the same Section 0 rigor that rework got.

---

## 0. Audit — confirm before building

1. ~~**Confirm the exact shape of the layered vision architecture from the map rendering rework**~~ - **confirmed.** `updateMapLayers()` (`static/vtt-app/render/mapLayers.js:125-173`) loops the viewer's owned tokens (radii from `computeVisionRadii()`, `render/vision.js`) and pushes `{x,y,r}` entries into `colorEntries`/`grayEntries`, then syncs those onto two `<clipPath>`s via `syncClipCircles()` (`mapLayers.js:162-163`). A light source's circle is a new, third kind of entry into that same `colorEntries` array (never gray) - but because it's conditional per viewer (§2b), it can't just be another pass over the owned-tokens loop; it needs its own function, called after the owned-token radii are known, contributing extra `colorEntries` before `syncClipCircles(colorClipEl, ...)` runs.
2. ~~**Confirm token type handling**~~ - **confirmed: free-form string everywhere, no enum, no validation, client or server.** Server-side, `token.type` is only ever compared against literals (`'pc'`/`'enemy'`/`'npc'`) in `vtt/server/store.js:71` and `vtt/server/handlers/token.js` - nothing rejects an unrecognized value. Client-side, `static/vtt-app/index.html:343-346` (and a second `<select>` at 396-398, the Token Manager type filter) hardcode `<option>`s for pc/npc/enemy - adding `prop` is a markup addition, not a validation change. `render/tokens.js`'s `TYPE_COLOR` map falls back to gray for unknown types, so canvas rendering won't break even before `prop` is added there explicitly.
3. ~~**Confirm current move-authorization logic**~~ - **confirmed type-agnostic.** `canEditToken()` (`vtt/server/handlers/token.js:54-57`) is purely `meta.role === 'gm' || token.ownerId === meta.playerId`. A player-owned prop will be movable with zero new authorization code.
4. ~~**Confirm hidden-token filtering's exact mechanism**~~ - **confirmed still true post-map-rework.** `filterSessionForRole()` (`vtt/server/store.js:89-114`) drops any `token.hidden` token from the player-facing `tokens` map entirely before it's sent, and `broadcastToken()` (`vtt/server/handlers/token.js:176-184`) applies the same gate to every live event. A hidden light-emitting token's light genuinely never reaches players - the data isn't there to compute against.

**Extra findings, not asked for but load-bearing for Section 1** - the Dependency Note below asks whether Phase 10 actually built the Token Manager/Add Token form type-conditional per that spec's own Section 3d. Only partially true, with a real gap:
- `syncFieldVisibilityForType()` (`static/vtt-app/main.js:3118-3120`) exists as the intended hook, but today it *only* toggles the owner field's visibility for `pc`. None of the actual field-hiding Section 1 needs (hide HP/vision/speed for `prop`) is built yet.
- `readTokenFormFields()` (`main.js:3266-3283`) always includes `visionNormalFt`, `visionDarkFt`, `speedFt`, `ac`, `stats.hp/maxHp` in the object sent to the server, regardless of type. Building a prop today would put zeroed HP/vision/speed fields into the data model - exactly what §1 says must **not** happen. This function must become type-conditional too, not just the visibility toggle.
- **Token Manager's row list** (`tokenManagerRowsHtml`, `main.js:2754-2810`) and the **player's own-token sidebar card** (`ownTokenListHtml`, `main.js:3546-3581`) are both fully type-agnostic - every row/card unconditionally renders HP/AC/attacks/condition/speed/vision controls. Section 3d only asked for the *edit form* to be type-conditional; these two list/card renderers were never in scope for that ask, but a prop will appear in both once §1 lands (Token Manager per this spec's §3a explicitly listing "Prop" as a filter type; the owner's sidebar per §1's "movable by them"). These need type-conditional treatment too, added as part of §1 here, or a prop will show a nonsensical HP/AC/attack UI.
- Combat Actions access is already gated on `t.characterId` (`miniSheetHtml`, `main.js:3592`), not type - so it already implicitly excludes props by construction (they'll never have a `characterId`). No explicit type check needed for §1's "does not appear in the Combat Actions modal" requirement; this is incidental, not deliberate, but it satisfies the requirement as-is.

Aside: `docs/vtt-current-state.md` (the living state doc) stops at Phase 7 - Phases 8-11 were never folded in, so this audit read `main.js`/handler source directly rather than the doc. Worth updating that doc once this phase ships, covering the Phase 8-12 gap, not just Phase 12.

**Report findings before Section 2 (the reveal-on-approach mechanic) is built.**

---

## 1. Prop token type

Add `prop` as a valid `type` alongside `pc`/`npc`/`enemy`. A prop has:
- Position (`x`, `y`) — same as any token.
- Art — same upload/library mechanism as any token.
- Optionally `ownerId` — if set, that player can move it (per Section 0.3's findings, this should require no new authorization logic if move-checks are already ownership-based, not type-based).
- No HP, no vision stats, no speed — these fields should be **absent from the data model for a prop**, not just hidden in the UI with zero values sitting unused underneath.
- Does **not** appear in the Combat Actions modal (Phase 8) — it has no attack/heal actions, isn't a valid combat participant.

### 1a. Token Manager / Add Token form (Phase 10 dependency)

Per Phase 10 Section 3d, the Add Token/Token Manager form should already be built type-conditional. This phase is where that pays off: selecting `prop` as the type should hide HP/vision/speed fields entirely and show only art, position, optional owner, and the light-emission fields below. If Phase 10 wasn't built with this conditional structure, that's a blocker worth flagging rather than working around with a cluttered form.

---

## 2. Light emission — the reveal-on-approach mechanic

### 2a. Data model

Any token (not just props) can carry `lightEmitting: boolean` and `lightRadiusFt: number` (e.g. 10 or 20, per 5e torch/lantern conventions — expose as a plain number field, not a preset dropdown, so it's not locked to specific item types).

### 2b. Per-viewer conditional rendering — the core new logic

Unlike a token's own vision circles (always active for its owner, unconditionally), a light source's contribution to the **color** layer's clip-path is **conditional per viewing player**:

- For a given viewing player, a light-emitting token's circle is only included in that player's clip-path computation if the light source's position currently falls within that same player's own vision reach (their own tokens' normal or dark vision radius, from the existing per-owner circle set).
- If the light source is outside the viewer's own vision reach, it contributes nothing to that viewer's rendering — not a dimmed version, not a partial reveal, nothing.
- Once revealed (light source's position enters the viewer's own vision reach), the light's full `lightRadiusFt` circle becomes an additional color-layer clip contribution for that viewer — extending their visible color area beyond their own vision circle, for as long as the light source remains within their vision reach.

This means the light-clip computation must be **recalculated per viewer, on every token-move event** (either the light source moving, or the viewer's own token moving) — not a static, shared addition to the map the way the base vision circles are. Given light-source counts are typically small (a handful of torches/props at most, not dozens), this is cheap arithmetic (distance checks), not a performance concern — but it is genuinely new logic, not a variant of existing logic, and should be implemented as its own clearly-named function rather than folded silently into the existing per-owner circle assembly.

**Trigger condition, precisely**: a light source is "revealed" for a viewer once the light source's **center position** falls within that viewer's current vision reach (their vision circles' union, at whichever band — normal or dark — currently extends far enough). Don't build partial/edge fuzziness (e.g. "half-visible" glow) — it's binary: within reach, fully contributes; outside reach, contributes nothing.

### 2c. Simplifications, on purpose

- **No dim-light nuance.** 5e's real rules distinguish bright light (full color, no penalty) from dim light (lightly obscured, still colored). This phase doesn't model that distinction — a light source simply extends the color-band radius, full stop, no separate dim-band rendering. If this needs refining later based on actual play, it's an addition, not a redesign of what's built here.
- **Hidden light sources don't propagate**, per Section 0.4's confirmed limitation — a GM-hidden creature carrying a torch won't cast light for players, since the token (and thus its light data) is never sent to them at all. Known, accepted limitation, not a bug to fix in this phase.
- **No falloff/gradient** — light radius is a hard-edged circle, same treatment as vision circles already get. Softer falloff is a cosmetic refinement, not core to the mechanic.

---

## 3. What's explicitly not this phase

- Multiple overlapping light sources with any special interaction (e.g. combined brightness) — each light source's circle just independently contributes to the clip-path union; overlapping lights behave exactly like overlapping vision circles already do (the union just covers more area), no new logic needed there specifically.
- Light sources affecting anything other than the color-layer clip-path (e.g. no interaction with fog-of-war painting, since manual fog doesn't exist per the earlier map-rework audit).

---

## Verification

Live check, both roles: place a lit prop (or a player-owned light-emitting token) in a spot no player's vision currently reaches — confirm no player sees any glow. Move a player's token toward it — confirm the light "switches on" for that player only once their own vision circle reaches the light's position, not before. Confirm a second player whose vision hasn't reached it still sees nothing, even though the first player now does (fully per-viewer, not shared). Confirm a hidden light-emitting enemy token still doesn't propagate light to players, consistent with existing hidden-token behavior. Confirm a player can move a prop they own (a carried torch) and that its light-reveal recalculates correctly as it moves. Confirm prop tokens don't appear in the Combat Actions modal.

## Sequencing

0 (audit, all four findings reported) → 1 (prop token type + form) → 2 (light emission — the real work, depends on 1 existing for props specifically, though the light fields themselves work on any token type per 2a).

## Dependency note

This phase assumes Phase 10's Token Manager/Add Token form was built type-conditional (per that spec's Section 3d) — confirm that's actually true before starting Section 1 here, since building it retroactively mid-Phase-12 is exactly the kind of rework Phase 10 was asked to avoid causing.
