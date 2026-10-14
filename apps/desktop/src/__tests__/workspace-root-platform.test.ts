// @vitest-environment node
import { PassThrough } from 'node:stream';
import { createHostCatalogClient } from '@brainstrike/agent-host/catalog';
import type { HostAttachment } from '@brainstrike/host-lease';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { createDesktopWorkspaceRootCatalog } from '../agent-host-platform/workspace-root-client';
import {
  createWorkspaceRootClient,
  serveWorkspaceRootStore,
} from '../agent-host-platform/workspace-root-store';

function transport(store: WorkspaceRootPort) {
  const requests = new PassThrough();
  const responses = new PassThrough();
  const main = createMessageConnection(
    new StreamMessageReader(responses),
    new StreamMessageWriter(requests)
  );
  const host = createMessageConnection(
    new StreamMessageReader(requests),
    new StreamMessageWriter(responses)
  );
  const serving = serveWorkspaceRootStore(host, store);
  main.listen();
  host.listen();
  return {
    client: createWorkspaceRootClient(main),
    close: async () => {
      await serving.close();
      main.dispose();
      host.dispose();
      requests.destroy();
      responses.destroy();
    },
    main,
    serving,
  };
}

test('the private platform transports typed root operations and rejects extra authority fields', async () => {
  const workspaceRoots = vi.fn<WorkspaceRootPort['workspaceRoots']>(async () => ({ roots: [] }));
  const fixture = transport({ workspaceRoots });
  try {
    await expect(fixture.client.workspaceRoots({ operation: 'list' })).resolves.toEqual({
      roots: [],
    });
    expect(workspaceRoots).toHaveBeenCalledWith({ operation: 'list' });
    await expect(
      fixture.main.sendRequest('host/workspace-roots', {
        operation: 'register',
        root: {
          displayName: 'Alpha',
          path: '/disposable/Alpha',
          preferredId: 'root-alpha',
          status: 'live',
        },
      })
    ).rejects.toThrow();
    expect(workspaceRoots).toHaveBeenCalledTimes(1);
  } finally {
    await fixture.close();
  }
});

test('physical store admission joins before the private endpoint closes', async () => {
  const entered = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const workspaceRoots = vi.fn<WorkspaceRootPort['workspaceRoots']>(async () => {
    entered.resolve();
    await committed.promise;
    return { roots: [] };
  });
  const fixture = transport({ workspaceRoots });
  try {
    const request = fixture.client.workspaceRoots({
      mountedPaths: [],
      operation: 'disconnect-except',
    });
    await entered.promise;
    let closed = false;
    const closing = fixture.serving.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(fixture.client.workspaceRoots({ operation: 'list' })).rejects.toThrow();
    committed.resolve();
    await request;
    await closing;
  } finally {
    committed.resolve();
    await fixture.close();
  }
});

test('an authenticated attachment stays usable during index-only retirement and detaches on physical close', async () => {
  const fixture = transport({ workspaceRoots: async () => ({ roots: [] }) });
  const closed = Promise.withResolvers<void>();
  const attachment = {
    catalog: createHostCatalogClient(fixture.main),
    closed: closed.promise,
  } as HostAttachment & { catalog: ReturnType<typeof createHostCatalogClient> };
  const acquire = vi.fn(async () => attachment);
  const catalog = createDesktopWorkspaceRootCatalog(acquire);
  try {
    await expect(catalog.workspaceRoots({ operation: 'list' })).resolves.toEqual({ roots: [] });
    acquire.mockRejectedValue(new Error('Native index admission is closed'));
    await expect(catalog.workspaceRoots({ operation: 'list' })).resolves.toEqual({ roots: [] });
    expect(acquire).toHaveBeenCalledTimes(1);
    closed.resolve();
    await Promise.resolve();
    await expect(catalog.workspaceRoots({ operation: 'list' })).rejects.toThrow();
    expect(acquire).toHaveBeenCalledTimes(2);
  } finally {
    closed.resolve();
    await fixture.close();
  }
});
