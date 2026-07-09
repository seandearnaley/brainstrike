import type {
  SemanticSearchRequest,
  TextSearchRequest,
  WorkspaceSearchResults,
} from '@brainstrike/workspace-search';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootIdentityProvider } from '../roots/root-identity-context';
import {
  createWorkspaceSearchRunners,
  useWorkspaceSearchController,
} from '../use-workspace-search-controller';

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
});

describe('useWorkspaceSearchController', () => {
  afterEach(() => {
    useWorkspaceSearchStore.getState().reset();
  });

  function withRootIdentity(map: ReadonlyMap<string, string>) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return <RootIdentityProvider dbRootIdByAdapterRootId={map}>{children}</RootIdentityProvider>;
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
});
