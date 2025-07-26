import type { FileExplorerState } from '@brainstrike/types';
import type { StateCreator } from 'zustand';
import { FileContentCache } from '../utils/file-content-cache';

// Global cache instance - much more aggressive limits
const fileContentCache = new FileContentCache(
  5 * 1024 * 1024, // 5MB max (10x reduction)
  50 // 50 files max (20x reduction)
);

export function createFileContentActions(
  set: Parameters<StateCreator<FileExplorerState>>[0],
  get: Parameters<StateCreator<FileExplorerState>>[1]
) {
  return {
    setFileContent: (compositeKey: string, content: string) => {
      // Add to cache first
      fileContentCache.set(compositeKey, content);

      // Update state with cache-aware logic
      set((state) => {
        // Check if we should keep this in state or rely on cache
        const cacheStats = fileContentCache.getStats();

        // If cache is getting full, only keep essential files in state
        if (cacheStats.totalSize > 2 * 1024 * 1024) {
          // 2MB threshold (15x reduction)
          // Only keep recently accessed files in state
          const recentKeys = fileContentCache
            .getEntriesByAccess()
            .slice(0, 10) // Keep top 10 recent files in state (5x reduction)
            .map((entry) => entry.key);

          const filteredContents: Record<string, string> = {};
          for (const key of recentKeys) {
            const cachedContent = fileContentCache.get(key);
            if (cachedContent) {
              filteredContents[key] = cachedContent;
            }
          }

          // Add current file
          filteredContents[compositeKey] = content;

          return { fileContents: filteredContents };
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

    getFileContent: (compositeKey: string): string | undefined => {
      // First check state
      const state = get();
      if (state.fileContents[compositeKey]) {
        return state.fileContents[compositeKey];
      }

      // Then check cache
      return fileContentCache.get(compositeKey);
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

    clearAllFileContents: () => {
      fileContentCache.clear();
      set({ fileContents: {} });
    },

    getFileContentCacheStats: () => {
      return fileContentCache.getStats();
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
  };
}
