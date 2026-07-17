import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const httpClient = {
  callTool: vi.fn(
    async (
      _toolId: string,
      _params?: Record<string, unknown>,
      opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
    ) => {
      opts?.onProgress?.({ message: 'working', progress: 1, total: 1 }, {});
      return { content: [{ text: 'done', type: 'text' }] };
    }
  ),
  dispose: vi.fn(),
  listTools: vi.fn(async () => ({ 'web.echo': {} })),
  name: 'web',
  supportsTool: vi.fn((toolId: string) => toolId === 'web.echo'),
  transport: 'sse' as const,
};

vi.mock('../../mcp/http-client', () => ({
  createHttpClient: vi.fn(() => httpClient),
}));

import { callTool, disposeClients, initClients } from '../../mcp';

// mcp-http-client.integration.test.ts proves real SDK progress delivery. This unit test
// keeps the registry-to-client callback contract covered independently.
describe('mcp-clients (progress delegation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await disposeClients();
  });

  test('forwards progress before returning the canonical tool result', async () => {
    initClients({
      servers: [{ name: 'web', transport: 'sse', url: 'https://example.com/mcp' }],
    });
    const events: string[] = [];

    const result = await callTool(
      'web.echo',
      { text: 'hi' },
      {
        onProgress: (payload) => {
          expect(payload).toEqual({ message: 'working', progress: 1, total: 1 });
          events.push('progress');
        },
      }
    );
    events.push('result');

    expect(events).toEqual(['progress', 'result']);
    expect(result).toEqual({ content: [{ text: 'done', type: 'text' }] });
  });
});
