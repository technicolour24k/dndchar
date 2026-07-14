# Modifier-Primacy Architecture - D&D Character Sheet Rewrite

**Status:** Confirmed design direction. Supersedes sections 2.13-2.19 of the original Migration Handover document for all matters concerning Modifiers, Effects, Items, Feats, and Actions.

**Relationship to the Migration Handover:** This document does not replace the handover. Sections on hosting, stack, campaigns, parties, version-history *storage mechanics*, and the general project philosophy in the handover remain in force. This document specifically replaces the conceptual model in 2.13 ("ingredients/cake"), 2.14 (Modifier vs Effect distinction), 2.15-2.17 (items/spells as assembly points, one-off actions), 2.18-2.19 (editor UI direction), and refines the version-history semantics described in 2.24/3.19/4.8.

**How this document came to exist:** It was developed through conversation, not handed down as a finished spec. Each decision below is recorded with the reasoning that produced it, and in several cases with the exact example that surfaced the issue, because the *why* matters as much as the *what* when this gets implemented or revisited.

---

## 1. Background - Why This Document Exists

The original Migration Handover described a five-box content model: Modifiers, Effects, Items, Feats, and Actions sat as related but distinct concepts, each with its own editor UI, its own data shape, and its own place in a "Modifiers | Effects | Rule Hooks (Advanced)" tab structure. Items were described as "assembly points" that could contain Passive Modifiers, Granted Effects, Granted Features, Granted Spells, Actions, and Resources/Charges as six separate attachable categories.

That model was workable, but it was a federation of related concepts rather than a single coherent one. While reviewing actual D&D Beyond homebrew item data as seed material for this project, a sharper observation emerged: **modifiers aren't one ingredient among several - they are the substrate underneath all of them.**

An attack isn't a thing that *has* modifiers attached to it. An attack basically *is* a small named bundle of modifiers (damage dice of a given type, a bonus to hit, a crit threshold) with a trigger condition wrapped around it. The same is true of a feat, an item's passive bonus, a spell's effect, and the rule that determines what counts as a critical hit for a given character. There is no separate rules-math vocabulary for "what an Effect does" versus "what an Action does" versus "what an Item grants" - there is only ever a change to some value, under some condition, from some source.

This reframing collapses several previously open questions from the handover in one move (see Section 7), and it is the controlling model going forward.

### 1.1 The triggering example

The real-world example that crystallised this was a piece of seed data pulled directly from the user's D&D Beyond homebrew:

> **Adamantine Ring of Precision** (Item, Very Rare, 2 charges, resets at Dawn)
> - *Enhanced Critical Hits*: When you score a critical hit with a melee weapon, roll an additional die of damage for the weapon's type.
> - *Luck*: Allows the wearer to reroll two d20 rolls per day.

D&D Beyond's own structured editor *partially* modelled this: "Enhanced Critical Hits" appeared as a real row in the item's Modifiers table (Modifier: *Damage - Melee Weapon Attacks*, Dice Roll: 1, Restriction: *On a critical hit*). But "Luck" did not - it lived only as prose in the description, with its *quantity* (2) captured structurally via the item's Charges field, but its *mechanic* (reroll a d20) not represented as a modifier at all.

The user then pointed out that the official 5e **Lucky** feat grants the same underlying mechanic - luck dice that let you reroll - just with a different count (3, rather than 2) and a different source. This was the moment the model clicked: these are not "an Item's bespoke ability" and "a Feat's bespoke ability" that happen to look similar. They are **the same Modifier definition** (`luck_dice`, parameterised by count), instantiated twice, from two different sources, with two different parameter values. Treating them as unrelated would mean re-implementing the same mechanic twice and missing the connection entirely - exactly the duplication the project has wanted to avoid since the original handover (handover §2.13, §6.3: "reduce the number of places and ways modifiers work").

---

## 2. The Core Model

### 2.1 Modifier - the only mechanical primitive

A **Modifier** is an atomic statement of the form:

> *For [target], change [value], when [condition holds].*

Examples, drawn directly from real content already in the project's scope:

| Modifier (informal) | Target | Operation | Value | Condition |
|---|---|---|---|---|
| Enhanced Critical Hits | Melee weapon damage | Add die | +1 die of weapon's damage type | On critical hit |
| Luck (ring) | d20 roll | Grant reroll | - | On use, limited by charges |
| Lucky (feat) | d20 roll | Grant reroll | - | On use, limited by charges |
| Crit on 18-20 | Crit threshold | Lower threshold | −2 | Always (or "while wielding X") |
| Action Surge | Action pool | Add | +1 action | Once per rest, on use |
| Haste's speed boost | Speed | Multiply / Add | ×2 or +X | While container active |

