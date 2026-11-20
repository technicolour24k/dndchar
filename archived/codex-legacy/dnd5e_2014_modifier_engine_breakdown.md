# D&D 5E 2014 Modifier Engine Breakdown

## Purpose

This document defines the categories of player-modifying effects that a D&D 5E 2014 character management system should support.

The goal is **not** to hard-code every individual spell, class feature, feat, item, or condition. Instead, the system should use a generic **modifier engine** where effects such as `Rage`, `Haste`, `Shield`, `Bless`, `Poisoned`, `Prone`, magic armour, cover, and homebrew mechanics can all be represented using the same structure.

This is intended for a dynamic character sheet / rules engine where effects can be activated, expired, recalculated, and displayed to the player.

---

## Core Design Principle

Every modifier should be treated as an **effect**.

An effect may come from:

- A race/species trait
- A class feature
- A subclass feature
- A feat
- A spell
- Equipment
- A magic item
- A condition
- Exhaustion
- A combat action
- The environment
- A monster/NPC ability
- A curse
- A boon/blessing
- Homebrew content

Each effect should contain one or more **modifiers**.

For example:

- `Rage` modifies damage, resistance, advantage, concentration, and spellcasting.
- `Haste` modifies speed, AC, Dexterity saves, action economy, and has an end penalty.
- `Shield` modifies AC temporarily and grants immunity to `Magic Missile`.
- `Bless` modifies attack rolls and saving throws with an extra `d4`.
- `Poisoned` applies disadvantage to attacks and ability checks.

---

## Modifier Categories

These are the main categories of modifiers the system should support.

| Category | Examples |
|---|---|
| Ability score modifier | ASI, Belt of Giant Strength, Headband of Intellect, Primal Champion |
| Ability score maximum modifier | Barbarian Primal Champion, manuals/tomes |
| Ability check modifier | Rage advantage on STR checks, Guidance, Enhance Ability |
| Skill modifier | Expertise, Jack of All Trades, Pass without Trace, Reliable Talent |
| Passive score modifier | Observant, advantage/disadvantage equivalents, magic items |
| Saving throw modifier | Bless, Resistance, Aura of Protection, Diamond Soul, cover |
| Attack roll modifier | Archery Fighting Style, Bless, Bane, Reckless Attack, Sharpshooter |
| Damage roll modifier | Rage, Divine Favour, Hunter's Mark, Hex, Great Weapon Master |
| Damage taken modifier | Resistance, vulnerability, immunity, Heavy Armour Master, Uncanny Dodge |
| AC modifier | Shield, Shield of Faith, Haste, Mage Armour, Barkskin, cover |
| AC formula override | Unarmoured Defence, Mage Armour, Barkskin, Wild Shape forms |
| HP/current HP modifier | Healing, damage, Lay on Hands, Cure Wounds |
| Temporary HP | False Life, Heroism, Armour of Agathys, Inspiring Leader |
| Max HP modifier | Aid, Heroes' Feast, Harm, Life-draining effects |
| Speed modifier | Haste, Longstrider, Mobile, Fast Movement, grappled |
| Movement mode grant | Fly, Spider Climb, Alter Self, Wild Shape |
| Movement restriction | Grappled, restrained, prone, difficult terrain, Slow |
| Condition application/removal | Poisoned, stunned, frightened, charmed, Lesser Restoration |
| Advantage/disadvantage | Dodge, Faerie Fire, invisibility, prone, restrained |
| Extra dice | Bless, Guidance, Bardic Inspiration, Divine Smite, Sneak Attack |
| Reroll/replacement/minimum roll | Lucky, Portent, Reliable Talent, Indomitable |
| Critical range/effect | Champion Fighter, Assassin, Savage Attacks, Brutal Critical |
| Action economy | Haste extra action, Action Surge, Slow, stunned, incapacitated |
| Bonus action changes | Rage activation, Cunning Action, Frenzy, Polearm Master |
| Reaction changes | Shield, Counterspell, Protection Fighting Style, Sentinel |
| Spellcasting restriction | Rage, Silence, incapacitated effects |
| Concentration state | Bless, Hex, Hunter's Mark, Fly, Haste |
| Senses | Darkvision, blindsight, truesight, blinded, See Invisibility |
| Size/form/type change | Enlarge/Reduce, Polymorph, Wild Shape, Shapechange |
| Targeting/visibility | Invisibility, cover, obscurement, Sanctuary, Mirror Image |
| Resource modification | Ki, Sorcery Points, Bardic Inspiration, Channel Divinity, spell slots |
| Proficiency changes | Race, class, feats, Knowledge Cleric, Expertise, Jack of All Trades |
| Weapon/armour rule changes | Fighting Styles, Crossbow Expert, Sharpshooter, Great Weapon Master |
| Environmental modifiers | Cover, squeezing, underwater combat, difficult terrain |
| Death-state modifiers | Death saves, unconscious, stabilised, Death Ward |

