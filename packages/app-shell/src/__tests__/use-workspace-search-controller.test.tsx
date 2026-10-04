import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { SearchEmbedderProvider } from '@brainstrike/vector-management';
import type {
  NativeWorkspaceSearchDependencies,
  SemanticSearchRequest,
  TextSearchRequest,
  WorkspaceSearchResults,
} from '@brainstrike/workspace-search/core';
import {
  NativeWorkspaceSearchProvider,
  useWorkspaceSearchStore,
} from '@brainstrike/workspace-search/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootIdentityProvider } from '../roots/root-identity-context';
import {
  createWorkspaceSearchRunners,
  useWorkspaceSearchController,
} from '../use-workspace-search-controller';

// The controller resolves the file-open seam via `useIdeFileEditor()`. Mock it so
// the line-forwarding contract is observable without a full IdeLayout host.
const { openFileInTabMock } = vi.hoisted(() => ({ openFileInTabMock: vi.fn() }));
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useIdeFileEditor: () => ({ openFileInTab: openFileInTabMock, registerOpenFileInTab: vi.fn() }),
  };
});

function makeTextResults(overrides?: Partial<WorkspaceSearchResults>): WorkspaceSearchResults {
  return {
    files: [
      {
        children: [
          {
            after: [],
            before: [],
            chunkEndLine: 5,
            chunkId: 'chunk-1',
            chunkStartLine: 1,
            kind: 'match',
            line: 3,
            lineText: 'const x = 1;',
            provenance: 'index',
          },
        ],
        dbRootId: 'D1',
        path: 'src/a.ts',
        rootDisplayName: 'Root One',
      },
    ],
    mode: 'text',
    notices: {
      candidatesTruncated: false,
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      truncated: false,
    },
    totalMatches: 1,
    ...overrides,
  };
}

