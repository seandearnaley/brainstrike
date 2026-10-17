// @vitest-environment node

import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract';
import type {
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import type { NativeIndexLifecycleObservation } from '@brainstrike/indexing-contract/indexer-client';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import { canonicalError, canonicalFault } from '../canonical-utility-protocol';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import {
  createActivation,
  emptyCollection,
  mocks,
  requestedScope,
  resetActivationFixture,
  setCatalogRecords,
  setCatalogRoot,
  storeId,
  unused,
  writer,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

/** What Main receives when the agent host's state index missed its deadline mid-sync. */
const stateIndexTimeout = (): Error =>
  canonicalError(
    canonicalFault(
      new BoundaryFailureError(
        fault({
          category: 'timeout',
          code: 'state-index.request-timeout',
          message:
            "The agent host's state index did not answer in time. It restarts on the next request.",
        })
      )
    )
  );

type Sync = 'timeout' | 'broken' | 'complete';

/** One granted root whose nth startup sync ends as `syncs[n]` says; later syncs repeat the last. */
function startup(syncs: readonly Sync[]) {
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
  setCatalogRoot();
  setCatalogRecords(() => []);
  mocks.readyPort.mockReturnValue({
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
  });
  let attached = 0;
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      const sync = syncs[Math.min(attached, syncs.length - 1)];
      attached += 1;
      if (sync === 'complete') {
        const ticket = await dependencies.publication.beginScan({
          requestId: `workspace-${attached}`,
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
      } else {
        const error =
          sync === 'timeout' ? stateIndexTimeout() : new Error('Workspace walk failed.');
        queueMicrotask(() => dependencies.onError('sync', error));
      }
      return { close: async () => {}, trigger: unused };
    }
  );
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const observed: NativeIndexLifecycleObservation[] = [];
  const activation = createActivation({
    application,
    embedding: { documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    reopenDelaysMs: [0, 0, 0],
    storage: {
      getItem: async () =>
        JSON.stringify({
          state: {
            enabled: true,
            indexingPolicyPreset: 'balanced',
            managedCollectionId: 'selected',
            nativeIndexMode: 'TEXT',
            nativeLocalSelection: null,
            paused: false,
            worktreeRootIndexingOptInById: {},
          },
        }),
    },
  });
  const observer = new AbortController();
  void activation
    .observeLifecycle((observation) => observed.push(observation), observer.signal)
    .catch(() => undefined);
  return {
    activation,
    attached: () => attached,
    close: async () => {
      observer.abort();
      await activation.close();
    },
    observed,
  };
}

const refusals = (observed: readonly NativeIndexLifecycleObservation[]) =>
  observed.flatMap((observation) =>
    observation.kind === 'refused' && 'message' in observation.cause
      ? [observation.cause.message]
      : []
  );

it('re-opens a generation whose startup sync timed out, visibly, and serves once it succeeds', async () => {
  const index = startup(['timeout', 'complete']);
  await expect(index.activation.acquire()).rejects.toThrow('did not answer in time');

  await vi.waitFor(() => expect(index.observed.at(-1)?.kind).toBe('ready'));
  await expect(index.activation.acquireRead()).resolves.toBeDefined();
  expect(index.attached()).toBe(2);
  expect(refusals(index.observed)).toEqual([
    "The agent host's state index did not answer in time. It restarts on the next request. Retrying automatically (attempt 1 of 3).",
  ]);
  await index.close();
});

it('stops after three re-opens and stays refused with the typed cause', async () => {
  const index = startup(['timeout']);
  await expect(index.activation.acquire()).rejects.toThrow('did not answer in time');

  await vi.waitFor(() => expect(refusals(index.observed)).toHaveLength(4));
  expect(index.attached()).toBe(4);
  expect(refusals(index.observed).at(-1)).toBe(
    "The agent host's state index did not answer in time. It restarts on the next request."
  );
  await expect(index.activation.acquireRead()).rejects.toThrow('did not answer in time');
  expect(index.attached()).toBe(4);
  await index.close();
});

it('never re-opens a startup failure its owner did not type as transient', async () => {
  const index = startup(['broken', 'complete']);
  await expect(index.activation.acquire()).rejects.toThrow('Workspace walk failed.');

  await vi.waitFor(() => expect(refusals(index.observed)).toEqual(['Workspace walk failed.']));
  await expect(index.activation.acquireRead()).rejects.toThrow('Workspace walk failed.');
  expect(index.attached()).toBe(1);
  await index.close();
});
