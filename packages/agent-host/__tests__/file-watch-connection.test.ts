import { describe, expect, it, vi } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostMethodHandler } from '../src/auth-connection.js';
import { bindHostFileReadMethods, bindHostFileWatchMethods } from '../src/file-watch-connection.js';
import type {
  HostClientOrigin,
  HostFileReads,
  HostFileWatches,
  HostFileWatchSession,
} from '../src/ports.js';
import {
  type HostMethod,
  WORKSPACE_FILES_EVENT,
  type WorkspaceFilesEvent,
} from '../src/protocol.js';

function bound(fileWatches: HostFileWatches, origin: HostClientOrigin) {
  const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
  const handle: HostMethodHandler = (method, request) => {
    handlers.set(method, async (params) => await request(params as never));
  };
  const sendNotification = vi.fn(async () => undefined);
  const binding = bindHostFileWatchMethods(
    handle,
    { dispose: vi.fn(), sendNotification } as unknown as MessageConnection,
    fileWatches,
    origin
  );
  return { binding, handlers, sendNotification };
}

function fileWatches() {
  let push: (event: WorkspaceFilesEvent) => void = () => undefined;
  const close = vi.fn(async () => undefined);
  const session: HostFileWatchSession = {
    close,
    'workspace/files/unwatch': vi.fn(async () => null),
    'workspace/files/watch': vi.fn(async () => ({ watchId: 'fs-watch-1' })),
    'workspace/files/watch-retry': vi.fn(async () => ({ retried: true as const })),
  };
  const open = vi.fn((send: (event: WorkspaceFilesEvent) => void) => {
    push = send;
    return session;
  });
  return { close, open, owner: { open }, push: (event: WorkspaceFilesEvent) => push(event) };
}

/** ADR-0029 stage 4: the Explorer's root watches are the desktop user's, one connection at a time. */
describe('host file watch methods', () => {
  it('opens one watch session per connection, streams it, and ends it with the connection', async () => {
    const service = fileWatches();
    const { binding, handlers, sendNotification } = bound(service.owner, 'desktop-ui');

    await expect(handlers.get('workspace/files/watch')?.({ path: '/repo' })).resolves.toEqual({
      watchId: 'fs-watch-1',
    });
    await handlers.get('workspace/files/unwatch')?.({ watchId: 'fs-watch-1' });
    const event: WorkspaceFilesEvent = { changes: [], type: 'changes', watchId: 'fs-watch-1' };
    service.push(event);
    binding.dispose();

    expect(service.open).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledWith(WORKSPACE_FILES_EVENT, event);
    expect(service.close).toHaveBeenCalledOnce();
  });

  it('refuses every file watch method to a public-socket client', async () => {
    const service = fileWatches();
    const { handlers } = bound(service.owner, 'public-socket');

    for (const method of [
      'workspace/files/unwatch',
      'workspace/files/watch',
      'workspace/files/watch-retry',
    ] as const) {
      await expect(handlers.get(method)?.({})).rejects.toThrow(
        "Workspace file watching is available only to the desktop's private client"
      );
    }
    expect(service.open).not.toHaveBeenCalled();
  });
});

/** ADR-0029 stage 4: the Explorer's reads of live roots are the desktop user's alone. */
describe('host file read methods', () => {
  const reads = (): HostFileReads => ({
    'workspace/files/exists': vi.fn(async () => ({ exists: true })),
    'workspace/files/list': vi.fn(async () => ({
      entries: [],
      inspected: 0,
      rootId: 'root-1',
      truncated: false,
    })),
    'workspace/files/read': vi.fn(async () => ({ content: 'text' })),
  });
  const bind = (fileReads: HostFileReads | undefined, origin: HostClientOrigin) => {
    const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
    const handle: HostMethodHandler = (method, request) => {
      handlers.set(method, async (params) => await request(params as never));
    };
    bindHostFileReadMethods(handle, fileReads, origin);
    return handlers;
  };

  it("answers the desktop's private client", async () => {
    const handlers = bind(reads(), 'desktop-ui');
    await expect(handlers.get('workspace/files/read')?.({ path: '/repo/a.ts' })).resolves.toEqual({
      content: 'text',
    });
  });

  it('refuses every read to a public-socket client, and says so where the host has none', async () => {
    const service = reads();
    const publicHandlers = bind(service, 'public-socket');
    for (const method of [
      'workspace/files/exists',
      'workspace/files/list',
      'workspace/files/read',
    ] as const) {
      await expect(publicHandlers.get(method)?.({ path: '/repo' })).rejects.toThrow(
        "Workspace file reading is available only to the desktop's private client"
      );
      expect(service[method]).not.toHaveBeenCalled();
    }
    await expect(
      bind(undefined, 'desktop-ui').get('workspace/files/list')?.({ path: '/repo' })
    ).rejects.toThrow('Workspace file reading is unavailable on this host');
  });
});
