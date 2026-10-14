import type { CollectionCatalogEntry } from '@brainstrike/assistant-contract';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type {
  IndexerCoverageBatch,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { dispatchEmbeddingSetUpdated } from '@brainstrike/utils/browser-events';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeWorkspaceSearchContext } from '../../core/native-workspace-search-context';
import { SearchCollectionPicker } from '../search-collection-picker';
import { SearchCoverageBanner } from '../search-coverage-banner';
import { useSemanticAvailability } from '../use-semantic-availability';

const { liveQuery } = vi.hoisted(() => ({
  liveQuery: vi.fn(() => ({ loading: false, rows: [] })),
}));
vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db/react')>()),
  usePGliteLiveQuery: liveQuery,
}));
const entry: CollectionCatalogEntry = {
  counts: { chunks: 4, files: 2, unprocessedFiles: 0 },
  createdAt: '2026-10-13T12:00:00.000Z',
  dimensions: 384,
  distance: 'cosine',
  id: 'imported',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  name: 'Imported documents',
  vectors: { kind: 'unavailable', reason: 'No configured vector profile.' },
};
function observation(scanComplete: boolean): IndexerCoverageBatch {
  const embedding = { indexMode: 'text-only' as const };
  return {
    coverage: [
      {
        collections: [
          { chunks: 4, embeddingSetId: 'imported', indexedFiles: 2, missingVectors: 0, vectors: 0 },
        ],
        embedding,
        roots: [],
        storeId: 'store-a',
        totals: { chunks: 4, indexedFiles: 2, missingVectors: 0, vectors: 0 },
        vectorCoverageComplete: false,
      },
    ],
    kind: 'current',
    status: {
      authorizedCollectionIds: ['imported'],
      authorizedRootIds: ['root-a'],
      collectionReadiness: [{ embeddingSetId: 'imported', scanComplete }],
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
  Reflect.deleteProperty(window, 'collectionCatalog');
  vi.clearAllMocks();
});
describe('native Search projections without a database provider', () => {
  it('selects a real catalog collection while its vector count is unavailable', async () => {
    const snapshot = vi.fn(async () => ({ ok: true, value: [entry] }));
    Object.defineProperty(window, 'collectionCatalog', { configurable: true, value: { snapshot } });
    render(<SearchCollectionPicker />);
    expect(await screen.findByRole('combobox', { name: 'Search collection' })).toBeVisible();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(liveQuery).not.toHaveBeenCalled();
  });
  it('does not let an old catalog response overwrite a committed update', async () => {
    let resolveOld: (value: { ok: true; value: CollectionCatalogEntry[] }) => void = () => {};
    const old = new Promise<{ ok: true; value: CollectionCatalogEntry[] }>((resolve) => {
      resolveOld = resolve;
    });
    const snapshot = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue({ ok: true, value: [entry] });
    Object.defineProperty(window, 'collectionCatalog', { configurable: true, value: { snapshot } });
    render(<SearchCollectionPicker />);
    act(() => dispatchEmbeddingSetUpdated({ id: entry.id, reason: 'updated' }));
    expect(await screen.findByRole('combobox')).toBeVisible();
    await act(async () => {
      resolveOld({ ok: true, value: [] });
      await old;
    });
    expect(screen.getByRole('combobox')).toBeVisible();
  });
  it('keeps incomplete native publication visible despite all current chunks being present', async () => {
    const coverageBatch = vi
      .fn<IndexSearchCapability['coverageBatch']>()
      .mockResolvedValue(observation(false));
    const dependency = { capability: bridge(coverageBatch), embedQuery: vi.fn(), profile: null };
    const { rerender } = render(
      <NativeWorkspaceSearchContext value={dependency}>
        <SearchCoverageBanner collectionId="imported" rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Indexing');
    await waitFor(() => expect(coverageBatch).toHaveBeenCalledOnce());
    expect(liveQuery).not.toHaveBeenCalled();
    const completed = observation(true);
    coverageBatch.mockResolvedValue(completed);
    rerender(
      <NativeWorkspaceSearchContext
        value={{
          ...dependency,
          ...(completed.kind === 'current' ? { status: completed.status } : {}),
        }}
      >
        <SearchCoverageBanner collectionId="imported" rootIds={['root-a']} />
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
        <SearchCoverageBanner collectionId="imported" rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    const current = observation(true);
    if (current.kind !== 'current') {
      throw new Error('Expected current fixture');
    }
    rerender(
      <NativeWorkspaceSearchContext value={{ ...dependency, status: current.status }}>
        <SearchCoverageBanner collectionId="imported" rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    await act(async () => {
      finishOld(observation(false));
      await old;
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('keeps an invalidated coverage observation pending without retrying it', async () => {
    const coverageBatch = vi
      .fn<IndexSearchCapability['coverageBatch']>()
      .mockResolvedValue({ code: 'native-coverage-observation-invalidated', kind: 'invalidated' });
    render(
      <NativeWorkspaceSearchContext
        value={{ capability: bridge(coverageBatch), embedQuery: vi.fn(), profile: null }}
      >
        <SearchCoverageBanner collectionId="imported" rootIds={['root-a']} />
      </NativeWorkspaceSearchContext>
    );
    await waitFor(() => expect(coverageBatch).toHaveBeenCalledOnce());
    expect(screen.getByRole('status')).toBeVisible();
    expect(liveQuery).not.toHaveBeenCalled();
  });
  it('surfaces a catalog read failure instead of treating it as an empty catalog', async () => {
    const snapshot = vi.fn(async () => ({
      error: INTERNAL_FAULT,
      ok: false,
    }));
    Object.defineProperty(window, 'collectionCatalog', { configurable: true, value: { snapshot } });
    render(<SearchCollectionPicker />);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByTestId('workspace-search-single-collection')).not.toBeInTheDocument();
    expect(liveQuery).not.toHaveBeenCalled();
  });
  it('disables SQL observation when native semantic availability is supplied', () => {
    const native = { available: false, reason: 'Vector profile required.' };
    expect(renderHook(() => useSemanticAvailability('imported', native)).result.current).toBe(
      native
    );
    expect(liveQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