---

## Core Conditions

Conditions should be first-class effects. They are commonly applied by spells, monster attacks, class features, traps, and environmental effects.

| Condition | Mechanical Impact |
|---|---|
| Blinded | Cannot see, automatically fails sight-based checks, attacks against have advantage, own attacks have disadvantage |
| Charmed | Cannot attack charmer, charmer has advantage on social checks |
| Deafened | Cannot hear, automatically fails hearing checks |
| Frightened | Disadvantage on checks/attacks while source is visible, cannot move closer to source |
| Grappled | Speed becomes 0, cannot benefit from speed bonuses |
| Incapacitated | Cannot take actions or reactions |
| Invisible | Attacks by invisible creature have advantage, attacks against it have disadvantage, visibility/targeting changes |
| Paralysed | Incapacitated, cannot move/speak, automatically fails STR/DEX saves, attacks against have advantage, close hits crit |
| Petrified | Incapacitated, resistant to damage, immune to poison/disease, automatically fails STR/DEX saves, attacks against have advantage |
| Poisoned | Disadvantage on attack rolls and ability checks |
| Prone | Crawling only unless standing, own attacks have disadvantage, close melee attacks against have advantage |
| Restrained | Speed 0, own attacks have disadvantage, attacks against have advantage, DEX saves have disadvantage |
| Stunned | Incapacitated, cannot move, automatically fails STR/DEX saves, attacks against have advantage |
| Unconscious | Incapacitated, prone, drops held items, automatically fails STR/DEX saves, attacks against have advantage, close hits crit |

Recommended implementation:

- Store conditions separately from generic active effects if useful for UI clarity.
- Internally, conditions should still resolve into the same modifier engine.
- Some conditions contain multiple modifiers.
- Some conditions affect both the target and attackers interacting with the target.

---

## Exhaustion

2014 exhaustion should be modelled as a numeric state from `0` to `6`.

| Exhaustion Level | Effect |
|---:|---|
| 1 | Disadvantage on ability checks |
| 2 | Speed halved |
| 3 | Disadvantage on attack rolls and saving throws |
| 4 | Hit point maximum halved |
| 5 | Speed reduced to 0 |
| 6 | Death |

Recommended implementation:

- Store exhaustion as a number.
- Derive the active modifiers from the exhaustion level.
- Do not store each exhaustion effect as a separate condition unless there is a strong reason to do so.

---

## Combat and Environment States

These are not always described as buffs/debuffs, but they still modify characters and should be represented.

| State | Modifier |
|---|---|
| Dodge | Attacks against the creature have disadvantage, creature has advantage on DEX saves until start of next turn |
| Help | Grants advantage to an ally's next relevant ability check or attack |
| Half cover | +2 AC and +2 DEX saves |
| Three-quarters cover | +5 AC and +5 DEX saves |
| Total cover | Cannot be targeted directly |
| Squeezing | Extra movement cost, disadvantage on attacks and DEX saves, attacks against have advantage |
| Difficult terrain | Movement costs extra |
| Heavily obscured | Visibility and targeting changes |
| Lightly obscured | Perception/visibility effects |
| Underwater combat | Weapon attack restrictions/disadvantage depending on weapon and swim speed |
| Mounted | Movement and targeting interactions |
| Surprised | Restricts movement/actions/reactions at start of combat |
| Dying | Death save tracking |
| Stabilised | Dying but no longer making death saves |
| Concentrating | Tracks active concentration effect and concentration checks |

---

## Class Features That Modify Characters

These are the major 2014 class features that should be represented as modifiers or effect sources.

### Barbarian

- Rage
- Unarmoured Defence
- Reckless Attack
- Danger Sense
- Fast Movement
- Feral Instinct
- Brutal Critical
- Relentless Rage
- Persistent Rage
- Indomitable Might
- Primal Champion

### Bard

- Bardic Inspiration
- Jack of All Trades
- Song of Rest
- Expertise
- Countercharm
- Cutting Words
- Peerless Skill

### Cleric

- Channel Divinity effects
- Domain proficiencies
- Divine Strike
- Potent Spellcasting
- Blessed Healer
- Warding Flare
- War God's Blessing
- Domain-specific auras/effects

### Druid

