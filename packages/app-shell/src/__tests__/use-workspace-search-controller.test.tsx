import type {
  SemanticSearchRequest,
  TextSearchRequest,
  WorkspaceSearchResults,
} from '@brainstrike/workspace-search';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootIdentityProvider } from '../roots/root-identity-context';
import {
  createWorkspaceSearchRunners,
  resolveGrepRepository,
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

describe('resolveGrepRepository', () => {
  it('uses the platform repo directly when it exposes findGrepCandidates (desktop)', async () => {
    const findGrepCandidates = vi.fn(async () => []);
    const platformRepo = { findGrepCandidates } as unknown as Parameters<
      typeof resolveGrepRepository
    >[0];
    const dbQuery = vi.fn(async () => ({ rows: [] }));
    const db = { query: dbQuery } as unknown as Parameters<typeof resolveGrepRepository>[1];

    const repo = resolveGrepRepository(platformRepo, db);
    await repo.findGrepCandidates({ caseSensitive: false, likePattern: 'x', limit: 10 });

    expect(findGrepCandidates).toHaveBeenCalledTimes(1);
    // The platform repo is used verbatim, so the raw db.query seam is untouched.
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('falls back to a query-only PGlite repo when the platform repo has no grep method (web)', async () => {
    const platformRepo = { fullTextSearch: vi.fn() } as unknown as Parameters<
      typeof resolveGrepRepository
    >[0];
    const dbQuery = vi.fn(async () => ({ rows: [] }));
    const db = { query: dbQuery } as unknown as Parameters<typeof resolveGrepRepository>[1];

    const repo = resolveGrepRepository(platformRepo, db);
    await repo.findGrepCandidates({ caseSensitive: false, likePattern: 'x', limit: 10 });

    // The fallback FileChunkRepository reads candidates through db.query.
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });
});

describe('useWorkspaceSearchController', () => {
  beforeEach(() => {
    openFileInTabMock.mockClear();
  });
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

  it('onOpenFile forwards the match line to the file-open seam as { line }', () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: withRootIdentity(new Map()),
    });
    act(() => {
      result.current.onOpenFile('root-a|@|src/a.ts', 42);
    });
    expect(openFileInTabMock).toHaveBeenCalledWith('root-a|@|src/a.ts', { line: 42 });
  });

  it('onOpenFile omits the options object when no line is given', () => {
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
});
