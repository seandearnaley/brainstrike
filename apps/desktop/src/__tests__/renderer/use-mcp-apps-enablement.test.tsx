// @vitest-environment jsdom
/**
 * Live per-server MCP Apps enablement in the visible renderer (BST-1604).
 * A generation whose effective Apps state is off must reach the app host as
 * `false` so the mounted app unmounts through its ordinary teardown. The
 * status comes from the agent host (BST-1930 c5b).
 */

import type { McpStatusCapability } from '@brainstrike/app-shell/mcp-status-capability';
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMcpAppsEnablement } from '../../renderer/use-mcp-apps-enablement';

const snapshot = (apps: boolean, revision: number): McpHostSnapshot => ({
  revision,
  servers: [
    {
      configuredProtocol: '2026-07-28',
      configuredServerId: 'linear' as McpHostSnapshot['servers'][number]['configuredServerId'],
      extensions: { apps, tasks: true },
      generation: revision,
      state: 'disconnected',
      transport: 'streamable-http',
    },
  ],
});

function createStatus(initial: McpHostSnapshot) {
  let current = initial;
  const listeners = new Set<(status: McpHostSnapshot) => void>();
  const status: McpStatusCapability = {
    read: vi.fn(async () => current),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    push(next: McpHostSnapshot) {
      current = next;
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
    status,
  };
}

describe('useMcpAppsEnablement', () => {
  it('reports Apps enabled for a server whose generation advertises them', async () => {
    const { status } = createStatus(snapshot(true, 1));
    const { result } = renderHook(() => useMcpAppsEnablement(status));
    await waitFor(() => expect(status.read).toHaveBeenCalled());
    expect(result.current('linear')).toBe(true);
  });

  it('flips to disabled when a pushed status reports the dial off', async () => {
    const { push, status } = createStatus(snapshot(true, 1));
    const { result } = renderHook(() => useMcpAppsEnablement(status));
    await waitFor(() => expect(status.read).toHaveBeenCalled());
    push(snapshot(false, 2));
    await waitFor(() => expect(result.current('linear')).toBe(false));
  });

  it('keeps a pushed revision when an older read settles after it', async () => {
    let settleRead: (value: McpHostSnapshot) => void = () => undefined;
    const { push, status } = createStatus(snapshot(true, 1));
    status.read = vi.fn(
      () =>
        new Promise<McpHostSnapshot>((resolve) => {
          settleRead = resolve;
        })
    );
    const { result } = renderHook(() => useMcpAppsEnablement(status));
    push(snapshot(false, 2));
    await waitFor(() => expect(result.current('linear')).toBe(false));

    // Settle the stale read and let React commit whatever it applies.
    await act(async () => {
      settleRead(snapshot(true, 1));
      await Promise.resolve();
    });

    expect(result.current('linear')).toBe(false);
  });

  it('leaves a server the host does not report at the shipped default', async () => {
    const { status } = createStatus(snapshot(false, 1));
    const { result } = renderHook(() => useMcpAppsEnablement(status));
    await waitFor(() => expect(result.current('linear')).toBe(false));
    expect(result.current('unknown-server')).toBe(true);
  });

  it('reports enabled where there is no MCP status at all', () => {
    const { result } = renderHook(() => useMcpAppsEnablement(null));
    expect(result.current('linear')).toBe(true);
  });
});
