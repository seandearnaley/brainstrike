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
import { useSearchSelectionBridge } from '../use-search-selection-bridge';

const ROOT = 'root-1';
const OTHER_ROOT = 'root-2';
const PATH = 'src/a.ts';
const KEY = encodeFileSelection(ROOT, PATH);

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

/** A range owned by the search bridge — the only kind its toggles may mutate. */
function makeSearchRange(overrides: Partial<TapestryRange>): TapestryRange {
  return makeRange({ ...overrides, origin: 'search' });
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

function curationState() {
  return useWorkspaceContextCurationStore.getState();
}

beforeEach(() => {
  useWorkspaceContextCurationStore.setState({ tapestryRangesByKey: {} });
});

describe('useSearchSelectionBridge', () => {
  it('toggleFile(true) selects the file; toggleFile(false) deselects and clears ranges', () => {
    const { result } = renderBridge();

    act(() => result.current.bridge.toggleFile(KEY, true));
    expect(result.current.bridge.isFileChecked(KEY)).toBe(true);
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(true);

    act(() =>
      curationState().setTapestryRangesForKey(KEY, [makeSearchRange({ endLine: 5, startLine: 1 })])
    );

    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(result.current.bridge.isFileChecked(KEY)).toBe(false);
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(false);
    expect(curationState().tapestryRangesByKey[KEY]).toEqual([]);
  });

  it('toggleFile(false) preserves userModified + default ranges while clearing search-owned', () => {
    const { result } = renderBridge();
    const userRange = makeRange({ endLine: 5, id: 'u', startLine: 1, userModified: true });
    const defaultRange = makeRange({ endLine: 40, id: 'd', startLine: 0 });

    act(() => result.current.bridge.toggleFile(KEY, true));
    act(() =>
      curationState().setTapestryRangesForKey(KEY, [
        userRange,
        defaultRange,
        makeSearchRange({ endLine: 10, id: 'x', startLine: 8 }),
      ])
    );

    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(curationState().tapestryRangesByKey[KEY]).toEqual([userRange, defaultRange]);
  });

  it('toggleChunk(true) on an unselected file selects it and writes the coalesced range', () => {
    const { result } = renderBridge();
    const chunk = { endLine: 14, startLine: 10 };
    expect(result.current.bridge.isFileChecked(KEY)).toBe(false);

    act(() => result.current.bridge.toggleChunk(KEY, chunk, true));

    expect(result.current.bridge.isFileChecked(KEY)).toBe(true);
    const ranges = curationState().tapestryRangesByKey[KEY];
    expect(ranges).toHaveLength(1);
    expect(ranges?.[0]).toMatchObject({
      endLine: 15,
      isActive: true,
      origin: 'search',
      startLine: 10,
    });
    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('checked');
  });

  it('toggleChunk(false) removes the covered search-owned range; a non-overlapping userModified survives', () => {
    const { result } = renderBridge();
    const chunk = { endLine: 14, startLine: 10 };
    // userModified range elsewhere so it does not cover the unchecked chunk.
    const userRange = makeRange({ endLine: 35, id: 'u', startLine: 30, userModified: true });

    act(() => result.current.bridge.toggleFile(KEY, true));
    act(() =>
      curationState().setTapestryRangesForKey(KEY, [
        userRange,
        makeSearchRange({ endLine: 15, id: 'x', startLine: 10 }),
      ])
    );

    act(() => result.current.bridge.toggleChunk(KEY, chunk, false));

    expect(curationState().tapestryRangesByKey[KEY]).toEqual([userRange]);
    expect(result.current.bridge.isFileChecked(KEY)).toBe(true);
  });

  it('toggleChunk(false) under an auto-created default range deselects the file and never mutates the default', () => {
    const { result } = renderBridge();
    const chunk = { endLine: 14, startLine: 10 };
    const defaultRange = makeRange({ endLine: 50, id: 'd', startLine: 0 });

    // File selected via the explorer store; preview panel wrote the full-file default.
    act(() => result.current.store.getState().addSelectedFile(ROOT, PATH));
    act(() => curationState().setTapestryRangesForKey(KEY, [defaultRange]));
    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('checked');

    // The default covers the chunk and the bridge may not trim it, so unchecking
    // one chunk deselects the WHOLE file; the default range is left verbatim.
    act(() => result.current.bridge.toggleChunk(KEY, chunk, false));

    expect(result.current.bridge.isFileChecked(KEY)).toBe(false);
    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('unchecked');
    expect(curationState().tapestryRangesByKey[KEY]).toEqual([defaultRange]);
  });

  it('check -> uncheck round trip on an unselected file ends unselected + chunk unchecked', () => {
    const { result } = renderBridge();
    const chunk = { endLine: 14, startLine: 10 };
    expect(result.current.bridge.isFileChecked(KEY)).toBe(false);

    // toggleChunk(true) auto-selects the file and writes a search-managed range.
    act(() => result.current.bridge.toggleChunk(KEY, chunk, true));
    expect(result.current.bridge.isFileChecked(KEY)).toBe(true);

    // toggleChunk(false) removes the only range AND must deselect the file so the
    // round trip is idempotent (no zero-range whole-file 'checked' collapse).
    act(() => result.current.bridge.toggleChunk(KEY, chunk, false));
    expect(result.current.bridge.isFileChecked(KEY)).toBe(false);
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(false);
    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('unchecked');
  });

  it('check -> uncheck round trip keeps the file selected when a userModified range remains', () => {
    const { result } = renderBridge();
    const chunk = { endLine: 14, startLine: 10 };
    const userRange = makeRange({ endLine: 30, id: 'u', startLine: 25, userModified: true });

    // Pre-existing hand-curated range on a selected file.
    act(() => result.current.bridge.toggleFile(KEY, true));
    act(() => curationState().setTapestryRangesForKey(KEY, [userRange]));

    act(() => result.current.bridge.toggleChunk(KEY, chunk, true));
    act(() => result.current.bridge.toggleChunk(KEY, chunk, false));

    // The userModified range survives verbatim and keeps the file selected.
    expect(result.current.bridge.isFileChecked(KEY)).toBe(true);
    expect(curationState().tapestryRangesByKey[KEY]).toEqual([userRange]);
  });

  it('deselects the entire file when unchecking one chunk of an explorer whole-file (zero-range) selection', () => {
    const { result } = renderBridge();
    const chunk = { endLine: 14, startLine: 10 };
    const otherChunk = { endLine: 40, startLine: 30 };

    // Select the file the way the EXPLORER tree checkbox does — directly via the
    // file-explorer store, NOT the bridge's toggleChunk — leaving zero tapestry
    // ranges. chunkCoverage's zero-ranges rule then reads every chunk as 'checked'.
    act(() => result.current.store.getState().addSelectedFile(ROOT, PATH));
    expect(result.current.bridge.isFileChecked(KEY)).toBe(true);
    expect(curationState().tapestryRangesByKey[KEY]).toBeUndefined();
    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('checked');
    expect(result.current.bridge.chunkState(KEY, otherChunk)).toBe('checked');

    // Unchecking a single chunk can't be expressed as "whole file minus one
    // chunk" in the range model, so the bridge deselects the WHOLE file.
    act(() => result.current.bridge.toggleChunk(KEY, chunk, false));

    expect(result.current.bridge.isFileChecked(KEY)).toBe(false);
    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('unchecked');
    // A different, never-toggled chunk in the same file reads unchecked too —
    // proof this deselected the whole file, not just a partial range.
    expect(result.current.bridge.chunkState(KEY, otherChunk)).toBe('unchecked');
  });

  it('chunkState reflects both stores live', () => {
    const { result } = renderBridge();
    const chunk = { endLine: 14, startLine: 10 };

    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('unchecked');

    // Select via the file-explorer store's own action (not the bridge).
    act(() => result.current.store.getState().addSelectedFile(ROOT, PATH));
    // Selected with no ranges -> whole-file semantics.
    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('checked');

    act(() =>
      curationState().setTapestryRangesForKey(KEY, [
        makeRange({ endLine: 13, id: 'x', startLine: 10 }),
      ])
    );
    expect(result.current.bridge.chunkState(KEY, chunk)).toBe('indeterminate');
  });

  it('reads and writes a FOREIGN (non-focused) root via its folderState, like the explorer tree', () => {
    const { result } = renderBridge();

    // Focus a different root so ROOT becomes foreign (forest mode).
    act(() => {
      result.current.store.setState({ currentFolderId: OTHER_ROOT });
    });

    act(() => result.current.bridge.toggleFile(KEY, true));

    const state = result.current.store.getState();
    // The write routed into the foreign root's folderState, NOT the top-level set.
    expect(state.selectedFilePaths.has(KEY)).toBe(false);
    expect(state.folderStates[ROOT]?.selectedFilePaths.has(KEY)).toBe(true);
    // The bridge reads it back the same way the explorer's own checkboxes do.
    expect(result.current.bridge.isFileChecked(KEY)).toBe(true);
    expect(result.current.bridge.chunkState(KEY, { endLine: 14, startLine: 10 })).toBe('checked');

    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(result.current.store.getState().folderStates[ROOT]?.selectedFilePaths.has(KEY)).toBe(
      false
    );
    expect(result.current.bridge.isFileChecked(KEY)).toBe(false);
  });
});
