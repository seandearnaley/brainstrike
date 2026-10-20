// @vitest-environment node
import type { HostCatalog } from '@brainstrike/agent-host/catalog';
import type { HostAttachment } from '@brainstrike/host-lease';
import { expect, test, vi } from 'vitest';
import { createDesktopWorkspaceRootCatalog } from '../agent-host-platform/workspace-root-client';
import { HOST_LEASE_CLOSED } from '../desktop-shutdown-state';

function fixture() {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected catalog operation');
  };
  const catalog = {
    collections: vi.fn<HostCatalog['collections']>(unexpected),
    forgeCache: vi.fn<HostCatalog['forgeCache']>(unexpected),
    forgeCacheSnapshot: vi.fn<HostCatalog['forgeCacheSnapshot']>(unexpected),
    modelChoices: vi.fn<HostCatalog['modelChoices']>(unexpected),
    promptLibrary: vi.fn<HostCatalog['promptLibrary']>(unexpected),
    sourceCatalog: vi.fn<HostCatalog['sourceCatalog']>(unexpected),
    threadGroups: vi.fn<HostCatalog['threadGroups']>(unexpected),
    viewFilterPresets: vi.fn<HostCatalog['viewFilterPresets']>(unexpected),
    workspaceRoots: vi.fn<HostCatalog['workspaceRoots']>(unexpected),
    worktreeLedger: vi.fn<HostCatalog['worktreeLedger']>(unexpected),
  };
  const closed = Promise.withResolvers<void>();
  const attachment: HostAttachment & { readonly catalog: HostCatalog } = {
    catalog,
    close: vi.fn(async () => closed.resolve()),
    closed: closed.promise,
    record: {
      endpoint: '/disposable/socket',
      hostVersion: '1',
      pid: 123,
      protocolVersion: 1,
      start: 'test',
      token: '0'.repeat(64),
    },
  };
  const acquire = vi.fn(async () => attachment);
  const borrower = createDesktopWorkspaceRootCatalog(acquire);
  return { acquire, attachment, borrower, catalog };
}

test.each(['workspaceRoots', 'worktreeLedger'] as const)(
  'terminal close joins admitted %s through its reply and refuses new requests',
  async (method) => {
    const f = fixture();
    const ack = Promise.withResolvers<void>();
    let request: Promise<unknown>;
    if (method === 'workspaceRoots') {
      f.catalog.workspaceRoots.mockImplementation(async () => {
        await ack.promise;
        return { roots: [] };
      });
      request = f.borrower.workspaceRoots({ operation: 'list' });
    } else {
      f.catalog.worktreeLedger.mockImplementation(async () => {
        await ack.promise;
        return { rows: [] };
      });
      request = f.borrower.worktreeLedger({ operation: 'list-active' });
    }
    await vi.waitFor(() => expect(f.catalog[method]).toHaveBeenCalledOnce());
    let prepared = false;
    const closing = f.borrower.prepareClose().then(() => {
      prepared = true;
    });
    expect(f.borrower.prepareClose()).toBe(f.borrower.prepareClose());
    await expect(f.borrower.workspaceRoots({ operation: 'list' })).rejects.toMatchObject({
      failure: HOST_LEASE_CLOSED,
    });
    await expect(f.borrower.worktreeLedger({ operation: 'list-active' })).rejects.toMatchObject({
      failure: HOST_LEASE_CLOSED,
    });
    expect(prepared).toBe(false);
    expect(f.acquire).toHaveBeenCalledOnce();
    ack.resolve();
    await request;
    await closing;
    expect(prepared).toBe(true);
    expect(f.attachment.close).not.toHaveBeenCalled();
  }
);

test('a borrow admitted before terminal close finishes its acquisition and operation', async () => {
  const f = fixture();
  const acquisition = Promise.withResolvers<typeof f.attachment>();
  f.acquire.mockReturnValueOnce(acquisition.promise);
  const ack = Promise.withResolvers<void>();
  f.catalog.workspaceRoots.mockImplementation(async () => {
    await ack.promise;
    return { roots: [] };
  });
  const request = f.borrower.workspaceRoots({ operation: 'list' });
  let prepared = false;
  const closing = f.borrower.prepareClose().then(() => {
    prepared = true;
  });
  await Promise.resolve();
  expect(prepared).toBe(false);
  expect(f.catalog.workspaceRoots).not.toHaveBeenCalled();
  acquisition.resolve(f.attachment);
  await vi.waitFor(() => expect(f.catalog.workspaceRoots).toHaveBeenCalledOnce());
  expect(prepared).toBe(false);
  ack.resolve();
  await expect(request).resolves.toEqual({ roots: [] });
  await closing;
});

test.each(['acquisition', 'operation'] as const)(
  'a rejected admitted %s stays visible to its caller and terminal drain',
  async (phase) => {
    const f = fixture();
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cause = new Error('Expected admitted catalog failure');
    if (phase === 'acquisition') {
      f.acquire.mockImplementation(async () => {
        admitted.resolve();
        await release.promise;
        throw cause;
      });
    } else {
      f.catalog.workspaceRoots.mockImplementation(async () => {
        admitted.resolve();
        await release.promise;
        throw cause;
      });
    }
    const request = f.borrower.workspaceRoots({ operation: 'list' });
    const refused = expect(request).rejects.toBe(cause);
    await admitted.promise;
    const closing = f.borrower.prepareClose();
    const failedClose = expect(closing).rejects.toMatchObject({ errors: [cause] });
    release.resolve();
    await refused;
    await failedClose;
    await expect(f.borrower.prepareClose()).rejects.toMatchObject({ errors: [cause] });
  }
);

test('settled operations retain caller ownership and do not become a later shutdown failure', async () => {
  const f = fixture();
  const cause = new Error('Expected caller-owned completed failure');
  f.catalog.workspaceRoots.mockRejectedValueOnce(cause);
  await expect(f.borrower.workspaceRoots({ operation: 'list' })).rejects.toBe(cause);
  await expect(f.borrower.prepareClose()).resolves.toBeUndefined();
});
