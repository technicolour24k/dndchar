-- Decks unit 4 (plans/dndchar/decks): seeds The Deck of Mystical Fate. Additive and idempotent: every insert is
-- guarded, and rerunning changes nothing (an edited deck is never overwritten).
--  * Four condition Containers carry the deck's timed effects. Every link is a 'bonus' (or advantage /
--    disadvantage) modifier with a signed {value} filled in per application (never a 'penalty': failures are
--    negative values), and every condition is stack_behavior 'stack' so separate draws sum instead of refreshing.
--    They are hidden from the player's apply list (isCondition/isSelectable false).
--  * The deck Container and its rules JSON. The JSON between the $deck_rules$ markers must stay identical to
--    MYSTICAL_FATE_RULES in src/lib/rules/decks.fixture.ts (a test compares them).
-- The deck is attached to no campaign: a DM enables it per campaign.
-- To roll back: delete the deck_definitions row, the deck:mystical_fate row, the four condition rows and their links
-- (only if nothing references them), or archive them.

-- 1. Shared modifier definitions. Reuse an existing non-archived one by target and type (system first, oldest first);
--    insert a blank one only when none exists.
INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, is_system)
SELECT wanted.target, wanted.modifier_type, NULL, true
FROM (VALUES ('ac', 'bonus'), ('attack_roll.all', 'bonus'), ('attack_roll.all', 'advantage'), ('attack_roll.all', 'disadvantage'))
  AS wanted(target, modifier_type)
WHERE NOT EXISTS (
  SELECT 1 FROM modifier_definitions existing
  WHERE existing.target = wanted.target AND existing.modifier_type = wanted.modifier_type AND NOT existing.is_archived
)
ON CONFLICT DO NOTHING;

-- 2. The four condition Containers.
INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, is_system, is_archived,
  activation_type, duration_type, duration_rounds, requires_concentration, expiry_boundary, stack_behavior, metadata_json)
SELECT wanted.content_key, 'condition', wanted.name, wanted.description, 'homebrew', true, false,
  'passive', 'rounds', 10, false, wanted.expiry_boundary, 'stack', '{"isCondition": false, "isSelectable": false}'::jsonb
FROM (VALUES
  ('condition:deck_fate_ac', 'Deck of Mystical Fate: AC', 'AC bonus or penalty from a card of the Deck of Mystical Fate. The value is set per draw.', 'round_end'),
  ('condition:deck_fate_hit', 'Deck of Mystical Fate: to hit', 'To-hit bonus or penalty from a card of the Deck of Mystical Fate. The value is set per draw.', 'round_end'),
  ('condition:deck_fate_adv_next', 'King''s Strike: advantage on next attack', 'Advantage on your next attack roll (or until the minute is up).', 'next_attack'),
  ('condition:deck_fate_dis_next', 'King''s Strike (failed): disadvantage on next attack', 'Disadvantage on your next attack roll (or until the minute is up).', 'next_attack')
) AS wanted(content_key, name, description, expiry_boundary)
ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING;

-- 3. Links (carried, priority 0). Exactly one definition per target and type (system first, oldest first).
INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, value_override_expression, priority, sort_order)
SELECT container.id,
  (SELECT m.id FROM modifier_definitions m WHERE m.target = wanted.target AND m.modifier_type = wanted.modifier_type AND NOT m.is_archived
   ORDER BY m.is_system DESC, m.created_at ASC, m.id ASC LIMIT 1),
  'carried', NULLIF(wanted.value_expression, ''), 0, 0
FROM (VALUES
  ('condition:deck_fate_ac', 'ac', 'bonus', '{value}'),
  ('condition:deck_fate_hit', 'attack_roll.all', 'bonus', '{value}'),
  ('condition:deck_fate_adv_next', 'attack_roll.all', 'advantage', ''),
  ('condition:deck_fate_dis_next', 'attack_roll.all', 'disadvantage', '')
) AS wanted(content_key, target, modifier_type, value_expression)
JOIN content_definitions container ON container.content_key = wanted.content_key AND container.content_type = 'condition' AND container.owner_user_id IS NULL
WHERE EXISTS (SELECT 1 FROM modifier_definitions m WHERE m.target = wanted.target AND m.modifier_type = wanted.modifier_type AND NOT m.is_archived)
ON CONFLICT DO NOTHING;