- Wild Shape
- Combat Wild Shape
- Land's Stride
- Nature's Ward
- Elemental Wild Shape
- Archdruid

### Fighter

- Fighting Style
- Second Wind
- Action Surge
- Extra Attack
- Indomitable
- Improved Critical
- Remarkable Athlete
- Battle Master Manoeuvres
- Eldritch Strike

### Monk

- Unarmoured Defence
- Martial Arts
- Ki
- Flurry of Blows
- Patient Defence
- Step of the Wind
- Unarmoured Movement
- Deflect Missiles
- Slow Fall
- Stunning Strike
- Evasion
- Diamond Soul
- Empty Body

### Paladin

- Lay on Hands
- Fighting Style
- Divine Smite
- Divine Health
- Aura of Protection
- Aura of Courage
- Improved Divine Smite
- Cleansing Touch
- Oath auras
- Channel Divinity effects

### Ranger

- Fighting Style
- Natural Explorer
- Land's Stride
- Hide in Plain Sight
- Vanish
- Feral Senses
- Foe Slayer
- Hunter features

### Rogue

- Expertise
- Sneak Attack
- Cunning Action
- Uncanny Dodge
- Evasion
- Reliable Talent
- Blindsense
- Slippery Mind
- Elusive
- Stroke of Luck

### Sorcerer

- Font of Magic
- Metamagic
- Draconic Resilience
- Elemental Affinity
- Wild Magic Surge
- Tides of Chaos
- Bend Luck

### Warlock

- Eldritch Invocations
- Pact Boons
- Patron features
- Dark One's Blessing
- Dark One's Own Luck
- Fiendish Resilience
- Entropic Ward

### Wizard

- Arcane Recovery
- Arcane Ward
- Portent
- Sculpt Spells
- Potent Cantrip
- Empowered Evocation
- Illusory Self
- Transmuter's Stone
- Spell Mastery

---

## Feats That Modify Characters

Most 2014 feats either modify a score, grant a proficiency, alter action economy, change combat rules, or add a resource.

| Feat | Modifier Type |
|---|---|
| Alert | Initiative, surprise, unseen attacker rules |
| Athlete | Ability score, movement, climbing, jumping |
| Actor | Ability score, advantage on impersonation/deception checks |
| Charger | Bonus action attack/shove, damage/push modifier |
| Crossbow Expert | Loading property, melee ranged attack disadvantage, bonus attack |
| Defensive Duelist | Reaction AC bonus |
| Dual Wielder | AC, weapon eligibility |
| Dungeon Delver | Advantage, trap saves, damage resistance |
| Durable | Ability score, hit dice healing minimum |
| Elemental Adept | Damage resistance bypass, damage die floor |
| Grappler | Advantage/restrained interactions |
| Great Weapon Master | Bonus action attack, -5/+10 attack/damage toggle |
| Healer | Healing action/resource |
| Heavily Armoured | Ability score, armour proficiency |
| Heavy Armour Master | Ability score, flat damage reduction |
| Inspiring Leader | Temporary HP |
| Keen Mind | Ability score, memory/navigation utility |
| Lightly Armoured | Ability score, armour proficiency |
| Linguist | Ability score, languages |
| Lucky | Roll replacement/reroll resource |
| Mage Slayer | Reaction attack, concentration penalties, save advantage |
| Magic Initiate | Spell grants |
| Martial Adept | Manoeuvre dice/effects |
| Medium Armour Master | Armour DEX cap, stealth disadvantage removal |
| Mobile | Speed, difficult terrain after Dash, opportunity attack avoidance |
| Moderately Armoured | Ability score, armour/shield proficiency |
| Mounted Combatant | Advantage, attack redirection, mount save protection |
| Observant | Ability score, passive Perception/Investigation |
| Polearm Master | Bonus action attack, reaction attack trigger |
| Resilient | Ability score, saving throw proficiency |
| Ritual Caster | Spell grants |
| Savage Attacker | Damage reroll |
| Sentinel | Opportunity attack rules, speed reduction |
| Sharpshooter | Cover ignore, range ignore, -5/+10 attack/damage toggle |
| Shield Master | Bonus shove, DEX save modifiers, reaction damage prevention |
| Skilled | Proficiencies |
| Skulker | Hiding/visibility/ranged miss rules |
| Spell Sniper | Spell range, cover ignore, cantrip grant |
| Tavern Brawler | Ability score, unarmed damage, improvised proficiency, bonus grapple |
| Tough | Max HP |
| War Caster | Concentration advantage, somatic handling, spell opportunity attack |
| Weapon Master | Ability score, weapon proficiencies |