Critically: **a weapon attack is not a separate kind of entity.** It is a named bundle of modifiers - base damage dice, ability-modifier-to-damage, proficiency-to-hit - each of which is itself an ordinary Modifier. There is no parallel "Attack" mechanics engine; attacks are just a particular flavour of container (see 2.2) that happens to bundle damage- and to-hit-type modifiers together under a name.

A Modifier definition does **not** carry:
- Duration or lifecycle (belongs to the container - see 2.2)
- Cost (belongs to the container)
- Source/provenance of a *specific instance* (the definition is shared; the instance attached to a container carries the source)

A Modifier definition's **target** must be able to point at more than simple numeric stats. Confirmed target categories:
- Derived stats (AC, speed, saving throw bonus)
- Roll categories (melee weapon damage, ranged spell attack, a specific skill check)
- Discrete rules (crit threshold, advantage/disadvantage state on a category of roll)
- Character resource pools - including custom, non-5e pools. This explicitly includes the character's own **action economy** ("you get +1 action this turn" - Action Surge - is structurally the same kind of Modifier as a damage bonus, just targeting the action pool instead of a damage roll) and campaign-specific pools such as **Soulfire** and the newer **Vowfire** system.

### 2.2 Container - everything that is not a Modifier

Everything previously imagined as a peer of Modifier - Effect, Item, Feat, Action, Attack, Spell - collapses into a single concept, here called a **Container**. A Container is a named, described, sourced wrapper that grants one or more Modifier *instances*.

A Container carries:

- **Name and description** (flavour text, narrative content)
- **Source** - what grants it (an item, a feat, a class feature, a spell, a homebrew effect)
- **Activation type** - passive (always active while the container is active), triggered (fires when its condition is met, e.g. on crit), or active-use (consumes a cost when manually used)
- **Cost** - see 2.3
- **Duration / lifecycle** - see 2.4
- **One or more Modifier instances** - each instance is a reference to a Modifier definition plus the parameter values for this particular grant (e.g. `luck_dice` with `count: 2` for the ring, `count: 3` for the Lucky feat)

This means an Item, a Feat, a Spell, an Effect, and an Attack are not five different schemas - they are all the *same* Container shape, distinguished only by metadata (what kind of source they are, how they're triggered, what they cost), never by having a different mechanical vocabulary underneath.

### 2.3 Cost is structured, not a scalar

Because the project already anticipates costs beyond simple "uses your action" - multi-action costs (some future ability costing 2 actions), and multiple resource pools (Soulfire, the new Vowfire system) - cost on a Container must be a list, not a single number:

```
cost: [
  { pool: "action", amount: 1 },
  { pool: "vowfire", amount: 1 }
]
```

This also covers the project's existing custom action-economy model (4 actions per turn: 2 attacks, 2 utility - per the original handover's standing instruction) without needing a special case: "uses an action" is just `{ pool: "action", amount: 1 }`, exactly like any other resource cost.

### 2.4 Duration and lifecycle belong to the Container, not the Modifier

If duration lived on the Modifier itself, every modifier capable of being temporary would need duration-handling logic baked in, even when most instances of it are permanent (a +1 AC ring versus a temporary +1 AC from Shield). Duration is a property of *how this particular grant is currently active*, not of the underlying mechanic, so it belongs to the Container:

- A Container is either permanent (while equipped/known) or has a duration, tracked in rounds internally (per the original handover's existing decision, §2.21 - this is unchanged)
- On expiry, a Container's Modifier instances simply stop being active. The Container can optionally define an expiry side effect (e.g. Haste's lethargy on wear-off), which is itself just another Modifier instance that activates on the "expired" trigger.

### 2.5 Source and target-of-effect are independent

A Modifier instance's **source** (the Container/character that granted it) and its **target-of-effect** (the character it actually applies to) are tracked separately, and are *usually* the same character but not always.