-- 4. The deck Container and its rules.
INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, is_system, is_archived,
  activation_type, requires_concentration, stack_behavior, metadata_json)
VALUES ('deck:mystical_fate', 'deck', 'The Deck of Mystical Fate', $deck_desc$Number Cards (2 - Ace):
Diamonds: Each party member gains the card's value in gold.
Hearts: Each party member gains the card's value in temporary HP.
Clubs: One party member gains the card's value in AC for 1 minute.
Spades: One party member gains the card's value in hit bonus for 1 minute.

Royals (Jack, Queen, King):
Jack (11):
- Diamonds: Bounty of Fortune - Each party member rolls 1d10 and the aggregated result is added to 10 gold for each party member.
- Hearts: Gift of Vitality - Each party member receives 1d10 + 5 healing.
- Clubs: Shield of Valor - Each party member gains +2 to AC for 1 minute.
- Spades: Precision Strike - Each party member gains +2 to hit for 1 minute.
Queen (12):
- Diamonds: Treasure Trove - The party finds a hidden cache containing 10 + 2d10 gold and a minor magical item.
- Hearts: Aura of Healing - Each party member regains 2d10 + 5 HP.
- Clubs: Defender's Aura - Each party member gains +4 to AC for 1 minute.
- Spades: Queen's Blessing - Each party member gains +4 to hit for 1 minute.
King (13):
- Diamonds: King's Ransom - The party receives a windfall of 20 + 3d10 gold and a random magical item.
- Hearts: Royal Recovery - Each party member is healed for 3d10 + 5 HP and cured of one status condition.
- Clubs: King's Shield - Each party member gains +6 to AC for 1 minute and resistance to one type of damage (chosen by the player).
- Spades: King's Strike - Each party member gains +6 to hit for 1 minute and advantage on their next attack roll.
Jokers: Red Joker on gold back = high-powered magic item; Red Joker on black back = cursed item; Black Joker on gold back = powerful enemy; Black Joker on black (silver) back = powerful ally. All DM-adjudicated.

Rules: two decks shuffled together; backs gold or black; gold-backed cards have red and black suits; black-backed cards have red and silver suits. Success = red suit on gold back, or silver suit on black back; otherwise failure, which inverts everything. One draw, full replacement and reshuffle every draw. "One party member" = the drawer. Ace = 1 or 11, player's choice.$deck_desc$, 'homebrew', true, false,
  'passive', false, 'stack', '{}'::jsonb)
ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING;

