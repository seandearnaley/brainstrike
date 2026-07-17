import type { FileExplorerState } from '@brainstrike/types';
import type { StateCreator } from 'zustand';
import { FileContentCache } from '../utils/file-content-cache';

// Global cache instance - much more aggressive limits
const fileContentCache = new FileContentCache(
  5 * 1024 * 1024, // 5MB max (10x reduction)
  50 // 50 files max (20x reduction)
);

/**
 * Build filtered file contents for memory-constrained state
 */
function buildFilteredContents(compositeKey: string, content: string): Record<string, string> {
  // Get current cache snapshot atomically to prevent race conditions
  const currentCacheKeys = new Set(fileContentCache.getKeys());
  const recentEntries = fileContentCache.getEntriesByAccess().slice(0, 10); // Keep top 10 recent files in state (5x reduction)

  // Build filtered state only from entries that are confirmed to exist in cache
  const filteredContents: Record<string, string> = {};

  // Add recent entries that still exist in cache
  for (const entry of recentEntries) {
    if (currentCacheKeys.has(entry.key)) {
      const cachedContent = fileContentCache.get(entry.key);
      if (cachedContent !== undefined) {
        filteredContents[entry.key] = cachedContent;
      }
    }
  }

  // Always ensure current file is in state (it's guaranteed to be in cache)
  filteredContents[compositeKey] = content;

  return filteredContents;
}

/**
 * Determine if cache-aware state management should be used
 */
function shouldUseFilteredState(): boolean {
  const cacheStats = fileContentCache.getStats();
  return cacheStats.totalSize > 2 * 1024 * 1024; // 2MB threshold (15x reduction)
}

export function createFileContentActions(
  set: Parameters<StateCreator<FileExplorerState>>[0],
  get: Parameters<StateCreator<FileExplorerState>>[1]
) {
  return {
    clearAllFileContents: () => {
      fileContentCache.clear();
      set({ fileContents: {} });
    },

    clearFileContents: (compositeKeys: string[]) => {
      // Clear from cache
      fileContentCache.deleteKeys(compositeKeys);

      // Clear from state
      set((state) => {
        const newFileContents = { ...state.fileContents };
        for (const key of compositeKeys) {
          delete newFileContents[key];
        }
        return { fileContents: newFileContents };
      });
    },

    evictOldFileContents: (count = 10) => {
      fileContentCache.evictOldest(count);

      // Sync state with cache
      const cacheKeys = new Set(fileContentCache.getKeys());
      set((state) => {
        const filteredContents: Record<string, string> = {};
        for (const [key, content] of Object.entries(state.fileContents)) {
          if (cacheKeys.has(key)) {
            filteredContents[key] = content;
          }
        }
        return { fileContents: filteredContents };
      });
    },

    getFileContent: (compositeKey: string): string | undefined => {
      // Check cache first for most up-to-date content, then fall back to state
      // This ensures we always get the latest content and prevents split-brain scenarios
      const cachedContent = fileContentCache.get(compositeKey);
      if (cachedContent !== undefined) {
        return cachedContent;
      }

      // Fall back to state if not in cache (should be rare with current logic)
      const state = get();
      return state.fileContents[compositeKey];
    },

    getFileContentCacheStats: () => fileContentCache.getStats(),
    setFileContent: (compositeKey: string, content: string) => {
      // Add to cache first
      fileContentCache.set(compositeKey, content);

      // Update state with cache-aware logic
      set((state) => {
        if (shouldUseFilteredState()) {
          return { fileContents: buildFilteredContents(compositeKey, content) };
        }

        // Normal case - add to state
        return {
          fileContents: {
            ...state.fileContents,
            [compositeKey]: content,
          },
        };
      });
    },
  };
}