This was confirmed specifically for menu-driven effects: some abilities (the worked example was Aurora's *Pulse of the Living Flame* / glyph-style mechanics from the existing Ascended Weapons design) present a choice - pick which party member receives a temporary buff - and that buff is then applied to a different character than the one who activated it. The design intent is:

- The triggering UI is a **menu**: the player picks from available modifier-bundles (where more than one mutually-exclusive option exists, as with Elemental Infusion's choice of damage type) and, separately, picks the target character.
- Once chosen, a temporary Modifier instance is created with `source: [originating container/character]` and `target: [chosen character]`.
- A live-update notification (via the existing Socket.IO direction from the handover, §2.7) informs the target character's client that a new temporary modifier has been applied to them.
- **Scope note:** the menu-and-targeting UI itself is in scope to build now (so the team can at minimum select an effect and a player and see that reflected), even though the full real-time delivery mechanism may be layered in incrementally per the handover's existing "realtime is additive, not a prerequisite" stance (§2.7, §4.10).

---

## 3. Stacking and Combination Rules

This is one of the two decisions most likely to silently produce wrong numbers if under-specified (the other being the container schema, which is why both were prioritised early in discussion).

### 3.1 Stacking behaviour is implied by operation type, not opted into per-modifier

The initial instinct was an optional "doesn't stack?" flag, checked per-modifier by whoever authors it. On reflection, this was refined: **the default stacking behaviour must be implied by the operation type itself**, because relying on every content author to remember to flag non-stacking interactions (e.g. two independently-authored homebrew items that both happen to grant advantage on the same roll type) is exactly the kind of silent-failure risk the project should not accept by default.

Confirmed default behaviours by operation type:

| Operation type | Default stacking behaviour |
|---|---|
| Advantage / Disadvantage | Net serially, **per roll-category bucket** (see 3.2). Multiple sources of advantage do not stack with each other; they simply mean "you have advantage." |
| Resistance / Vulnerability | Net serially, **per damage-type bucket** (see 3.2). |
| Flat numeric add/subtract | Sum normally. Multiple +1 AC sources add up. |
| Set (override to an exact value) | Most-restrictive or most-recently-applied wins - exact tie-break rule is an open question (see Section 6), but "set" does not sum with itself or with adds in the naive way. |
| Grant of a resource (e.g. luck dice, extra action) | Sums by count, since each instance is a discrete, countable grant - see the Lucky/ring example, where 2 + 3 luck dice from two sources is meaningfully different from "you have advantage twice." |

An optional **"doesn't stack with itself"** flag remains available on a Modifier definition for genuine exceptions outside these defaults (for example, a homebrew aura that should not combine with a second copy of the identical aura from a different source) - but it is the exception path, not the primary mechanism.

### 3.2 "Net serially" is scoped per-bucket, not globally

A specific risk was identified and resolved: netting advantage against disadvantage, or resistance against vulnerability, must be calculated **per relevant category**, not as one global counter across the whole character.

Worked example: a character can simultaneously have resistance to bludgeoning damage *and* vulnerability to fire damage. These do not net against each other - they are independent because they apply to different damage types. Only sources affecting the *same* bucket (the same damage type, the same roll category) net against each other.

Given that scoping, the confirmed rule is straightforward and correct for standard 5e semantics: within a single bucket, count sources, and net them serially (2 advantage + 1 disadvantage = net 1 advantage; 1 resistance + 1 vulnerability to the same damage type = net neutral). This is deliberately the simplest rule that produces correct 5e-standard results, and was confirmed as sufficient rather than an oversimplification.

---

## 4. Version History and Modifier-Definition Drift

This is the most consequential decision in this document, because it directly revises a claim made elsewhere in the project's history (handover §2.24, §3.19), and because it has a real, user-facing consequence that needs to be stated plainly rather than discovered during play.

### 4.1 The problem

Modifier definitions are shared, reusable, and **mutable** - the whole point of the modifier-primacy model is that `luck_dice` is one definition referenced by both the ring and the Lucky feat, and if the design changes (e.g. luck dice evolve from "reroll a d20" to "roll 2d20 and take the better, twice as powerful"), that change should propagate to everything that uses `luck_dice`, rather than requiring every container that references it to be hunted down and edited individually.

But the project also has a strong, explicitly stated commitment to comprehensive version history - "from first born to final death," not a small undo stack (handover §2.24, §6.11). Those two commitments are in tension: if a modifier definition can change, what does "restoring an old version of a character" actually mean?

### 4.2 The resolved rule: quantity/presence is historical, mechanics is current

The confirmed rule, stated precisely:

> **What a character had, and how many, is frozen at snapshot time. What that thing *does*, mechanically, is always resolved against the current live definition - never frozen.**

Concretely: a version snapshot of a character records, for each active modifier instance, which modifier *definition* it referenced and what parameter values applied (e.g. "luck_dice, count 3, source: Lucky feat"). It does **not** record the mechanical text or formula of `luck_dice` itself at that time. When that snapshot is later viewed or restored, the count and source come from the snapshot (historical), but what `luck_dice` actually does is resolved against whatever the live definition says *right now* (current).

Worked consequence, exactly as discussed: a player snapshot recorded "3 luck dice" back when `luck_dice` meant "reroll a d20." If the definition is later changed to mean "roll 2d20, take the better," restoring that old snapshot gives the player 3× "roll 2d20, take the better" - not 3× "reroll a d20." This is a deliberate, confirmed decision, not an oversight: **restoring an old version is time-travel for the character's state, not for the rules.** Given that this is a living homebrew system under active iteration, "what would this ability have done under rules we've since abandoned" is judged to be rarely, if ever, the useful question - the useful question is "what did this character have, and what does it do under our current understanding of it."

This explicitly **revises** the handover's §2.24/§3.19 framing, which described version history in terms that could be read as preserving the sheet faithfully across time in an absolute sense. It still does, for anything that hasn't had its underlying definition edited - the revision only narrows the claim for the specific case of shared modifier-definition drift.

### 4.3 Soft-delete only - modifier definitions are never destroyed

A direct consequence of 4.2: if a modifier definition is hard-deleted after being referenced by any historical snapshot, restoring that snapshot has nothing to resolve against. The confirmed resolution is that **modifier definitions are soft-deleted only.** A definition can be deprecated or hidden from use in new content, but it must never be permanently destroyed once it has been referenced anywhere, so that any historical reference always resolves against something live. This is consistent with, and an extension of, the project's existing general aversion to silent data loss.

### 4.4 Version-history review should distinguish two different kinds of "what changed"

Because restoring/reviewing a snapshot can now surface differences that have nothing to do with anything the *character* did, the version-history UI's diff/summary text should explicitly distinguish two categories, rather than presenting them as one undifferentiated list of changes:

1. **Character-state diffs** - what actually changed about this specific character between two saves: levelled up, equipped a new item, lost a resource, took damage. This is the diff most players expect and is computed snapshot-to-snapshot.
2. **Modifier-definition drift** - what has changed about a *shared* modifier definition since this snapshot was taken, independent of anything the character did. For example: "Note: 3 of the modifiers in this snapshot have since been redefined; the values shown reflect the current definitions, not what applied at the time this snapshot was saved."

This distinction matters because conflating them would make a player reasonably (but incorrectly) assume that a change in displayed behaviour reflects something they did, when it may instead reflect a DM-side homebrew edit made sessions later. Because the relevant comparison is "snapshot's recorded definition-reference vs. whatever the live definition is *now*," this diff text should be **generated at view time**, not precomputed and baked into the snapshot at save time - the project cannot know in advance which future definition edits will end up being relevant to a given old snapshot.

---

## 5. Worked Example - Walking the Whole Model End to End

To verify the model holds together, here is the Adamantine Ring of Precision and the Lucky feat expressed in the confirmed shape.

**Modifier definitions (shared, reusable):**

```
Modifier: crit_extra_damage_die
  target: melee_weapon_damage
  operation: add_die
  value: "1 × [weapon's damage type]"
  condition: on_critical_hit

Modifier: luck_dice
  target: d20_roll
  operation: grant_reroll
  value: (none - the reroll itself is the effect)
  condition: on_use, gated by container's charge cost
```

**Containers (sourced, instanced):**

```
Container: Adamantine Ring of Precision (Item)
  rarity: Very Rare
  activation_type: mixed (passive crit modifier + active-use luck dice)
  cost: { pool: "item_charges", amount: 1 per luck_dice use }
  charges: 2, reset: Dawn
  grants:
    - crit_extra_damage_die  (no parameters needed)
    - luck_dice, count: 2

Container: Lucky (Feat)
  activation_type: active-use
  cost: { pool: "feat_uses", amount: 1 per use }
  uses: 3, reset: long_rest
  grants:
    - luck_dice, count: 3
```

Both containers reference the **same** `luck_dice` modifier definition. A character with both the ring and the feat has two separate Modifier *instances* of `luck_dice` active - one with count 2 sourced from the ring, one with count 3 sourced from the feat - which, per Section 3.1 ("grant of a resource sums by count"), the character experiences as 5 total luck dice available, drawn from two pools with two separate reset conditions. Nothing about either container needed to re-describe what a luck die does; that lives in exactly one place.

---

## 6. Open Questions Carried Forward

These are explicitly unresolved and should not be treated as decided. They are narrower and more tractable than the open questions in the original handover, because the core model is now settled - these are implementation-detail decisions within that model.

- **Tie-break rule for "set" operations.** When two sources both try to *set* the same value (rather than add to it), which wins - most recently applied, most restrictive, or highest-priority source? Not yet decided.
- **Exact menu/targeting UI scope for the first pass.** Confirmed that the menu-and-target-selection flow should be built early enough to "echo out the effect and player," but the precise UI (party-member picker, confirmation flow, how it reads from the existing places/character data) is not yet designed.
- **Vowfire system integration details.** Vowfire is confirmed as a real, additional resource pool analogous to Soulfire, and costs must be able to reference it, but Vowfire's own rules (pool size, recharge, what it's narratively for) are a separate, not-yet-designed system - this document only commits to costs being able to *target* it generically.
- **Modifiers-about-modifiers / conditional suppression.** The original handover's "Rule Hooks (Advanced)" concept was proposed as an escape hatch for logic too complex for ordinary modifiers. Under modifier-primacy, most of what Rule Hooks was meant to cover is now handled by ordinary modifiers with conditions - but it has not been explicitly decided whether a modifier's *condition* is allowed to reference "does this character already have an active modifier of type X" (true conditional suppression/dependency between modifiers). A simple first pass - disallow this in v1, escape to a Rule-Hooks-style mechanism only if a genuine case demands it - was suggested but not formally confirmed.
- **Whether non-stacking exceptions need richer scoping than a boolean flag.** The "doesn't stack with itself" flag (3.1) is currently conceived as a simple per-definition boolean. Whether some future case needs something more granular (e.g. "doesn't stack with other instances from the same source category, but does stack across categories") has not been tested against a real example yet.

---

## 7. What This Resolves From the Original Handover

For traceability, this section maps the new model directly onto previously-open items from the Migration Handover, so it is clear what is now settled and what still stands.

- **Handover §2.13-2.17 (ingredients/cake metaphor, modifier vs effect distinction, items as assembly points, one-off actions as a distinct requirement)** - superseded. There is one ingredient (Modifier); everything else is a Container. "One-off actions" like "Heal 2d4+3" are not a separate Action entity - they are a Modifier (target: HP, operation: add, value: 2d4+3) wrapped in a Container whose activation type is active-use rather than passive or triggered.
- **Handover §2.18-2.19 (separate Modifier/Effect/Item editor UIs, "Rule Hooks (Advanced)" as a third tab)** - the underlying editor workflow (library → editor → attach/configure, three-column layout) likely still holds as a UI pattern, but the tab structure no longer needs to separate "Modifiers" from "Effects" as different kinds of content - they are both just Containers. This needs revisiting as an explicit UI redesign task, not assumed to carry over unchanged.
- **Handover §4.5 (spell grants from items - design details left open)** - partially resolved in shape: an item-granted spell is just a Container (the spell) referenced/granted by another Container (the item), which is structurally identical to how the Lucky feat and the ring both grant `luck_dice`. The remaining open questions from §4.5 (known vs. prepared vs. always-available semantics, slot vs. charge consumption, custom DC/casting-stat overrides) are still genuinely open - modifier-primacy clarifies the *architecture* of the grant, not the specific 5e-casting-semantics questions.
- **Handover §4.6 (generic action model)** - resolved. There is no separate action contract to design; an action is a Container with an active-use activation type, granting one or more Modifiers, with a structured cost.
- **Handover §4.2 (exact modifier vocabulary and stacking rules)** - substantially resolved by Section 3 of this document. The remaining gap is the "set" tie-break rule (Section 6).
- **Handover §4.4 (Rule Hooks implementation and safety)** - narrowed. Most of what Rule Hooks was meant to cover is now ordinary modifier logic. What remains for Rule Hooks, if anything, is the conditional-suppression case noted in Section 6 - a much smaller surface than originally scoped.
- **Handover §2.24/§3.19/§4.8 (version history requirements and storage design)** - the *storage mechanism* questions (snapshot vs diff vs event-sourced) remain open exactly as before. What this document adds is a firm semantic rule that did not previously exist: history snapshots are state-historical but mechanics-current, per Section 4.

---

## 8. Summary

Modifiers are the only mechanical primitive in the system. An Item, Feat, Spell, Effect, and Attack are all the same underlying shape - a named, sourced, costed Container that grants one or more Modifier instances - distinguished from each other only by metadata, never by mechanics. Stacking behaviour is implied by operation type and scoped per-bucket, not left to individual content authors to flag correctly by hand. Costs and durations belong to the Container, not the Modifier, because they describe how a particular grant behaves, not what the underlying mechanic is. Version history freezes what a character had and how much, but always resolves what that thing *does* against the live, current modifier definition - meaning history is a faithful record of character state, not a time machine back to old rules text - and because of that, modifier definitions must never be hard-deleted, only soft-deleted, so that old history always has something to resolve against.

This is the controlling architecture for all future content-modelling work on this project.
