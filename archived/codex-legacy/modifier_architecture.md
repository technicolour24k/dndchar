# Modifier Architecture

This document explains the distinction between modifier targets, modifier definitions, effects, and catalogue content in the TavernSheet rules engine.

## Modifier Targets

A modifier target identifies **where in the rules engine a change applies**. It is a calculation hook, not a change by itself.

Examples:

```text
initiative
ac
attack_roll.all
saving_throw.wis
damage_roll.melee_weapon.dex
```

Each target can also provide:

- A friendly name for administration screens.
- A category such as combat, checks, saves, or spellcasting.
- The expected value type, such as number, dice, formula, or no value.
- Whether the application currently consumes the target during calculations.

For example:

```text
initiative | Initiative | combat | number | runtime supported
```

Creating a target makes it available for data entry. It does not automatically implement its calculation. Targets marked as stored only still require resolver support before they affect a character sheet.

## Modifier Definitions

A modifier definition combines a target with an operation and an optional default value. It represents one reusable mechanical instruction.

Examples:

```text
initiative | bonus | 5
attack_roll.all | advantage | null
attack_roll.all | extra_die | 1d4
speed.all | multiplier | 2
```

Modifier definitions are deduplicated by:

```text
target + operation + default value
```

This means separate effects can reuse the same definition. Bless and a homebrew effect can both reference `attack_roll.all | extra_die | 1d4` without creating duplicate modifier records.

An effect link may override the definition's default value. This supports reuse where the mechanical shape is the same but a particular effect has a different value.

The resolved value is:

```text
effect link override, when present
otherwise modifier definition default
```

## Effects

An effect is the named cause or state that bundles one or more modifier definitions.

For example, Bless can be represented as:

```text
Effect: Bless
Duration: Concentration
Description: Add 1d4 to attack rolls and saving throws.

Modifiers:
- attack_roll.all | extra_die | 1d4
- saving_throw.all | extra_die | 1d4
```

Rage bundles several independent mechanics:

```text
- ability_check.str | advantage
- saving_throw.str | advantage
- damage_roll.melee_weapon.str | bonus | rage_damage_bonus
- damage_taken.bludgeoning | resistance
- damage_taken.piercing | resistance
- damage_taken.slashing | resistance
- spellcasting | block
- concentration | block
```

Effects hold context and lifecycle information that does not belong on a modifier definition:

- Name and description.
- Source information.
- Duration and expiry behavior.
- Concentration requirements.
- Whether the effect is a condition.
- Whether players can select it directly.
- Homebrew ownership and metadata.
- The complete set of modifiers that should activate or deactivate together.

Without an effect, a character might have an unexplained `+2 AC`. An effect records that the bonus came from Half Cover, also grants the related Dexterity saving throw bonus, and allows the complete state to be removed consistently.

## System Effects

System effects are effects that are not managed as catalogue items, spells, feats, or class features. They primarily represent:

- Conditions, such as Poisoned.
- Combat states, such as Dodge.
- Environmental states, such as Half Cover.
- Other temporary or manually activated rule bundles.

They are not simply modifiers because a system effect may contain several modifiers and needs its own description, source, duration, activation, and expiry behavior.

For example:

```text
Effect: Half Cover
Duration: While applicable

Modifiers:
- ac | bonus | 2
- saving_throw.dex | bonus | 2
```

The two modifiers remain reusable mechanical instructions. Half Cover is the rule state that groups and explains them.

## Catalogue Content

Items, spells, feats, and class features are catalogue content. Catalogue entries may attach effects with activation rules such as:

- While carried.
- While equipped.
- While attuned.
- On use.
- Manual activation.

For example, a magic shield may be represented as:

```text
Catalogue content: Shield of Warning
Activation: Equipped
Attached effect: Shield of Warning Equipped
Attached modifier: initiative | advantage | null
```

Keeping catalogue content separate from effects allows the same effect and modifier machinery to be used by official SRD content, private homebrew, environmental states, and temporary combat conditions.

## Hierarchy

The complete relationship is:

```text
Modifier Target
  identifies the calculation being changed

Modifier Definition
  defines the operation and optional default value

Effect
  bundles modifiers and supplies context and lifecycle

Catalogue Content or System State
  supplies or activates the effect

Character
  receives the active effect and resolves its modifiers
```

In short:

- **Target:** Where does the rule apply?
- **Modifier definition:** What mechanical change occurs?
- **Effect:** Why is the change active, and for how long?
- **Catalogue content or system state:** What grants or activates the effect?
