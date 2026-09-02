import { describe, expect, it } from 'vitest';
import { resolveMcpAppBridge } from '../mcp-app-bridge';

const complete = {
  execute: () => undefined,
  prepare: () => undefined,
  prepareShell: () => undefined,
  readResource: () => undefined,
  release: () => undefined,
  releaseShell: () => undefined,
};

describe('resolveMcpAppBridge', () => {
  it('resolves a complete window.mcp.apps bridge', () => {
    expect(resolveMcpAppBridge({ mcp: { apps: complete } })).toBe(complete);
  });

  it('is null when the host exposes no apps bridge', () => {
    expect(resolveMcpAppBridge({ mcp: {} })).toBeNull();
    expect(resolveMcpAppBridge({})).toBeNull();
    expect(resolveMcpAppBridge(undefined)).toBeNull();
  });

  it('is null for a partial or non-object bridge', () => {
    const { readResource: _omitted, ...partial } = complete;
    expect(resolveMcpAppBridge({ mcp: { apps: partial } })).toBeNull();
    const { releaseShell: _omittedShell, ...withoutShell } = complete;
    expect(resolveMcpAppBridge({ mcp: { apps: withoutShell } })).toBeNull();
    expect(resolveMcpAppBridge({ mcp: { apps: 'apps' } })).toBeNull();
  });
});
