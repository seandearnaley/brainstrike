import path from 'node:path';
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import type { SecureWorkspaceRoot } from '@brainstrike/assistant-service/node-workspace-services';
import { describe, expect, it, vi } from 'vitest';
import { createRegistry, rootHandle, secureRoot } from './workspace-root-registry-test-helpers';

const WORKSPACE = path.resolve('/workspace');
const REPLACEMENT = path.resolve('/replacement');

type DirListing = Awaited<ReturnType<SecureWorkspaceRoot['listDir']>>;

function context(signal = new AbortController().signal): {
  requestId: string;
  signal: AbortSignal;
} {
  return { requestId: 'root-borrow-test', signal };
}

async function mounted(root: SecureWorkspaceRoot = secureRoot(WORKSPACE)): Promise<{
  createSecureRoot: ReturnType<typeof vi.fn<(rootPath: string) => Promise<SecureWorkspaceRoot>>>;
  registry: ReturnType<typeof createRegistry>;
  rootId: string;
}> {
  const createSecureRoot = vi.fn(async () => root);
  const registry = createRegistry({
    createSecureRoot,
    resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
  });
  const descriptor = await registry.addRoot(rootHandle(WORKSPACE));
  return { createSecureRoot, registry, rootId: descriptor.rootId };
}

/** A mounted root whose next directory listing is held until the test settles it. */
function heldListing(): {
  readonly listing: PromiseWithResolvers<DirListing>;
  readonly root: SecureWorkspaceRoot;
  readonly started: Promise<void>;
} {
  const started = Promise.withResolvers<void>();
  const listing = Promise.withResolvers<DirListing>();
  const root = {
    ...secureRoot(WORKSPACE),
    listDir: vi.fn(() => {
      started.resolve();
      return listing.promise;
    }),
  };
  return { listing, root, started: started.promise };
}

const EMPTY_LISTING = { entries: [], inspected: 0, truncated: false };

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true })
  );
}

