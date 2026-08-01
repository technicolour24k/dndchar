# VTT Phase 10 — Map Reveal/Hide + Token Manager

## Why

Two features bundled together on purpose, not just adjacent — they're the same workflow. A GM preps a map, hidden from players, and populates it with tokens via a manageable list rather than the current sidebar-per-token clutter; only once everything's arranged does the map (and whatever's on it) become visible. Testing one properly basically requires the other, so build and verify them together.

---

## 0. Prerequisites — confirm before building

- **Where does map data live in session state today**, and how does `map:set` currently reach players — is it part of `state:full`/broadcast unconditionally, or is there already any gating mechanism worth reusing? Confirm the exact shape before adding a `revealed` field.
- **Confirm `filterSessionForRole` (or whatever the current single filtering chokepoint is called) is still the one place all player-facing filtering happens.** This phase adds a new gate to that same function — don't introduce a second filtering path.
- **Confirm the Add Token form/modal's current structure** (already converted to a modal per an earlier fix) — the Token Manager reuses this exact form for editing, pre-filled, so its fields and validation need to be understood before extending it to an edit mode.
- **Confirm today's grid-size default value and where it's set** (currently 50) before changing it to 96 — should be a one-line default change, confirm it's not hardcoded in more than one place.

---

## 1. Map reveal/hide

### 1a. Data model

Add `revealed: boolean` (default `false` for a newly-set map — a GM should have to explicitly reveal, not have it default-open) to the map object in session state.

### 1b. Filtering — a hard gate, not an independent rule

When `map.revealed === false`, players receive **nothing map-related** — no map image/video URL, no tokens, no markers, nothing on that map — regardless of any individual token's own `hidden` flag. This is a short-circuit ahead of all existing token-level filtering, not a parallel rule: a non-hidden PC token still shouldn't render for players while the map itself is unrevealed, because there's nothing to render it onto. The GM's own view is entirely unaffected by this flag — they always see everything, exactly as today.

Practically: in `filterSessionForRole`, check `map.revealed` first for the `player` role branch; if false, return an empty/placeholder map state (no tokens array, no map URL) before any other filtering logic runs.

**What players see while unrevealed**: a clear "waiting for the GM" state, not a blank broken screen — something honest about what's happening, not an empty canvas that looks like an error.

### 1c. Reveal/Hide control

One toggle button (not buried in a settings modal — see Section 2's framing), always visible to the GM in the main toolbar. Clicking it flips `map.revealed` and broadcasts the resulting full (now-filtered-for-players) state. Same button does both directions — "Reveal Map" when hidden, "Hide Map" when revealed, label reflecting current state.

### 1d. Interaction with combat/targeting

While unrevealed, players have nothing to interact with (no tokens rendered, nothing to click) — no separate authorization check needed beyond what filtering already prevents; a player can't target a token they were never sent.

---

## 2. Map Settings modal

Wrap the existing map upload/dimensions/grid-size/brightness fields (currently inline in the sidebar) into their own modal, following the same pattern as Add Token's earlier conversion. **Explicitly exclude Reveal/Hide from this modal** — that stays a persistent one-click toolbar control per 1c, since it's used far more frequently than "set once per map" fields like dimensions or grid size.

While here: change the default grid size value from 50 to 96 in this form. Only affects newly-created maps — existing maps keep whatever grid size they were already set with, no migration needed.

---

## 3. Token Manager modal

### 3a. Structure

A modal listing every token in the current session — searchable/filterable by type (PC/NPC/Enemy, and Prop once Phase 12 lands) and probably by name. Selecting a token from the list opens the **same form Add Token already uses**, pre-filled with that token's current values, in edit mode rather than create mode. This is a direct application of the project's established "shared logic/shared form, not a second UI" convention — don't build a separate edit form.

Given the stated pain point is specifically 20+ token clutter, the list should support at minimum:
- Grouping or sorting by type (all PCs together, all enemies together, etc.)
- Some indication of state at a glance (defeated/condition badge, matching what's already shown elsewhere)

### 3b. Save to catalog

An option on the edit form: "Save to catalog." This should **prompt for a name** rather than silently overwriting the original catalog entry it may have been loaded from — a goblin that's taken damage mid-session and had its name customized shouldn't silently become the new default "Goblin" template. Default the prompt to the token's current display name, but require confirmation before writing.

### 3c. Bulk actions (worth including, not explicitly asked for)

Given the stated problem is specifically about clutter after throwing "multiple enemies in the mix," a multi-select + bulk-remove action (for post-combat cleanup of defeated enemies) is the natural extension of this modal's actual purpose. Not mandatory for a first pass if it adds meaningful time, but flagged because it's the exact pain point motivating this phase, not scope creep.

### 3d. Forward-compatibility with Phase 12 (props)

The edit form should already be built to be **type-conditional** — fields shown depend on the token's `type` (a `prop` token, landing in Phase 12, won't need HP/vision/speed fields at all, and will need a light-emission toggle that other types won't). Don't hardcode the form to only understand `pc`/`npc`/`enemy` in a way that requires rework when Phase 12 adds `prop` — structure the field-rendering logic to key off `type` from the start, even before `prop` exists as an option.

---

## Verification

Live, both roles: GM sets a new map (defaults to unrevealed), confirm players see a clear waiting state, not a broken/blank screen. GM opens Token Manager, adds several enemies via the reused form while map is still unrevealed, confirms players still see nothing. GM hits Reveal — confirm players now see the map and every token that isn't individually hidden, in one update. GM hides again mid-session — confirm players immediately lose visibility. GM edits an existing token via Token Manager and saves to catalog under a new name — confirm the original catalog entry is unchanged and a new one exists. Confirm grid size defaults to 96 on a freshly created map, and that an existing map's grid size is untouched.

## Sequencing

0 (prerequisites) → 1 (reveal/hide, since it's the smaller and more isolated of the two) → 2 (Map Settings modal, small, can slot in alongside 1) → 3 (Token Manager, the larger piece, verified together with 1 per the shared workflow described in Why).
