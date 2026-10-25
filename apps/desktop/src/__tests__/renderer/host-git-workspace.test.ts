// @vitest-environment jsdom
import type { HostClient } from '@brainstrike/agent-host/browser';
import type { GitWorkspaceEvent } from '@brainstrike/agent-host/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopHostConnection } from '../../renderer/desktop-host-connection';
import { createDesktopWorkspaceGitServices } from '../../renderer/host-git-workspace';

// The window's real connector loads the browser JSON-RPC transport; each test injects its host.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

/** One agent host: its git event listener, its subscribe calls, and a way to stop it. */
function fakeHost() {
  let push: ((event: GitWorkspaceEvent) => void) | undefined;
  let stop: () => void = () => undefined;
  const request = vi.fn(async () => ({}));
  const host = {
    close: vi.fn(async () => undefined),
    closed: new Promise<void>((resolve) => {
      stop = resolve;
    }),
    onGitWorkspace: vi.fn((listener: (event: GitWorkspaceEvent) => void) => {
      push = listener;
      return () => undefined;
    }),
    request,
  } as unknown as HostClient;
  const invalidated = (generation: number): GitWorkspaceEvent => ({
    event: { generation, gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
    type: 'changes-invalidated',
  });
  return {
    host,
    invalidate: (generation: number) => push?.(invalidated(generation)),
    request,
    stop: () => stop(),
  };
}

describe('desktop workspace git services', () => {
  it('keeps invalidation generations rising when a replacement host numbers from 1 again', async () => {
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
    const { changes } = createDesktopWorkspaceGitServices(connection);
    if (!changes) {
      throw new Error('Desktop workspace git services have no Changes bridge');
    }
    const generations: number[] = [];

    changes.onInvalidated((event) => generations.push(event.generation));
    await vi.waitFor(() =>
      expect(first.request).toHaveBeenCalledWith('workspace/git/subscribe', {})
    );
    first.invalidate(1);
    first.invalidate(2);

    first.stop();
    await vi.waitFor(() =>
      expect(replacement.request).toHaveBeenCalledWith('workspace/git/subscribe', {})
    );
    replacement.invalidate(1);

    expect(generations).toEqual([1, 2, 3]);
  });
});
