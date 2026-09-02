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
});
