import {
  BoundaryFailureError,
  describeBoundaryError,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { SearchEmbedderProvider } from '@brainstrike/vector-management';
import type { NativeWorkspaceSearchDependencies } from '@brainstrike/workspace-search/core';
import {
  NativeWorkspaceSearchExecutor,
  NativeWorkspaceSearchProvider,
  useWorkspaceSearchStore,
} from '@brainstrike/workspace-search/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootIdentityProvider } from '../roots/root-identity-context';
import {
  createNativeWorkspaceSearchRunners,
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

describe('native Search boundary presentation', () => {
  it('retains the recorded GPU-loss remedy without exposing the private cause', async () => {
    useWorkspaceSearchStore.getState().reset();
    useWorkspaceSearchStore.getState().setQuery('where is the release signing procedure');
    // Recorded Main-to-visible envelope from actual hardware loss on 91d27dbeb.
    const failure = new BoundaryFailureError(
      {
        category: 'availability',
        code: 'EMBEDDING_DEVICE_LOST',
        correlationId: '8cb3b33a-70a7-4753-b72b-cbea1c0b5250',
        kind: 'fault',
        message: 'WebGPU device was lost.',
        remedy: 'Choose the model again to retry.',
      },
      { cause: new Error('private vendor device stack') }
    );
    const executor = new NativeWorkspaceSearchExecutor({
      capability: null,
      embedQuery: vi.fn(),
      profile: null,
    });
    vi.spyOn(executor, 'searchSemantic').mockRejectedValueOnce(failure);
    createNativeWorkspaceSearchRunners(executor, ['D1']).runSemanticSearch();
    await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('error'));
    // A fault names the reference Main logged its private cause under (BST-2202).
    expect(useWorkspaceSearchStore.getState().error).toBe(
      'WebGPU device was lost. Choose the model again to retry. Reference: 8cb3b33a-70a7-4753-b72b-cbea1c0b5250'
    );
    expect(useWorkspaceSearchStore.getState().error).not.toContain('private vendor');
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

  it('fails the search honestly when no native index is attached (no executor)', async () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: withRootIdentity(new Map()),
    });

    result.current.runTextSearch();
    await waitFor(() => {
      expect(useWorkspaceSearchStore.getState().status).toBe('error');
    });
    expect(useWorkspaceSearchStore.getState().error).toContain('native index is not attached');
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

  it('preserves explicit semantic mode when native capability is lost', async () => {
    useWorkspaceSearchStore.getState().setMode('semantic');
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
      coverageBatch: vi.fn(async () => {
        throw new Error('Unexpected coverage batch');
      }),
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
      coverageBatch: vi.fn<IndexSearchCapability['coverageBatch']>(),
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
        coverageBatch: vi.fn<IndexSearchCapability['coverageBatch']>(async () => ({
          coverage: [
            {
              embedding,
              roots: [{ rootId: 'D1', ...counts }],
              storeId: 'store-a',
              totals: counts,
              vectorCoverageComplete: true,
            },
          ],
          kind: 'current',
          status: {
            authorizedRootIds: ['D1'],
            embedding,
            kind: 'ready',
            rootReadiness: [{ rootId: 'D1', scanComplete: true }],
            storeId: 'store-a',
          },
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
      const availabilityRenders: {
        capability: IndexSearchCapability | null;
        available: boolean | undefined;
      }[] = [];
      const { result, unmount, rerender } = renderHook(
        () => {
          const controller = useWorkspaceSearchController();
          availabilityRenders.push({
            available: controller.semanticAvailability?.available,
            capability: dependencies.capability,
          });
          return controller;
        },
        { wrapper: Wrapper }
      );
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
        const lostCapabilityRenders = availabilityRenders.filter((row) => row.capability === null);
        expect(lostCapabilityRenders.length).toBeGreaterThan(0);
        expect(lostCapabilityRenders.map((row) => row.available)).not.toContain(true);
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

it.each([
  new BoundaryFailureError(
    {
      category: 'configuration',
      code: 'embedding.missing-key',
      kind: 'refusal',
      message: 'No API key configured for the embedding provider.',
      remedy: 'Configure the embedding provider API key in Settings, then retry indexing.',
    },
    { cause: new Error('private fixture') }
  ),
  ...(
    [
      {
        category: 'input',
        code: 'embedding.input-too-long',
        message: 'The embedding provider refused the input as too large.',
        remedy: 'Reduce the text sent for embedding, then retry.',
      },
      {
        category: 'availability',
        code: 'embedding.rate-limit',
        message: 'The embedding provider is rate limiting requests.',
        remedy: 'Wait for the provider rate limit to clear, then retry.',
      },
    ] as const
  ).map(
    (failure) =>
      new BoundaryFailureError(
        { ...failure, kind: 'refusal' },
        { cause: new Error('private fixture') }
      )
  ),
  new Error('private untyped coverage failure'),
])(
  'renders coverage failure as unavailable using only its safe boundary description',
  async (error) => {
    useWorkspaceSearchStore.getState().reset();
    const profile = {
      dimensions: 384,
      dtype: 'fp16' as const,
      modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
      revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
      tokenCap: 256,
    };
    const capability: IndexSearchCapability = {
      coverage: vi.fn(),
      coverageBatch: vi.fn(async () => {
        throw error;
      }),
      grep: vi.fn(),
      rebuild: vi.fn(),
      search: vi.fn(),
      status: vi.fn(),
    };
    const dependencies = { capability, embedQuery: vi.fn(), profile };
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
    const { result, unmount } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: Wrapper,
    });
    await waitFor(() =>
      expect(result.current.semanticAvailability).toEqual({
        available: false,
        reason: describeBoundaryError(error),
      })
    );
    expect(result.current.semanticAvailability?.reason).not.toContain('private');
    expect(dependencies.embedQuery).not.toHaveBeenCalled();
    unmount();
  }
);
