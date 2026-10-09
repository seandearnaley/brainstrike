import { describe, expect, it } from 'vitest';
import { resolveMcpAppShellBridge } from '../mcp-app-bridge';

const complete = {
  prepareShell: () => undefined,
  readResource: () => undefined,
  releaseShell: () => undefined,
};

describe('resolveMcpAppShellBridge', () => {
  it('resolves a complete window.mcp.apps shell bridge', () => {
    expect(resolveMcpAppShellBridge({ mcp: { apps: complete } })).toBe(complete);
  });

  it('is null when the host exposes no apps bridge', () => {
    expect(resolveMcpAppShellBridge({ mcp: {} })).toBeNull();
    expect(resolveMcpAppShellBridge({})).toBeNull();
    expect(resolveMcpAppShellBridge(undefined)).toBeNull();
  });

  it('is null for a partial or non-object bridge', () => {
    const { readResource: _omitted, ...partial } = complete;
    expect(resolveMcpAppShellBridge({ mcp: { apps: partial } })).toBeNull();
    const { releaseShell: _omittedShell, ...withoutShell } = complete;
    expect(resolveMcpAppShellBridge({ mcp: { apps: withoutShell } })).toBeNull();
    expect(resolveMcpAppShellBridge({ mcp: { apps: 'apps' } })).toBeNull();
  });
});
