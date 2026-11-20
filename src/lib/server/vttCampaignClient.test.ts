import { describe, expect, it } from 'vitest';
// The same file the browser loads (the VTT client is unbundled), tested from here.
import {
  ACTION_LABELS, GM_REPLACED_MESSAGE, NOT_DM_MESSAGE, REMOVED_MESSAGE, describeJoinError, describeKick,
  describeTicketFailure, loginHref, readCampaignParams, reconnectPlan, tableHref as clientTableHref
} from '../../../static/vtt-app/shared/campaignJoin.js';
import { canOpenAsGm, quickRoomHref, tableHref } from '$lib/campaigns/vttLinks';

const ID = '22222222-2222-4222-8222-222222222222';

describe('readCampaignParams', () => {
  it('reads a campaign id and role', () => {
    expect(readCampaignParams(`?campaignId=${ID}&role=gm`)).toEqual({ campaignId: ID, role: 'gm' });
    expect(readCampaignParams(`?campaignId=${ID}&role=player`)).toEqual({ campaignId: ID, role: 'player' });
  });
  it('defaults to player, and treats anything but gm as player', () => {
    expect(readCampaignParams(`?campaignId=${ID}`)?.role).toBe('player');
    expect(readCampaignParams(`?campaignId=${ID}&role=admin`)?.role).toBe('player');
  });
  it('is not a campaign table without a valid id (Quick rooms stay as they were)', () => {
    expect(readCampaignParams('')).toBeNull();
    expect(readCampaignParams('?playerId=a&playerName=b')).toBeNull();
    expect(readCampaignParams('?campaignId=nonsense&role=gm')).toBeNull();
  });
});

describe('table links', () => {
  const user = { id: 'u-1', name: 'Ada Lovelace' };
  it('the lobby link and the browser copy agree, and round-trip through readCampaignParams', () => {
    const href = tableHref(ID, 'gm', user);
    expect(href).toBe(clientTableHref(ID, 'gm', user));
    expect(href.startsWith('/vtt-app/index.html?')).toBe(true);
    const search = href.slice(href.indexOf('?'));
    expect(readCampaignParams(search)).toEqual({ campaignId: ID, role: 'gm' });
    expect(new URLSearchParams(search).get('playerName')).toBe('Ada Lovelace');
  });
  it('the Quick room link carries no campaign', () => {
    const href = quickRoomHref(user);
    expect(readCampaignParams(href.slice(href.indexOf('?')))).toBeNull();
  });
  it('only DMs get an Open as DM link', () => {
    expect(canOpenAsGm('dm')).toBe(true);
    expect(canOpenAsGm('co_dm')).toBe(true);
    expect(canOpenAsGm('player')).toBe(false);
    expect(canOpenAsGm(null)).toBe(false);
  });
});

