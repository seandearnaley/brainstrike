import type { TapestryRange } from '@brainstrike/file-explorer-ui';
import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
} from '@brainstrike/file-explorer-ui/shell';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { type SelectedChunk, useChunkSelectionStore } from '../chunk-selection-store';
import { useSearchSelectionBridge } from '../use-search-selection-bridge';

const ROOT = 'root-1';
const OTHER_ROOT = 'root-2';
const PATH = 'src/a.ts';
const KEY = encodeFileSelection(ROOT, PATH);

function chunk(id: string, startLine: number, endLine: number): SelectedChunk {
  return { chunkId: id, endLine, startLine };
}

function makeRange(overrides: Partial<TapestryRange>): TapestryRange {
  return {
    color: '#000000',
    endLine: 5,
    id: 'seed',
    isActive: true,
    startLine: 1,
    ...overrides,
  };
}

function createWrapper() {
  const storageAdapter = new MemoryStorageAdapter();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <FileExplorerProvider storageAdapter={storageAdapter}>{children}</FileExplorerProvider>;
  };
}

function renderBridge() {
  return renderHook(
    () => ({
      bridge: useSearchSelectionBridge(),
      store: useFileExplorerStoreContext(),
    }),
    { wrapper: createWrapper() }
  );
}

function ranges(): TapestryRange[] {
  return useWorkspaceContextCurationStore.getState().tapestryRangesByKey[KEY] ?? [];
}

/** Search-owned covering spans (exclusive [start,end)), sorted, sans ids/colors. */
function searchSpans(): Array<{ endLine: number; startLine: number }> {
  return ranges()
    .filter((r) => r.origin === 'search')
    .map((r) => ({ endLine: r.endLine, startLine: r.startLine }))
    .sort((a, b) => a.startLine - b.startLine);
}

beforeEach(() => {
  useWorkspaceContextCurationStore.setState({ tapestryRangesByKey: {} });
  useChunkSelectionStore.setState({ selectionsByKey: {} });
});

