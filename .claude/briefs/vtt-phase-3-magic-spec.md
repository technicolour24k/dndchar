# VTT Phase 3 — Magic

**Supersedes `vtt-phase-3-spec.md` and `vtt-phase-3-kickoff.md` — use this file going forward, those two can be archived.** Nothing technical changed from those drafts; this just consolidates them into one file and makes the scope boundary explicit: **Phase 3 is magic/spells only.** The "modular widget" question raised alongside this was resolved as *no rearchitecture needed* (see Convention, below) — it doesn't get its own phase, because there's no separate deliverable, just a discipline to hold to while building this one.

---

## 0. Close-out (Phase 2.5, not Phase 3 — do this first)

Not new work. Phase 2.5's spec asked for a real two-browser click-through of the attack flow and that never happened — everything since has been verified via automated/headless checks only. Phase 3's spell-casting explicitly reuses that flow, so confirm it actually works before building on it.

**Done when**: two browser tabs (GM + a player with an equipped weapon), attack an enemy token, and the whole visible sequence works — arm → target ring → confirm card → Attack button → roll breakdown → hit/miss → damage applied → attacker still can't see the enemy's real HP. If this surfaces a bug, fix it now; cheaper than finding the same bug twice, once here and again in the spell path.

---

## Convention: shared logic, not shared UI

Resolved discussion, not a task: "modular widget" means single source of truth for *behavior/data*, not rendered markup. This project already has that pattern working (`src/lib/rules/dnd5e.ts` — pure functions for AC, speed, vision, spell save DC/attack bonus — called directly by the Svelte sheet and via API routes by the vanilla-JS VTT). No new build tooling, no custom elements.

**What this means for Phase 3 specifically**: `resolveSpellDamage()` (Section 2 below) goes in `dnd5e.ts` alongside the existing functions, not written inline in either surface. That's the only actionable instruction here — everything else is already-established practice.

**Worth an explicit check while in there**: this project has hit the same bug shape three times (`imageUrl`, `speedFt`, and the `equippedItems`/`equippedAttackItems` mixup all missed being added to a shared list/filter). If Phase 3 introduces any new player-editable field (e.g. for spell slot consumption), check it against `PLAYER_EDITABLE_FIELDS` explicitly rather than assuming coverage.

---

## Core (this is what "Phase 3 done" means)

### 1. Confirm the spell data schema surface

Research/decision, not code. Check where spell content lives (`content_definitions`/`character_content_instances`) and whether an existing admin surface already supports editing spell fields, the way `/admin/rules/*` does for modifiers. Spell damage is a property of the spell itself, not a character-stat modifier — don't assume the vision-field precedent (`021_vtt_vision_targets.sql`, a new `modifier_targets` row) applies here without checking; it solved a different kind of problem.

**Done when**: you know whether damage fields are new columns/JSON on an existing table (and how they'd be authored) or whether hand-seeding the specific spells your group uses is the pragmatic path at this scale.

### 2. Build the damage model + resolution function

`resolveSpellDamage(spell, { castAtSlotLevel, casterLevel })` in `dnd5e.ts`. Per spell: `resolution` (attack/save/auto), `damageType`, `baseDice`, and a `scaling` shape — cantrip (`extraDice` + tiers at character levels 5/11/17) or leveled-spell upcast (`extraDicePerSlotLevel`, nullable for spells that don't scale with upcasting). Full detail in the original `vtt-phase-3-spec.md` Section 1 — copy that section's field definitions verbatim, they don't need rework.

**Done when**: a cantrip resolves the correct dice count at caster levels 1/5/11/17, and a leveled spell resolves correctly cast at base level vs. upcast two levels, checked against hand-computed values.

### 3. Wire single-target spells into the attack flow

Extend the mini-sheet's prepared-spells list (currently display-only) to be clickable like weapon actions — pick a slot level if upcastable, arm targeting, click a target, resolve via `resolveSpellDamage()`, apply through the existing `target:select` → `token:stat:update`/`delta` path from Phase 2.5. Save-based spells need a lightweight "type in the target's save result" prompt, since players can't see each other's rolls today (this is a UX detail worth a gut-check once it's in front of you, not a hard requirement to get perfect first try).

**Done when**: casting a damage cantrip on an enemy token in a live session resolves and applies correctly, hit and miss both.

### 4. Seed the spells your group actually uses

Data entry, not architecture. The ~10-15 spells your players actually have prepared, damage formulas filled in via whatever Section 1 determined. Skip the rest of the spell list — no need to seed spells nobody's using.

**Done when**: those specific spells work end to end in a live session.

---

## Optional / stretch (independent of Core and each other — pick up in any order, or skip)

### 5. Click-any-token read-only info panel
Reuses `miniSheetHtml()` in a read-only mode for any token, not just owned ones. Respects existing filtering exactly as-is (no `stats` for enemy/npc, no raw HP for non-owned PC tokens) — purely client-side rendering of data already received, no new server work. Full detail in the original spec's Section 3.

### 6. AoE spells (Fireball etc.)
Reuses the existing marker/AoE-placement + `getTokensInShape()` auto-targeting system from Phase 2 — a spell just needs an `areaShape` field (circle/cone/cube + size), then damage resolves per-target the same way as Core Item 3. Full detail in the original spec's Section 2b.

---

## Explicitly not this phase

**Music.** No dependency on anything above, no phase number needed — write up `music:play`/`music:stop` as a thin broadcast event whenever tracks are actually picked.

---

## Order

0 (close-out) → 1 → 2 → 3 → 4. Items 5 and 6 can slot in anywhere after 0, including in parallel with Core if someone's free — neither depends on the magic system at all.
