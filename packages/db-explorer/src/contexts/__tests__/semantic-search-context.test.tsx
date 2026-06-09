import type { SearchConfig, SemanticSearchResult } from '@brainstrike/ui';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  type SearchExecutor,
  SemanticSearchProvider,
  useSemanticSearch,
} from '../semantic-search-context';

const searchConfig: SearchConfig = {
  distanceMetric: 'cosine',
  resultLimit: 10,
  threshold: 0.4,
};

const searchResult: SemanticSearchResult = {
  chunkId: 'chunk-1',
  content: 'semantic result',
  fileName: 'index.ts',
  filePath: 'src/index.ts',
  fileRecordId: 'file-1',
  nodeId: 'chunk-1',
  similarity: 0.92,
};

function createWrapper(
  searchExecutor?: SearchExecutor
): (props: { children: ReactNode }) => ReactNode {
  return function SemanticSearchTestWrapper({ children }: { children: ReactNode }) {
    const providerProps = searchExecutor ? { searchExecutor } : {};
    return <SemanticSearchProvider {...providerProps}>{children}</SemanticSearchProvider>;
  };
}

describe('SemanticSearchProvider', () => {
  it('returns default no-op context when no provider is mounted', async () => {
    const { result } = renderHook(() => useSemanticSearch());

    expect(result.current).toMatchObject({
      error: null,
      hasSearched: false,
      isSearching: false,
      searchResults: [],
    });

    await act(async () => {
      await result.current.executeSearch('query', searchConfig, 'set-1');
    });

    expect(result.current.searchResults).toEqual([]);
  });

  it('executes search and stores results', async () => {
    const searchExecutor = vi.fn<SearchExecutor>(async () => [searchResult]);
    const { result } = renderHook(() => useSemanticSearch(), {
      wrapper: createWrapper(searchExecutor),
    });

    await act(async () => {
      await result.current.executeSearch('  query  ', searchConfig, 'set-1');
    });

    expect(searchExecutor).toHaveBeenCalledWith('  query  ', searchConfig, 'set-1');
    expect(result.current).toMatchObject({
      error: null,
      hasSearched: true,
      isSearching: false,
      searchResults: [searchResult],
    });
  });

  it.each([
    {
      embeddingSetId: 'set-1',
      expectedError: 'Search executor not configured',
      query: 'query',
      searchExecutor: undefined,
    },
    {
      embeddingSetId: 'set-1',
      expectedError: 'Search query is empty',
      query: '   ',
      searchExecutor: vi.fn<SearchExecutor>(),
    },
    {
      embeddingSetId: null,
      expectedError: 'Select an active embedding set to perform semantic search',
      query: 'query',
      searchExecutor: vi.fn<SearchExecutor>(),
    },
  ])('sets validation error before searching for $expectedError', async ({
    embeddingSetId,
    expectedError,
    query,
    searchExecutor,
  }) => {
    const { result } = renderHook(() => useSemanticSearch(), {
      wrapper: createWrapper(searchExecutor),
    });

    await act(async () => {
      await result.current.executeSearch(query, searchConfig, embeddingSetId);
    });

    expect(result.current).toMatchObject({
      error: expectedError,
      hasSearched: false,
      isSearching: false,
      searchResults: [],
    });
    if (searchExecutor) {
      expect(searchExecutor).not.toHaveBeenCalled();
    }
  });

  it('captures executor failures and clears stale results', async () => {
    const searchExecutor = vi.fn<SearchExecutor>(async () => {
      throw new Error('search failed');
    });
    const { result } = renderHook(() => useSemanticSearch(), {
      wrapper: createWrapper(searchExecutor),
    });

    act(() => {
      result.current.setSearchResults([searchResult]);
    });

    await act(async () => {
      await result.current.executeSearch('query', searchConfig, 'set-1');
    });

    expect(result.current).toMatchObject({
      error: 'search failed',
      hasSearched: false,
      isSearching: false,
      searchResults: [],
    });
  });

  it('supports direct result/error setters and clearing state', () => {
    const { result } = renderHook(() => useSemanticSearch(), {
      wrapper: createWrapper(vi.fn<SearchExecutor>()),
    });

    act(() => {
      result.current.setSearchResults([searchResult]);
      result.current.setError('manual error');
    });

    expect(result.current.searchResults).toEqual([searchResult]);
    expect(result.current.error).toBe('manual error');

    act(() => {
      result.current.clearResults();
    });

    expect(result.current).toMatchObject({
      error: null,
      hasSearched: false,
      searchResults: [],
    });
  });
});