---

## Spells That Create Active Modifiers

Spells should be represented as active effects where appropriate.

Important spell properties:

- Duration
- Concentration requirement
- Target(s)
- Range
- Save type
- Repeat save timing
- Attack roll requirement
- Scaling by spell slot level
- End condition
- On-expire effects
- Ongoing round-based effects
- Whether the spell affects self, ally, enemy, area, or object

### Common Buff/Modifier Spells

| Spell | Modifier Type |
|---|---|
| Aid | Max HP/current HP increase |
| Armour of Agathys | Temporary HP, retaliation damage |
| Bane | Subtract d4 from attacks/saves |
| Barkskin | AC floor |
| Beacon of Hope | Advantage on WIS/death saves, max healing |
| Bless | Add d4 to attacks/saves |
| Blur | Attacks against have disadvantage |
| Branding Smite | Extra damage, reveal invisibility |
| Crusader's Mantle | Aura damage bonus |
| Darkvision | Sense grant |
| Death Ward | Prevent drop/death once |
| Divine Favour | Damage bonus |
| Enhance Ability | Advantage/check modifiers/temp HP/carrying variants |
| Enlarge/Reduce | Size, STR checks/saves, damage |
| Expeditious Retreat | Bonus action Dash |
| False Life | Temporary HP |
| Fire Shield | Resistance, retaliation damage |
| Fly | Flying speed |
| Freedom of Movement | Ignore movement restrictions |
| Gaseous Form | Speed/form/resistance/action restrictions |
| Greater Invisibility | Invisible condition-style targeting |
| Guidance | Add d4 to ability check |
| Haste | Speed, AC, DEX saves, extra action, end penalty |
| Heroism | Frightened immunity, temp HP each round |
| Hex | Extra damage, ability check disadvantage |
| Holy Aura | Advantage on saves, attacks against disadvantage, extra undead/fiend effect |
| Hunter's Mark | Extra damage, tracking advantage |
| Invisibility | Invisible |
| Jump | Jump distance multiplier |
| Longstrider | Speed increase |
| Mage Armour | AC formula |
| Magic Weapon | Attack/damage bonus, magical weapon flag |
| Mirror Image | Attack redirection |
| Pass without Trace | Stealth bonus, no tracks |
| Protection from Energy | Damage resistance |
| Protection from Evil and Good | Defensive disadvantage/immunity vs creature types |
| Protection from Poison | Poison save advantage, poison resistance |
| Resistance | Add d4 to saving throw |
| Sanctuary | Targeting restriction |
| See Invisibility | Sense modifier |
| Shield | Reaction AC bonus, Magic Missile immunity |
| Shield of Faith | AC bonus |
| Shillelagh | Weapon ability/damage override |
| Spider Climb | Climb movement |
| Stoneskin | Nonmagical B/P/S resistance |
| True Strike | Advantage on next attack |
| Warding Bond | AC/saves bonus, resistance, damage sharing |
| Water Breathing | Breathing flag |
| Water Walk | Movement/environment flag |

### Debuff Spells That May Modify Players

Enemies can apply these effects to player characters, so they should also be modelled.

| Spell | Modifier Type |
|---|---|
| Bestow Curse | Custom debuffs |
| Blindness/Deafness | Conditions |
| Calm Emotions | Suppress charmed/frightened |
| Charm Person | Charmed |
| Colour Spray | Blinded |
| Command | Forced action/behaviour |
| Compelled Duel | Targeting/movement restrictions |
| Confusion | Randomised action behaviour |
| Contagion | Disease/poison-style debuffs |
| Dominate Beast | Charmed/control |
| Dominate Person | Charmed/control |
| Dominate Monster | Charmed/control |
| Ensnaring Strike | Restrained, recurring damage |
| Entangle | Restrained |
| Faerie Fire | Advantage against target, invisibility negation |
| Fear | Frightened, forced movement/drop |
| Feeblemind | INT/CHA set to 1, spellcasting/communication restriction |
| Flesh to Stone | Restrained into petrified |
| Grease | Prone/difficult terrain style effects |
| Hold Person | Paralysed |
| Hold Monster | Paralysed |
| Hypnotic Pattern | Charmed/incapacitated/speed 0 |
| Otto's Irresistible Dance | Movement consumed, disadvantage attacks/DEX saves, attacks against advantage |
| Phantasmal Killer | Frightened, recurring damage |
| Ray of Enfeeblement | Weapon damage reduction |
| Ray of Sickness | Poisoned |
| Sleep | Unconscious |
| Slow | Speed, AC, DEX saves, reactions, action economy, spellcasting delay |
| Staggering Smite | Disadvantage and reaction loss |
| Stinking Cloud | Action loss |
| Suggestion | Behaviour control |
| Mass Suggestion | Behaviour control |
| Geas | Behaviour control/damage punishment |
| Tasha's Hideous Laughter | Prone/incapacitated |
| Web | Restrained |
| Wrathful Smite | Frightened |

