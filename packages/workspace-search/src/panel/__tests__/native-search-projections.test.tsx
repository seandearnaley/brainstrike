import type {
  IndexerCoverageBatch,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeWorkspaceSearchContext } from '../../core/native-workspace-search-context';
import { SearchCoverageBanner } from '../search-coverage-banner';

function observation(scanComplete: boolean): IndexerCoverageBatch {
  const embedding = { indexMode: 'text-only' as const };
  return {
    coverage: [
      {
        embedding,
        roots: [{ chunks: 4, indexedFiles: 2, missingVectors: 0, rootId: 'root-a', vectors: 0 }],
        storeId: 'store-a',
        totals: { chunks: 4, indexedFiles: 2, missingVectors: 0, vectors: 0 },
        vectorCoverageComplete: false,
      },
    ],
    kind: 'current',
    status: {
      authorizedRootIds: ['root-a'],
      embedding,
      kind: 'ready',
      rootReadiness: [{ rootId: 'root-a', scanComplete }],
      storeId: 'store-a',
    },
  };
}
function bridge(coverageBatch: IndexSearchCapability['coverageBatch']): IndexSearchCapability {
  return {
    coverage: vi.fn(),
    coverageBatch,
    grep: vi.fn(),
    rebuild: vi.fn(),
    search: vi.fn(),
    status: vi.fn(),
  };
}
afterEach(() => {
  vi.clearAllMocks();
});
describe('native Search projections', () => {
  it('keeps incomplete native publication visible despite all current chunks being present', async () => {
    // The banner verifies coverage before it reports it. The first read is held
    // open so both states are observed instead of raced (BST-2220).
    const firstRead = Promise.withResolvers<IndexerCoverageBatch>();
    const coverageBatch = vi
      .fn<IndexSearchCapability['coverageBatch']>()
      .mockResolvedValue(observation(false))
      .mockReturnValueOnce(firstRead.promise);
    const dependency = { capability: bridge(coverageBatch), embedQuery: vi.fn(), profile: null };
    const { rerender } = render(
      <NativeWorkspaceSearchContext value={dependency}>
        <SearchCoverageBanner rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Verifying index coverage…');
    await waitFor(() => expect(coverageBatch).toHaveBeenCalledOnce());
    expect(coverageBatch).toHaveBeenCalledWith([{ rootIds: ['root-a'] }]);
    await act(async () => {
      firstRead.resolve(observation(false));
      await firstRead.promise;
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Indexing'));
    expect(coverageBatch).toHaveBeenCalledOnce();
    const completed = observation(true);
    coverageBatch.mockResolvedValue(completed);
    rerender(
      <NativeWorkspaceSearchContext
        value={{
          ...dependency,
          ...(completed.kind === 'current' ? { status: completed.status } : {}),
        }}
      >
        <SearchCoverageBanner rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
  it('retains a later completed observation when an older coverage read settles last', async () => {
    let finishOld: (batch: IndexerCoverageBatch) => void = () => {};
    const old = new Promise<IndexerCoverageBatch>((resolve) => {
      finishOld = resolve;
    });
    const coverageBatch = vi
      .fn<IndexSearchCapability['coverageBatch']>()
      .mockReturnValueOnce(old)
      .mockResolvedValue(observation(true));
    const dependency = { capability: bridge(coverageBatch), embedQuery: vi.fn(), profile: null };
    const { rerender } = render(
      <NativeWorkspaceSearchContext value={dependency}>
        <SearchCoverageBanner rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    const current = observation(true);
    if (current.kind !== 'current') {
      throw new Error('Expected current fixture');
    }
    rerender(
      <NativeWorkspaceSearchContext value={{ ...dependency, status: current.status }}>
        <SearchCoverageBanner rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    await act(async () => {
      finishOld(observation(false));
      await old;
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('reports coverage for the indexed folders only, leaving out a folder the index does not cover', async () => {
    const complete = observation(true);
    if (complete.kind !== 'current') {
      throw new Error('Expected current fixture');
    }
    const coverageBatch = vi
      .fn<IndexSearchCapability['coverageBatch']>()
      .mockResolvedValue(complete);
    const capability = bridge(coverageBatch);
    const { rerender } = render(
      <NativeWorkspaceSearchContext
        value={{ capability, embedQuery: vi.fn(), profile: null, status: complete.status }}
      >
        <SearchCoverageBanner rootIds={['root-a', 'worktree']} />
      </NativeWorkspaceSearchContext>
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(coverageBatch).toHaveBeenCalledExactlyOnceWith([{ rootIds: ['root-a'] }]);
    rerender(
      <NativeWorkspaceSearchContext
        value={{ capability, embedQuery: vi.fn(), profile: null, status: complete.status }}
      >
        <SearchCoverageBanner rootIds={['worktree']} />
      </NativeWorkspaceSearchContext>
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(coverageBatch).toHaveBeenCalledOnce();
  });
  it('keeps an invalidated coverage observation pending without retrying it', async () => {
    const coverageBatch = vi
      .fn<IndexSearchCapability['coverageBatch']>()
      .mockResolvedValue({ code: 'native-coverage-observation-invalidated', kind: 'invalidated' });
    render(
      <NativeWorkspaceSearchContext
        value={{ capability: bridge(coverageBatch), embedQuery: vi.fn(), profile: null }}
      >
        <SearchCoverageBanner rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    await waitFor(() => expect(coverageBatch).toHaveBeenCalledOnce());
    expect(screen.getByRole('status')).toBeVisible();
  });
});
