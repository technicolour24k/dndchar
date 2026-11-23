import type { DeckRules } from '$lib/types/decks';

// The rules JSON for The Deck of Mystical Fate. Unit 4's seed migration (048) must match this.
// Outcome text is the user's verbatim wording; inverseText is the inverted wording (authored here).

const SUIT_RANKS = [
  { rank: 'A', kind: 'number', label: 'Ace', value: null, valueOptions: [1, 11] },
  ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ rank: String(n), kind: 'number', label: String(n), value: n })),
  { rank: 'J', kind: 'royal', label: 'Jack', value: 11 },
  { rank: 'Q', kind: 'royal', label: 'Queen', value: 12 },
  { rank: 'K', kind: 'royal', label: 'King', value: 13 }
];

const FATE_AC = 'condition:deck_fate_ac';
const FATE_HIT = 'condition:deck_fate_hit';

export const MYSTICAL_FATE_RULES: DeckRules = {
  version: 1,
  cardSets: [
    {
      tags: { back: 'gold' },
      suits: [
        { suit: 'hearts', colour: 'red', label: 'Hearts' }, { suit: 'diamonds', colour: 'red', label: 'Diamonds' },
        { suit: 'clubs', colour: 'black', label: 'Clubs' }, { suit: 'spades', colour: 'black', label: 'Spades' }
      ],
      ranks: SUIT_RANKS,
      extras: [
        { key: 'joker_red', label: 'Red Joker', tags: { kind: 'joker', colour: 'red' } },
        { key: 'joker_black', label: 'Black Joker', tags: { kind: 'joker', colour: 'black' } }
      ]
    },
    {
      tags: { back: 'black' },
      suits: [
        { suit: 'hearts', colour: 'red', label: 'Hearts' }, { suit: 'diamonds', colour: 'red', label: 'Diamonds' },
        { suit: 'clubs', colour: 'silver', label: 'Clubs' }, { suit: 'spades', colour: 'silver', label: 'Spades' }
      ],
      ranks: SUIT_RANKS,
      extras: [
        { key: 'joker_red', label: 'Red Joker', tags: { kind: 'joker', colour: 'red' } },
        { key: 'joker_silver', label: 'Black (silver) Joker', tags: { kind: 'joker', colour: 'silver' } }
      ]
    }
  ],
  success: {
    rules: [
      { when: { back: 'gold', colour: 'red' }, result: 'success' },
      { when: { back: 'black', colour: 'silver' }, result: 'success' }
    ],
    otherwise: 'failure'
  },
  outcomes: [
    {
      id: 'red_joker', when: { kind: 'joker', colour: 'red' }, name: 'Red Joker',
      text: 'The party gains a high-powered magic item.', inverseText: 'The party finds a cursed item.',
      steps: [{ type: 'dm_prompt', text: 'The party gains a high-powered magic item', inverseText: 'The party finds a cursed item' }]
    },
    {
      id: 'black_joker', when: { kind: 'joker' }, name: 'Black Joker',
      text: 'The party gains a powerful ally.', inverseText: 'The party encounters a powerful enemy.',
      steps: [{ type: 'dm_prompt', text: 'The party gains a powerful ally', inverseText: 'The party encounters a powerful enemy' }]
    },
    {
      id: 'jack_diamonds', when: { kind: 'royal', rank: 'j', suit: 'diamonds' }, name: 'Bounty of Fortune',
      text: 'Each party member rolls 1d10 and the aggregated result is added to 10 gold for each party member.',
      inverseText: 'Each party member rolls 1d10 and loses 10 gold plus the aggregated result.',
      rolls: [{ name: 'party_roll', dice: '1d10', per: 'party_member' }],
      steps: [{ type: 'currency', coin: 'gp', amount: '10 + {party_roll}', target: 'each_party_member' }]
    },
    {
      id: 'jack_hearts', when: { kind: 'royal', rank: 'j', suit: 'hearts' }, name: 'Gift of Vitality',
      text: 'Each party member receives 1d10 + 5 healing.', inverseText: 'Each party member takes 1d10 + 5 damage.',
      steps: [{ type: 'heal', amount: '1d10+5', target: 'each_party_member' }]
    },
    {
      id: 'jack_clubs', when: { kind: 'royal', rank: 'j', suit: 'clubs' }, name: 'Shield of Valor',
      text: 'Each party member gains +2 to AC for 1 minute.', inverseText: 'Each party member suffers -2 to AC for 1 minute.',
      steps: [{ type: 'condition', conditionKey: FATE_AC, params: { value: '2' }, durationRounds: 10, target: 'each_party_member' }]
    },
    {
      id: 'jack_spades', when: { kind: 'royal', rank: 'j', suit: 'spades' }, name: 'Precision Strike',
      text: 'Each party member gains +2 to hit for 1 minute.', inverseText: 'Each party member suffers -2 to hit for 1 minute.',
      steps: [{ type: 'condition', conditionKey: FATE_HIT, params: { value: '2' }, durationRounds: 10, target: 'each_party_member' }]
    },
    {
      id: 'queen_diamonds', when: { kind: 'royal', rank: 'q', suit: 'diamonds' }, name: 'Treasure Trove',
      text: 'The party finds a hidden cache containing 10 + 2d10 gold and a minor magical item.',
      inverseText: 'The party loses 10 + 2d10 gold and a minor magical item.',
      steps: [
        { type: 'currency', coin: 'gp', amount: '10+2d10', target: 'party_split' },
        { type: 'dm_prompt', text: 'A minor magical item for the party', inverseText: 'The party loses a minor magical item' }
      ]
    },
    {
      id: 'queen_hearts', when: { kind: 'royal', rank: 'q', suit: 'hearts' }, name: 'Aura of Healing',
      text: 'Each party member regains 2d10 + 5 HP.', inverseText: 'Each party member loses 2d10 + 5 HP.',
      steps: [{ type: 'heal', amount: '2d10+5', target: 'each_party_member' }]
    },
    {
      id: 'queen_clubs', when: { kind: 'royal', rank: 'q', suit: 'clubs' }, name: 'Defender\'s Aura',
      text: 'Each party member gains +4 to AC for 1 minute.', inverseText: 'Each party member suffers -4 to AC for 1 minute.',
      steps: [{ type: 'condition', conditionKey: FATE_AC, params: { value: '4' }, durationRounds: 10, target: 'each_party_member' }]
    },
    {
      id: 'queen_spades', when: { kind: 'royal', rank: 'q', suit: 'spades' }, name: 'Queen\'s Blessing',
      text: 'Each party member gains +4 to hit for 1 minute.', inverseText: 'Each party member suffers -4 to hit for 1 minute.',
      steps: [{ type: 'condition', conditionKey: FATE_HIT, params: { value: '4' }, durationRounds: 10, target: 'each_party_member' }]
    },
    {
      id: 'king_diamonds', when: { kind: 'royal', rank: 'k', suit: 'diamonds' }, name: 'King\'s Ransom',
      text: 'The party receives a windfall of 20 + 3d10 gold and a random magical item.',
      inverseText: 'The party loses 20 + 3d10 gold and a random magical item.',
      steps: [
        { type: 'currency', coin: 'gp', amount: '20+3d10', target: 'party_split' },
        { type: 'dm_prompt', text: 'A random magical item for the party', inverseText: 'The party loses a random magical item' }
      ]
    },
    {
      id: 'king_hearts', when: { kind: 'royal', rank: 'k', suit: 'hearts' }, name: 'Royal Recovery',
      text: 'Each party member is healed for 3d10 + 5 HP and cured of one status condition.',
      inverseText: 'Each party member takes 3d10 + 5 damage and gains one status condition.',
      steps: [
        { type: 'heal', amount: '3d10+5', target: 'each_party_member' },
        {
          type: 'dm_prompt', text: 'Each party member may be cured of one status condition - remove it by hand',
          inverseText: 'Each party member gains one status condition of the DM\'s choice'
        }
      ]
    },
    {
      id: 'king_clubs', when: { kind: 'royal', rank: 'k', suit: 'clubs' }, name: 'King\'s Shield',
      text: 'Each party member gains +6 to AC for 1 minute and resistance to one type of damage (chosen by the player).',
      inverseText: 'Each party member suffers -6 to AC for 1 minute and is vulnerable to one type of damage (chosen by the DM).',
      steps: [
        { type: 'condition', conditionKey: FATE_AC, params: { value: '6' }, durationRounds: 10, target: 'each_party_member' },
        {
          type: 'dm_prompt', text: 'Each party member picks one damage type to resist for 1 minute - add it by hand',
          inverseText: 'Each party member is vulnerable to one damage type of the DM\'s choice for 1 minute'
        }
      ]
    },
    {
      id: 'king_spades', when: { kind: 'royal', rank: 'k', suit: 'spades' }, name: 'King\'s Strike',
      text: 'Each party member gains +6 to hit for 1 minute and advantage on their next attack roll.',
      inverseText: 'Each party member suffers -6 to hit for 1 minute and disadvantage on their next attack roll.',
      steps: [
        { type: 'condition', conditionKey: FATE_HIT, params: { value: '6' }, durationRounds: 10, target: 'each_party_member' },
        {
          type: 'condition', conditionKey: 'condition:deck_fate_adv_next', durationRounds: 10, target: 'each_party_member',
          inverse: { conditionKey: 'condition:deck_fate_dis_next' }
        }
      ]
    },
    {
      id: 'number_diamonds', when: { kind: 'number', suit: 'diamonds' }, name: 'Gold',
      text: 'Each party member gains the card\'s value in gold.', inverseText: 'Each party member loses the card\'s value in gold.',
      steps: [{ type: 'currency', coin: 'gp', amount: '{value}', target: 'each_party_member' }]
    },
    {
      id: 'number_hearts', when: { kind: 'number', suit: 'hearts' }, name: 'Temporary vitality',
      text: 'Each party member gains the card\'s value in temporary HP.', inverseText: 'Each party member loses the card\'s value in temporary HP.',
      steps: [{ type: 'temp_hp', amount: '{value}', target: 'each_party_member' }]
    },
    {
      id: 'number_clubs', when: { kind: 'number', suit: 'clubs' }, name: 'Armour',
      text: 'One party member gains the card\'s value in AC for 1 minute.', inverseText: 'One party member loses the card\'s value in AC for 1 minute.',
      steps: [{ type: 'condition', conditionKey: FATE_AC, params: { value: '{value}' }, durationRounds: 10, target: 'drawer' }]
    },
    {
      id: 'number_spades', when: { kind: 'number', suit: 'spades' }, name: 'Accuracy',
      text: 'One party member gains the card\'s value in hit bonus for 1 minute.', inverseText: 'One party member loses the card\'s value in hit bonus for 1 minute.',
      steps: [{ type: 'condition', conditionKey: FATE_HIT, params: { value: '{value}' }, durationRounds: 10, target: 'drawer' }]
    }
  ]
};