---

## Equipment and Magic Items

Equipment and magic items should use the same modifier system as spells and features.

| Item Type | Modifier Examples |
|---|---|
| Armour | Base AC formula, stealth disadvantage, STR requirement |
| Shield | +2 AC |
| Weapon | Damage dice, properties, finesse/ranged/heavy/two-handed |
| Ammunition | Attack/damage changes, consumable tracking |
| Potion | Temporary effect, healing, resistance, size/speed/etc. |
| Scroll | Spell grant/one-use casting |
| Magic weapon | Attack/damage bonus, extra dice, crit riders |
| Magic armour/shield | AC bonus, resistance, stealth changes |
| Wondrous item | Ability score setting, flight, invisibility, senses, spellcasting |
| Ring/cloak/robe | AC, saves, resistance, spell DC/attack modifiers |
| Staff/wand/rod | Charges, spell grants, spell attack/DC bonuses |
| Cursed item | Forced states, disadvantage, attunement lock, behaviour constraints |

Examples:

- Ring of Protection: bonus to AC and saving throws.
- Cloak of Protection: bonus to AC and saving throws.
- Belt of Giant Strength: overrides/sets Strength score.
- Headband of Intellect: sets Intelligence score.
- Boots of Speed: speed modifier and disadvantage for opportunity attacks.
- Winged Boots: flying speed.
- Magic weapon +1/+2/+3: attack and damage modifier.
- Magic armour +1/+2/+3: AC modifier.

---

## Stacking Rules

The modifier engine must account for 5E stacking behaviour.

| Rule | Behaviour |
|---|---|
| Advantage/disadvantage do not stack numerically | One or more advantage sources grant advantage; one or more disadvantage sources grant disadvantage; if both exist, they cancel |
| Same spell does not stack with itself | Use the strongest/current one, not duplicates |
| Different named bonuses usually stack | Shield + Haste + cover can all apply if valid |
| AC formulas do not stack | Mage Armour, Unarmoured Defence, Barkskin, etc. compete; choose the applicable formula |
| Resistance does not stack | Resistance halves damage once |
| Vulnerability does not stack | Vulnerability doubles damage once |
| Immunity overrides damage | If immune, damage becomes 0 unless special rules apply |
| Temporary HP does not stack | Character chooses which temporary HP pool to keep |
| Concentration is exclusive | One concentration spell at a time by default |
| Predicates matter | Rage damage applies only to melee weapon attacks using Strength |
| Duration matters | Some effects expire at start/end of turn, after one attack, after one save, after concentration ends, or after fixed rounds |
| Source matters | Some effects only apply against certain creature types, damage types, weapons, or conditions |

---

## Recommended Database Tables

These are suggested tables for a SQL-backed implementation.

```sql
CREATE TABLE effect_definitions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    effect_key VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    source_ref VARCHAR(150) NULL,
    description TEXT NULL,
    duration_type VARCHAR(50) NULL,
    duration_rounds INT NULL,
    requires_concentration TINYINT(1) DEFAULT 0,
    is_condition TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

```sql
CREATE TABLE effect_modifiers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    effect_id INT NOT NULL,
    target VARCHAR(150) NOT NULL,
    modifier_type VARCHAR(50) NOT NULL,
    value_expression VARCHAR(255) NULL,
    condition_expression TEXT NULL,
    priority INT DEFAULT 0,
    FOREIGN KEY (effect_id) REFERENCES effect_definitions(id)
);
```

```sql
CREATE TABLE active_character_effects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    character_id INT NOT NULL,
    effect_id INT NOT NULL,
    source_character_id INT NULL,
    remaining_rounds INT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,
    metadata JSON NULL,
    FOREIGN KEY (effect_id) REFERENCES effect_definitions(id)
);
```

```sql
CREATE TABLE character_conditions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    character_id INT NOT NULL,
    condition_key VARCHAR(100) NOT NULL,
    source_effect_id INT NULL,
    remaining_rounds INT NULL,
    metadata JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

