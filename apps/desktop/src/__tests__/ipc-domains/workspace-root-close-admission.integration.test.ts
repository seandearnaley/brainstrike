// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachAgentHost, startAgentHost } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { createDesktopWorkspaceRootCatalog } from '../../agent-host-platform/workspace-root-client';
import { nativeIndexClosedError } from '../../native-index-lifecycle-errors';
import { createRegistry, createStorage } from './workspace-root-registry-test-helpers';

const rootId = 'b5f5883e-c414-485a-9c1b-1b43a579ca10';

test('retirement joins the restored-root catalog ACK and its record reopens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brainstrike-restored-root-ack-'));
  const path = join(root, 'workspace');
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let writer: StateStore | undefined;
  const host = await startAgentHost({ lifetime: 'persistent', root }, async (startup) => {
    writer = startup.store;
    return {
      close: async () => undefined,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, INTERNAL_FAULT },
        yolo: false,
      }),
      tools: {},
    };
  });
  if (!writer) {
    throw new Error('Host did not acquire its catalog writer');
  }
  const register = writer.workspaceRoots.bind(writer);
  vi.spyOn(writer, 'workspaceRoots').mockImplementation(async (request) => {
    const reply = await register(request);
    if (request.operation === 'register') {
      entered.resolve();
      await released.promise;
    }
    return reply;
  });
  const client = await attachAgentHost(host.record);
  const registry = createRegistry({
    getRootsCatalog: async () => client.catalog,
    storage: createStorage({ rootsList: JSON.stringify([{ addedAt: 1, path, rootId }]) }),
  });
  const restoring = registry.restoreRoots();
  await entered.promise;
  let hostClosed = false;
  let registryClosed = false;
  const closingHost = host.close().then(() => {
    hostClosed = true;
  });
  const closingRegistry = registry.dispose().then(() => {
    registryClosed = true;
  });
  try {
    await expect
      .poll(async () => {
        try {
          await client.catalog.workspaceRoots({ operation: 'list' });
          return false;
        } catch (cause) {
          expect(cause).toMatchObject({ code: 'host.closing', failure: { kind: 'refusal' } });
          return true;
        }
      })
      .toBe(true);
    expect(hostClosed).toBe(false);
    expect(registryClosed).toBe(false);
    released.resolve();
    expect(await restoring).toContainEqual(
      expect.objectContaining({ handle: expect.objectContaining({ path }), rootId })
    );
    await Promise.all([closingHost, closingRegistry]);
    const reopened = await StateStore.open(root);
    try {
      const { roots } = await reopened.workspaceRoots({ operation: 'list' });
      expect(roots).toContainEqual(expect.objectContaining({ id: rootId, path, status: 'live' }));
    } finally {
      await reopened.close();
    }
  } finally {
    released.resolve();
    await client.close();
    await registry.dispose();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('a terminally fenced catalog borrow is refused before a new request can be admitted', async () => {
  const acquire = vi.fn(async (): Promise<never> => {
    throw nativeIndexClosedError('shutdown');
  });
  const catalog = createDesktopWorkspaceRootCatalog(acquire);
  await expect(
    catalog.workspaceRoots({
      operation: 'register',
      root: { displayName: 'workspace', path: '/workspace', preferredId: rootId },
    })
  ).rejects.toMatchObject({ refusal: { kind: 'closed', reason: 'shutdown' } });
  expect(acquire).toHaveBeenCalledOnce();
});
