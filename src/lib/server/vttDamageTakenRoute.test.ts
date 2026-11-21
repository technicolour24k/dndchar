import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, character: null as any }));
vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/services/characters', () => ({ getCharacterForRoll: async () => mocks.character }));

import { POST } from '../../routes/vtt/api/damage-taken/+server';
import { internalSecretValid } from './internalSecret';

const call = (secret: string | null, body: Record<string, unknown> = {}) =>
  POST({
    request: new Request('http://localhost/vtt/api/damage-taken', {
      method: 'POST',
      headers: secret === null ? {} : { 'x-vtt-internal-secret': secret },
      body: JSON.stringify({ characterId: 'c1', amount: 7, damageType: 'slashing', ...body })
    })
  } as any);

afterEach(() => {
  vi.unstubAllEnvs();
  delete mocks.env.VTT_INTERNAL_SECRET;
  mocks.character = null;
});

describe('POST /vtt/api/damage-taken', () => {
  it('rejects a wrong or missing secret with 401', async () => {
    mocks.env.VTT_INTERNAL_SECRET = 'real-secret';
    expect((await call('wrong-secret!')).status).toBe(401);
    expect((await call('short')).status).toBe(401);
    expect((await call(null)).status).toBe(401);
  });

  it('refuses with 401 when no secret is configured in production, even for the dev fallback string', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call('vtt-internal-dev-secret')).status).toBe(401);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('accepts the dev fallback outside production, and resolves for a character at the table', async () => {
    mocks.character = { campaignId: 'camp', ownerUserId: 'u1', modifierSources: [], classes: [] };
    const res = await call('vtt-internal-dev-secret', { campaignId: 'camp' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ final: 7, steps: [], breakdown: '' });
  });

  it('refuses a character from another campaign, or (Quick room) not owned by the token owner', async () => {
    mocks.character = { campaignId: 'camp', ownerUserId: 'u1', modifierSources: [], classes: [] };
    expect((await call('vtt-internal-dev-secret', { campaignId: 'other' })).status).toBe(403);
    expect((await call('vtt-internal-dev-secret', { ownerId: 'u2' })).status).toBe(403);
    expect((await call('vtt-internal-dev-secret', { ownerId: 'u1' })).status).toBe(200);
  });
});

describe('internalSecretValid', () => {
  it('non-strict still works on the fallback in production (log routes keep logging)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(internalSecretValid('vtt-internal-dev-secret', { route: '/x', nodeEnv: 'production', secret: '' })).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
