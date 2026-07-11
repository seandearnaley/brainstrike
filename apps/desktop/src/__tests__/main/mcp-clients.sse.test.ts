import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { createHttpClient } = vi.hoisted(() => ({
  createHttpClient: vi.fn(() => ({
    callTool: vi.fn(async () => {
      throw new Error('legacy SSE connection failed');
    }),
    dispose: vi.fn(),
    listTools: vi.fn(async () => ({})),
    name: 'web',
    supportsTool: vi.fn(() => false),
    transport: 'sse' as const,
  })),
}));

vi.mock('../../mcp/http-client', () => ({ createHttpClient }));

import { disposeClients, getClient, initClients } from '../../mcp';

// Real legacy SSE negotiation is covered by mcp-http-client.integration.test.ts.
// This registry test locks in the fail-loud behavior that replaced the bespoke fallback client.
describe('mcp-clients (legacy SSE selection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await disposeClients();
  });

  test('selects the canonical HTTP adapter and propagates connection failures', async () => {
    initClients({
      servers: [
        {
          headers: { Authorization: 'Bearer test' },
          name: 'web',
          transport: 'sse',
          url: 'https://example.com/legacy',
        },
      ],
    });
    const client = getClient('web');

    expect(createHttpClient).toHaveBeenCalledWith({
      headers: { Authorization: 'Bearer test' },
      name: 'web',
      transport: 'sse',
      url: 'https://example.com/legacy',
    });
    await expect(client?.callTool('web.ping')).rejects.toThrow('legacy SSE connection failed');
  });
});
