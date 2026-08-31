import { afterEach, describe, expect, test, vi } from 'vitest';

const { explicitClient, state } = vi.hoisted(() => {
  const client = {
    callTool: vi.fn(async () => ({ content: [{ text: 'called', type: 'text' }] })),
    close: vi.fn(async () => undefined),
    getConnectionGeneration: vi.fn(() => state.generation),
    getNegotiatedProtocolVersion: vi.fn(() => '2025-11-25' as const),
    getProtocolEra: vi.fn(() => 'legacy' as const),
    getServerCapabilities: vi.fn(() => ({ tools: {} })),
    getServerVersion: vi.fn(() => ({ name: 'fixture', version: '1' })),
    listTools: vi.fn(
      async (): Promise<{
        tools: Array<{ inputSchema: { type: string }; name: string }>;
      }> => ({ tools: [] })
    ),
  };
  const state = { client, generation: 1 };
  return {
    explicitClient: vi.fn(function ExplicitHttpMcpClientMock() {
      return client;
    }),
    state,
  };
});

vi.mock('@brainstrike/agent/mcp-client', () => ({ ExplicitHttpMcpClient: explicitClient }));

import { createHttpClient } from '../../mcp/http-client';

describe('desktop explicit HTTP MCP adapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
    state.generation = 1;
  });

  test('refreshes changed catalogs and rejects a disappeared tool after a new client generation', async () => {
    state.client.listTools
      .mockResolvedValueOnce({ tools: [{ inputSchema: { type: 'object' }, name: 'old' }] })
      .mockResolvedValueOnce({ tools: [{ inputSchema: { type: 'object' }, name: 'new' }] })
      .mockResolvedValueOnce({ tools: [] });
    const client = createHttpClient({
      name: 'desktop',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });

    await expect(client.listTools()).resolves.toHaveProperty('desktop.old');
    state.generation = 2;
    await expect(client.callTool('desktop.new', { value: 'changed' })).resolves.toEqual({
      content: [{ text: 'called', type: 'text' }],
    });
    expect(state.client.listTools).toHaveBeenCalledTimes(2);
    expect(state.client.callTool).toHaveBeenLastCalledWith(
      { arguments: { value: 'changed' }, name: 'new' },
      expect.objectContaining({ toolDefinition: expect.any(Object) })
    );

    state.generation = 3;
    await expect(client.callTool('desktop.old')).rejects.toThrow(
      'Unsupported MCP tool: desktop.old'
    );
    expect(state.client.listTools).toHaveBeenCalledTimes(3);
  });
});