describe('describeTicketFailure', () => {
  it('a DM who was demoted falls back to a player ticket, with a message', () => {
    expect(describeTicketFailure({ status: 403, error: 'not_dm', requestedRole: 'gm' })).toEqual({ kind: 'fallback_player', message: NOT_DM_MESSAGE });
  });
  it('not a member (removed, or archived) stops for good', () => {
    const f = describeTicketFailure({ status: 403, error: 'not_member', requestedRole: 'player' });
    expect(f.kind).toBe('stop');
    expect(f.message).toBe(REMOVED_MESSAGE);
    // Even a gm request that is refused for membership is a stop, not a fallback.
    expect(describeTicketFailure({ status: 403, error: 'not_member', requestedRole: 'gm' }).kind).toBe('stop');
  });
  it('an unknown campaign stops with its own message', () => {
    const f = describeTicketFailure({ status: 404, error: 'campaign_not_found', requestedRole: 'player' });
    expect(f.kind).toBe('stop');
    expect(f.message).toMatch(/couldn't be found/);
  });
  it('a dead network or a 5xx retries; a login redirect (401) offers sign in', () => {
    expect(describeTicketFailure({ status: 0, error: undefined, requestedRole: 'gm' }).kind).toBe('retry');
    expect(describeTicketFailure({ status: 503, error: undefined, requestedRole: 'gm' }).kind).toBe('retry');
    const login = describeTicketFailure({ status: 401, error: undefined, requestedRole: 'gm' });
    expect(login.kind).toBe('login');
    expect(login.actions).toEqual(['signin', 'lobby']);
  });
});

describe('describeJoinError', () => {
  it('bad_ticket gets one fresh-ticket retry, then stops with the plain message', () => {
    expect(describeJoinError({ reason: 'bad_ticket' }, { ticketRetried: false }).kind).toBe('retry_ticket');
    const second = describeJoinError({ reason: 'bad_ticket' }, { ticketRetried: true });
    expect(second.kind).toBe('stop');
    expect(second.actions).toEqual(['lobby']);
  });
  it('ticket_required never retries', () => {
    expect(describeJoinError({ reason: 'ticket_required' }, { ticketRetried: false }).kind).toBe('stop');
  });
  it('our own stale socket holds the seat: automatic reconnects take over quietly, a fresh open asks', () => {
    const msg = { reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'self' };
    expect(describeJoinError(msg, { auto: true })).toEqual({ kind: 'takeover', takeoverOf: 'self' });
    const asked = describeJoinError(msg, { auto: false });
    expect(asked.kind).toBe('prompt');
    expect(asked.message).toMatch(/already have this table open elsewhere/);
    expect(asked.actions).toContain('takeover');
    expect(asked.takeoverOf).toBe('self');
  });
  it('the co-DM holds the seat: always asks (never takes over silently), even on a reconnect', () => {
    const msg = { reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'other' };
    for (const auto of [true, false]) {
      const result = describeJoinError(msg, { auto });
      expect(result.kind).toBe('prompt');
      expect(result.title).toMatch(/co-DM/);
      expect(result.actions).toEqual(['takeover', 'player', 'lobby']);
      expect(result.takeoverOf).toBe('co');
    }
    // An older server without heldBy is treated as somebody else (asks).
    expect(describeJoinError({ reason: 'gm_seat_taken', canTakeOver: true }, { auto: true }).kind).toBe('prompt');
  });
  it('gm_already_claimed offers the player view, never a takeover', () => {
    const result = describeJoinError({ reason: 'gm_already_claimed' }, {});
    expect(result.title).toBe('The DM is running this table');
    expect(result.actions).toEqual(['player', 'lobby']);
    // gm_seat_taken without canTakeOver is the same answer.
    expect(describeJoinError({ reason: 'gm_seat_taken' }, {}).actions).toEqual(['player', 'lobby']);
  });
  it('every action name has a label, and unknown reasons stop with the reason shown', () => {
    for (const reason of ['bad_ticket', 'gm_seat_taken', 'gm_already_claimed', 'whatever']) {
      const r = describeJoinError({ reason, canTakeOver: true, heldBy: 'other' }, { ticketRetried: true });
      for (const name of r.actions ?? []) expect((ACTION_LABELS as Record<string, string>)[name]).toBeTruthy();
    }
    expect(describeJoinError({ reason: 'whatever' }, {}).message).toMatch(/whatever/);
  });
});

describe('describeKick', () => {
  it('removal (or archive) stops and says so', () => {
    const k = describeKick('removed_from_campaign');
    expect(k.kind).toBe('stop');
    expect(k.message).toBe(REMOVED_MESSAGE);
    expect(k.message).toMatch(/no longer in this campaign/);
  });
  it('a role change reconnects', () => {
    expect(describeKick('role_changed').kind).toBe('reconnect');
  });
  it('anything else stops, but offers a retry', () => {
    const k = describeKick('mystery');
    expect(k.kind).toBe('stop');
    expect(k.actions).toContain('retry');
  });
  it('the messages are friendly and have no em dash or curly quote', () => {
    expect(GM_REPLACED_MESSAGE).toMatch(/DM has taken the GM seat/);
    for (const text of [GM_REPLACED_MESSAGE, REMOVED_MESSAGE, NOT_DM_MESSAGE]) expect(text).not.toMatch(/—|’/);
  });
});

describe('loginHref', () => {
  it('returns to the table after sign in, through the login next flow', () => {
    const href = loginHref(ID, 'gm');
    expect(href.startsWith('/login?next=')).toBe(true);
    expect(decodeURIComponent(href.slice('/login?next='.length))).toBe('/vtt-app/index.html?campaignId=' + ID + '&role=gm');
  });
});

describe('reconnectPlan', () => {
  it('a table we were joined to keeps trying, slowing down', () => {
    expect(reconnectPlan({ everJoined: true, attempt: 0 })).toEqual({ delayMs: 1500 });
    expect(reconnectPlan({ everJoined: true, attempt: 50 })).toEqual({ delayMs: 5000 });
  });
  it('one we never reached gives up after a few tries', () => {
    expect(reconnectPlan({ everJoined: false, attempt: 4 })).toEqual({ delayMs: 5000 });
    expect(reconnectPlan({ everJoined: false, attempt: 5 })).toEqual({ giveUp: true });
  });
});
