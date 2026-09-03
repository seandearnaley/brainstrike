/**
 * Live per-server MCP Apps enablement in the visible renderer (BST-1604).
 * A generation whose effective Apps state is off must reach the app host as
 * `false` so the mounted app unmounts through its ordinary teardown.
 */
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMcpAppsEnablement } from '../../renderer/use-mcp-apps-enablement';

const snapshot = (apps: boolean): McpHostSnapshot => ({
  revision: 1,
  servers: [
    {
      configuredProtocol: '2026-07-28',
      configuredServerId: 'linear' as McpHostSnapshot['servers'][number]['configuredServerId'],
      extensions: { apps, tasks: true },
      generation: 1,
      state: 'disconnected',
      transport: 'streamable-http',
    },
  ],
});

function createHost(initial: McpHostSnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    host: {
      mcp: {
        getServerStatusSnapshot: vi.fn(async () => current),
        onServerStatusUpdated: (callback: () => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      },
    },
    push(next: McpHostSnapshot) {
      current = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

describe('useMcpAppsEnablement', () => {
  it('reports Apps enabled for a server whose generation advertises them', async () => {
    const { host } = createHost(snapshot(true));
    const { result } = renderHook(() => useMcpAppsEnablement(host));
    await waitFor(() => expect(result.current('linear')).toBe(true));
  });

  it('flips to disabled when the host snapshot reports the dial off', async () => {
    const { host, push } = createHost(snapshot(true));
    const { result } = renderHook(() => useMcpAppsEnablement(host));
    await waitFor(() => expect(result.current('linear')).toBe(true));
    push(snapshot(false));
    await waitFor(() => expect(result.current('linear')).toBe(false));
  });

  it('leaves a server the host does not report at the shipped default', async () => {
    const { host } = createHost(snapshot(false));
    const { result } = renderHook(() => useMcpAppsEnablement(host));
    await waitFor(() => expect(result.current('linear')).toBe(false));
    expect(result.current('unknown-server')).toBe(true);
  });

  it('reports enabled when the host exposes no MCP status bridge at all', () => {
    const { result } = renderHook(() => useMcpAppsEnablement({}));
    expect(result.current('linear')).toBe(true);
  });
});
