import { beforeEach, describe, expect, it } from 'vitest';
import { type SelectedChunk, useChunkSelectionStore } from '../chunk-selection-store';

const KEY = 'root|@|src/a.ts';
const OTHER = 'root|@|src/b.ts';

function chunk(id: string, startLine = 1, endLine = 10): SelectedChunk {
  return { chunkId: id, endLine, startLine };
}

function subset(key: string): Record<string, SelectedChunk> {
  return useChunkSelectionStore.getState().selectionsByKey[key] ?? {};
}

beforeEach(() => {
  useChunkSelectionStore.setState({ selectionsByKey: {} });
});

describe('useChunkSelectionStore', () => {
  it('addChunk inserts by chunkId under the key', () => {
    useChunkSelectionStore.getState().addChunk(KEY, chunk('c1'));
    expect(subset(KEY)).toEqual({ c1: chunk('c1') });
  });

  it('addChunk of a second chunk keeps both; addChunk with the same id replaces', () => {
    const { addChunk } = useChunkSelectionStore.getState();
    addChunk(KEY, chunk('c1', 1, 10));
    addChunk(KEY, chunk('c2', 11, 20));
    expect(Object.keys(subset(KEY))).toEqual(['c1', 'c2']);
    addChunk(KEY, chunk('c1', 5, 8));
    expect(subset(KEY)).toEqual({ c1: chunk('c1', 5, 8), c2: chunk('c2', 11, 20) });
  });

  it('removeChunk drops one chunk and leaves an empty map when it was the last', () => {
    const { addChunk, removeChunk } = useChunkSelectionStore.getState();
    addChunk(KEY, chunk('c1'));
    addChunk(KEY, chunk('c2', 11, 20));
    removeChunk(KEY, 'c1');
    expect(Object.keys(subset(KEY))).toEqual(['c2']);
    removeChunk(KEY, 'c2');
    expect(subset(KEY)).toEqual({});
  });

  it('removeChunk is a no-op for a missing key or chunkId (stable reference)', () => {
    const before = useChunkSelectionStore.getState().selectionsByKey;
    useChunkSelectionStore.getState().removeChunk(KEY, 'nope');
    expect(useChunkSelectionStore.getState().selectionsByKey).toBe(before);
  });

  it('replaceForKey overwrites the whole subset', () => {
    const { addChunk, replaceForKey } = useChunkSelectionStore.getState();
    addChunk(KEY, chunk('c1'));
    replaceForKey(KEY, [chunk('c2', 11, 20), chunk('c3', 21, 30)]);
    expect(Object.keys(subset(KEY))).toEqual(['c2', 'c3']);
  });

  it('clearForKey removes only that key; clearAll wipes everything', () => {
    const { addChunk, clearForKey, clearAll } = useChunkSelectionStore.getState();
    addChunk(KEY, chunk('c1'));
    addChunk(OTHER, chunk('d1'));
    clearForKey(KEY);
    expect(subset(KEY)).toEqual({});
    expect(Object.keys(subset(OTHER))).toEqual(['d1']);
    clearAll();
    expect(useChunkSelectionStore.getState().selectionsByKey).toEqual({});
  });

  it('clearForKey is a no-op for an absent key (stable reference)', () => {
    const before = useChunkSelectionStore.getState().selectionsByKey;
    useChunkSelectionStore.getState().clearForKey(KEY);
    expect(useChunkSelectionStore.getState().selectionsByKey).toBe(before);
  });
});
