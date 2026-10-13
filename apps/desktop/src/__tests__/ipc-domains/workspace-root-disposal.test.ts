// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import type { SecureWorkspaceRoot } from '../../ipc-domains/workspace-root-types';
import {
  createRegistry,
  createRegistryDatabaseQuery,
  createStorage,
  secureRoot,
} from './workspace-root-registry-test-helpers';

const stored = { addedAt: 1, path: '/workspace', rootId: '01119602-b67e-4e7e-83ad-ab54def811ef' };

function rootStorage() {
  return createStorage({ rootsList: JSON.stringify([stored]) });
}

function observed<T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> {
  return operation.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ reason, status: 'rejected' })
  );
}

describe('WorkspaceRootRegistry accepted mutation retirement', () => {
  it('drains held secure-root opening and queued restore before closing their capabilities', async () => {
    const entered = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<void>();
    const roots: SecureWorkspaceRoot[] = [];
    const createSecureRoot = vi.fn(async () => {
      const root = secureRoot(stored.path);
      roots.push(root);
      if (roots.length === 1) {
        entered.resolve();
        await opening.promise;
      }
      return root;
    });
    const registry = createRegistry({ createSecureRoot, storage: rootStorage() });
    const first = observed(registry.restoreRoots());
    await entered.promise;
    const queued = observed(registry.restoreRoots());
    const disposing = observed(registry.dispose());
    const late = observed(registry.restoreRoots());
    expect(roots[0]?.close).not.toHaveBeenCalled();
    opening.resolve();
    const [firstResult, queuedResult, lateResult, disposalResult] = await Promise.all([
      first,
      queued,
      late,
      disposing,
    ]);
    expect(firstResult).toMatchObject({
      status: 'fulfilled',
      value: [{ permissionState: 'granted', rootId: stored.rootId }],
    });
    expect(queuedResult).toMatchObject({
      status: 'fulfilled',
      value: [{ permissionState: 'granted', rootId: stored.rootId }],
    });
    expect(lateResult.status).toBe('rejected');
    expect(disposalResult).toEqual({ status: 'fulfilled', value: undefined });
    expect(createSecureRoot).toHaveBeenCalledTimes(2);
    for (const root of roots) {
      expect(root.close).toHaveBeenCalledTimes(1);
    }
  });

  it('joins accepted restore across its DB initialization barrier before retiring mounts', async () => {
    const entered = Promise.withResolvers<void>();
    const database = Promise.withResolvers<void>();
    const roots: SecureWorkspaceRoot[] = [];
    const query = createRegistryDatabaseQuery();
    const registry = createRegistry({
      createSecureRoot: async () => {
        const root = secureRoot(stored.path);
        roots.push(root);
        return root;
      },
      getRootsDatabase: async () => {
        entered.resolve();
        await database.promise;
        return { query } as unknown as WorkspaceRootsQueryable;
      },
      storage: rootStorage(),
    });
    const first = observed(registry.restoreRoots());
    await entered.promise;
    const queued = observed(registry.restoreRoots());
    let closed = false;
    const disposing = observed(registry.dispose()).then((result) => {
      closed = true;
      return result;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(roots[0]?.close).not.toHaveBeenCalled();
    database.resolve();
    const results = await Promise.all([first, queued, disposing]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(query).toHaveBeenCalled();
    for (const root of roots) {
      expect(root.close).toHaveBeenCalledTimes(1);
    }
  });
});
