import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const httpClient = {
  callTool: vi.fn(),
  dispose: vi.fn(),
  listTools: vi.fn(async () => ({ 'web.echo': {} })),
  name: 'web',
  supportsTool: vi.fn((toolId: string) => toolId === 'web.echo'),
  transport: 'sse' as const,
};

vi.mock('../../mcp/http-client', () => ({
  createHttpClient: vi.fn(() => httpClient),
}));

import { disposeClients, getClient, initClients } from '../../mcp';

// Real Streamable HTTP and legacy SSE wire behavior lives in
// mcp-http-client.integration.test.ts. These tests keep registry result forwarding explicit.
describe('mcp-clients (canonical SSE results)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await disposeClients();
  });

  test('preserves canonical MCP content and structured content', async () => {
    httpClient.callTool.mockResolvedValueOnce({
      content: [{ text: 'hello', type: 'text' }],
      structuredContent: { echo: 'hello' },
    });
    initClients({
      servers: [{ name: 'web', transport: 'sse', url: 'https://example.com/mcp' }],
    });

    const result = await getClient('web')?.callTool('web.echo', { text: 'hello' });

    expect(httpClient.callTool).toHaveBeenCalledWith('web.echo', { text: 'hello' });
    expect(result).toEqual({
      content: [{ text: 'hello', type: 'text' }],
      structuredContent: { echo: 'hello' },
    });
  });

  test('preserves MCP isError results without converting them to transport failures', async () => {
    httpClient.callTool.mockResolvedValueOnce({
      content: [{ text: 'expected failure', type: 'text' }],
      isError: true,
    });
    initClients({
      servers: [{ name: 'web', transport: 'sse', url: 'https://example.com/mcp' }],
    });

    await expect(getClient('web')?.callTool('web.echo')).resolves.toEqual({
      content: [{ text: 'expected failure', type: 'text' }],
      isError: true,
    });
  });
});
