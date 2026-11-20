import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCampaignClient } from '../../../static/vtt-app/campaign.js';
import { STABLE_JOIN_MS } from '../../../static/vtt-app/shared/campaignJoin.js';

// The stateful half of the campaign table client (static/vtt-app/campaign.js), driven with fake
// timers, a fake fetch and a tiny fake DOM. The pure decisions are in vttCampaignClient.test.ts; this
// checks the things that depend on ORDER: a takeover is never repeated by a later reconnect, a
// replaced tab doesn't win the seat back on refresh, and back-off only resets after a stable join.

const ID = '22222222-2222-4222-8222-222222222222';

// --- Fakes ------------------------------------------------------------------------------------

function fakeElement() {
  const handlers: Record<string, () => void> = {};
  let text = '';
  const el: any = {
    style: {},
    hidden: false,
    className: '',
    children: [] as any[],
    classList: { add: vi.fn(), remove: vi.fn() },
    addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; },
    click: () => handlers.click?.(),
    appendChild(child: any) { el.children.push(child); },
    querySelectorAll: () => [],
    get textContent() { return text; },
    // Setting text clears children, like the real DOM (the notice rebuilds its buttons that way).
    set textContent(value: string) { text = value; el.children = []; }
  };
  return el;
}

let elements: Record<string, any>;
let tickets: Array<{ status: number; body: any }>;
let ticketBodies: any[];
let storage: Map<string, string>;
let replaceState: ReturnType<typeof vi.fn>;

function setup(role: 'gm' | 'player', { reload = false } = {}) {
  elements = {};
  ticketBodies = [];
  tickets = [];
  storage = new Map();
  replaceState = vi.fn();
  if (reload) storage.set(`vtt_campaign_open_${ID}`, '1');
  vi.stubGlobal('document', {
    getElementById: (id: string) => (elements[id] ??= fakeElement()),
    createElement: () => fakeElement()
  });
  vi.stubGlobal('location', {
    search: `?campaignId=${ID}&role=${role}`,
    href: `http://localhost/vtt-app/index.html?campaignId=${ID}&role=${role}`
  });
  vi.stubGlobal('history', { replaceState });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); }
  });
  vi.stubGlobal('fetch', async (_url: string, init: any) => {
    ticketBodies.push(JSON.parse(init.body));
    const next = tickets.shift() ?? { status: 200, body: okTicket(JSON.parse(init.body).role) };
    return { ok: next.status >= 200 && next.status < 300, status: next.status, redirected: false, json: async () => next.body };
  });
  const deps = { connect: vi.fn(), closeSocket: vi.fn(), setIdentity: vi.fn() };
  const client = createCampaignClient(deps);
  return { client, deps };
}

const okTicket = (role: string) => ({ sessionId: 'ROOM1234', ticket: `t-${Math.random()}`, role, campaignName: 'Camp', userId: 'u1', displayName: 'Ada' });
// Let the awaiting fetch inside connectCampaign finish.
const settle = () => vi.advanceTimersByTimeAsync(0);
// The notice card's buttons, by label order.
const noticeButtons = () => elements.campaignNoticeActions.children;
const lastBody = () => ticketBodies[ticketBodies.length - 1];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// --- Tests ------------------------------------------------------------------------------------

describe('takeover is never repeated by a later reconnect (W1)', () => {
  it('after a deliberate co-DM takeover, a dropped connection reconnects WITHOUT takeoverOf', async () => {
    const { client, deps } = setup('gm');
    client.start();
    await settle();
    expect(lastBody()).toEqual({ role: 'gm', takeoverOf: null });

    // The co-DM holds the seat: the primary DM is asked, and presses "Take over".
    client.onJoinError({ reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'other' });
    expect(noticeButtons().length).toBe(3);
    noticeButtons()[0].click();
    await settle();
    expect(lastBody()).toEqual({ role: 'gm', takeoverOf: 'co' });
    client.onJoined();

    // Network drop later: the retry must ask who holds the seat now, not displace anybody.
    client.onClose(1006);
    await vi.advanceTimersByTimeAsync(1500);
    expect(lastBody()).toEqual({ role: 'gm', takeoverOf: null });
    expect(deps.connect).toHaveBeenCalledTimes(3);
  });

  it('a fresh-ticket retry of the SAME attempt keeps its takeover', async () => {
    const { client } = setup('gm');
    client.start();
    await settle();
    client.onJoinError({ reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'other' });
    noticeButtons()[0].click();
    await settle();
    client.onJoinError({ reason: 'bad_ticket' });
    await settle();
    expect(lastBody()).toEqual({ role: 'gm', takeoverOf: 'co' });
  });

  it('own stale socket on a reload: quiet takeoverOf self; on a fresh open it asks first', async () => {
    const reloaded = setup('gm', { reload: true });
    reloaded.client.start();
    await settle();
    reloaded.client.onJoinError({ reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'self' });
    await settle();
    expect(lastBody()).toEqual({ role: 'gm', takeoverOf: 'self' });

    const fresh = setup('gm');
    fresh.client.start();
    await settle();
    fresh.client.onJoinError({ reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'self' });
    expect(ticketBodies.length).toBe(1); // no quiet takeover
    expect(elements.campaignNoticeText.textContent).toMatch(/already have this table open elsewhere/);
    noticeButtons()[0].click();
    await settle();
    expect(lastBody()).toEqual({ role: 'gm', takeoverOf: 'self' });
  });

  it('a co-DM holding the seat is asked about even on an automatic reconnect', async () => {
    const { client } = setup('gm', { reload: true });
    client.start();
    await settle();
    client.onJoinError({ reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'other' });
    expect(ticketBodies.length).toBe(1);
    expect(elements.campaignNoticeTitle.textContent).toMatch(/co-DM/);
  });
});

