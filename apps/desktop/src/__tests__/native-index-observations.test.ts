// @vitest-environment node
import { createNativeCanonicalPublication } from '@brainstrike/canonical-ingestion';
import {
  type IndexerCoverageBatch,
  type IndexerStatus,
  type NativeIndexLifecycleObservation,
  type NativeIndexObservation,
  NativeIndexRefusalError,
} from '@brainstrike/indexing-contract/indexer-client';
import { expect, it, vi } from 'vitest';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { observeNativeIndex } from '../native-index-observations';

const workspace = { kind: 'workspace', rootId: 'root' } as const;

it('tells its observer the readiness each scan start, settle and invalidation leaves', async () => {
  const writer = {
    info: vi.fn(async () => ({ storeId: 'store' })),
    // The fixture's one scope is the only one a manifest is verified for.
    verifyScopedManifest: vi.fn(async () => ({
      authorityEpoch: 'epoch',
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope: workspace,
      storeId: 'store',
      unexpected: [],
    })),
  };
  let observed: ReturnType<typeof publication.getReadiness> = [];
  const publication = createNativeCanonicalPublication(
    writer as unknown as Parameters<typeof createNativeCanonicalPublication>[0],
    [workspace],
    () => {
      observed = publication.getReadiness();
    }
  );
  const ticket = await publication.beginScan({ requestId: 'scan-1', scope: workspace });
  expect(observed).toEqual(publication.getReadiness());
  expect(observed[0]).toMatchObject({ generation: 1, scanComplete: false });
  await publication.finishScan({
    aborted: false,
    errors: [],
    files: [],
    full: true,
    ticket,
    truncatedDirectories: [],
  });
  expect(observed).toEqual(publication.getReadiness());
  expect(observed[0]).toMatchObject({ scanComplete: true });
  publication.invalidateScope(workspace);
  expect(observed).toEqual(publication.getReadiness());
  expect(observed[0]).toMatchObject({ scanComplete: false });
});

type ReadyStatus = Extract<IndexerStatus, { kind: 'ready' }>;
const ready = (indexedFiles: number): ReadyStatus => ({
  authorizedRootIds: ['root'],
  embedding: { indexMode: 'text-only' },
  kind: 'ready',
  rootReadiness: [{ rootId: 'root', scanComplete: true }],
  storeId: `store-${indexedFiles}`,
});
const covered = (status: ReadyStatus, indexedFiles: number): IndexerCoverageBatch => {
  const counts = { chunks: indexedFiles, indexedFiles, missingVectors: 0, vectors: 0 };
  return {
    coverage: [
      {
        embedding: { indexMode: 'text-only' },
        roots: [{ rootId: 'root', ...counts }],
        storeId: status.storeId,
        totals: counts,
        vectorCoverageComplete: true,
      },
    ],
    kind: 'current',
    status,
  };
};

/** Main's index as the observer reads it: what its lifecycle, scans and reads report. */
function mainIndex() {
  let lifecycle: ((observation: NativeIndexLifecycleObservation) => void) | undefined;
  let changed: (() => void) | undefined;
  let indexedFiles = 1;
  const published: NativeIndexObservation[] = [];
  const controller = new AbortController();
  const status = vi.fn(async (): Promise<IndexerStatus> => ready(indexedFiles));
  const coverageBatch = vi.fn(async (): Promise<IndexerCoverageBatch> => {
    const current = ready(indexedFiles);
    return covered(current, indexedFiles);
  });
  void observeNativeIndex({
    coverageBatch,
    observeChanges: (listener) => {
      changed = listener;
    },
    observeLifecycle: async (listener) => {
      lifecycle = listener;
    },
    publish: (observation) => published.push(observation),
    signal: controller.signal,
    status,
  });
  return {
    change: (files: number) => {
      indexedFiles = files;
      changed?.();
    },
    coverageBatch,
    lifecycle: (observation: NativeIndexLifecycleObservation) => lifecycle?.(observation),
    published,
    status,
  };
}

it('publishes the index as its latest change left it, even when it changes during a read', async () => {
  const main = mainIndex();
  main.lifecycle({ generation: 1, kind: 'ready' });
  await vi.waitFor(() =>
    expect(main.published.at(-1)?.progress).toEqual({
      coverage: covered(ready(1), 1),
      kind: 'read',
      status: ready(1),
    })
  );
  // A scan settles while Main is reading the index for an earlier change.
  const held = Promise.withResolvers<void>();
  main.status.mockImplementationOnce(async () => {
    await held.promise;
    return ready(2);
  });
  main.change(2);
  main.change(3);
  held.resolve();
  await vi.waitFor(() =>
    expect(main.published.at(-1)).toEqual({
      lifecycle: { generation: 1, kind: 'ready' },
      progress: { coverage: covered(ready(3), 3), kind: 'read', status: ready(3) },
    })
  );
});

it('publishes a read Main could not make: a replaced index as preparing, any other in its owner’s words', async () => {
  const main = mainIndex();
  main.status.mockRejectedValueOnce(
    new NativeAuthorityTransitionError('Native source or saved profile changed during search.')
  );
  main.lifecycle({ generation: 2, kind: 'ready' });
  await vi.waitFor(() =>
    expect(main.published.at(-1)?.progress).toMatchObject({
      kind: 'read',
      status: { kind: 'unavailable', phase: 'preparing' },
    })
  );
  main.coverageBatch.mockRejectedValueOnce(
    new NativeIndexRefusalError(
      { kind: 'setup-required', message: 'Choose a search mode.' },
      'Choose a search mode.'
    )
  );
  main.change(4);
  await vi.waitFor(() =>
    expect(main.published.at(-1)?.progress).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('Settings'),
    })
  );
});