```sql
CREATE TABLE character_exhaustion (
    character_id INT PRIMARY KEY,
    exhaustion_level TINYINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

---

## Suggested Modifier Target Names

Use consistent target keys. This will make the engine easier to query and debug.

### Ability Scores

```text
ability.str
ability.dex
ability.con
ability.int
ability.wis
ability.cha
ability_max.str
ability_max.dex
ability_max.con
ability_max.int
ability_max.wis
ability_max.cha
```

### Ability Checks

```text
ability_check.all
ability_check.str
ability_check.dex
ability_check.con
ability_check.int
ability_check.wis
ability_check.cha
```

### Saving Throws

```text
saving_throw.all
saving_throw.str
saving_throw.dex
saving_throw.con
saving_throw.int
saving_throw.wis
saving_throw.cha
saving_throw.death
```

### Skills

```text
skill.all
skill.acrobatics
skill.animal_handling
skill.arcana
skill.athletics
skill.deception
skill.history
skill.insight
skill.intimidation
skill.investigation
skill.medicine
skill.nature
skill.perception
skill.performance
skill.persuasion
skill.religion
skill.sleight_of_hand
skill.stealth
skill.survival
```

### Combat

```text
ac
ac_formula
initiative
attack_roll.all
attack_roll.melee
attack_roll.ranged
attack_roll.spell
attack_roll.weapon
attack_roll.melee_weapon
attack_roll.ranged_weapon
damage_roll.all
damage_roll.weapon
damage_roll.melee_weapon
damage_roll.ranged_weapon
damage_roll.spell
damage_taken.all
damage_taken.bludgeoning
damage_taken.piercing
damage_taken.slashing
damage_taken.fire
damage_taken.cold
damage_taken.lightning
damage_taken.thunder
damage_taken.acid
damage_taken.poison
damage_taken.psychic
damage_taken.necrotic
damage_taken.radiant
damage_taken.force
critical_range
critical_damage
```

### Movement

```text
speed.all
speed.walk
speed.fly
speed.swim
speed.climb
speed.burrow
movement.restriction
movement.difficult_terrain
jump.distance
```

### Resources and Actions

```text
action.standard
action.extra
action.bonus
action.reaction
action.blocked
reaction.available
reaction.trigger
bonus_action.available
spellcasting
concentration
resource.spell_slot
resource.rage
resource.ki
resource.sorcery_point
resource.channel_divinity
resource.bardic_inspiration
```

### Senses and Visibility

```text
sense.darkvision
sense.blindsight
sense.tremorsense
sense.truesight
visibility.self
visibility.targeting
cover
obscurement
```

---

## Suggested Modifier Types

```text
bonus
penalty
set
minimum
maximum
multiplier
divider
advantage
disadvantage
extra_die
reroll
replace_roll
minimum_roll
proficiency_grant
expertise_grant
resistance
vulnerability
immunity
condition_apply
condition_remove
formula_override
grant
deny
block
trigger
reaction_grant
resource_add
resource_spend
resource_restore
```

---

## Example Effect: Rage

```json
{
  "effect_key": "rage",
  "name": "Rage",
  "source_type": "class_feature",
  "source_ref": "barbarian.rage",
  "duration": {
    "type": "timed",
    "rounds": 10
  },
  "requires": [
    "not_wearing_heavy_armour"
  ],
  "modifiers": [
    {
      "target": "ability_check.str",
      "type": "advantage"
    },
    {
      "target": "saving_throw.str",
      "type": "advantage"
    },
    {
      "target": "damage_roll.melee_weapon.str",
      "type": "bonus",
      "value": "rage_damage_bonus"
    },
    {
      "target": "damage_taken.bludgeoning",
      "type": "resistance"
    },
    {
      "target": "damage_taken.piercing",
      "type": "resistance"
    },
    {
      "target": "damage_taken.slashing",
      "type": "resistance"
    },
    {
      "target": "spellcasting",
      "type": "blocked"
    },
    {
      "target": "concentration",
      "type": "blocked"
    }
  ]
}
```

Notes:

- Rage has conditions/predicates.
- Rage damage should only apply to melee weapon attacks using Strength.
- Rage should not apply while wearing heavy armour.
- Rage blocks spellcasting and concentration.

---

## Example Effect: Shield

```json
{
  "effect_key": "shield_spell",
  "name": "Shield",
  "source_type": "spell",
  "source_ref": "spell.shield",
  "duration": {
    "type": "until_start_of_next_turn"
  },
  "trigger": "reaction_when_hit_or_targeted_by_magic_missile",
  "modifiers": [
    {
      "target": "ac",
      "type": "bonus",
      "value": 5
    },
    {
      "target": "spell.magic_missile",
      "type": "immunity"
    }
  ]
}
```

Notes:

- Shield is a reaction.
- It lasts until the start of the caster's next turn.
- It affects the triggering attack and subsequent attacks during the duration.

---

## Example Effect: Haste

```json
{
  "effect_key": "haste",
  "name": "Haste",
  "source_type": "spell",
  "source_ref": "spell.haste",
  "duration": {
    "type": "concentration",
    "max_rounds": 10
  },
  "modifiers": [
    {
      "target": "speed.all",
      "type": "multiplier",
      "value": 2
    },
    {
      "target": "ac",
      "type": "bonus",
      "value": 2
    },
    {
      "target": "saving_throw.dex",
      "type": "advantage"
    },
    {
      "target": "action.extra.haste",
      "type": "grant",
      "allowed_actions": [
        "attack_one_weapon_attack",
        "dash",
        "disengage",
        "hide",
        "use_object"
      ]
    }
  ],
  "on_end": [
    {
      "target": "actions",
      "type": "blocked",
      "duration": "one_turn"
    },
    {
      "target": "movement",
      "type": "blocked",
      "duration": "one_turn"
    }
  ]
}
```

Notes:

- Haste uses concentration.
- Haste grants a restricted extra action.
- Haste has a negative effect when it ends.
- The extra action cannot be treated as a normal full action.

---

## Example Effect: Bless

```json
{
  "effect_key": "bless",
  "name": "Bless",
  "source_type": "spell",
  "source_ref": "spell.bless",
  "duration": {
    "type": "concentration",
    "max_rounds": 10
  },
  "modifiers": [
    {
      "target": "attack_roll.all",
      "type": "extra_die",
      "value": "1d4"
    },
    {
      "target": "saving_throw.all",
      "type": "extra_die",
      "value": "1d4"
    }
  ]
}
```

---

## Example Effect: Poisoned

```json
{
  "effect_key": "condition_poisoned",
  "name": "Poisoned",
  "source_type": "condition",
  "source_ref": "condition.poisoned",
  "duration": {
    "type": "variable"
  },
  "modifiers": [
    {
      "target": "attack_roll.all",
      "type": "disadvantage"
    },
    {
      "target": "ability_check.all",
      "type": "disadvantage"
    }
  ]
}
```

---

## Example Effect: Half Cover

```json
{
  "effect_key": "half_cover",
  "name": "Half Cover",
  "source_type": "environment",
  "source_ref": "cover.half",
  "duration": {
    "type": "while_applicable"
  },
  "modifiers": [
    {
      "target": "ac",
      "type": "bonus",
      "value": 2
    },
    {
      "target": "saving_throw.dex",
      "type": "bonus",
      "value": 2
    }
  ]
}
```

---

## Example Effect: Mage Armour

```json
{
  "effect_key": "mage_armour",
  "name": "Mage Armour",
  "source_type": "spell",
  "source_ref": "spell.mage_armour",
  "duration": {
    "type": "timed",
    "hours": 8
  },
  "requires": [
    "not_wearing_armour"
  ],
  "modifiers": [
    {
      "target": "ac_formula",
      "type": "formula_override",
      "value": "13 + dex_mod"
    }
  ]
}
```

---

## Example Effect: Unarmoured Defence - Barbarian

```json
{
  "effect_key": "barbarian_unarmoured_defence",
  "name": "Unarmoured Defence",
  "source_type": "class_feature",
  "source_ref": "barbarian.unarmoured_defence",
  "duration": {
    "type": "permanent"
  },
  "requires": [
    "not_wearing_armour"
  ],
  "modifiers": [
    {
      "target": "ac_formula",
      "type": "formula_override",
      "value": "10 + dex_mod + con_mod + shield_bonus"
    }
  ]
}
```

---

## Example Effect: Unarmoured Defence - Monk

```json
{
  "effect_key": "monk_unarmoured_defence",
  "name": "Unarmoured Defence",
  "source_type": "class_feature",
  "source_ref": "monk.unarmoured_defence",
  "duration": {
    "type": "permanent"
  },
  "requires": [
    "not_wearing_armour",
    "not_wielding_shield"
  ],
  "modifiers": [
    {
      "target": "ac_formula",
      "type": "formula_override",
      "value": "10 + dex_mod + wis_mod"
    }
  ]
}
```

---

## Suggested Resolution Flow

When calculating a derived value such as AC, attack bonus, damage, save bonus, or speed:

1. Load base character data.
2. Load race/species traits.
3. Load class/subclass features.
4. Load feats.
5. Load equipped items.
6. Load active magic item effects.
7. Load active spells.
8. Load active conditions.
9. Load exhaustion-derived modifiers.
10. Load environmental/combat states.
11. Filter modifiers by predicate/condition.
12. Resolve formula overrides.
13. Apply bonuses/penalties.
14. Apply advantage/disadvantage state.
15. Apply resistance/vulnerability/immunity if resolving damage.
16. Return final calculated value plus an audit trail explaining where it came from.

---

## Audit Trail Requirement

Every calculated value should be explainable.

For example, AC should be able to display:

```text
Base AC: 16 from Chain Mail
Shield: +2
Haste: +2
Shield spell: +5
Half Cover: +2
Final AC: 27
```

For damage:

```text
Longsword damage: 1d8 + STR
Rage bonus: +2
Divine Favour: +1d4 radiant
Great Weapon Master: +10
Final damage expression: 1d8 + STR + 2 + 1d4 radiant + 10
```

This is very important for player trust. If the app silently says `AC 27`, players will ask why. If it explains itself, they will trust it.

---

## Recommended First Test Cases

Build the engine against these first:

1. Rage
2. Haste
3. Shield
4. Bless
5. Poisoned
6. Prone
7. Half Cover / Three-Quarters Cover
8. Mage Armour
9. Barbarian Unarmoured Defence
10. Monk Unarmoured Defence
11. Magic weapon +1
12. Ring of Protection
13. Aid
14. Temporary HP from Heroism or False Life
15. Exhaustion levels 1-6
16. Wild Shape or Polymorph

If these work cleanly, most other D&D 5E effects become data entry rather than custom code.

---

## Implementation Notes

### Avoid Hard-Coding Named Effects

Bad:

```php
if ($effect === 'rage') {
    $damage += 2;
}
```

Better:

```php
foreach ($activeModifiers as $modifier) {
    if (modifierApplies($modifier, $context)) {
        applyModifier($calculation, $modifier);
    }
}
```

Named effects should live in data. The engine should only understand modifier types and targets.

---

### Use Context Objects for Calculations

A modifier only applies if its conditions match the current calculation context.

Example attack context:

```json
{
  "calculation": "damage_roll",
  "attack_type": "melee_weapon",
  "ability_used": "str",
  "weapon_properties": ["versatile"],
  "damage_type": "slashing",
  "is_spell": false,
  "is_critical": false,
  "target_creature_type": "undead"
}
```

This allows effects like Rage, Sneak Attack, Divine Smite, Favoured Enemy, and Great Weapon Master to be evaluated cleanly.

---

### Separate Permanent and Active Effects

Permanent effects:

- Race traits
- Class features
- Feats
- Passive magic item effects
- Proficiencies

Active effects:

- Rage
- Haste
- Shield
- Bless
- Poisoned
- Prone
- Cover
- Temporary item activations
- Monster debuffs

Both should use the same modifier system, but active effects need duration/state tracking.

---

### Support Homebrew from Day One

Since this project is expected to support homebrew/custom systems, avoid making assumptions like:

- Only one type of inspiration exists.
- Only official skills exist.
- Only official damage types exist.
- Only official conditions exist.
- Only official resources exist.
- Only spell slots power abilities.

Where possible, use flexible keys rather than rigid enums.

For example:

```text
resource.vowfire
resource.soulfire
condition.bleeding
condition.burning
modifier.custom.whatever_the_dm_invents_next
```

The DM will invent nonsense. The app should smile politely and survive.

---

## Minimum Viable Modifier Engine

For an initial implementation, support these modifier types first:

- `bonus`
- `penalty`
- `set`
- `formula_override`
- `advantage`
- `disadvantage`
- `extra_die`
- `resistance`
- `vulnerability`
- `immunity`
- `grant`
- `block`
- `condition_apply`
- `condition_remove`

Support these target groups first:

- `ac`
- `ac_formula`
- `speed.*`
- `ability_check.*`
- `saving_throw.*`
- `attack_roll.*`
- `damage_roll.*`
- `damage_taken.*`
- `action.*`
- `spellcasting`
- `concentration`
- `condition.*`

This will cover the majority of common gameplay.

---

## Summary

The character sheet should not try to understand every D&D feature as bespoke logic.

Instead:

1. Represent every buff, debuff, item, feature, spell, condition, and environment rule as an effect.
2. Let each effect contain one or more modifiers.
3. Let modifiers target specific calculated values.
4. Use context to decide whether a modifier applies.
5. Resolve stacking rules consistently.
6. Always provide an audit trail explaining the final number.

This approach should support official D&D 5E 2014 content and leave enough room for extensive homebrew systems.
