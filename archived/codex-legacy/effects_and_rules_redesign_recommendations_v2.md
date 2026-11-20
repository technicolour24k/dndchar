# Modifiers, Effects & Catalogue Content - Revised Recommended Model

## 1. Decision Summary

The previous document made **Effects** the primary object managed by admins and recommended that Items attach only Effects.

That is too restrictive for the model now agreed.

The better approach is:

- Admins create and maintain **Modifiers** as reusable mechanical building blocks.
- Admins create **Effects** when a group of modifiers needs a name, active state, duration, expiry, stacking behaviour, or other lifecycle context.
- **Catalogue content** - Items, Equipment, Spells, Feats, Class Features, Subclass Features, and similar entries - stitches those building blocks together into player-facing rules.
- Catalogue content may attach a Modifier directly when the mechanic is a simple passive rule.
- Items may also grant Features, Effects, Actions, and Spell Access.

In other words:

```text
Modifiers and Effects are ingredients.
Catalogue content is the finished cake.
```

---

## 2. Core Concepts

### 2.1 Rule Hook - Advanced Engine Configuration

A **Rule Hook** identifies the calculation or state that can be changed.

Examples:

```text
ac
initiative
attack_roll.all
saving_throw.dex
movement.walk
```

Rule Hooks are engine-facing configuration. Normal admins should rarely create or edit them directly.

### 2.2 Modifier - Reusable Atomic Mechanic

A **Modifier** is one reusable mechanical instruction.

It answers:

```text
What does this change?
How does it change it?
What value does it use?
```

Examples:

```text
Armour Class → Bonus → +1
All Saving Throws → Bonus → +1
All Attack Rolls → Disadvantage
Movement Speed → Multiplier → ×2
Strength Saving Throws → Advantage
```

A Modifier normally points to one Rule Hook, one operation, and an optional default value.

### 2.3 Effect - Named Active State

An **Effect** is a named bundle of one or more Modifiers that needs active-state context.

Use an Effect where the game needs to know that something is currently true, why it is true, and when it ends.

Effects may own:

- name and description
- duration and expiry behaviour
- concentration requirements
- stack behaviour
- manual activation eligibility
- source and visibility metadata
- one or more attached Modifiers

Examples:

```text
Dodge
Hasted
Raging
Poisoned
Half Cover
Aura of Terror
Boots of Speed Active
```

### 2.4 Action / Resolution - Immediate Event

An **Action** resolves something immediately rather than changing an ongoing calculation.

Examples:

```text
Deal 8d6 fire damage
Heal 2d8 + spellcasting modifier
Spend 1 item charge
Restore a spell slot
Apply an Effect
Remove an Effect
Create a summoned creature
```

Actions may apply or remove Effects, but they are not Effects themselves.

### 2.5 Catalogue Content - Player-Facing Finished Entries

**Catalogue Content** is the player-facing layer that assembles the rules.

This includes:

- Items and Equipment
- Spells
- Feats
- Class Features
- Subclass Features
- Species, lineage, and background features
- System states where needed

Catalogue Content can attach the appropriate ingredients:

```text
Modifiers
Effects
Actions
Resource costs and recharge rules
Requirements and activation rules
Granted Features
Spell Access
```

---

## 3. Recommended Relationship Model

```text
Rule Hooks
  └── power Modifiers

Modifiers
  ├── attach to Effects
  ├── attach directly to Catalogue Content
  └── may be reused by many entries

Effects
  ├── group active Modifiers
  ├── define lifecycle and state behaviour
  └── are granted, activated, or applied by Catalogue Content

Actions
  ├── resolve immediate events
  └── may apply or remove Effects

Catalogue Content
  ├── Items / Equipment
  ├── Spells
  ├── Feats and Features
  └── stitches together Modifiers, Effects, Actions, costs,
      requirements, and access rules

Character
  └── receives active mechanics from owned, equipped, prepared,
      learned, or otherwise available Catalogue Content
```

---

## 4. Attachment Rules

### 4.1 Direct Modifier Attachments

Attach a Modifier directly to Catalogue Content when it is a simple passive rule and does **not** need an independent state, duration, or activation lifecycle.

Example:

```text
Cloak of Protection
├── Modifier: Armour Class → Bonus → +1
├── Modifier: All Saving Throws → Bonus → +1
└── Availability: While equipped and attuned
```

Do not create a fake Effect such as `Cloak of Protection Equipped` merely to hold two simple passive modifiers.

### 4.2 Effect Attachments

Attach an Effect when a named state must be activated, displayed, tracked, expired, stacked, or removed.

Example:

```text
Boots of Speed
├── Action: Activate Boots
└── Applies Effect: Boots of Speed Active
    └── Modifier: Movement Speed → Multiplier → ×2
    Duration: 10 minutes
```

Example:

