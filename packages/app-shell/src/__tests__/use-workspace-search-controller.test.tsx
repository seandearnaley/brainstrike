import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { act } from '@brainstrike/test-utils/react-act';
import {
  useWorkspaceSearchStore,
  type WorkspaceFileSearch,
  WorkspaceFileSearchContext,
  type WorkspaceSearchHit,
  type WorkspaceSearchSummary,
} from '@brainstrike/workspace-search/core';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSearchController } from '../use-workspace-search-controller';

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

// The Explorer's folder names, read through the explorer store the Search tab lives under.
const explorer = vi.hoisted(() => ({
  rootDescriptors: {
    A1: { displayName: 'repo', path: '/work/repo', rootId: 'A1' },
    A2: { displayName: 'wt2', path: '/work/wt2', rootId: 'A2' },
  } as Record<string, { displayName: string; path: string; rootId: string }>,
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof explorer) => T): T =>
    selector(explorer),
}));

const SUMMARY: WorkspaceSearchSummary = {
  candidatesTruncated: false,
  matchLimitReached: false,
  scanLimited: false,
  timedOut: false,
  unreadableRootIds: [],
};

const hit = (path: string, line = 1): WorkspaceSearchHit => ({
  line,
  lineText: `needle in ${path}`,
  path,
  rootId: 'A1',
});

/** One search the test drives: stream matches into it, then end it. */
interface DrivenSearch {
  readonly fail: (cause: unknown) => void;
  readonly finish: (summary?: WorkspaceSearchSummary) => void;
  readonly request: Parameters<WorkspaceFileSearch['search']>[0];
  readonly send: (hits: readonly WorkspaceSearchHit[]) => void;
  readonly signal: AbortSignal;
}

/** A search seam whose every search the test drives by hand. */
function drivenSearch() {
  const searches: DrivenSearch[] = [];
  const service: WorkspaceFileSearch = {
    search: (request, onMatches, signal) =>
      new Promise((resolve, reject) => {
        searches.push({
          fail: reject,
          finish: (summary = SUMMARY) => resolve(summary),
          request,
          send: onMatches,
          signal,
        });
      }),
  };
  return { searches, service };
}

function wrapperWith(service: WorkspaceFileSearch | null) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <WorkspaceFileSearchContext value={service}>{children}</WorkspaceFileSearchContext>;
  };
}

const store = () => useWorkspaceSearchStore.getState();

describe('useWorkspaceSearchController', () => {
  beforeEach(() => {
    openFileInTabMock.mockClear();
    store().reset();
  });
  afterEach(() => {
    store().reset();
  });

  it('shows matches as they stream in, then the finished search', async () => {
    const { searches, service } = drivenSearch();
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: wrapperWith(service),
    });
    act(() => {
      store().setQuery('needle');
      store().toggleCase();
      result.current.runSearch();
    });
    const [search] = searches;
    expect(search?.request).toEqual({
      caseSensitive: true,
      isRegex: false,
      query: 'needle',
      wholeWord: false,
    });

    act(() => search?.send([hit('a.ts'), hit('b.ts')]));
    await waitFor(() => expect(store().files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']));
    expect(store().status).toBe('searching');

    act(() => search?.finish({ ...SUMMARY, matchLimitReached: true }));
    await waitFor(() => expect(store().status).toBe('results'));
    expect(store().summary).toMatchObject({ matchLimitReached: true });
  });

  it('a newer search cancels the running one and drops its late matches', async () => {
    const { searches, service } = drivenSearch();
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: wrapperWith(service),
    });
    act(() => {
      store().setQuery('first');
      result.current.runSearch();
    });
    act(() => {
      store().setQuery('second');
      result.current.runSearch();
    });
    const [first, second] = searches;
    expect(first?.signal.aborted).toBe(true);
    expect(second?.signal.aborted).toBe(false);

    act(() => {
      first?.send([hit('stale.ts')]);
      first?.finish();
      second?.send([hit('fresh.ts')]);
    });
    await waitFor(() => expect(store().files.map((file) => file.path)).toEqual(['fresh.ts']));
    expect(store().status).toBe('searching');
  });

  it('changing a match option cancels the running search', () => {
    const { searches, service } = drivenSearch();
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: wrapperWith(service),
    });
    act(() => {
      store().setQuery('needle');
      result.current.runSearch();
    });
    act(() => store().toggleRegex());
    expect(searches[0]?.signal.aborted).toBe(true);
    expect(store().status).toBe('idle');
  });

  it('closing the Search tab cancels its search', () => {
    const { searches, service } = drivenSearch();
    const { result, unmount } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: wrapperWith(service),
    });
    act(() => {
      store().setQuery('needle');
      result.current.runSearch();
    });
    unmount();
    expect(searches[0]?.signal.aborted).toBe(true);
  });

  it('shows a refusal in words, with its remedy, and never the private cause', async () => {
    const { searches, service } = drivenSearch();
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: wrapperWith(service),
    });
    act(() => {
      store().setQuery('needle');
      result.current.runSearch();
    });
    act(() =>
      searches[0]?.fail(
        new BoundaryFailureError(
          {
            category: 'configuration',
            code: 'workspace.search-no-folder',
            kind: 'refusal',
            message: 'No folder is open, so there is nothing to search.',
            remedy: 'Open a folder, then search again.',
          },
          { cause: new Error('private detail') }
        )
      )
    );
    await waitFor(() => expect(store().status).toBe('error'));
    expect(store().error).toBe(
      'No folder is open, so there is nothing to search. Open a folder, then search again.'
    );
  });

  it('says search is unavailable where the frame offers none', () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: wrapperWith(null),
    });
    act(() => {
      store().setQuery('needle');
      result.current.runSearch();
    });
    expect(store()).toMatchObject({
      error: 'Workspace search is unavailable in this window.',
      status: 'error',
    });
  });

  it('names each folder as the Explorer does', () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: wrapperWith(null),
    });
    expect(result.current.rootName('A2')).toBe('wt2');
    expect(result.current.workspaceRootCount).toBe(2);
  });

  it('opens a match at its line, and a file row at the top', () => {
    const { result } = renderHook(() => useWorkspaceSearchController(), {
      wrapper: wrapperWith(null),
    });
    act(() => {
      result.current.onOpenFile('A1|@|src/a.ts', { line: 42 });
      result.current.onOpenFile('A1|@|src/b.ts');
    });
    expect(openFileInTabMock).toHaveBeenNthCalledWith(1, 'A1|@|src/a.ts', { line: 42 });
    expect(openFileInTabMock).toHaveBeenNthCalledWith(2, 'A1|@|src/b.ts', undefined);
  });
});