describe('useSearchSelectionBridge', () => {
  it('toggleFile(true) selects the file with no search ranges; toggleFile(false) deselects', () => {
    const { result } = renderBridge();

    act(() => result.current.bridge.toggleFile(KEY, true));
    expect(result.current.bridge.fileState(KEY)).toBe('checked');
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(true);
    expect(searchSpans()).toEqual([]);

    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(result.current.bridge.fileState(KEY)).toBe('unchecked');
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(false);
  });

  it('toggleChunk(true) on an unselected file selects it and derives the chunk span', () => {
    const { result } = renderBridge();
    const c = chunk('c1', 10, 14);

    act(() => result.current.bridge.toggleChunk(KEY, c, true, [c]));

    expect(result.current.bridge.fileState(KEY)).toBe('indeterminate');
    expect(result.current.bridge.chunkState(KEY, 'c1')).toBe('checked');
    expect(searchSpans()).toEqual([{ endLine: 15, startLine: 10 }]);
  });

  it('OVERLAPPING chunks are reversible: uncheck A leaves exactly B (the core fix)', () => {
    const { result } = renderBridge();
    // Overlapping spans: A [1,26) and B [22,50) (chunks share lines 22–25).
    const a = chunk('a', 1, 25);
    const b = chunk('b', 22, 49);
    const siblings = [a, b];

    act(() => result.current.bridge.toggleChunk(KEY, a, true, siblings));
    act(() => result.current.bridge.toggleChunk(KEY, b, true, siblings));
    expect(result.current.bridge.chunkState(KEY, 'a')).toBe('checked');
    expect(result.current.bridge.chunkState(KEY, 'b')).toBe('checked');

    // Unchecking A must NOT flip B: B stays checked, ranges = exactly B's span.
    act(() => result.current.bridge.toggleChunk(KEY, a, false, siblings));
    expect(result.current.bridge.chunkState(KEY, 'a')).toBe('unchecked');
    expect(result.current.bridge.chunkState(KEY, 'b')).toBe('checked');
    expect(searchSpans()).toEqual([{ endLine: 50, startLine: 22 }]);

    // Unchecking B clears everything and deselects the file.
    act(() => result.current.bridge.toggleChunk(KEY, b, false, siblings));
    expect(result.current.bridge.chunkState(KEY, 'b')).toBe('unchecked');
    expect(searchSpans()).toEqual([]);
    expect(result.current.bridge.fileState(KEY)).toBe('unchecked');
  });

  it('IDENTICAL/NESTED spans toggle independently by chunkId', () => {
    const { result } = renderBridge();
    const outer = chunk('outer', 10, 30);
    const inner = chunk('inner', 15, 20); // nested inside outer
    const twin = chunk('twin', 10, 30); // identical span, different id
    const siblings = [outer, inner, twin];

    act(() => result.current.bridge.toggleChunk(KEY, outer, true, siblings));
    act(() => result.current.bridge.toggleChunk(KEY, inner, true, siblings));
    act(() => result.current.bridge.toggleChunk(KEY, twin, true, siblings));

    // Unchecking inner leaves outer + twin selected (independent set membership).
    act(() => result.current.bridge.toggleChunk(KEY, inner, false, siblings));
    expect(result.current.bridge.chunkState(KEY, 'outer')).toBe('checked');
    expect(result.current.bridge.chunkState(KEY, 'twin')).toBe('checked');
    expect(result.current.bridge.chunkState(KEY, 'inner')).toBe('unchecked');
    // Derived output still covers [10,31) — merge is output-only, safe.
    expect(searchSpans()).toEqual([{ endLine: 31, startLine: 10 }]);
  });

  it('whole-file: unchecking one of three chunks converts to the other two', () => {
    const { result } = renderBridge();
    const c1 = chunk('c1', 1, 10);
    const c2 = chunk('c2', 11, 20);
    const c3 = chunk('c3', 21, 30);
    const siblings = [c1, c2, c3];

    // Whole-file selection: file selected, empty chunk subset.
    act(() => result.current.bridge.toggleFile(KEY, true));
    expect(result.current.bridge.chunkState(KEY, 'c2')).toBe('checked');

    // Uncheck c2 -> convert to {c1, c3}; file stays selected (indeterminate).
    act(() => result.current.bridge.toggleChunk(KEY, c2, false, siblings));
    expect(result.current.bridge.fileState(KEY)).toBe('indeterminate');
    expect(result.current.bridge.chunkState(KEY, 'c1')).toBe('checked');
    expect(result.current.bridge.chunkState(KEY, 'c3')).toBe('checked');
    expect(result.current.bridge.chunkState(KEY, 'c2')).toBe('unchecked');
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(true);
    expect(searchSpans()).toEqual([
      { endLine: 11, startLine: 1 },
      { endLine: 31, startLine: 21 },
    ]);
  });

  it('whole-file: unchecking the only chunk deselects the file entirely', () => {
    const { result } = renderBridge();
    const only = chunk('only', 1, 10);

    act(() => result.current.bridge.toggleFile(KEY, true));
    act(() => result.current.bridge.toggleChunk(KEY, only, false, [only]));

    expect(result.current.bridge.fileState(KEY)).toBe('unchecked');
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(false);
  });

  it('whole-file: unchecking the file clears everything', () => {
    const { result } = renderBridge();
    const c1 = chunk('c1', 1, 10);
    const c2 = chunk('c2', 11, 20);

    // Build a subset, then toggleFile(true) supersedes it with whole-file.
    act(() => result.current.bridge.toggleChunk(KEY, c1, true, [c1, c2]));
    act(() => result.current.bridge.toggleFile(KEY, true));
    expect(result.current.bridge.fileState(KEY)).toBe('checked');
    expect(searchSpans()).toEqual([]);
    expect(useChunkSelectionStore.getState().selectionsByKey[KEY]).toBeUndefined();

    // Now uncheck the file -> nothing remains.
    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(result.current.bridge.fileState(KEY)).toBe('unchecked');
    expect(searchSpans()).toEqual([]);
  });

  it('preserves a userModified range verbatim through every chunk toggle', () => {
    const { result } = renderBridge();
    const userRange = makeRange({ endLine: 90, id: 'u', startLine: 80, userModified: true });
    const a = chunk('a', 1, 25);
    const b = chunk('b', 22, 49);
    const siblings = [a, b];

    act(() => result.current.store.getState().addSelectedFile(ROOT, PATH));
    act(() =>
      useWorkspaceContextCurationStore.getState().setTapestryRangesForKey(KEY, [userRange])
    );

    // Whole-file with a userModified range present -> uncheck a chunk converts.
    act(() => result.current.bridge.toggleChunk(KEY, b, false, siblings));
    expect(ranges().find((r) => r.id === 'u')).toEqual(userRange);

    act(() => result.current.bridge.toggleChunk(KEY, a, true, siblings));
    expect(ranges().find((r) => r.id === 'u')).toEqual(userRange);

    act(() => result.current.bridge.toggleChunk(KEY, a, false, siblings));
    expect(ranges().find((r) => r.id === 'u')).toEqual(userRange);

    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(ranges()).toEqual([userRange]);
  });

  it('toggleFile(true) after a subset existed clears the subset and leaves no search ranges', () => {
    const { result } = renderBridge();
    const c1 = chunk('c1', 1, 10);

    act(() => result.current.bridge.toggleChunk(KEY, c1, true, [c1]));
    expect(searchSpans()).toEqual([{ endLine: 11, startLine: 1 }]);

    act(() => result.current.bridge.toggleFile(KEY, true));
    expect(result.current.bridge.fileState(KEY)).toBe('checked');
    expect(useChunkSelectionStore.getState().selectionsByKey[KEY]).toBeUndefined();
    expect(searchSpans()).toEqual([]);
  });

  it('check -> uncheck round trip on an unselected file returns to the start', () => {
    const { result } = renderBridge();
    const c = chunk('c1', 10, 14);

    act(() => result.current.bridge.toggleChunk(KEY, c, true, [c]));
    expect(result.current.bridge.fileState(KEY)).toBe('indeterminate');

    act(() => result.current.bridge.toggleChunk(KEY, c, false, [c]));
    expect(result.current.bridge.fileState(KEY)).toBe('unchecked');
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(false);
    expect(result.current.bridge.chunkState(KEY, 'c1')).toBe('unchecked');
  });

  it('reads and writes a FOREIGN (non-focused) root via its folderState, like the explorer tree', () => {
    const { result } = renderBridge();

    act(() => {
      result.current.store.setState({ currentFolderId: OTHER_ROOT });
    });

    act(() => result.current.bridge.toggleFile(KEY, true));

    const state = result.current.store.getState();
    expect(state.selectedFilePaths.has(KEY)).toBe(false);
    expect(state.folderStates[ROOT]?.selectedFilePaths.has(KEY)).toBe(true);
    expect(result.current.bridge.fileState(KEY)).toBe('checked');
    expect(result.current.bridge.chunkState(KEY, 'any')).toBe('checked');

    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(result.current.store.getState().folderStates[ROOT]?.selectedFilePaths.has(KEY)).toBe(
      false
    );
    expect(result.current.bridge.fileState(KEY)).toBe('unchecked');
  });
});
