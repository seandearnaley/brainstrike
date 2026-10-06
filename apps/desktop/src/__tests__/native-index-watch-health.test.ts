// @vitest-environment node

import type {
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import {
  emptyCollection,
  fixture,
  mocks,
  requestedScope,
  resetActivationFixture,
  scope,
  storeId,
  unused,
  writer,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

it('keeps native reads admitted with incomplete proofs during recoverable watcher rescan and fails closed for real failures', async () => {
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: '/actual/root',
    generation: 'actual-generation',
    listDir: unused,
    readFile: unused,
    retire: async () => {},
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: unused,
  };
  const application = {
    roots: {
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  mocks.database.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM roots')
      ? [{ id: 'root', kind: 'path' }]
      : sql.includes('FROM embedding_sets')
        ? [{ id: 'selected' }]
        : [],
  }));
  let workspace: CanonicalWorkspaceRuntimeDependencies | undefined;
  const trigger = vi.fn(async () => undefined);
  const native = {
    ...writer(),
    verifyScopedManifest: async (
      request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]
    ) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope: requestedScope(request),
      storeId,
      unexpected: [],
    }),
  };
  mocks.readyPort.mockReturnValue(native);
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      workspace = dependencies;
      const ticket = await dependencies.publication.beginScan({
        requestId: 'initial',
        scope: { kind: 'workspace', rootId: 'root' },
      });
      dependencies.onReceipt(
        await dependencies.publication.finishScan({
          aborted: false,
          errors: [],
          files: [],
          full: true,
          ticket,
          truncatedDirectories: [],
        })
      );
      return { close: async () => {}, trigger };
    }
  );
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, onError } = fixture(application);
  try {
    await activation.acquire();
    const emit = (
      health: Parameters<CanonicalWorkspaceRuntimeDependencies['onWatchHealth']>[0]
    ): void => {
      if (!workspace) {
        throw new Error('Workspace was not attached.');
      }
      workspace.onWatchHealth(health);
    };
    const before = await activation.getSearchAuthority();
    expect(before.readiness.every((entry) => entry.scanComplete)).toBe(true);
    emit({
      backend: 'fs-events',
      failure: {
        code: 'rescan-required',
        message: 'Events were dropped by the FSEvents client. File system must be re-scanned.',
        retryable: true,
        terminal: false,
      },
      state: 'degraded',
      timestamp: 1,
    });
    const partial = await activation.withRead(async (read) => ({
      authority: await read.getAuthority(),
      info: await read.port.info(),
    }));
    expect(partial.info.storeId).toBe(storeId);
    expect(partial.authority.readiness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scanComplete: false,
          scope: { kind: 'workspace', rootId: 'root' },
        }),
        expect.objectContaining({ scanComplete: false, scope }),
      ])
    );
    expect(onError).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
    emit({ backend: 'fs-events', state: 'healthy', timestamp: 2 });
    expect(
      (await activation.getSearchAuthority()).readiness.every((entry) => entry.scanComplete)
    ).toBe(false);
    if (!workspace) {
      throw new Error('Workspace was not attached.');
    }
    const recovery = await workspace.publication.beginScan({
      requestId: 'full-recovery',
      scope: { kind: 'workspace', rootId: 'root' },
    });
    workspace.onReceipt(
      await workspace.publication.finishScan({
        aborted: false,
        errors: [],
        files: [],
        full: true,
        ticket: recovery,
        truncatedDirectories: [],
      })
    );
    await vi.waitFor(async () => {
      expect(
        (await activation.getSearchAuthority()).readiness.every((entry) => entry.scanComplete)
      ).toBe(true);
    });
    for (const state of ['degraded', 'failed', 'stopped'] as const) {
      const reason = `actual ${state} failure`;
      emit({
        backend: 'fs-events',
        failure: { code: 'backend-error', message: reason, retryable: true, terminal: false },
        state,
        timestamp: 3,
      });
      await expect(activation.withRead((read) => read.getAuthority())).rejects.toThrow(reason);
      expect(onError).toHaveBeenLastCalledWith(
        'workspace watcher health',
        expect.objectContaining({ message: reason })
      );
      emit({
        backend: 'fs-events',
        failure: {
          code: 'rescan-required',
          message: 'Too many events. File system must be re-scanned.',
          retryable: true,
          terminal: false,
        },
        state: 'degraded',
        timestamp: 3,
      });
      await expect(activation.withRead((read) => read.getAuthority())).rejects.toThrow(reason);
      emit({ backend: 'fs-events', state: 'healthy', timestamp: 4 });
    }
    expect(trigger).toHaveBeenCalledTimes(3);
  } finally {
    await activation.close();
  }
});