describe('WorkspaceRootRegistry root borrows', () => {
  it('borrows the mounted capability for its exact root and refuses arbitrary paths', async () => {
    const root = secureRoot(WORKSPACE);
    const f = await mounted(root);
    const lease = await f.registry.borrowSourceRootForPath(WORKSPACE);
    expect(lease.rootId).toBe(f.rootId);
    expect(lease.canonicalPath).toBe(root.canonicalPath);
    await expect(
      f.registry.borrowSourceRootForPath(path.join(WORKSPACE, 'subdirectory'))
    ).rejects.toThrow('mounted root');
    await expect(f.registry.borrowSourceRootForPath('/other-root')).rejects.toThrow('mounted root');
    await lease.retire();
    expect(root.close).not.toHaveBeenCalled();
  });

  it('lists through the same opened capability, which outlives a retired borrow', async () => {
    const root = secureRoot(WORKSPACE);
    const { createSecureRoot, registry } = await mounted(root);
    const lease = await registry.borrowSourceRootForPath(WORKSPACE);
    await lease.listDir('src', 7, context());
    expect(root.listDir).toHaveBeenCalledExactlyOnceWith('src', 7);
    await lease.retire();
    expect(root.close).not.toHaveBeenCalled();
    const next = await registry.borrowSourceRootForPath(WORKSPACE);
    await expect(next.listDir('.', 7, context())).resolves.toEqual(EMPTY_LISTING);
    expect(createSecureRoot).toHaveBeenCalledTimes(1);
    await next.retire();
  });

  it('refuses malformed relative paths and out-of-policy bounds before native I/O', async () => {
    const root = secureRoot(WORKSPACE);
    const { registry } = await mounted(root);
    const lease = await registry.borrowSourceRootForPath(WORKSPACE);
    for (const relativePath of [
      '/outside',
      '../secret',
      'dir/../secret',
      'a//b',
      'a\\b',
      'C:/secret',
      'a\0b',
    ]) {
      await expect(lease.listDir(relativePath, 7, context())).rejects.toThrow();
    }
    for (const maxEntries of [0, -1, 10_001, Number.NaN]) {
      await expect(lease.listDir('.', maxEntries, context())).rejects.toThrow();
    }
    expect(root.listDir).not.toHaveBeenCalled();
    await lease.retire();
  });

  it('joins a held listing after cancellation and discards its late entries', async () => {
    const held = heldListing();
    const { registry } = await mounted(held.root);
    const lease = await registry.borrowSourceRootForPath(WORKSPACE);
    const controller = new AbortController();
    const canceled = new Error('request canceled');
    const outcome = lease
      .listDir('.', 7, context(controller.signal))
      .catch((error: unknown) => error);
    await held.started;
    controller.abort(canceled);
    let retired = false;
    const retirement = lease.retire().then(() => {
      retired = true;
    });
    expect(lease.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(retired).toBe(false);
    held.listing.resolve(EMPTY_LISTING);
    expect(await outcome).toBe(canceled);
    await retirement;
    expect(held.root.close).not.toHaveBeenCalled();
  });

  it('answers a listing its folder removal retired with the typed unmounted refusal', async () => {
    const held = heldListing();
    const { registry, rootId } = await mounted(held.root);
    const lease = await registry.borrowSourceRootForPath(WORKSPACE);
    const outcome = lease.listDir('.', 7, context()).catch((error: unknown) => error);
    await held.started;
    let removed = false;
    const removal = registry.removeRoot(rootId).then(() => {
      removed = true;
    });
    await waitForAbort(lease.signal);
    await expect(lease.listDir('.', 7, context())).rejects.toThrow();
    expect(removed).toBe(false);
    expect(held.root.close).not.toHaveBeenCalled();
    held.listing.resolve(EMPTY_LISTING);
    const error = await outcome;
    expect(error).toBeInstanceOf(BoundaryFailureError);
    expect(error).toMatchObject({
      failure: { code: 'workspace.root-unmounted', kind: 'refusal' },
    });
    await removal;
    expect(held.root.close).toHaveBeenCalledTimes(1);
    await expect(registry.borrowSourceRootForPath(WORKSPACE)).rejects.toThrow('exact mounted root');
  });

  it('refuses a listing that its folder data deletion took over', async () => {
    const held = heldListing();
    const { registry, rootId } = await mounted(held.root);
    const lease = await registry.borrowSourceRootForPath(WORKSPACE);
    const outcome = lease.listDir('.', 7, context()).catch((error: unknown) => error);
    await held.started;
    // The deletion owns the mount before it retires the lease: the listing finishes in between.
    const reservation = registry.reserveRootDataDeletion(rootId);
    held.listing.resolve(EMPTY_LISTING);
    expect(await outcome).toMatchObject({ failure: { code: 'workspace.root-unmounted' } });
    await expect(registry.borrowSourceRootForPath(WORKSPACE)).rejects.toThrow('Root data deletion');
    reservation.release();
    await lease.retire();
  });

  it('retains an unchanged incumbent, and retires it when a reopen resolves elsewhere', async () => {
    const original = secureRoot(WORKSPACE);
    const redundant = secureRoot(WORKSPACE);
    const replacement = secureRoot(REPLACEMENT);
    const registry = createRegistry({
      createSecureRoot: vi
        .fn<(rootPath: string) => Promise<SecureWorkspaceRoot>>()
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(redundant)
        .mockResolvedValueOnce(replacement),
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
    });
    await registry.addRoot(rootHandle(WORKSPACE));
    const first = await registry.borrowSourceRootForPath(WORKSPACE);
    await registry.addRoot(rootHandle(WORKSPACE));
    expect(first.signal.aborted).toBe(false);
    expect(redundant.close).toHaveBeenCalledTimes(1);
    await registry.restoreRoots();
    expect(first.signal.aborted).toBe(true);
    await expect(first.listDir('.', 7, context())).rejects.toThrow();
    await expect(registry.borrowSourceRootForPath(REPLACEMENT)).rejects.toThrow(
      'exact mounted root'
    );
    expect(original.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).toHaveBeenCalledTimes(1);
    await registry.dispose();
  });

  it('registry disposal revokes at once and returns only after admitted work settles', async () => {
    const held = heldListing();
    const { registry } = await mounted(held.root);
    const lease = await registry.borrowSourceRootForPath(WORKSPACE);
    const outcome = lease.listDir('.', 7, context()).catch((error: unknown) => error);
    await held.started;
    let disposed = false;
    const disposal = Promise.resolve(registry.dispose()).then(() => {
      disposed = true;
    });
    expect(lease.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(held.root.close).not.toHaveBeenCalled();
    held.listing.resolve(EMPTY_LISTING);
    expect(await outcome).toBeInstanceOf(Error);
    await disposal;
    expect(held.root.close).toHaveBeenCalledTimes(1);
  });
});
