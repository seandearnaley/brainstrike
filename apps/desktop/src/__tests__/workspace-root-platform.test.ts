// @vitest-environment node
import { PassThrough } from 'node:stream';
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

test('an attached writer stays usable during an index-only retirement without reacquiring the profile', async () => {
  const fixture = transport({ workspaceRoots: async () => ({ roots: [] }) });
  const acquire = vi.fn(async (): Promise<never> => {
    throw new Error('Native index admission is closed');
  });
  const catalog = createDesktopWorkspaceRootCatalog(acquire);
  const detach = catalog.attach(fixture.main);
  try {
    await expect(catalog.workspaceRoots({ operation: 'list' })).resolves.toEqual({ roots: [] });
    expect(acquire).not.toHaveBeenCalled();
    detach();
    await expect(catalog.workspaceRoots({ operation: 'list' })).rejects.toThrow();
    expect(acquire).toHaveBeenCalledTimes(1);
  } finally {
    detach();
    await fixture.close();
  }
});
