import { beforeEach, describe, expect, it, vi } from 'vitest';

const createHttpClient = vi.hoisted(() => vi.fn());

vi.mock('../../mcp/http-client', () => ({ createHttpClient }));

import { createSseClient } from '../../mcp/sse-client';

describe('legacy SSE client compatibility entry', () => {
  beforeEach(() => {
    createHttpClient.mockReset();
  });

  it('delegates legacy SSE to the canonical explicit HTTP adapter', () => {
    const delegatedClient = { name: 'remote', transport: 'sse' };
    createHttpClient.mockReturnValue(delegatedClient);
    const server = {
      headers: { Authorization: 'Bearer token' },
      name: 'remote',
      transport: 'sse' as const,
      url: 'https://example.com/sse',
    };

    expect(createSseClient(server)).toBe(delegatedClient);
    expect(createHttpClient).toHaveBeenCalledExactlyOnceWith(server);
  });
});
