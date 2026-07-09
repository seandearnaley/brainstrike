import { create } from 'zustand';

/**
 * A single selected search chunk. Line bounds are 1-based and INCLUSIVE
 * ([startLine..endLine]) — the FileChunk convention shared with the result model.
 * The selected-chunk SET (keyed by `chunkId`) is the SOURCE OF TRUTH for
 * workspace-search selection; Tapestry ranges are a one-way derived OUTPUT.
 */
export interface SelectedChunk {
  chunkId: string;
  endLine: number;
  startLine: number;
}

interface ChunkSelectionState {
  /** Add (or replace) a single chunk under a file's composite key. */
  addChunk: (key: string, chunk: SelectedChunk) => void;
  /** Drop every selection for every key (session reset). */
  clearAll: () => void;
  /** Drop the whole chunk subset for one file (e.g. whole-file supersedes it). */
  clearForKey: (key: string) => void;
  /** Remove a single chunk from a file's subset by id. */
  removeChunk: (key: string, chunkId: string) => void;
  /** Replace a file's entire chunk subset with the given chunks. */
  replaceForKey: (key: string, chunks: readonly SelectedChunk[]) => void;
  /** compositeKey -> chunkId -> chunk. A missing/empty entry means "no subset". */
  selectionsByKey: Record<string, Record<string, SelectedChunk>>;
}

function toChunkMap(chunks: readonly SelectedChunk[]): Record<string, SelectedChunk> {
  const map: Record<string, SelectedChunk> = {};
  for (const chunk of chunks) {
    map[chunk.chunkId] = chunk;
  }
  return map;
}

/**
 * Session-lived selected-chunk set for workspace search. Plain `create` (no
 * persistence), mirroring `workspace-search-store.ts` house style. The bridge
 * writes this set first, then derives Tapestry ranges from it — checkbox state
 * is read from the set, never from the ranges (see range-math + bridge).
 */
export const useChunkSelectionStore = create<ChunkSelectionState>((set) => ({
  addChunk: (key, chunk) =>
    set((state) => ({
      selectionsByKey: {
        ...state.selectionsByKey,
        [key]: { ...state.selectionsByKey[key], [chunk.chunkId]: chunk },
      },
    })),
  clearAll: () => set({ selectionsByKey: {} }),
  clearForKey: (key) =>
    set((state) => {
      if (state.selectionsByKey[key] === undefined) {
        return {};
      }
      const next = { ...state.selectionsByKey };
      delete next[key];
      return { selectionsByKey: next };
    }),
  removeChunk: (key, chunkId) =>
    set((state) => {
      const subset = state.selectionsByKey[key];
      if (subset?.[chunkId] === undefined) {
        return {};
      }
      const nextSubset = { ...subset };
      delete nextSubset[chunkId];
      return {
        selectionsByKey: { ...state.selectionsByKey, [key]: nextSubset },
      };
    }),
  replaceForKey: (key, chunks) =>
    set((state) => ({
      selectionsByKey: { ...state.selectionsByKey, [key]: toChunkMap(chunks) },
    })),
  selectionsByKey: {},
}));