```text
Ring of Terror
└── Grants Effect: Aura of Terror
    ├── Availability: While equipped and attuned
    ├── Modifier: Frightened save / aura behaviour
    └── Ongoing state visible to nearby creatures
```

### 4.3 Feature Attachments

An Item may grant a Feature where the item gives the character a distinct, reusable capability rather than only a passive stat change.

Example:

```text
Wand of Winter
└── Grants Feature: Winter's Rebuke
    ├── Action: Activate
    ├── Resource: Item charges
    └── Applies Effect / resolves an immediate action
```

### 4.4 Spells

A Spell is catalogue content, not inherently an Effect or Modifier.

Some spells resolve immediately:

```text
Fireball
├── Casting requirements
└── Action resolution: Deal 8d6 fire damage
```

Some spells apply an ongoing Effect:

```text
Haste
├── Casting requirements
└── Applies Effect: Hasted
    ├── Modifier: Armour Class → Bonus → +2
    ├── Modifier: Movement Speed → Multiplier → ×2
    ├── Modifier: Dexterity Saving Throws → Advantage
    └── Modifier: Extra Action → Grant
    Duration: Concentration, up to 1 minute
```

### 4.5 Features and Class Abilities

A Feature may contain direct Modifiers, Actions, Effects, or all three.

Example:

```text
Rage (Class Feature)
├── Action: Enter Rage
└── Applies Effect: Raging
    ├── Modifier: Strength Checks → Advantage
    ├── Modifier: Strength Saves → Advantage
    ├── Modifier: Bludgeoning Damage Taken → Resistance
    ├── Modifier: Piercing Damage Taken → Resistance
    └── Modifier: Slashing Damage Taken → Resistance
```

---

## 5. Item-Level Spell Access

Items and Equipment can grant access to a Spell without copying the Spell's definition.

The Item should reference the central Spell record and configure how that specific item allows it to be cast.

```text
Item / Equipment
├── Direct Modifiers
├── Granted Effects
├── Granted Features
├── Actions and resources
└── Granted Spells
```

### 5.1 Example

```text
Wand of Fireballs
└── Granted Spell: Fireball
    ├── Access Type: Cast from this item
    ├── Availability: While held
    ├── Cost: 1-3 item charges
    ├── Cast Level: Derived from charges spent
    ├── Save DC: Item-defined, 15
    └── Spell Attack Bonus: Item-defined, +7
```

### 5.2 Initial supported access modes

The first version should deliberately cover only the common cases:

```text
Cast from this item using charges
Cast from this item with a limited free use
Cast from this item at will
Cast from this item using the character's spell slots
```

Potential future modes can include stored spells, selectable spell lists, copied spells, and special recharge rules. These should not be forced into the first version.

### 5.3 Data design recommendation

The UI should initially expose **Granted Spells** on Item and Equipment records.

However, the data model should avoid making the relationship item-only, because Feats and Class Features may later also grant spell access.

Recommended approach:

```text
content_spell_access
- id
- owner_content_type
- owner_content_id
- spell_id
- access_type
- availability_condition
- resource_type
- resource_cost
- use_limit
- recharge_rule
- cast_level_mode
- fixed_cast_level
- save_dc_mode
- fixed_save_dc
- spell_attack_mode
- fixed_spell_attack_bonus
- sort_order
```

This allows an Item UI now while keeping the underlying attachment reusable for future Feature and Feat support.

---

## 6. Terminology Changes

Keep database names where they are useful internally, but use the following wording in the UI.

| Current UI / technical term | Recommended UI term | Meaning |
|---|---|---|
| Modifier Target | **Rule Hook** | Advanced engine location where a mechanic applies. |
| Modifier Definition | **Modifier** | Reusable atomic mechanical instruction. |
| System Effect | **Effect** | Named active state that groups modifiers and lifecycle behaviour. |
| Modifier-to-parent link | **Applied Modifier** | A Modifier attached to a specific Effect, Item, Spell, or Feature. |
| Target | **Applies To** | The stat, roll, state, or calculation affected. |
| Operation | **Change** | Bonus, advantage, resistance, block, multiplier, and so on. |
| Default Value | **Base Value** | Default number, dice expression, formula, or other value. |
| Override | **Entry-specific Value** | Value replacing the base Modifier value for one attachment only. |
| Friendly Label | **Display Name** (optional) | Normally generated automatically. |
| Publication | **Remove** | A saved entry is immediately available. |

Examples:

```text
ability_check.stealth / bonus / 2
becomes
Stealth Checks → Bonus → +2

attack_roll.all / disadvantage / null
becomes
All Attack Rolls → Disadvantage
```

---

## 7. Modifier Management Page

The former Effects-first screen should be adjusted to reflect the agreed model.

### Page name

```text
Modifiers & Effects
```

### Internal tabs

