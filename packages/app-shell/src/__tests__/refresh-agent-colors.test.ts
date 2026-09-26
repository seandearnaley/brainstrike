import { afterEach, describe, expect, it, vi } from 'vitest';
import { canRefreshAgentColors, refreshAgentColors } from '../refresh-agent-colors';

vi.mock('@brainstrike/assistant-contract', () => ({
  getAssistantBridge: () => ({
    getAuth: async () => ({ token: 'token' }),
    getUrl: async () => 'http://assistant.test',
  }),
}));
vi.mock('@brainstrike/assistant-data', () => ({
  resolveAssistantAuthHeaders: async () => ({ 'x-brainstrike-assistant-token': 'token' }),
}));
vi.mock('../hooks/use-assistant-availability', () => ({
  resolveAssistantBaseUrl: async () => 'http://assistant.test',
}));

describe('saved agent color refresh client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the root owner and reports the committed count', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ changed: 4 }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(canRefreshAgentColors()).toBe(true);

    await expect(refreshAgentColors('root', 'owner')).resolves.toBe(4);
    expect(fetch).toHaveBeenCalledWith('http://assistant.test/assistant/refresh-agent-colors', {
      body: JSON.stringify({ ownerResourceId: 'owner', rootThreadId: 'root' }),
      headers: {
        'content-type': 'application/json',
        'x-brainstrike-assistant-token': 'token',
      },
      method: 'POST',
    });
  });

  it('passes the host conflict reason through to the user', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ message: 'Finish or stop the active agent run.' }), {
          status: 409,
        })
    );
    await expect(refreshAgentColors('root', 'owner')).rejects.toThrow(
      'Finish or stop the active agent run.'
    );
  });
});
