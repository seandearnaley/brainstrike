// @vitest-environment jsdom
import type { HostClient } from '@brainstrike/agent-host/browser';
import type { WorkspaceIndexEvent } from '@brainstrike/agent-host/protocol';
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import type { NativeIndexObservation } from '@brainstrike/indexing-contract/indexer-client';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopHostConnection } from '../../renderer/desktop-host-connection';
import { createDesktopWorkspaceIndex } from '../../renderer/host-workspace-index';

// The window's real connector loads the browser JSON-RPC transport; each test injects its host.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

/** One agent host: its index event listener, its requests, and a way to stop it. */
function fakeHost() {
  let push: ((event: WorkspaceIndexEvent) => void) | undefined;
  let stop: () => void = () => undefined;
  const request = vi.fn(async (method: string) =>
    method === 'index/subscribe' ? { subscribed: true } : {}
  );
  const host = {
    close: vi.fn(async () => undefined),
    closed: new Promise<void>((resolve) => {
      stop = resolve;
    }),
    onWorkspaceIndex: vi.fn((listener: (event: WorkspaceIndexEvent) => void) => {
      push = listener;
      return () => undefined;
    }),
    request,
  } as unknown as HostClient;
  return { host, push: (event: WorkspaceIndexEvent) => push?.(event), request, stop: () => stop() };
}

const READY: NativeIndexObservation = {
  lifecycle: { generation: 1, kind: 'ready' },
  progress: { kind: 'read', status: { kind: 'unavailable', reason: 'Preparing' } },
};

describe('desktop workspace index', () => {
  it('keeps Settings and Search listening across a replaced host', async () => {
    const first = fakeHost();
    const replacement = fakeHost();
    const hosts = [first.host, replacement.host];
    const connection = createDesktopHostConnection(async () => {
      const next = hosts.shift();
      if (!next) {
        throw new Error('No further agent host');
      }
      return next;
    });
    const index = createDesktopWorkspaceIndex(connection);
    const configs: IndexConfig[] = [];
    const observations: NativeIndexObservation[] = [];

    index.onConfigChanged((config) => configs.push(config));
    index.onLifecycleChanged((observation) => observations.push(observation));
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledWith('index/subscribe', {}));
    expect(
      first.request.mock.calls.filter(([method]) => method === 'index/subscribe')
    ).toHaveLength(1);
    first.push({ config: { ...DEFAULT_INDEX_CONFIG, mode: 'off' }, type: 'config' });

    first.stop();
    await vi.waitFor(() => expect(replacement.request).toHaveBeenCalledWith('index/subscribe', {}));
    replacement.push({ observation: READY, type: 'lifecycle' });

    expect(configs).toEqual([{ ...DEFAULT_INDEX_CONFIG, mode: 'off' }]);
    expect(observations).toEqual([READY]);
  });

  it('sends a settings change only as a patch the host accepts', async () => {
    const host = fakeHost();
    const index = createDesktopWorkspaceIndex(createDesktopHostConnection(async () => host.host));

    await index.updateConfig({ mode: 'semantic', paused: true });
    await expect(index.updateConfig({ mode: 'vector' })).rejects.toThrow();

    expect(host.request).toHaveBeenCalledOnce();
    expect(host.request).toHaveBeenCalledWith('index/config/update', {
      mode: 'semantic',
      paused: true,
    });
  });
});