```text
[ Modifiers ] [ Effects ] [ Rule Hooks ]
```

The **Modifiers** tab should be the default landing tab because it is the reusable mechanical library that admins maintain directly.

Effects remain a first-class tab, but are not the only valid home for Modifiers.

### Modifier tab layout

```text
┌─────────────────────┬──────────────────────────────────┬──────────────────────────┐
│ Modifier Library    │ Modifier Editor                  │ Create / Reuse Modifier  │
│                     │                                  │                          │
│ Search / filters    │ Applies To                       │ Guided Rule Hook Builder │
│ New Modifier        │ Change                           │ Change, value, priority  │
│ Existing modifiers  │ Base value                       │ Generated Rule Hook      │
│                     │ Used by / references             │ Save Modifier            │
└─────────────────────┴──────────────────────────────────┴──────────────────────────┘
```

### Effects tab layout

The existing mockup concept still works well for this tab:

```text
┌─────────────────────┬──────────────────────────────────┬──────────────────────────┐
│ Effect Library      │ Effect Editor                    │ Attach Modifier          │
│                     │                                  │                          │
│ Search / filters    │ Name, type, source, duration     │ Search existing Modifier │
│ New Effect          │ Description                      │ Or create a new one      │
│ Existing effects    │ Attached Modifiers                │ Entry-specific settings  │
│                     │ Used by / references             │ Attach                  │
└─────────────────────┴──────────────────────────────────┴──────────────────────────┘
```

The Effect editor should attach an existing Modifier where possible, while allowing creation of a new Modifier inline if no suitable one exists.

### Rule Hooks tab

Keep Rule Hooks as explicitly advanced engine configuration. It should not be part of the normal content workflow.

---

## 8. Attachment Metadata

The shared Modifier should hold only reusable mechanics.

```text
Modifier
- rule_hook_id
- operation
- base_value
- value_type
- internal/display metadata
```

The attachment should hold context specific to the parent entry.

```text
Applied Modifier
- modifier_id
- owner_type
- owner_id
- entry_specific_value
- condition
- priority
- sort_order
- availability / activation condition where required
```

This prevents conditions such as `while wearing armour` from leaking into every use of a reusable `Armour Class → Bonus → +1` Modifier.

---

## 9. Editing and Deletion Safety

Modifiers may be shared across many Effects and Catalogue entries.

Before editing a shared Modifier, show its references and offer:

```text
[ Update shared Modifier ]
[ Create a copy for this entry ]
```

Default to copying when an edit would alter mechanics for a single parent entry.

Deletion rules:

| Record | Recommended behaviour |
|---|---|
| Referenced Modifier | Prevent hard deletion; allow archive. |
| Referenced Effect | Prevent hard deletion; allow archive. |
| Referenced Rule Hook | Prevent deletion. |
| Unused homebrew record | Allow deletion after confirmation. |
| System-owned record | Prevent deletion or require a strong safeguard. |

---

## 10. Changes Required to the Previous Recommendation Document

The following parts of the previous document should be replaced or amended:

1. Replace **Rule Change** with **Modifier** throughout.
2. Change the page title from **Effects & Rules** to **Modifiers & Effects**.
3. Change the default internal tab from **Effects** to **Modifiers**.
4. Replace the earlier statement that Items should attach Effects instead of raw Modifiers.
5. Allow Items, Equipment, Spells, and Features to attach direct Modifiers, Effects, Actions, and other relevant components.
6. Add **Granted Spells** as an Item/Equipment-level section.
7. Keep the original Effect lifecycle and Rule Hook builder recommendations; those still stand.
8. Retain the removal of Publication entirely.

---

## 11. Revised Acceptance Criteria

The redesign is complete when:

- [ ] There is no Publication/Published workflow.
- [ ] Saved Modifiers, Effects, and Rule Hooks are immediately available.
- [ ] Admins can search, create, edit, archive, and inspect Modifiers from a dedicated Modifier Library.
- [ ] Effects can attach one or more reusable Modifiers and own lifecycle data.
- [ ] Items and Equipment can attach direct Modifiers for simple passives.
- [ ] Items and Equipment can attach Effects for active or lifecycle-based mechanics.
- [ ] Items and Equipment can grant Features, Actions, and Spell Access where appropriate.
- [ ] Spells can resolve immediate Actions, apply Effects, or both.
- [ ] Feats and Features can attach direct Modifiers, Effects, and Actions.
- [ ] A normal admin can create `All Attack Rolls → Disadvantage` without typing `attack_roll.all`.
- [ ] Generated Rule Hooks remain visible but read-only in standard mode.
- [ ] Shared Modifier edits clearly show all affected references.
- [ ] Rule Hooks are labelled as advanced engine configuration.
- [ ] Referenced records cannot be accidentally hard-deleted.
