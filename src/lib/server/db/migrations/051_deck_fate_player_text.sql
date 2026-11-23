-- VTT feedback unit 1 (plans/dndchar/vtt-feedback): player-facing wording for the two jokers of the Deck of
-- Mystical Fate. Players see "The party finds an item." / "The party encounters someone." with no Success or
-- Failure, and "Waiting on the DM." for the task. The DM still sees the full text.
--  * Updates the GLOBAL seed only (content_key 'deck:mystical_fate', scope 'global'). Campaign copies, personal
--    decks and library copies are DM-owned data and are left alone on purpose; a DM adds playerText, hideSuccess
--    and hideFromPlayers in the deck editor.
--  * The deck DESCRIPTION is player-visible and its Jokers line spelled out every joker result (including the cursed
--    item), so the same migration replaces that line with a vague one. Same global-only rule.
--  * Idempotent: it sets the rules to a fixed value, so rerunning changes nothing.
--  * The JSON in the UPDATE below must stay identical to MYSTICAL_FATE_RULES in
--    src/lib/rules/decks.fixture.ts (a test compares them).
-- To roll back: rerun this statement with the JSON from 048_seed_deck_of_mystical_fate.sql (global decks are
-- read-only, so nothing a DM edited is overwritten).
UPDATE deck_definitions d
SET rules_json = $deck_rules${
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
          "inverseText": "The party finds a cursed item",
          "hideFromPlayers": true
        }
      ],
      "playerText": "The party finds an item.",
      "hideSuccess": true
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
          "inverseText": "The party encounters a powerful enemy",
          "hideFromPlayers": true
        }
      ],
      "playerText": "The party encounters someone.",
      "hideSuccess": true
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
}$deck_rules$::jsonb, updated_at = now()
FROM content_definitions c
WHERE c.id = d.content_id AND c.content_key = 'deck:mystical_fate' AND c.scope = 'global'
  AND c.owner_user_id IS NULL AND d.campaign_id IS NULL;

-- The description's last line named every joker outcome; players can read the description, so make it vague.
UPDATE content_definitions c
SET description = regexp_replace(c.description, 'Jokers: .*$', 'Jokers: the DM decides what they bring, and the table is only told a general result.'),
    updated_at = now()
FROM deck_definitions d
WHERE c.id = d.content_id AND c.content_key = 'deck:mystical_fate' AND c.scope = 'global'
  AND c.owner_user_id IS NULL AND d.campaign_id IS NULL;
