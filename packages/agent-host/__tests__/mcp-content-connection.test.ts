import { describe, expect, it, vi } from 'vitest';
import type { HostMethodHandler } from '../src/auth-connection.js';
import { bindHostMcpContentMethods } from '../src/mcp-content-connection.js';
import type { HostClientOrigin, HostMcpContentService } from '../src/ports.js';
import type { HostMethod } from '../src/protocol.js';

const REFUSED = {
  error: { category: 'not-connected', code: 'mcp_content_lifecycle_closed', message: 'closed' },
  ok: false,
} as const;

function bound(service: HostMcpContentService, origin: HostClientOrigin) {
  const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
  const handle: HostMethodHandler = (method, request) => {
    handlers.set(method, async (params) => await request(params as never));
  };
  bindHostMcpContentMethods(handle, service, origin);
  return handlers;
}

function service(): HostMcpContentService {
  return {
    complete: vi.fn(async () => REFUSED),
    prompt: vi.fn(async () => REFUSED),
    read: vi.fn(async () => REFUSED),
  };
}

/** BST-1930 c5d: resource and prompt bodies are the desktop user's data. */
describe('host MCP content methods', () => {
  it("answers the desktop's private client with each verb's outcome", async () => {
    const owner = service();
    const handlers = bound(owner, 'desktop-ui');

    for (const method of [
      'mcp/content/complete',
      'mcp/content/prompt',
      'mcp/content/read',
    ] as const) {
      await expect(handlers.get(method)?.({})).resolves.toEqual(REFUSED);
    }
    expect(owner.read).toHaveBeenCalledOnce();
  });

  it('refuses every content verb to a public-socket client', async () => {
    const owner = service();
    const handlers = bound(owner, 'public-socket');

    for (const method of [
      'mcp/content/complete',
      'mcp/content/prompt',
      'mcp/content/read',
    ] as const) {
      await expect(handlers.get(method)?.({})).rejects.toThrow(
        "MCP content is available only to the desktop's private client"
      );
    }
    expect(owner.complete).not.toHaveBeenCalled();
    expect(owner.prompt).not.toHaveBeenCalled();
    expect(owner.read).not.toHaveBeenCalled();
  });
});