describe('createWorkspaceSearchRunners', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
    useWorkspaceSearchStore.getState().setQuery('hello');
  });

  it('runTextSearch resolves the set id, forwards the scope, and populates the store', async () => {
    const searchText = vi.fn(
      async (req: TextSearchRequest): Promise<WorkspaceSearchResults | null> => {
        expect(req.query).toBe('hello');
        expect(req.embeddingSetId).toBe('set-42');
        expect(req.rootIds).toEqual(['D1', 'D2']);
        return makeTextResults();
      }
    );
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText },
      resolveEffectiveEmbeddingSetId: async () => 'set-42',
      workspaceDbRootIds: ['D1', 'D2'],
    });

    runners.runTextSearch();
    expect(useWorkspaceSearchStore.getState().status).toBe('searching');

    await waitFor(() => {
      expect(useWorkspaceSearchStore.getState().status).toBe('results');
    });
    expect(useWorkspaceSearchStore.getState().results?.totalMatches).toBe(1);
    expect(searchText).toHaveBeenCalledTimes(1);
  });

  it('runTextSearch passes the store default textResultLimit (200) as maxResults', async () => {
    let capturedReq: TextSearchRequest | undefined;
    const searchText = vi.fn(async (req: TextSearchRequest): Promise<WorkspaceSearchResults> => {
      capturedReq = req;
      return makeTextResults();
    });
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText },
      resolveEffectiveEmbeddingSetId: async () => 'set-42',
      workspaceDbRootIds: ['D1'],
    });

    runners.runTextSearch();
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
    expect(capturedReq?.maxResults).toBe(200);
  });

  it('runTextSearch passes the CURRENT (bumped) textResultLimit as maxResults', async () => {
    useWorkspaceSearchStore.getState().increaseTextResultLimit();
    let capturedReq: TextSearchRequest | undefined;
    const searchText = vi.fn(async (req: TextSearchRequest): Promise<WorkspaceSearchResults> => {
      capturedReq = req;
      return makeTextResults();
    });
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText },
      resolveEffectiveEmbeddingSetId: async () => 'set-42',
      workspaceDbRootIds: ['D1'],
    });

    runners.runTextSearch();
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
    expect(capturedReq?.maxResults).toBe(400);
  });

  // Show-more generation safety: a mode switch immediately after a Show-more
  // click (increaseTextResultLimit + rerun) must still drop late results —
  // the bump itself never touches generation, so the rerun's own
  // beginSearch() is what the mode switch races against.
  it('a mode switch right after a Show-more bump+rerun drops the late text result (stale generation)', async () => {
    let resolveText: (r: WorkspaceSearchResults) => void = () => {};
    const searchText = vi.fn(
      () =>
        new Promise<WorkspaceSearchResults>((resolve) => {
          resolveText = resolve;
        })
    );
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: [],
    });

    // Simulate the panel's Show-more handler: bump, then rerun.
    useWorkspaceSearchStore.getState().increaseTextResultLimit();
    runners.runTextSearch();
    await waitFor(() => expect(searchText).toHaveBeenCalledTimes(1));

    // A mode change right after the click invalidates the in-flight run.
    useWorkspaceSearchStore.getState().setMode('semantic');
    resolveText(makeTextResults());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useWorkspaceSearchStore.getState().status).toBe('idle');
    expect(useWorkspaceSearchStore.getState().results).toBeNull();
  });

  it('runSemanticSearch forwards the scope and populates the store', async () => {
    const searchSemantic = vi.fn(
      async (req: SemanticSearchRequest): Promise<WorkspaceSearchResults | null> => {
        expect(req.rootIds).toEqual(['D9']);
        return makeTextResults({ mode: 'semantic' });
      }
    );
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic, searchText: vi.fn() },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: ['D9'],
    });

    runners.runSemanticSearch();
    await waitFor(() => {
      expect(useWorkspaceSearchStore.getState().status).toBe('results');
    });
    expect(searchSemantic).toHaveBeenCalledTimes(1);
  });

  it('routes executor errors to failSearch with the message', async () => {
    const runners = createWorkspaceSearchRunners({
      executor: {
        searchSemantic: vi.fn(),
        searchText: async () => {
          throw new Error('grep exploded');
        },
      },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: [],
    });

    runners.runTextSearch();
    await waitFor(() => {
      expect(useWorkspaceSearchStore.getState().status).toBe('error');
    });
    expect(useWorkspaceSearchStore.getState().error).toBe('grep exploded');
  });

  it('routes a set-resolution error to failSearch', async () => {
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText: vi.fn() },
      resolveEffectiveEmbeddingSetId: async () => {
        throw new Error('no workspace index');
      },
      workspaceDbRootIds: [],
    });

    runners.runTextSearch();
    await waitFor(() => {
      expect(useWorkspaceSearchStore.getState().status).toBe('error');
    });
    expect(useWorkspaceSearchStore.getState().error).toBe('no workspace index');
  });

  it('treats a superseded (null) result as a no-op', async () => {
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText: async () => null },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: [],
    });

    runners.runTextSearch();
    // Give the async work a chance to (not) write results.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useWorkspaceSearchStore.getState().status).toBe('searching');
    expect(useWorkspaceSearchStore.getState().results).toBeNull();
  });

  it('drops results that resolve AFTER a mode change (stale generation)', async () => {
    let resolveText: (r: WorkspaceSearchResults) => void = () => {};
    const searchText = vi.fn(
      () =>
        new Promise<WorkspaceSearchResults>((resolve) => {
          resolveText = resolve;
        })
    );
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: [],
    });

    runners.runTextSearch();
    await waitFor(() => expect(searchText).toHaveBeenCalledTimes(1));

    // A mode change invalidates the in-flight run (advances the store generation).
    useWorkspaceSearchStore.getState().setMode('semantic');
    resolveText(makeTextResults());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useWorkspaceSearchStore.getState().status).toBe('idle');
    expect(useWorkspaceSearchStore.getState().results).toBeNull();
  });

  it('an older run rejection cannot clobber a newer run that already resolved', async () => {
    let rejectOld: (e: Error) => void = () => {};
    const oldRun = createWorkspaceSearchRunners({
      executor: {
        searchSemantic: vi.fn(),
        searchText: () =>
          new Promise<WorkspaceSearchResults>((_, reject) => {
            rejectOld = reject;
          }),
      },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: [],
    });

    oldRun.runTextSearch();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A newer run supersedes it and resolves.
    const newRun = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText: async () => makeTextResults() },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: [],
    });
    newRun.runTextSearch();
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));

    // The old run rejects late — it must NOT flip status to 'error'.
    rejectOld(new Error('stale grep died'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useWorkspaceSearchStore.getState().status).toBe('results');
    expect(useWorkspaceSearchStore.getState().error).toBeNull();
    expect(useWorkspaceSearchStore.getState().results?.totalMatches).toBe(1);
  });

  // F3 pin: no abandonment path may strand status at 'searching' with no live run,
  // and the LATEST run always wins regardless of completion order.
  it('rapid re-dispatch: the second run wins; a late first resolve cannot clobber it', async () => {
    let resolveFirst: (r: WorkspaceSearchResults) => void = () => {};
    const searchText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceSearchResults>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(async () => makeTextResults({ totalMatches: 2 }));
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: [],
    });

    runners.runTextSearch(); // first run, left in-flight
    await waitFor(() => expect(searchText).toHaveBeenCalledTimes(1));
    runners.runTextSearch(); // second run supersedes and resolves
    await waitFor(() => expect(searchText).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
    expect(useWorkspaceSearchStore.getState().results?.totalMatches).toBe(2);

    // The first run resolves late with the stale generation → dropped.
    resolveFirst(makeTextResults({ totalMatches: 99 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useWorkspaceSearchStore.getState().status).toBe('results');
    expect(useWorkspaceSearchStore.getState().results?.totalMatches).toBe(2);
  });

  it('a toggle mid-flight with no new run lands on idle (never a stuck "searching")', async () => {
    let resolveText: (r: WorkspaceSearchResults) => void = () => {};
    const searchText = vi.fn(
      () =>
        new Promise<WorkspaceSearchResults>((resolve) => {
          resolveText = resolve;
        })
    );
    const runners = createWorkspaceSearchRunners({
      executor: { searchSemantic: vi.fn(), searchText },
      resolveEffectiveEmbeddingSetId: async () => 'set-1',
      workspaceDbRootIds: [],
    });

    runners.runTextSearch();
    await waitFor(() => expect(searchText).toHaveBeenCalledTimes(1));
    expect(useWorkspaceSearchStore.getState().status).toBe('searching');

    // A toggle abandons the in-flight run (advances the generation) with NO new run.
    act(() => {
      useWorkspaceSearchStore.getState().toggleCase();
    });
    expect(useWorkspaceSearchStore.getState().status).toBe('idle');

    // The abandoned run resolving late must not resurrect 'searching'/'results'.
    resolveText(makeTextResults());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useWorkspaceSearchStore.getState().status).toBe('idle');
    expect(useWorkspaceSearchStore.getState().results).toBeNull();
  });
});

