import type { CharacterClass, CharacterListItem } from '$lib/types/character';

// 'dm' is the PRIMARY DM, 'co_dm' the single co-DM. Site admin is not a role (it is an override).
export type CampaignRole = 'dm' | 'co_dm' | 'player';

export type Campaign = {
  id: string;
  name: string;
  description: string;
  inviteCode: string;
  roomCode: string;
  createdByUserId: string | null;
  isArchived: boolean;
  createdAt: string;
};

export type CampaignMember = {
  userId: string;
  displayName: string;
  role: CampaignRole;
  joinedAt: string;
};

export type CampaignCharacter = {
  id: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
  partyActive: boolean;
  classes: CharacterClass[];
  hpCurrent: number;
  hpMax: number;
};

export type CampaignSummary = {
  id: string;
  name: string;
  myRole: CampaignRole | null;
  isArchived: boolean;
  memberCount: number;
  characterCount: number;
  dmName: string | null;
};

export type CampaignListPage = {
  items: CampaignSummary[];
  total: number;
  page: number;
  pageCount: number;
  q: string;
  includeArchived: boolean;
};

// Other people's characters in one of the user's campaigns, for the roster's "Campaign characters".
export type CampaignCharacterGroup = {
  campaignId: string;
  campaignName: string;
  characters: (CharacterListItem & { ownerName: string })[];
};

// One of the user's own characters in the "add your character" picker, with where it is now.
export type CampaignCharacterOption = {
  id: string;
  name: string;
  campaignId: string | null;
  campaignName: string | null;
};

// One row of the VTT character picker in a campaign room (id, name, owner, class summary and HP).
export type CampaignPickerCharacter = {
  id: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
  classes: CharacterClass[];
  hpCurrent: number;
  hpMax: number;
};
