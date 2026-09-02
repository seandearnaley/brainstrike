import { describe, expect, it, vi } from 'vitest';
import { resolveMcpTaskBridge } from '../mcp-task-bridge';

const complete = { act: vi.fn(), list: vi.fn(), onStatusChanged: vi.fn() };

describe('resolveMcpTaskBridge', () => {
  it('returns the bridge when window.mcp.tasks exposes all three members', () => {
    expect(resolveMcpTaskBridge({ mcp: { tasks: complete } })).toBe(complete);
  });

  it('returns null when window.mcp has no tasks member (hidden hosts, older preloads)', () => {
    expect(resolveMcpTaskBridge({ mcp: {} })).toBeNull();
    expect(resolveMcpTaskBridge({})).toBeNull();
    expect(resolveMcpTaskBridge(undefined)).toBeNull();
  });

  it('returns null for a partial bridge rather than a half-wired one', () => {
    const { onStatusChanged: _omitted, ...partial } = complete;
    expect(resolveMcpTaskBridge({ mcp: { tasks: partial } })).toBeNull();
    expect(resolveMcpTaskBridge({ mcp: { tasks: 'tasks' } })).toBeNull();
  });
});
