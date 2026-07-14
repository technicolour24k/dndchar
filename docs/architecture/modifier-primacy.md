# Modifier-Primacy Architecture - D&D Character Sheet Rewrite

**What this document is:** a definition of the target data model and rules engine for this project - Modifier, Container, stacking, version history, and the rules that follow from them. It states what the system *should be*, at all times, in flat present tense. It makes no claims about what currently exists in any codebase.

**What this document is not:** a record of implementation progress. For that, see `docs/architecture/modifier-primacy-status.md`, which tracks how far the actual repository is from this specification at any point in time, and is expected to be regenerated periodically as the codebase changes. If the status document and this one ever appear to disagree about what the target model *should be* (as opposed to what's built), this document wins - the status document only reports distance to the target, it never redefines the target.

**Relationship to the Migration Handover:** this document does not replace the handover. Sections on hosting, stack, campaigns, parties, version-history storage mechanics, and general project philosophy in the handover remain in force. This document replaces the handover's conceptual content model - the "ingredients/cake" framing, the Modifier/Effect distinction, items-as-assembly-points, separate editor UIs per content type - and refines the version-history semantics described there. See Section 9 for the full mapping.

---

## 1. Background - Why This Model Exists

A character-sheet content model needs to represent items, feats, spells, class features, conditions, and attacks. The most natural first instinct is to treat these as related but distinct kinds of thing, each with its own data shape and its own editor - Modifiers, Effects, Items, Feats, and Actions as five separate, federated concepts.

That instinct is wrong for this project. **Modifiers aren't one ingredient among several - they are the substrate underneath all of them.**

An attack isn't a thing that *has* modifiers attached to it. An attack basically *is* a small named bundle of modifiers (damage dice of a given type, a bonus to hit, a crit threshold) with a trigger condition wrapped around it. The same is true of a feat, an item's passive bonus, a spell's effect, and the rule that determines what counts as a critical hit for a given character. There is no separate rules-math vocabulary for "what an Effect does" versus "what an Action does" versus "what an Item grants" - there is only ever a change to some value, under some condition, from some source.

### 1.1 The canonical worked example: Luck

The clearest illustration of why this matters is a single mechanic appearing in two unrelated places: a homebrew magic ring grants "reroll two d20 rolls per day," and the official Lucky feat grants "reroll three d20 rolls, regain on a long rest." These are not "an Item's bespoke ability" and "a Feat's bespoke ability" that happen to look similar. They are **the same Modifier definition** (`luck_dice`, parameterised by count), instantiated twice, from two different sources, with two different parameter values and two different reset conditions. A model that treats them as unrelated re-implements the same mechanic twice and misses the connection entirely - the project's standing goal is to minimise the number of places and ways a modifier can work, not multiply them.

---

## 2. The Core Model

### 2.1 Modifier - the only mechanical primitive

A **Modifier** is an atomic statement of the form:

> *For [target], change [value], when [condition holds].*

Examples:

| Modifier (informal) | Target | Operation | Value | Condition |
|---|---|---|---|---|
| Enhanced Critical Hits | Melee weapon damage | Add die | +1 die of weapon's damage type | On critical hit |
| Luck (ring) | d20 roll | Grant reroll | - | On use, limited by charges |
| Lucky (feat) | d20 roll | Grant reroll | - | On use, limited by charges |
| Crit on 18-20 | Crit threshold | Lower threshold | −2 | Always (or "while wielding X") |
| Action Surge | Action pool | Add | +1 action | Once per rest, on use |
| Haste's speed boost | Speed | Multiply / Add | ×2 or +X | While container active |

A weapon attack is not a separate kind of entity. It is a named bundle of Modifiers - base damage dice, ability-modifier-to-damage, proficiency-to-hit - each of which is itself an ordinary Modifier. There is no parallel "Attack" mechanics engine; attacks are a particular flavour of Container (2.2) that bundles damage- and to-hit-type Modifiers under a name.

A Modifier definition does **not** carry:
- Duration or lifecycle (belongs to the Container - 2.4)
- Cost (belongs to the Container - 2.3)
- Source/provenance of a specific instance (the definition is shared; the instance attached to a Container carries the source)

A Modifier's **target** must be able to point at more than simple numeric stats:
- Derived stats (AC, speed, saving throw bonus)
- Roll categories (melee weapon damage, ranged spell attack, a specific skill check)
- Discrete rules (crit threshold, advantage/disadvantage state on a category of roll)
- Character resource pools, including custom, non-5e pools - the character's own action economy is itself a target ("you get +1 action this turn" - Action Surge - is structurally the same kind of Modifier as a damage bonus, just targeting the action pool instead of a damage roll), as are campaign-specific pools such as Soulfire and Vowfire. Vowfire charges, for example, are granted exactly like any other countable resource: a feat grants a Modifier targeting `resource.vowfire` with a `grant`/count operation (e.g. "+2 Vowfire Charges"), and multiple Vowfire-granting sources on one character sum by count per 3.1's resource-grant rule, the same way multiple `luck_dice` sources do. Vowfire's own narrative rules (what charges are spent on, recharge conditions) are a separate, not-yet-designed system - but its representation as a Modifier target follows the existing pattern and needs no new mechanism.

Targets use a flat, dot-notation naming convention: `ability_check.str`, `attack_roll.all`, `damage_taken.bludgeoning`, `damage_roll.melee_weapon.str`, `ac`, `speed.all`, `concentration`, `spellcasting`. This convention is deliberately simple and flexible enough to express homebrew targets that don't exist in official rules (`condition.bleeding`, `resource.vowfire`) without requiring a fixed enum to be extended for every new idea a DM invents.

A Modifier's **value** is drawn from one of four sources:
- **Fixed** - a literal number (`+2`).
- **Dice** - a dice expression (`1d4`).
- **Stat-derived formula** - computed from the wielding character's own stats (`proficiency_bonus`, `10 + dex_mod + con_mod`).
- **Derived from a sibling** - computed at resolution time from another Modifier instance attached to the *same Container*, rather than from the character or a fixed value. The canonical case is a critical-hit bonus equal to a weapon's own base damage die resolved to its maximum (a d10 weapon's crit bonus is automatically +10, a d6 weapon's is automatically +6, without being set by hand on every weapon). This is a general value-source type, not a crit-specific special case - any future Modifier that needs to reference a property of its own Container, rather than the wielding character, uses the same mechanism.

### 2.2 Container - everything that is not a Modifier

Everything previously imagined as a peer of Modifier - Effect, Item, Feat, Action, Attack, Spell - collapses into a single concept: the **Container**. A Container is a named, described, sourced wrapper that grants one or more Modifier instances, one or more other Container instances (5.1), or a mix of both.

A Container carries:

- **Name and description** (flavour text, narrative content)
- **Source** - what grants it (an item, a feat, a class feature, a spell, a homebrew effect)
- **Activation type** - passive (always active while the Container is active), triggered (fires when its condition is met, e.g. on crit), or active-use (consumes a cost when manually used)
- **Cost** - 2.3
- **Duration / lifecycle** - 2.4
- **One or more grants** - each a reference to a Modifier or Container definition, plus the parameter values for this particular instance (e.g. `luck_dice` with `count: 2` for the ring, `count: 3` for the Lucky feat)

An Item, a Feat, a Spell, an Effect, and an Attack are not five different schemas - they are the same Container shape, distinguished only by metadata (what kind of source they are, how they're triggered, what they cost), never by a different mechanical vocabulary underneath.

A Container may grant a Modifier with no grants attached at all - a purely descriptive entry with a name, description, and quantity. This is the correct representation of mundane, non-magical inventory (a gold watch, an emerald ring, six cabbages): an empty-grant Container, not a special case outside the model.

### 2.3 Cost is structured, not a scalar

Cost on a Container is a list, not a single number, to support multi-resource and multi-unit costs:

```
cost: [
  { pool: "action", amount: 1 },
  { pool: "vowfire", amount: 1 }
]
```

This covers the project's custom action-economy model (4 actions per turn: 2 attacks, 2 utility) without a special case - "uses an action" is `{ pool: "action", amount: 1 }`, exactly like any other resource cost. A future ability costing two actions, or costing a mix of actions and a campaign-specific resource pool (Soulfire, Vowfire), is expressed the same way, by adding entries to the list.

### 2.4 Duration and lifecycle belong to the Container, not the Modifier

Duration is a property of how a particular grant is currently active, not of the underlying mechanic, so it belongs to the Container, never the Modifier. If duration lived on the Modifier, every Modifier capable of being temporary would need duration-handling logic baked in, even when most instances of it are permanent (a +1 AC ring versus a temporary +1 AC from Shield).

- A Container is either permanent (while equipped/known) or has a duration, tracked in rounds internally.
- On expiry, a Container's grants simply stop being active. A Container may define an expiry side effect (e.g. Haste's lethargy on wear-off), itself just another grant that activates on the "expired" trigger.

### 2.5 Source and target-of-effect are independent

A Modifier instance's **source** (the Container/character that granted it) and its **target-of-effect** (the character it actually applies to) are tracked separately. They are usually the same character, but not always - some abilities present a menu (pick which party member receives a temporary buff) and apply the resulting Modifier instance to a different character than the one who activated it. In this case the instance carries `source: [originating container/character]` and `target: [chosen character]` independently, and a live-update notification informs the target character's client that a new Modifier has been applied to them.

### 2.6 Every resolved value must produce an audit trail

Any value the system calculates from one or more active Modifiers - AC, attack bonus, damage, a saving throw, a skill check, or any other derived value - must be able to show why it arrived at that number, broken down by source. For example:

```text
Base AC: 16 (Chain Mail)
Shield: +2
Half Cover: +2
Final AC: 20
```

```text
Longsword damage: 1d8 + STR
Rage bonus: +2
Adamantine Ring of Precision (critical hit bonus): +8 (die max, derived from base weapon die)
Final damage: 1d8 + STR + 2 + 8
```

This applies uniformly to every calculated value, not only combat rolls. In a homebrew-heavy system where a character can plausibly have a dozen or more active Modifiers stacked from different sources at once, an unexplained final number undermines trust - a player seeing "AC 20" with no way to see where the bonus points came from has no way to notice a mistake, query a ruling, or understand their own character. This is also a direct consequence of 4.5: if a shared Modifier's value can change underneath a character, an audit trail is what lets a player or DM see which of their active bonuses came from a since-edited definition, rather than being told abstractly that "some things may have changed."

---

## 3. Stacking and Combination Rules

### 3.1 Stacking behaviour is implied by operation type, not opted into per-modifier

Default stacking behaviour is implied by the operation type itself, not flagged per-Modifier by whoever authors it. Relying on every content author to remember to flag a non-stacking interaction (e.g. two independently-authored homebrew items that both grant advantage on the same roll type) is exactly the kind of silent-failure risk this model should not permit by default.

Default behaviours by operation type:

| Operation type | Default stacking behaviour |
|---|---|
| Advantage / Disadvantage | A dice-pool mechanic, scoped per roll-category bucket (3.2) - see 3.3 for the full rule. Not a simple binary state, and not simple counting either. |
| Resistance / Vulnerability | Net serially, per damage-type bucket (3.2) - simple binary cancellation today; a candidate for the same dice-pool-style mechanic as advantage/disadvantage in the future, not yet built that way (3.3). |
| Flat numeric add/subtract | Sum normally. Multiple +1 AC sources add up. |
| Set (override to an exact value) | Most-restrictive or most-recently-applied wins. The exact tie-break rule is an open question - 8. |
| Grant of a resource (e.g. luck dice, extra action, Vowfire charges) | Sums by count, since each instance is a discrete, countable grant - 2 + 3 luck dice from two sources is meaningfully different from "you have advantage twice." |

A "doesn't stack with itself" flag is available on a Modifier definition for genuine exceptions outside these defaults (a homebrew aura that should not combine with a second copy of itself from a different source) - it is the exception path, not the primary mechanism.

### 3.2 Netting is scoped per-bucket, not globally

Netting opposing sources (advantage against disadvantage, resistance against vulnerability) is calculated per relevant category, never as one global counter across the whole character. A character can simultaneously have resistance to bludgeoning damage and vulnerability to fire damage; these do not net against each other, because they apply to different damage types. Only sources affecting the same bucket (the same damage type, the same roll category) net against each other.

### 3.3 The net-and-discard pattern, and advantage/disadvantage as its first application

Some operation types come in opposing pairs where sources on each side can cancel each other out, but where simply discarding canceled pairs and treating the survivors as an ordinary count loses real information. The general pattern this model uses for such pairs is: **net the two sides first by simple subtraction, discard whatever cancels exactly, and only the surviving net magnitude does anything.** What the surviving magnitude actually *does* depends on the specific operation type - it is not the same resolution for every opposing pair.

**Advantage/disadvantage - fully specified.** Each advantage source and each disadvantage source within a bucket is counted. Net = (advantage count − disadvantage count). The roll's dice pool size is **1 (base) + |net|**; sources that canceled each other out contribute nothing to the pool at all, as if they were never present. The sign of the net determines resolution direction: positive nets take the highest die in the pool, negative nets take the lowest, and a net of exactly zero means a true flat roll of 1 die, no extra dice rolled.

Worked examples:
- 3 advantage sources alone: net +3, pool = 1+3 = 4 dice, take highest.
- 3 disadvantage sources alone: net −3, pool = 4 dice, take lowest.
- 3 advantage + 1 disadvantage: net +2, pool = 1+2 = 3 dice, take highest.
- 1 advantage + 3 disadvantage: net −2, pool = 3 dice, take lowest.
- 2 advantage + 2 disadvantage: net 0, pool = 1 die, flat - the canceled sources do not inflate the pool.

This is a deliberate, confirmed departure from standard 5e's binary "any single disadvantage source cancels all advantage" rule - multiple sources on one side here genuinely produce a bigger pool and a stronger lean toward that side, rather than collapsing to a flat advantage/disadvantage state the moment both sides have at least one source.

**Resistance/vulnerability - not yet resolved this way.** Resistance and vulnerability currently use simple binary net cancellation (1 resistance + 1 vulnerability to the same damage type = net neutral, full stop - see 3.1's table), not the dice-pool mechanic above. Extending resistance/vulnerability to use the same net-and-discard *pattern* - where a surviving net magnitude beyond ±1 does something more than binary cancel/no-cancel (e.g. multiple net resistance sources scaling damage reduction further) - is wanted for the future, but the specific resolution (what a net magnitude of 2+ should actually do to a damage multiplier) is not yet designed and should not be assumed to mirror the dice-pool mechanic mechanically, only to follow the same net-then-discard-canceled-pairs *shape* as a starting point.

---

## 4. Version History and Modifier-Definition Drift

### 4.1 The problem this rule resolves

Modifier definitions are shared, reusable, and mutable - `luck_dice` is one definition referenced by both a ring and a feat, and if the design changes, that change should propagate to everything referencing `luck_dice`, rather than every Container that references it needing to be hunted down and edited individually.

This is in tension with a comprehensive version-history requirement ("from first born to final death," not a small undo stack): if a Modifier definition can change, what does "restoring an old version of a character" mean?

### 4.2 The rule: quantity/presence is historical, mechanics is current

> **What a character had, and how many, is frozen at snapshot time. What that thing does, mechanically, is always resolved against the current live definition - never frozen.**

A version snapshot records, for each active Modifier instance, which definition it referenced and what parameter values applied (e.g. "luck_dice, count 3, source: Lucky feat") - not the mechanical text or formula of that definition at the time. When a snapshot is viewed or restored, count and source come from the snapshot (historical); what the Modifier actually does is resolved against whatever the live definition currently says (current).

Worked consequence: a snapshot recorded "3 luck dice" when `luck_dice` meant "reroll a d20." If the definition is later changed to mean "roll 2d20, take the better," restoring that snapshot gives the player 3× "roll 2d20, take the better" - not 3× "reroll a d20." Restoring an old version is time-travel for the character's state, not for the rules. In a living homebrew system under active iteration, "what would this ability have done under rules since abandoned" is rarely the useful question; "what did this character have, and what does it do under current understanding" is.

### 4.3 Soft-delete only - modifier definitions are never destroyed

A direct consequence of 4.2: if a definition is hard-deleted after being referenced by any historical snapshot, restoring that snapshot has nothing to resolve against. Modifier definitions are soft-deleted only - a definition may be deprecated or hidden from use in new content, but must never be permanently destroyed once referenced anywhere, so any historical reference always resolves against something live.

### 4.4 Version-history review distinguishes two different kinds of "what changed"

Because reviewing a snapshot can surface differences unrelated to anything the character did, version-history review distinguishes two categories rather than presenting one undifferentiated list:

1. **Character-state diffs** - what actually changed about this character between two saves: levelled up, equipped a new item, lost a resource, took damage. Computed snapshot-to-snapshot.
2. **Modifier-definition drift** - what has changed about a shared definition since this snapshot was taken, independent of anything the character did. For example: "3 of the modifiers in this snapshot have since been redefined; the values shown reflect the current definitions, not what applied at the time this snapshot was saved."

Conflating the two would make a player reasonably but incorrectly assume a change in displayed behaviour reflects something they did, when it may instead reflect a definition edit made sessions later. Drift text is generated at view time, not precomputed at save time, since future definition edits can't be known in advance.

### 4.5 Editing a shared Modifier: update in place, or fork a copy

Editing a shared Modifier definition offers two paths: **update the shared definition** (the default - most edits, such as correcting a typo or rebalancing a number, genuinely should propagate everywhere the definition is used, consistent with 4.2), or **create a copy scoped to one entry** (fork a new, independent definition pre-filled from the original, leaving the original and every other reference to it untouched - for the case where an edit is only intended to change one specific Container's behaviour going forward, without diverging anything else that currently shares the same definition).

A forked copy is simply a new, independent Modifier definition like any other - it does not change how stacking, version history, or soft-deletion work.

---

## 5. Containers Can Grant Other Containers

### 5.1 The rule

A Container's grant may be one or more Modifier instances, one or more other Container instances, or a mix of both. Nothing restricts a Container to granting only raw Modifiers - a Container can grant an instance of another, separately-defined Container.

A reusable mechanical bundle does not need a special "Effect" category distinct from everything else: it is simply a Container, defined once, that other Containers can reference and instantiate. There is exactly one kind of thing in the system, used two ways - directly applying Modifiers, or applying another Container that in turn applies Modifiers (and possibly further Containers).

### 5.2 Worked example: Rage and Raging

- **Rage** (the class feature) is a Container. Activation type: active-use. Cost: one Rage use, reset per long/short rest. Its grant is not a set of Modifier instances directly - its grant is one instance of a different Container: **Raging**.
- **Raging** (the state) is itself a Container - temporary, with a duration tracked in rounds (or "until ended," per standard 5e Rage rules). It carries the actual mechanics: advantage on Strength checks and saves, a damage bonus on Strength-based melee attacks, resistance to bludgeoning/piercing/slashing damage, and a block on casting/concentrating on spells. All of these are ordinary Modifier instances.
- When Rage's use is activated, the system instantiates the Raging Container against the character. When Raging expires, its Modifier instances stop being active - the same expiry behaviour as any other Container, per 2.4.

### 5.3 Worked example: a reusable condition across unrelated sources

A homebrew Poisoned variant needs to apply identically whether inflicted by a trap, a spell, or a monster's bite:

- **Poisoned (homebrew)** is defined once, as a Container, carrying the Modifier instances the variant requires (e.g. disadvantage on attack rolls and ability checks, a damage-over-time tick).
- The trap, the spell, and the monster's bite are each their own small Container. Each one's grant is one instance of the Poisoned (homebrew) Container - not a re-declaration of its modifiers.
- If the homebrew Poisoned definition is later tuned, all three sources pick up the change automatically, because they reference the same underlying Container.

### 5.4 Why this isn't a new layer

There is still only one entity type (Container), and the version-history rules in Section 4 apply identically regardless of how many hops deep a grant chain goes - a snapshot freezes quantity/presence/source and always resolves mechanics against the current live definition, whether that definition is a Modifier or a Container being referenced. No new schema, no new editor concept, no new stacking rule is required - it falls out of the existing model once a Container is permitted to grant another Container, not only raw Modifiers.

---

## 6. Authoring, Permissions, and Player-Facing Application

### 6.1 Three-tier permission split

- **Players** may apply existing, predefined Containers to their own character - toggling a Condition like Poisoned on themselves from a player-facing apply screen - and may create new Containers that carry no grants at all: purely descriptive inventory items with a name, description, and quantity (a gold watch, an emerald ring, six cabbages). This is the empty-grant case described in 2.2, not a special case outside the model.
- **Only the DM/admin** may create or edit a Modifier definition, create or edit a Container that has any grant attached, or attach a grant to an existing Container. Authoring mechanics is gated; applying already-authored mechanics to oneself, within the predefined/Conditions set, is not.
- **If a player-created, grant-free Container later needs mechanics** (a DM decides a player's invented "Emerald Ring" is secretly magic), the player's original Container is replaced wholesale by a new DM-authored Container, rather than edited in place. This keeps authorship and grant-attachment exclusively a DM-side action, with no partial/hybrid editing path that could blur the boundary.

### 6.2 Authoring and applying are separated in the UI

A screen that lets a player apply predefined Containers to their own character (Conditions, known Spells, and similar player-self-applicable content) is distinct from a screen that authors or browses the full content catalogue (creating Modifiers, creating Containers, attaching grants). The two functions do not share a tab set or a single screen - catalogue browsing and authoring belongs exclusively in dedicated admin/rules screens, never on a player-facing apply screen.

### 6.3 A Container may attach multiple independent Modifier instances

Authoring a Container supports attaching an arbitrary number of Modifier instances to it - for example, a sword granting a to-hit bonus, a flat damage bonus, its base weapon damage die, and two further elemental damage dice (fire and cold), five Modifier instances on one Container. Per 3.1, these do not compete or need special-case logic to combine: they are independent `add` operations against the same or related targets, and sum normally. Where practical, attaching a new Modifier to a Container reuses an existing definition from the shared library rather than creating a fresh near-duplicate.

### 6.4 Roll resolution requires two phases when a condition depends on the roll's own outcome

Resolving a roll happens in two ordered phases when any attached Modifier's condition depends on the outcome of the roll itself (most commonly: a bonus that only applies on a critical hit). First, resolve the triggering roll (the to-hit roll) and determine which roll-outcome-dependent conditions are satisfied (critical hit, critical miss, beating a target's AC/DC by some margin). Second, resolve the dependent roll (damage, or any other outcome) using the now-known set of active Modifiers, including any whose condition is one of the outcomes just determined. A Modifier's condition can express "on critical hit" as ordinary data; what this rule requires is that the resolution engine check that condition against the to-hit result before finalizing which Modifiers apply, rather than resolving all attached Modifiers in one undifferentiated pass.

---

## 7. Worked Example - Walking the Whole Model End to End

The Adamantine Ring of Precision and the Lucky feat, expressed in the model's shape.

**Modifier definitions (shared, reusable):**

```
Modifier: crit_extra_damage_die
  target: melee_weapon_damage
  operation: add_fixed
  value: derived_from_sibling (this Container's base damage die, resolved to max)
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

Both Containers reference the same `luck_dice` Modifier definition. A character with both the ring and the feat has two separate Modifier instances of `luck_dice` active - one with count 2 sourced from the ring, one with count 3 sourced from the feat - which, per 3.1 ("grant of a resource sums by count"), the character experiences as 5 total luck dice available, drawn from two pools with two separate reset conditions. Neither Container needed to re-describe what a luck die does; that lives in exactly one place.

---

## 8. Open Questions

These are explicitly unresolved and should not be treated as decided.

- **Tie-break rule for "set" operations.** When two sources both try to set the same value (rather than add to it), which wins - most recently applied, most restrictive, or highest-priority source?
- **Exact menu/targeting UI scope for the first pass.** The menu-and-target-selection flow for source-differs-from-target Modifiers (2.5) needs a precise UI design - party-member picker, confirmation flow, how it reads from existing character data - not yet specified.
- **Vowfire's narrative/mechanical rules.** Vowfire charges are confirmed to be granted via ordinary Modifiers targeting `resource.vowfire`, sourced from feats (or other Containers) like any other countable resource - this representation is settled, not open (2.1). What remains undesigned is Vowfire's own gameplay rules: what charges are spent on, recharge conditions, and pool-size limits, if any.
- **Modifiers-about-modifiers / conditional suppression.** Whether a Modifier's condition may reference "does this character already have an active modifier of type X" (true conditional suppression/dependency between modifiers) is undecided. A simple first pass - disallow this, escape to a more advanced mechanism only if a genuine case demands it - is the working assumption but not formally confirmed.
- **Whether non-stacking exceptions need richer scoping than a boolean flag.** The "doesn't stack with itself" flag (3.1) is currently a simple per-definition boolean. Whether some future case needs finer scoping (e.g. "doesn't stack with other instances from the same source category, but does stack across categories") is untested against a real example.

---

## 9. Relationship to the Migration Handover

- **Handover §2.13-2.17** (ingredients/cake metaphor, modifier vs effect distinction, items as assembly points, one-off actions as a distinct requirement) - superseded by Sections 1-2 of this document. "One-off actions" like "Heal 2d4+3" are not a separate Action entity - a Modifier (target: HP, operation: add, value: 2d4+3) wrapped in a Container whose activation type is active-use.
- **Handover §2.18-2.19** (separate Modifier/Effect/Item editor UIs, "Rule Hooks (Advanced)" as a third tab) - the underlying editor workflow (library → editor → attach/configure) is retained as a UI pattern, but no longer needs to separate "Modifiers" from "Effects" as different kinds of content - both are Containers.
- **Handover §4.5** (spell grants from items) - resolved in shape by Section 5: an item-granted spell is a Container referenced/granted by another Container, structurally identical to how a feat and a ring both grant `luck_dice`. The remaining 5e-casting-semantics questions (known vs. prepared vs. always-available, slot vs. charge consumption, custom DC/casting-stat overrides) are not addressed by this document, which clarifies architecture, not casting rules.
- **Handover §4.6** (generic action model) - resolved. There is no separate action contract; an action is a Container with an active-use activation type, granting one or more Modifiers, with a structured cost.
- **Handover §4.2** (exact modifier vocabulary and stacking rules) - resolved by Section 3. The remaining gap is the "set" tie-break rule (Section 8).
- **Handover §4.4** (Rule Hooks implementation and safety) - narrowed. Most of what Rule Hooks was meant to cover is ordinary modifier logic under this model. What remains, if anything, is the conditional-suppression case in Section 8.
- **Handover §2.24/§3.19/§4.8** (version history requirements and storage design) - the storage mechanism questions (snapshot vs diff vs event-sourced) remain open. This document adds a firm semantic rule that did not previously exist: history snapshots are state-historical but mechanics-current (Section 4).

---

## 10. Summary

Modifiers are the only mechanical primitive in the system. An Item, Feat, Spell, Effect, and Attack are all the same underlying shape - a named, sourced, costed Container that grants one or more Modifier instances, or other Container instances - distinguished from each other only by metadata, never by mechanics. Stacking behaviour is implied by operation type and scoped per-bucket, not left to individual content authors to flag correctly by hand. Costs and durations belong to the Container, not the Modifier, because they describe how a particular grant behaves, not what the underlying mechanic is. Version history freezes what a character had and how much, but always resolves what that thing does against the live, current modifier definition - history is a faithful record of character state, not a time machine back to old rules text - and because of that, modifier definitions must never be hard-deleted, only soft-deleted. Authoring mechanics is gated to the DM/admin tier; applying predefined content to oneself is not. Every resolved value must show its own breakdown.

This is the controlling architecture for all content-modelling work on this project.