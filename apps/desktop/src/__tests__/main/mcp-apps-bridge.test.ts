import { describe, expect, it, vi } from 'vitest';
import { attachMcpAppsBridge } from '../../mcp/apps-bridge';

describe('attachMcpAppsBridge', () => {
  it('registers the three visible-UI Apps admission channels', () => {
    const appHost = { execute: vi.fn(), prepare: vi.fn(), release: vi.fn() };
    const registerAuthorizedInvoke = vi.fn();
    attachMcpAppsBridge({ appHost }, { registerAuthorizedInvoke });

    expect(registerAuthorizedInvoke.mock.calls.map((call) => call[1])).toEqual([
      'mcp:apps:prepare',
      'mcp:apps:execute',
      'mcp:apps:release',
    ]);
    for (const call of registerAuthorizedInvoke.mock.calls) {
      expect(call[2]).toEqual({ roles: ['visible-ui'] });
    }
  });

  it('rejects extra arguments before touching the app host', async () => {
    const appHost = { execute: vi.fn(), prepare: vi.fn(), release: vi.fn() };
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const registerAuthorizedInvoke = vi.fn(
      (_domain: string, channel: string, _policy: unknown, handler: never) => {
        handlers.set(channel, handler);
      }
    );
    attachMcpAppsBridge(
      { appHost },
      { registerAuthorizedInvoke: registerAuthorizedInvoke as never }
    );

    for (const channel of ['mcp:apps:prepare', 'mcp:apps:execute', 'mcp:apps:release']) {
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      await expect(handler?.({ sender: {} }, {}, 'extra')).rejects.toThrow(/exactly 1 argument/);
    }
    expect(appHost.prepare).not.toHaveBeenCalled();
    expect(appHost.execute).not.toHaveBeenCalled();
    expect(appHost.release).not.toHaveBeenCalled();
  });
});
