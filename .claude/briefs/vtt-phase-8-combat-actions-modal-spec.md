# VTT Phase 8 — Unified Combat Actions Modal

## Why

The mini-sheet's action rows (weapon attacks, spell slots/cantrips) live directly in the sidebar and will keep growing as more action types get added (healing, buffs, utility). Consolidate into a single **Combat Actions** entry point — a button that opens a modal or slideout with category tabs (Attack, Heal, and room for more later) — rather than the sidebar accumulating an ever-longer flat list.

This is a UI reorganization for the parts that already work (weapon attacks, damage spells — both live-verified) plus one genuinely new capability (healing someone else, which doesn't exist yet in any form). Keep those two threads separate in planning even though they land in the same modal — the Attack tab is low-risk rehoming of working code, the Heal tab has a real unknown at its center.

---

## 0. Design decision: ask intent, don't infer it — and what that simplifies

**Resolved, not just an open question**: rather than the system needing to know in advance whether a given action deals damage or heals (which would require categorizing every spell/item, and investigating whether `on_cast` can target someone other than the caster), the player picks intent at cast time — "Use Cure Wounds" → **[Attack] or [Heal]** → the roll happens, then applies as a negative or positive HP delta accordingly. "Attack" keeps today's full pipeline (to-hit/AC or save, `resolveSpellDamage()`, damage applied on hit). "Heal" skips the to-hit/save layer entirely — a heal always lands, same as an `auto`-resolution spell but adding instead of subtracting — and reuses the exact same roll → apply → broadcast plumbing already built and verified for Attack.

This removes the need to investigate whether `on_cast` can target someone else — the VTT's Heal path doesn't go through `on_cast` at all, it reuses Attack's own roll/apply pipeline with the sign and the to-hit check flipped off. The character sheet's own "Cast" button and its `on_cast`-driven self-healing stay completely untouched — two independent paths for two independent contexts (VTT combat targeting vs. sheet self-cast), same relationship `roll-attack` already has with `castCharacterSpell()` (reuses it for slot-spend, layers its own resolution on top).

**What's still a real prerequisite, narrower than originally scoped**: dice data. Phase 3 deliberately left `base_dice`/`scaling_json` unpopulated for pure-healing spells (Cure Wounds etc.) and never built any model for items at all. Both need it now:
- **Healing spells**: populate the existing `spell_definitions.base_dice`/`scaling_json` fields (already built, already Modifier-aware, already has an admin UI) for the healing spells you actually want available — no schema change, just data entry, same as Phase 3 Section 8's seeding.
- **Items/potions**: confirm whether any mechanical model exists for consumables at all before assuming a shape. If nothing does, the smallest version that works is a flat dice expression on the item (no scaling needed for a single "Potion of Healing," 2d4+2) — check first, don't assume it needs building from scratch.

**Report back what's actually there for items specifically** — that's the one open question left in this section; the `on_cast`-targeting question is no longer relevant given the intent-toggle approach.

---

## 1. Combat Actions modal/slideout — shell only

A single entry point (button in the mini-sheet, replacing the standalone action rows) opens a panel with category buttons across the top: **Attack**, **Heal**, and visual room for more (Buff/Support, Utility) even if only Attack and Heal have content this phase. Whether this is a true modal (blocks the map) or a dismissible slideout (map stays visible behind it) is a small implementation call, not a design fork worth gating on — pick whichever's less friction to build cleanly, both satisfy "get this out of the growing sidebar."

Clicking a category shows that category's available actions as a list — this list *replaces* what the sidebar currently shows inline, it doesn't duplicate it. Selecting an action from the list hands off to the existing arm → target → confirm → roll flow exactly as today; this section only changes how an action gets *selected*, not anything about what happens after.

---

## 2. Attack tab — rehome existing, verified flows

Populate from the same two sources already wired and already live-verified: `equippedAttackItems()` (weapon actions) and damage-resolution prepared spells (attack/save/auto per Phase 3). No behavior change to either — literally the same click targets, just listed under one tab instead of two separate sidebar sections.

**One new thing**: an always-available synthetic **Unarmed Strike** action, since it's not tied to any equipped item and currently doesn't exist anywhere in the data model. Flat, simple version is fine for this phase — 1 bludgeoning + STR modifier is the 5e baseline — implemented as a client-side or server-side constant action rather than needing its own database row, since it's identical for every character and isn't equipment-dependent.

**Verification**: live two-browser click-through — open the modal, Attack tab, confirm weapon actions and prepared damage spells both appear and both still resolve correctly through to damage applied. This should be low-risk given nothing about the underlying resolution changed, but per this project's own repeated lesson, confirm it live rather than assuming a UI rehome couldn't have broken the click wiring.

---

## 3. Heal tab — intent toggle on the shared roll pipeline

Any action with dice data behind it (weapon action, spell with `base_dice`, or a Section 0 item) can, in principle, go down either path — the modal doesn't need to pre-know which. Concretely:

1. Player picks an action (e.g. "Cure Wounds") from the modal.
2. Modal asks **[Attack] or [Heal]** before arming targeting.
3. **Attack**: unchanged, today's full pipeline — to-hit/AC or save, `resolveSpellDamage()`, damage applied on hit, nothing sent on a determined miss.
4. **Heal**: arms targeting the same way, but on confirm, rolls the same dice expression (`resolveSpellDamage()`'s dice-resolution half, without the to-hit/save layer — an heal always "hits"), and applies the result as a **positive** delta via the same `token:stat:update`/`delta` path damage already uses, capped at the target's `maxHp`.

No new authorization concept needed — a player healing an ally isn't more privileged than a player damaging an enemy, and both already run through the same server-enforced field/target checks.

**Overheal reporting — narrower than originally scoped**: per the separate `vtt-fix-restore-pc-hp-visibility.md` fix, PC HP is visible to all players again (only enemy/NPC HP stays hidden), so reporting the exact overheal amount for another player's healed token is **not** a leak — their HP was already visible before the heal. The leak concern (Phase 2/2.5's "never send the capped amount" lesson) only still applies to the unusual case of healing an enemy/NPC token — cap/suppress the exact number there, same as every other enemy-HP-related number already is. For any `pc` target, show the real number freely.

For items specifically: only relevant once Section 0 confirms what shape they actually take — but whatever that turns out to be, it should feed the same roll → intent-toggle → apply pipeline above, not a separate one.

---

## 4. Explicitly not this phase

Buff/Support and Utility categories — visual space is left for them in the modal shell (Section 1), but no content goes in them yet. No signal from actual play yet on what belongs there or how it should resolve (a buff doesn't have a "target takes damage" shape at all — it's closer to the conditions-toggle system that already exists than to Attack/Heal). Revisit once Attack and Heal are live and it's clearer what a third category actually needs to do.

---

## Sequencing

0 (item-model check + healing-spell dice seeding) → 1 (modal shell) → 2 (Attack tab, low-risk rehome) → 3 (Heal tab, intent toggle). 1 and 2 don't depend on 0 at all and can proceed immediately; only the items-specific half of 3 waits on 0's finding.

## Verification

Same discipline as every phase before this one: a live two-browser click-through is required before anything here is called done, not just automated/endpoint-level checks. Given this project's history of exactly this gap causing real confusion (Phase 2.5, the AC-discovery work, Phase 3 all needed manual confirmation before they could be trusted), don't let Phase 8 be the phase that skips it.