describe('useWorkspaceSearchController', () => {
  beforeEach(() => {
    openFileInTabMock.mockClear();
  });
  afterEach(() => {
    useWorkspaceSearchStore.getState().reset();
  });

  // The controller reads the shared embedder via `useSharedSearchEmbedder`, which
  // THROWS without a provider (no silent fallback). Enclose the hook in the real
  // provider; its embedder machinery is lazy, so no model loads in these tests.
  function withRootIdentity(map: ReadonlyMap<string, string>) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <SearchEmbedderProvider>
          <RootIdentityProvider dbRootIdByAdapterRootId={map}>{children}</RootIdentityProvider>
        </SearchEmbedderProvider>
      );
    };
  }

  it('exposes workspaceDbRootIds from the reconciliation map and resolves adapter ids', () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: withRootIdentity(
        new Map([
          ['A1', 'D1'],
          ['A2', 'D2'],
        ])
      ),
    });

    expect([...result.current.workspaceDbRootIds].sort()).toEqual(['D1', 'D2']);
    expect(result.current.resolveAdapterRootId('D1')).toBe('A1');
    expect(result.current.resolveAdapterRootId('missing')).toBeNull();
  });

  it('onOpenFile forwards the match line to the file-open seam as { line }', () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: withRootIdentity(new Map()),
    });
    act(() => {
      result.current.onOpenFile('root-a|@|src/a.ts', { line: 42 });
    });
    expect(openFileInTabMock).toHaveBeenCalledWith('root-a|@|src/a.ts', { line: 42 });
  });

  it('onOpenFile forwards a chunk range as { line, selection } so the block is selected', () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: withRootIdentity(new Map()),
    });
    act(() => {
      result.current.onOpenFile('root-a|@|src/a.ts', {
        line: 8,
        selection: { endLine: 12, startLine: 8 },
      });
    });
    expect(openFileInTabMock).toHaveBeenCalledWith('root-a|@|src/a.ts', {
      line: 8,
      selection: { endLine: 12, startLine: 8 },
    });
  });

  it('onOpenFile omits the options object when no target is given', () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: withRootIdentity(new Map()),
    });
    act(() => {
      result.current.onOpenFile('root-a|@|src/a.ts');
    });
    expect(openFileInTabMock).toHaveBeenCalledWith('root-a|@|src/a.ts', undefined);
  });

  it('fails the search honestly when the database is not ready (no executor)', async () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: withRootIdentity(new Map()),
    });

    result.current.runTextSearch();
    await waitFor(() => {
      expect(useWorkspaceSearchStore.getState().status).toBe('error');
    });
    expect(useWorkspaceSearchStore.getState().error).toContain('database is not ready');
  });
  it('keeps an installed but unavailable native provider visible instead of using legacy text search', async () => {
    const embedQuery = vi.fn();
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <SearchEmbedderProvider>
          <NativeWorkspaceSearchProvider
            dependencies={{ capability: null, embedQuery, profile: null }}
          >
            <RootIdentityProvider dbRootIdByAdapterRootId={new Map([['A1', 'D1']])}>
              {children}
            </RootIdentityProvider>
          </NativeWorkspaceSearchProvider>
        </SearchEmbedderProvider>
      );
    }
    useWorkspaceSearchStore.getState().setQuery('needle');
    const { result } = renderHook(() => useWorkspaceSearchController(), { wrapper: Wrapper });
    expect(result.current.allowTextPaging).toBe(false);
    act(() => result.current.runTextSearch());
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('error'));
    expect(useWorkspaceSearchStore.getState().error).toBe(
      'Native workspace search is unavailable.'
    );
    expect(embedQuery).not.toHaveBeenCalled();
    expect(useWorkspaceSearchStore.getState().mode).toBe('text');
  });

  it('preserves explicit semantic mode and collection when native capability is lost', async () => {
    useWorkspaceSearchStore.getState().setMode('semantic');
    useWorkspaceSearchStore.getState().setCollectionId('explicit-collection');
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <SearchEmbedderProvider>
          <NativeWorkspaceSearchProvider
            dependencies={{ capability: null, embedQuery: vi.fn(), profile: null }}
          >
            <RootIdentityProvider dbRootIdByAdapterRootId={new Map([['A1', 'D1']])}>
              {children}
            </RootIdentityProvider>
          </NativeWorkspaceSearchProvider>
        </SearchEmbedderProvider>
      );
    }
    const { result } = renderHook(() => useWorkspaceSearchController(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.semanticAvailability?.available).toBe(false));
    act(() => result.current.runSemanticSearch());
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('error'));
    expect(useWorkspaceSearchStore.getState().error).toBe(
      'Native workspace search is unavailable.'
    );
    expect(useWorkspaceSearchStore.getState().mode).toBe('semantic');
    expect(useWorkspaceSearchStore.getState().collectionId).toBe('explicit-collection');
  });
  it('composes text-only native search over canonical roots without a PGlite handle or model', async () => {
    const embedding = { indexMode: 'text-only' as const };
    const response = {
      candidateCount: 0,
      candidatesTruncated: false,
      embedding,
      hits: [],
      scanLimited: false,
      storeId: 'store-a',
      truncated: false,
    };
    const capability = {
      coverage: vi.fn<IndexSearchCapability['coverage']>(),
      grep: vi.fn<IndexSearchCapability['grep']>(async () => response),
      rebuild: vi.fn(async () => {}),
      search: vi.fn<IndexSearchCapability['search']>(async () => response),
      status: vi.fn<IndexSearchCapability['status']>(async () => ({
        authorizedRootIds: ['D1'],
        embedding,
        kind: 'ready',
        rootReadiness: [{ rootId: 'D1', scanComplete: false }],
        storeId: 'store-a',
      })),
    };
    const embedQuery = vi.fn();
    const dependencies = { capability, embedQuery, profile: null };
    const identities = new Map([['A1', 'D1']]);
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <SearchEmbedderProvider>
          <NativeWorkspaceSearchProvider dependencies={dependencies}>
            <RootIdentityProvider dbRootIdByAdapterRootId={identities}>
              {children}
            </RootIdentityProvider>
          </NativeWorkspaceSearchProvider>
        </SearchEmbedderProvider>
      );
    }
    useWorkspaceSearchStore.getState().setQuery('needle');
    const { result } = renderHook(() => useWorkspaceSearchController(), { wrapper: Wrapper });
    act(() => result.current.runTextSearch());
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
    expect(capability.search).toHaveBeenCalledExactlyOnceWith({
      limit: 100,
      mode: 'bm25',
      rootIds: ['D1'],
      text: 'needle',
    });
    expect(capability.grep).toHaveBeenCalledExactlyOnceWith({
      caseSensitive: false,
      isRegex: false,
      limit: 100,
      pattern: 'needle',
      rootIds: ['D1'],
    });
    expect(capability.coverage).not.toHaveBeenCalled();
    expect(embedQuery).not.toHaveBeenCalled();
    expect(result.current.allowTextPaging).toBe(false);
    expect(result.current.semanticAvailability?.available).toBe(false);
  });
  it('invalidates an in-flight native read when its installed capability changes', async () => {
    const embedding = { indexMode: 'text-only' as const };
    const response = {
      candidateCount: 0,
      candidatesTruncated: false,
      embedding,
      hits: [],
      scanLimited: false,
      storeId: 'store-a',
      truncated: false,
    };
    let resolveRead: (result: typeof response) => void = () => {};
    const capability = {
      coverage: vi.fn<IndexSearchCapability['coverage']>(),
      grep: vi.fn<IndexSearchCapability['grep']>(async () => response),
      rebuild: vi.fn(async () => {}),
      search: vi.fn<IndexSearchCapability['search']>(
        () =>
          new Promise<typeof response>((resolve) => {
            resolveRead = resolve;
          })
      ),
      status: vi.fn<IndexSearchCapability['status']>(async () => ({
        authorizedRootIds: ['D1'],
        embedding,
        kind: 'ready',
        rootReadiness: [{ rootId: 'D1', scanComplete: false }],
        storeId: 'store-a',
      })),
    };
    let dependencies: NativeWorkspaceSearchDependencies = {
      capability,
      embedQuery: vi.fn(),
      profile: null,
    };
    const identities = new Map([['A1', 'D1']]);
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <SearchEmbedderProvider>
          <NativeWorkspaceSearchProvider dependencies={dependencies}>
            <RootIdentityProvider dbRootIdByAdapterRootId={identities}>
              {children}
            </RootIdentityProvider>
          </NativeWorkspaceSearchProvider>
        </SearchEmbedderProvider>
      );
    }
    useWorkspaceSearchStore.getState().setQuery('needle');
    const { result, rerender } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: Wrapper,
    });
    act(() => result.current.runTextSearch());
    await waitFor(() => expect(capability.search).toHaveBeenCalledTimes(1));
    dependencies = { ...dependencies, capability: null };
    rerender();
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('error'));
    expect(useWorkspaceSearchStore.getState().error).toBe(
      'Native workspace search scope or capability changed.'
    );
    await act(async () => {
      resolveRead(response);
    });
    expect(useWorkspaceSearchStore.getState().status).toBe('error');
    expect(useWorkspaceSearchStore.getState().results).toBeNull();
    expect(useWorkspaceSearchStore.getState().mode).toBe('text');
  });

  it.each(['unmount', 'capability change'] as const)(
    'cancels owned native inference on %s and holds its promise until completion',
    async (action) => {
      const profile = {
        dimensions: 384,
        dtype: 'fp16' as const,
        modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
        revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
        tokenCap: 256,
      };
      const embedding = {
        indexMode: 'vector-configured' as const,
        profile,
        profileHash: '60a05b1084b11c2add2e01bb8112960f51e83e68c88ad4151b0dc54eb69e1914',
      };
      const counts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
      const capability: IndexSearchCapability = {
        coverage: vi.fn(async () => ({
          embedding,
          roots: [{ rootId: 'D1', ...counts }],
          storeId: 'store-a',
          totals: counts,
          vectorCoverageComplete: true,
        })),
        grep: vi.fn(),
        rebuild: vi.fn(async () => {}),
        search: vi.fn(),
        status: vi.fn(async () => ({
          authorizedRootIds: ['D1'],
          embedding,
          kind: 'ready' as const,
          rootReadiness: [{ rootId: 'D1', scanComplete: true }],
          storeId: 'store-a',
        })),
      };
      const physical = Promise.withResolvers<readonly number[]>();
      const settled = vi.fn();
      const embedQuery = vi.fn<NativeWorkspaceSearchDependencies['embedQuery']>(async () => {
        try {
          return await physical.promise;
        } finally {
          settled();
        }
      });
      let dependencies: NativeWorkspaceSearchDependencies = { capability, embedQuery, profile };
      const identities = new Map([['A1', 'D1']]);
      function Wrapper({ children }: { children: ReactNode }) {
        return (
          <SearchEmbedderProvider>
            <NativeWorkspaceSearchProvider dependencies={dependencies}>
              <RootIdentityProvider dbRootIdByAdapterRootId={identities}>
                {children}
              </RootIdentityProvider>
            </NativeWorkspaceSearchProvider>
          </SearchEmbedderProvider>
        );
      }
      useWorkspaceSearchStore.getState().setQuery('needle');
      useWorkspaceSearchStore.getState().setMode('semantic');
      const { result, unmount, rerender } = renderHook(() => useWorkspaceSearchController(), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(result.current.semanticAvailability?.available).toBe(true));
      act(() => result.current.runSemanticSearch());
      await waitFor(() => expect(embedQuery).toHaveBeenCalledOnce());
      const signal = embedQuery.mock.calls[0]?.[2].signal;
      if (!signal) {
        throw new Error('Native inference did not receive its owned signal');
      }
      if (action === 'unmount') {
        unmount();
      } else {
        dependencies = { ...dependencies, capability: null };
        rerender();
      }
      expect(signal.aborted).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      await act(async () => {
        physical.reject(signal.reason);
      });
      expect(settled).toHaveBeenCalledOnce();
      expect(capability.search).not.toHaveBeenCalled();
      expect(useWorkspaceSearchStore.getState().results).toBeNull();
    }
  );
});