describe('a replaced tab stays replaced (W3)', () => {
  it('forgets the reload marker, makes the URL a player link and rejoins as a player', async () => {
    const { client } = setup('gm', { reload: true });
    client.start();
    await settle();
    client.onJoined();
    expect(storage.get(`vtt_campaign_open_${ID}`)).toBe('1');

    client.onGmReplaced();
    expect(storage.has(`vtt_campaign_open_${ID}`)).toBe(false);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(String(replaceState.mock.calls[0][2])).toContain('role=player');
    // The close that follows the message doesn't start a second reconnect.
    client.onClose(4002);
    await vi.advanceTimersByTimeAsync(300);
    expect(ticketBodies.length).toBe(2);
    expect(lastBody()).toEqual({ role: 'player', takeoverOf: null });
  });

  it('choosing Open as player also makes the URL a player link', async () => {
    const { client } = setup('gm');
    client.start();
    await settle();
    client.onJoinError({ reason: 'gm_already_claimed' });
    noticeButtons()[0].click(); // "Open as player"
    await settle();
    expect(String(replaceState.mock.calls[0][2])).toContain('role=player');
    expect(lastBody().role).toBe('player');
  });
});

describe('reconnect back-off', () => {
  it('a join-then-close flap keeps backing off instead of resetting to the fast pace', async () => {
    const { client } = setup('player');
    client.start();
    await settle();
    const gaps: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      client.onJoined();
      await vi.advanceTimersByTimeAsync(1000); // closes well inside the stable window
      client.onClose(1006);
      const before = ticketBodies.length;
      let waited = 0;
      while (ticketBodies.length === before && waited < 10000) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      gaps.push(waited);
    }
    // 1.5s for the first three attempts, then slower.
    expect(gaps.slice(0, 3).every((g) => g <= 1600)).toBe(true);
    expect(gaps[3]).toBeGreaterThan(4000);
  });

  it('a join that stays up for the stable window resets the pace', async () => {
    const { client } = setup('player');
    client.start();
    await settle();
    // Burn some attempts first.
    for (let i = 0; i < 3; i += 1) {
      client.onJoined();
      await vi.advanceTimersByTimeAsync(500);
      client.onClose(1006);
      await vi.advanceTimersByTimeAsync(1600);
    }
    client.onJoined();
    await vi.advanceTimersByTimeAsync(STABLE_JOIN_MS + 100);
    client.onClose(1006);
    const before = ticketBodies.length;
    await vi.advanceTimersByTimeAsync(1600);
    expect(ticketBodies.length).toBe(before + 1);
  });
});

describe('other flows', () => {
  it('a logged-out ticket fetch offers a sign-in that returns to the table, and does not retry', async () => {
    const { client } = setup('gm');
    tickets.push({ status: 401, body: null });
    client.start();
    await settle();
    expect(elements.campaignNoticeText.textContent).toBe('Your login has expired - sign in again.');
    const loc: any = (globalThis as any).location;
    noticeButtons()[0].click();
    expect(loc.href).toContain('/login?next=');
    expect(decodeURIComponent(loc.href)).toContain(`campaignId=${ID}`);
    await vi.advanceTimersByTimeAsync(20000);
    expect(ticketBodies.length).toBe(1);
  });

  it('removed from the campaign stops for good: no retry, marker forgotten', async () => {
    const { client } = setup('player', { reload: true });
    client.start();
    await settle();
    client.onJoined();
    client.onKicked('removed_from_campaign');
    client.onClose(4001);
    await vi.advanceTimersByTimeAsync(20000);
    expect(ticketBodies.length).toBe(1);
    expect(storage.has(`vtt_campaign_open_${ID}`)).toBe(false);
    expect(elements.campaignNoticeText.textContent).toMatch(/no longer in this campaign/);
  });

  it('a demoted GM kicked for role_changed falls back to a player ticket', async () => {
    const { client } = setup('gm');
    client.start();
    await settle();
    client.onJoined();
    tickets.push({ status: 403, body: { error: 'not_dm' } });
    client.onKicked('role_changed');
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(ticketBodies.map((b) => b.role)).toEqual(['gm', 'gm', 'player']);
  });
});
