import type { CampaignRole } from '$lib/types/campaign';
import type { OverworldColour, OverworldIcon } from '$lib/overworld/palette';

export type OverworldVisibility = 'everyone' | 'private';
export type PinKind = 'pin' | 'party';

// A point on a map as fractions of the image: 0..1 across and down.
export type Pt = { x: number; y: number };
// The image's natural size in pixels.
export type Dims = { width: number; height: number };

// Who is looking, as far as the access rules care. `role` is the real campaign role (null for a
// non-member). The site admin flag is deliberately absent: it plays no part in the overworld.
export type OverworldViewer = {
  userId: string;
  role: CampaignRole | null;
  campaignArchived: boolean;
};

// The parts of a pin or route the access rules look at.
export type ItemFacts = {
  kind?: PinKind;
  visibility: OverworldVisibility;
  dmLocked: boolean;
  createdByUserId: string | null;
};

// The parts of a map the access rules look at.
export type MapFacts = {
  grantedAt: string | null;
  archivedAt: string | null;
};

export type OverworldMap = {
  id: string;
  campaignId: string;
  name: string;
  imageFile: string;
  imageWidth: number;
  imageHeight: number;
  imageBytes: number;
  milesAcross: number | null;
  grantedAt: string | null;
  archivedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OverworldPin = {
  id: string;
  mapId: string;
  kind: PinKind;
  x: number;
  y: number;
  label: string;
  note: string;
  colour: OverworldColour;
  icon: OverworldIcon;
  visibility: OverworldVisibility;
  dmLocked: boolean;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OverworldRouteLeg = {
  id: string;
  routeId: string;
  seq: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type OverworldRoute = {
  id: string;
  mapId: string;
  label: string;
  colour: OverworldColour;
  visibility: OverworldVisibility;
  dmLocked: boolean;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

// What the server sends to the client for one item: the row plus the per-viewer answers, so the
// client only has to hide buttons (every action re-checks on the server).
export type ItemViewFlags = {
  createdByName: string | null;
  canEdit: boolean;
  canChangeVisibility: boolean;
};

export type OverworldErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'limit'
  | 'invalid'
  | 'route_changed'
  | 'archived'
  | 'bad_image'
  | 'too_large'
  | 'length_required';

// ---- What the overworld service hands to page loaders (Units C onwards) ----

export type MapListItem = {
  id: string;
  name: string;
  // False = DMs only ("Not shared yet").
  granted: boolean;
  imageUrl: string;
  // Pins this viewer can see.
  pinCount: number;
  // For the DM settings forms (scale shown, and the replace-image shape warning).
  imageWidth: number;
  imageHeight: number;
  milesAcross: number | null;
};

// The values of the pin form (a new pin, or an existing one being edited).
export type PinDraft = {
  kind: PinKind;
  label: string;
  note: string;
  colour: OverworldColour;
  icon: OverworldIcon;
  visibility: OverworldVisibility;
};

export type MapList = {
  viewer: { canManage: boolean };
  maps: MapListItem[];
};

export type PinView = OverworldPin & ItemViewFlags;
export type RouteView = OverworldRoute & ItemViewFlags & { legs: OverworldRouteLeg[] };

export type MapView = {
  map: OverworldMap & { imageUrl: string };
  viewer: { canManage: boolean; canCreatePin: boolean; canCreateParty: boolean };
  pins: PinView[];
  routes: RouteView[];
};