INSERT INTO deck_definitions (content_id, rules_json)
SELECT id, $deck_rules${
  "version": 1,
  "cardSets": [
    {
      "tags": {
        "back": "gold"
      },
      "suits": [
        {
          "suit": "hearts",
          "colour": "red",
          "label": "Hearts"
        },
        {
          "suit": "diamonds",
          "colour": "red",
          "label": "Diamonds"
        },
        {
          "suit": "clubs",
          "colour": "black",
          "label": "Clubs"
        },
        {
          "suit": "spades",
          "colour": "black",
          "label": "Spades"
        }
      ],
      "ranks": [
        {
          "rank": "A",
          "kind": "number",
          "label": "Ace",
          "value": null,
          "valueOptions": [
            1,
            11
          ]
        },
        {
          "rank": "2",
          "kind": "number",
          "label": "2",
          "value": 2
        },
        {
          "rank": "3",
          "kind": "number",
          "label": "3",
          "value": 3
        },
        {
          "rank": "4",
          "kind": "number",
          "label": "4",
          "value": 4
        },
        {
          "rank": "5",
          "kind": "number",
          "label": "5",
          "value": 5
        },
        {
          "rank": "6",
          "kind": "number",
          "label": "6",
          "value": 6
        },
        {
          "rank": "7",
          "kind": "number",
          "label": "7",
          "value": 7
        },
        {
          "rank": "8",
          "kind": "number",
          "label": "8",
          "value": 8
        },
        {
          "rank": "9",
          "kind": "number",
          "label": "9",
          "value": 9
        },
        {
          "rank": "10",
          "kind": "number",
          "label": "10",
          "value": 10
        },
        {
          "rank": "J",
          "kind": "royal",
          "label": "Jack",
          "value": 11
        },
        {
          "rank": "Q",
          "kind": "royal",
          "label": "Queen",
          "value": 12
        },
        {
          "rank": "K",
          "kind": "royal",
          "label": "King",
          "value": 13
        }
      ],
      "extras": [
        {
          "key": "joker_red",
          "label": "Red Joker",
          "tags": {
            "kind": "joker",
            "colour": "red"
          }
        },
        {
          "key": "joker_black",
          "label": "Black Joker",
          "tags": {
            "kind": "joker",
            "colour": "black"
          }
        }
      ]
    },
    {
      "tags": {
        "back": "black"
      },
      "suits": [
        {
          "suit": "hearts",
          "colour": "red",
          "label": "Hearts"
        },
        {
          "suit": "diamonds",
          "colour": "red",
          "label": "Diamonds"
        },
        {
          "suit": "clubs",
          "colour": "silver",
          "label": "Clubs"
        },
        {
          "suit": "spades",
          "colour": "silver",
          "label": "Spades"
        }
      ],
      "ranks": [
        {
          "rank": "A",
          "kind": "number",
          "label": "Ace",
          "value": null,
          "valueOptions": [
            1,
            11
          ]
        },
        {
          "rank": "2",
          "kind": "number",
          "label": "2",
          "value": 2
        },
        {
          "rank": "3",
          "kind": "number",
          "label": "3",
          "value": 3
        },
        {
          "rank": "4",
          "kind": "number",
          "label": "4",
          "value": 4
        },
        {
          "rank": "5",
          "kind": "number",
          "label": "5",
          "value": 5
        },
        {
          "rank": "6",
          "kind": "number",
          "label": "6",
          "value": 6
        },
        {
          "rank": "7",
          "kind": "number",
          "label": "7",
          "value": 7
        },
        {
          "rank": "8",
          "kind": "number",
          "label": "8",
          "value": 8
        },
        {
          "rank": "9",
          "kind": "number",
          "label": "9",
          "value": 9
        },
        {
          "rank": "10",
          "kind": "number",
          "label": "10",
          "value": 10
        },
        {
          "rank": "J",
          "kind": "royal",
          "label": "Jack",
          "value": 11
        },
        {
          "rank": "Q",
          "kind": "royal",
          "label": "Queen",
          "value": 12
        },
        {
          "rank": "K",
          "kind": "royal",
          "label": "King",
          "value": 13
        }
      ],
      "extras": [
        {
          "key": "joker_red",
          "label": "Red Joker",
          "tags": {
            "kind": "joker",
            "colour": "red"
          }
        },
        {
          "key": "joker_silver",
          "label": "Black (silver) Joker",
          "tags": {
            "kind": "joker",
            "colour": "silver"
          }
        }
      ]
    }
  ],
  "success": {
    "rules": [
      {
        "when": {
          "back": "gold",
          "colour": "red"
        },
        "result": "success"
      },
      {
        "when": {
          "back": "black",
          "colour": "silver"
        },
        "result": "success"
      }
    ],
    "otherwise": "failure"
  },
  "outcomes": [
    {
      "id": "red_joker",
      "when": {
        "kind": "joker",
        "colour": "red"
      },
      "name": "Red Joker",
      "text": "The party gains a high-powered magic item.",
      "inverseText": "The party finds a cursed item.",
      "steps": [
        {
          "type": "dm_prompt",
          "text": "The party gains a high-powered magic item",
          "inverseText": "The party finds a cursed item"
        }
      ]
    },
    {
      "id": "black_joker",
      "when": {
        "kind": "joker"
      },
      "name": "Black Joker",
      "text": "The party gains a powerful ally.",
      "inverseText": "The party encounters a powerful enemy.",
      "steps": [
        {
          "type": "dm_prompt",
          "text": "The party gains a powerful ally",
          "inverseText": "The party encounters a powerful enemy"
        }
      ]
    },
    {
      "id": "jack_diamonds",
      "when": {
        "kind": "royal",
        "rank": "j",
        "suit": "diamonds"
      },
      "name": "Bounty of Fortune",
      "text": "Each party member rolls 1d10 and the aggregated result is added to 10 gold for each party member.",
      "inverseText": "Each party member rolls 1d10 and loses 10 gold plus the aggregated result.",
      "rolls": [
        {
          "name": "party_roll",
          "dice": "1d10",
          "per": "party_member"
        }
      ],
      "steps": [
        {
          "type": "currency",
          "coin": "gp",
          "amount": "10 + {party_roll}",
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "jack_hearts",
      "when": {
        "kind": "royal",
        "rank": "j",
        "suit": "hearts"
      },
      "name": "Gift of Vitality",
      "text": "Each party member receives 1d10 + 5 healing.",
      "inverseText": "Each party member takes 1d10 + 5 damage.",
      "steps": [
        {
          "type": "heal",
          "amount": "1d10+5",
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "jack_clubs",
      "when": {
        "kind": "royal",
        "rank": "j",
        "suit": "clubs"
      },
      "name": "Shield of Valor",
      "text": "Each party member gains +2 to AC for 1 minute.",
      "inverseText": "Each party member suffers -2 to AC for 1 minute.",
      "steps": [
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_ac",
          "params": {
            "value": "2"
          },
          "durationRounds": 10,
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "jack_spades",
      "when": {
        "kind": "royal",
        "rank": "j",
        "suit": "spades"
      },
      "name": "Precision Strike",
      "text": "Each party member gains +2 to hit for 1 minute.",
      "inverseText": "Each party member suffers -2 to hit for 1 minute.",
      "steps": [
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_hit",
          "params": {
            "value": "2"
          },
          "durationRounds": 10,
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "queen_diamonds",
      "when": {
        "kind": "royal",
        "rank": "q",
        "suit": "diamonds"
      },
      "name": "Treasure Trove",
      "text": "The party finds a hidden cache containing 10 + 2d10 gold and a minor magical item.",
      "inverseText": "The party loses 10 + 2d10 gold and a minor magical item.",
      "steps": [
        {
          "type": "currency",
          "coin": "gp",
          "amount": "10+2d10",
          "target": "party_split"
        },
        {
          "type": "dm_prompt",
          "text": "A minor magical item for the party",
          "inverseText": "The party loses a minor magical item"
        }
      ]
    },
    {
      "id": "queen_hearts",
      "when": {
        "kind": "royal",
        "rank": "q",
        "suit": "hearts"
      },
      "name": "Aura of Healing",
      "text": "Each party member regains 2d10 + 5 HP.",
      "inverseText": "Each party member loses 2d10 + 5 HP.",
      "steps": [
        {
          "type": "heal",
          "amount": "2d10+5",
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "queen_clubs",
      "when": {
        "kind": "royal",
        "rank": "q",
        "suit": "clubs"
      },
      "name": "Defender's Aura",
      "text": "Each party member gains +4 to AC for 1 minute.",
      "inverseText": "Each party member suffers -4 to AC for 1 minute.",
      "steps": [
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_ac",
          "params": {
            "value": "4"
          },
          "durationRounds": 10,
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "queen_spades",
      "when": {
        "kind": "royal",
        "rank": "q",
        "suit": "spades"
      },
      "name": "Queen's Blessing",
      "text": "Each party member gains +4 to hit for 1 minute.",
      "inverseText": "Each party member suffers -4 to hit for 1 minute.",
      "steps": [
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_hit",
          "params": {
            "value": "4"
          },
          "durationRounds": 10,
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "king_diamonds",
      "when": {
        "kind": "royal",
        "rank": "k",
        "suit": "diamonds"
      },
      "name": "King's Ransom",
      "text": "The party receives a windfall of 20 + 3d10 gold and a random magical item.",
      "inverseText": "The party loses 20 + 3d10 gold and a random magical item.",
      "steps": [
        {
          "type": "currency",
          "coin": "gp",
          "amount": "20+3d10",
          "target": "party_split"
        },
        {
          "type": "dm_prompt",
          "text": "A random magical item for the party",
          "inverseText": "The party loses a random magical item"
        }
      ]
    },
    {
      "id": "king_hearts",
      "when": {
        "kind": "royal",
        "rank": "k",
        "suit": "hearts"
      },
      "name": "Royal Recovery",
      "text": "Each party member is healed for 3d10 + 5 HP and cured of one status condition.",
      "inverseText": "Each party member takes 3d10 + 5 damage and gains one status condition.",
      "steps": [
        {
          "type": "heal",
          "amount": "3d10+5",
          "target": "each_party_member"
        },
        {
          "type": "dm_prompt",
          "text": "Each party member may be cured of one status condition - remove it by hand",
          "inverseText": "Each party member gains one status condition of the DM's choice"
        }
      ]
    },
    {
      "id": "king_clubs",
      "when": {
        "kind": "royal",
        "rank": "k",
        "suit": "clubs"
      },
      "name": "King's Shield",
      "text": "Each party member gains +6 to AC for 1 minute and resistance to one type of damage (chosen by the player).",
      "inverseText": "Each party member suffers -6 to AC for 1 minute and is vulnerable to one type of damage (chosen by the DM).",
      "steps": [
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_ac",
          "params": {
            "value": "6"
          },
          "durationRounds": 10,
          "target": "each_party_member"
        },
        {
          "type": "dm_prompt",
          "text": "Each party member picks one damage type to resist for 1 minute - add it by hand",
          "inverseText": "Each party member is vulnerable to one damage type of the DM's choice for 1 minute"
        }
      ]
    },
    {
      "id": "king_spades",
      "when": {
        "kind": "royal",
        "rank": "k",
        "suit": "spades"
      },
      "name": "King's Strike",
      "text": "Each party member gains +6 to hit for 1 minute and advantage on their next attack roll.",
      "inverseText": "Each party member suffers -6 to hit for 1 minute and disadvantage on their next attack roll.",
      "steps": [
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_hit",
          "params": {
            "value": "6"
          },
          "durationRounds": 10,
          "target": "each_party_member"
        },
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_adv_next",
          "durationRounds": 10,
          "target": "each_party_member",
          "inverse": {
            "conditionKey": "condition:deck_fate_dis_next"
          }
        }
      ]
    },
    {
      "id": "number_diamonds",
      "when": {
        "kind": "number",
        "suit": "diamonds"
      },
      "name": "Gold",
      "text": "Each party member gains the card's value in gold.",
      "inverseText": "Each party member loses the card's value in gold.",
      "steps": [
        {
          "type": "currency",
          "coin": "gp",
          "amount": "{value}",
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "number_hearts",
      "when": {
        "kind": "number",
        "suit": "hearts"
      },
      "name": "Temporary vitality",
      "text": "Each party member gains the card's value in temporary HP.",
      "inverseText": "Each party member loses the card's value in temporary HP.",
      "steps": [
        {
          "type": "temp_hp",
          "amount": "{value}",
          "target": "each_party_member"
        }
      ]
    },
    {
      "id": "number_clubs",
      "when": {
        "kind": "number",
        "suit": "clubs"
      },
      "name": "Armour",
      "text": "One party member gains the card's value in AC for 1 minute.",
      "inverseText": "One party member loses the card's value in AC for 1 minute.",
      "steps": [
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_ac",
          "params": {
            "value": "{value}"
          },
          "durationRounds": 10,
          "target": "drawer"
        }
      ]
    },
    {
      "id": "number_spades",
      "when": {
        "kind": "number",
        "suit": "spades"
      },
      "name": "Accuracy",
      "text": "One party member gains the card's value in hit bonus for 1 minute.",
      "inverseText": "One party member loses the card's value in hit bonus for 1 minute.",
      "steps": [
        {
          "type": "condition",
          "conditionKey": "condition:deck_fate_hit",
          "params": {
            "value": "{value}"
          },
          "durationRounds": 10,
          "target": "drawer"
        }
      ]
    }
  ]
}$deck_rules$::jsonb
FROM content_definitions WHERE content_key = 'deck:mystical_fate' AND owner_user_id IS NULL
ON CONFLICT (content_id) DO NOTHING;
