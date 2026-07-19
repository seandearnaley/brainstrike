import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
  assistantModuleLoaded: vi.fn(),
  getStatus: vi.fn(),
  postAssistant: vi.fn(),
}));

vi.mock('../app/api/assistant/route.js', () => {
  routeMocks.assistantModuleLoaded();
  return {
    POST: routeMocks.postAssistant,
  };
});

vi.mock('../app/api/assistant/status/route', () => ({
  GET: routeMocks.getStatus,
}));

import { POST } from '../../api/assistant';
import { GET } from '../../api/assistant/status';

describe('Vercel assistant entrypoints', () => {
  beforeEach(() => {
    routeMocks.getStatus.mockClear();
    routeMocks.postAssistant.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    undefined,
    'production',
  ])('fails closed without delegating the assistant request in %s', async (vercelEnvironment) => {
    vi.stubEnv('VERCEL_ENV', vercelEnvironment);
    const request = new Request('https://example.test/api/assistant', {
      body: JSON.stringify({ messages: [] }),
      method: 'POST',
    });

    const response = await POST(request);

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'assistant_disabled',
      reason: 'production_auth_required',
    });
    expect(routeMocks.assistantModuleLoaded).not.toHaveBeenCalled();
    expect(routeMocks.postAssistant).not.toHaveBeenCalled();
  });

  it('delegates assistant requests unchanged in a protected preview', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const expected = new Response('stream');
    routeMocks.postAssistant.mockResolvedValue(expected);
    const request = new Request('https://example.test/api/assistant', {
      body: JSON.stringify({ messages: [] }),
      method: 'POST',
    });

    await expect(POST(request)).resolves.toBe(expected);
    expect(routeMocks.postAssistant).toHaveBeenCalledWith(request);
  });

  it.each([
    undefined,
    'production',
  ])('reports the assistant disabled without delegating status in %s', async (vercelEnvironment) => {
    vi.stubEnv('VERCEL_ENV', vercelEnvironment);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      reason: 'production_auth_required',
    });
    expect(routeMocks.getStatus).not.toHaveBeenCalled();
  });

  it('delegates assistant status unchanged in a protected preview', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const expected = Response.json({ enabled: true });
    routeMocks.getStatus.mockResolvedValue(expected);

    await expect(GET()).resolves.toBe(expected);
    expect(routeMocks.getStatus).toHaveBeenCalledOnce();
  });
});
