# Select All Performance Optimization Design

**Date:** 2025-01-21
**Status:** Approved
**Author:** Claude (with user collaboration)

## Problem Statement

The "Select All" functionality in the web version causes browser freezes when selecting large numbers of files (1,000+). Users experience:

- Complete UI freeze during selection
- Browser becoming unresponsive (cannot refresh)
- Excessive console logging overwhelming DevTools

Root causes identified:

1. **N² subscription cascade** - Every row subscribes to entire `selectedFilePaths` Set
2. **Excessive INFO-level logging** in hot paths (22+ logs per selection change)
3. **Synchronous cascading effects** - Selection triggers token indexer, warm cache, and tree rebuilds
4. **No chunking/yielding** - 5,000 file additions happen in single tick

## Architecture Overview

### Current Flow (Problematic)

```
User clicks "Select All"
    ↓
collectAllFilePaths() traverses tree → returns 5,000 paths
    ↓
addMultipleSelectedFiles() creates new Set with 5,000 entries
    ↓
Zustand notifies ALL subscribers (Set reference changed)
    ↓
├── Every OptimizedFileTreeRow re-renders (even virtualized ones recompute)
├── Token indexer useEffect fires → logs 6x → iterates 5,000 keys
├── Warm cache useEffect fires → logs 2x → DB queries
└── buildFileHandleMap may rebuild → full tree traversal
    ↓
Browser frozen for 2-10 seconds
```

### Proposed Flow (Optimized)

```
User clicks "Select All"
    ↓
collectAllFilePaths() traverses tree → returns 5,000 paths
    ↓
addMultipleSelectedFilesChunked() adds 500 files per chunk
    ↓
Between chunks: requestIdleCallback yields to browser
    ↓
Zustand notifies subscribers with new Set + incremented selectionVersion
    ↓
├── Only rows whose selection CHANGED re-render (path-specific selectors)
├── Token indexer useEffect fires (debounced 300ms) → logs 1x (conditional)
├── Warm cache deferred until idle
└── buildFileHandleMap only rebuilds if stale AND needed
    ↓
UI remains responsive throughout
```

## Detailed Design

### 1. Selection State Architecture

#### 1.1 Add Selection Version Counter

```typescript
// packages/file-explorer/src/store.ts
interface FileExplorerState {
  selectedFilePaths: Set<string>;
  selectionVersion: number;  // NEW: Increments on every selection change
  // ... existing fields
}

const initialState: FileExplorerState = {
  selectedFilePaths: new Set<string>(),
  selectionVersion: 0,
  // ...
};
```

#### 1.2 Path-Specific Selector Hook

```typescript
// packages/file-explorer-ui/src/hooks/use-is-path-selected.ts
import { useCallback } from 'react';
import { encodeFileSelection } from '@brainstrike/utils';
import { useFileExplorerStoreContext } from '../file-explorer-provider';

/**
 * Selector hook that only triggers re-render when THIS path's selection changes.
 * Uses Zustand's built-in equality check on the boolean return value.
 */
export function useIsPathSelected(folderId: string, path: string): boolean {
  const store = useFileExplorerStoreContext();

  return store(
    useCallback(
      (s) => s.selectedFilePaths.has(encodeFileSelection(folderId, path)),
      [folderId, path]
    )
  );
}
```

#### 1.3 Directory Selection Count Selector

```typescript
// packages/file-explorer-ui/src/hooks/use-selected-count-in-directory.ts
import { useCallback } from 'react';
import { encodeFileSelection } from '@brainstrike/utils';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { shallow } from 'zustand/shallow';

/**
 * Selector for directories that need to know selection count.
 * Only re-renders when the COUNT changes, not on every selection change.
 */
export function useSelectedCountInDirectory(
  folderId: string,
  filePaths: string[]
): number {
  const store = useFileExplorerStoreContext();

  return store(
    useCallback(
      (s) => {
        let count = 0;
        for (const path of filePaths) {
          if (s.selectedFilePaths.has(encodeFileSelection(folderId, path))) {
            count++;
          }
        }
        return count;
      },
      [folderId, filePaths]
    )
  );
}
```

#### 1.4 Update OptimizedFileTreeRow

```typescript
// packages/file-explorer-ui/src/optimized-file-tree-row.tsx

// BEFORE (subscribes to entire Set):
const selectedFilePaths = store((s) => s.selectedFilePaths);
const isFileSelected = useMemo(
  () => isPathSelectedInFolder(selectedFilePaths, folderId, node.path),
  [selectedFilePaths, folderId, node.path]
);

// AFTER (subscribes to boolean only):
const isFileSelected = useIsPathSelected(folderId, node.path);

// For directories, use the count selector:
const selectedCountInDir = useSelectedCountInDirectory(folderId, allFilePaths);
```

### 2. Logging Level Optimization

#### 2.1 Files to Audit

| File | Changes |
|------|---------|
| `use-background-token-indexer-integration.ts` | 15 INFO→DEBUG |
| `use-shared-file-content-loading.ts` | 6 INFO→DEBUG |
| `tabbed-file-editor-panel.tsx` | 5 INFO→DEBUG |
| `use-lazy-file-tree.ts` | 8 INFO→DEBUG |
| `file-selection-actions.ts` | 2 INFO→DEBUG |
| `token-cache-context.tsx` | 8 DEBUG (already correct) |

#### 2.2 Conditional Batch Logger

```typescript
// packages/utils/src/logger.ts - add to existing exports

export interface BatchLoggerOptions {
  selectionThreshold?: number;
  fileOperationThreshold?: number;
}

const DEFAULT_THRESHOLDS = {
  selectionThreshold: 100,
  fileOperationThreshold: 50,
};

export function createBatchLogger(scope: string, options?: BatchLoggerOptions) {
  const logger = createLogger(scope);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options };

  return {
    ...logger,
    /**
     * Logs at INFO only if count exceeds threshold, otherwise DEBUG.
     * Useful for batch operations that would spam logs.
     */
    batchInfo: (
      msg: string,
      data: { count: number; [key: string]: unknown }
    ) => {
      const level = data.count > thresholds.selectionThreshold ? 'info' : 'debug';
      logger[level](msg, data);
    },
  };
}
```

#### 2.3 Example Migration

```typescript
// BEFORE:
logger.info('Selection effect triggered', {
  selectedFilesCount: selectedFiles.size,
  isReady: indexer.isReady,
  // ... more fields
});

// AFTER:
logger.debug('Selection effect triggered', {
  selectedFilesCount: selectedFiles.size,
  isReady: indexer.isReady,
});
// OR for important thresholds:
if (selectedFiles.size > 1000) {
  logger.info('Large selection detected', { count: selectedFiles.size });
}
```

### 3. Batched Selection Updates

#### 3.1 Chunked Selection Action

```typescript
// packages/file-explorer/src/actions/file-selection-actions.ts

const SELECTION_CHUNK_SIZE = 500;

addMultipleSelectedFilesChunked: async (
  folderId: string,
  paths: string[],
  onProgress?: (added: number, total: number) => void
) => {
  logger.debug('addMultipleSelectedFilesChunked starting', {
    folderId,
    totalPaths: paths.length,
  });

  let totalAdded = 0;

  for (let i = 0; i < paths.length; i += SELECTION_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + SELECTION_CHUNK_SIZE);

    set((state) => {
      const newSelected = new Set(state.selectedFilePaths);
      const previousSize = newSelected.size;

      for (const path of chunk) {
        if (newSelected.size >= state.maxSelectionCount) break;
        const key = encodeFileSelection(folderId, path);
        if (!newSelected.has(key)) {
          newSelected.add(key);
        }
      }

      totalAdded += newSelected.size - previousSize;

      return {
        selectedFilePaths: newSelected,
        selectionVersion: state.selectionVersion + 1,
      };
    });

    onProgress?.(Math.min(i + SELECTION_CHUNK_SIZE, paths.length), paths.length);

    // Yield to browser between chunks
    if (i + SELECTION_CHUNK_SIZE < paths.length) {
      await new Promise<void>(resolve => {
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(() => resolve(), { timeout: 50 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    }
  }

  logger.debug('addMultipleSelectedFilesChunked complete', {
    totalAdded,
    totalPaths: paths.length,
  });

  return totalAdded;
}
```

#### 3.2 Update Recursive Select All

```typescript
// packages/file-explorer-ui/src/hooks/use-recursive-select-all.ts

// In selectFilesWithLimit function:
async function selectFilesWithLimitChunked(
  allFilePaths: string[],
  folderId: string,
  addMultipleSelectedFilesChunked: (
    folderId: string,
    paths: string[],
    onProgress?: (added: number, total: number) => void
  ) => Promise<number>,
  maxSelectionCount: number,
  onProgress?: (progress: { added: number; total: number }) => void
): Promise<SelectAllResult> {
  if (allFilePaths.length === 0) {
    logger.debug('selectFilesWithLimit: no files to select');
    return { success: true, filePaths: [], totalAvailable: 0 };
  }

  const pathsToSelect = allFilePaths.slice(0, maxSelectionCount);

  logger.debug('selectFilesWithLimit: selecting files', {
    totalFiles: allFilePaths.length,
    selectingCount: pathsToSelect.length,
  });

  if (pathsToSelect.length > 0) {
    await addMultipleSelectedFilesChunked(
      folderId,
      pathsToSelect,
      (added, total) => onProgress?.({ added, total })
    );
  }

  return {
    success: true,
    filePaths: pathsToSelect,
    totalAvailable: allFilePaths.length,
    limitReached: allFilePaths.length > maxSelectionCount,
  };
}
```

### 4. Deferred Operations

#### 4.1 Lazy Handle Map Rebuild

```typescript
// packages/file-explorer-ui/src/use-background-token-indexer-integration.ts

// Add staleness tracking
const fileHandleMapStaleRef = useRef(false);

useEffect(() => {
  if (rebuildTimeoutRef.current) {
    clearTimeout(rebuildTimeoutRef.current);
  }

  // Mark as stale immediately
  fileHandleMapStaleRef.current = true;

  // Only rebuild if we actually need the map
  rebuildTimeoutRef.current = setTimeout(() => {
    // Skip rebuild if no files selected and no pending operations
    if (selectedFiles.size === 0 && inFlightRef.current.size === 0) {
      logger.debug('Skipping handle map rebuild - no active operations');
      return;
    }

    const map = new Map<string, HandleInfo>();
    buildFileHandleMap(fileTree, map);
    fileHandleMapRef.current = map;
    fileHandleMapStaleRef.current = false;
    setFileHandleMapSize(map.size);

    logger.debug('File handle map rebuilt', { size: map.size });
  }, 500);

  return () => {
    if (rebuildTimeoutRef.current) {
      clearTimeout(rebuildTimeoutRef.current);
    }
  };
}, [fileTree, selectedFiles.size]); // Note: only size, not the Set itself
```

#### 4.2 Increased Debounce for Large Selections

```typescript
// packages/file-explorer-ui/src/use-background-token-indexer-integration.ts

useEffect(() => {
  // ... existing checks ...

  const newFiles = Array.from(selectedFiles).filter(
    (key) => !indexedFilesRef.current.has(key) && !inFlightRef.current.has(key)
  );

  if (newFiles.length === 0) return;

  // Adaptive debounce based on batch size
  const debounceMs = newFiles.length > 500 ? 500
                   : newFiles.length > 100 ? 300
                   : 100;

  const timeoutId = setTimeout(() => {
    void triggerIndexing(newFiles);
  }, debounceMs);

  return () => clearTimeout(timeoutId);
}, [selectedFiles, triggerIndexing, ...]);
```

## Implementation Plan

### Phase 1: Quick Wins (1-2 hours)

1. Audit and downgrade log levels in identified files
2. Add conditional logging for large batches
3. Increase debounce timers

**Files to modify:**
- `packages/file-explorer-ui/src/use-background-token-indexer-integration.ts`
- `packages/file-explorer-ui/src/use-shared-file-content-loading.ts`
- `packages/file-explorer-ui/src/tabbed-file-editor-panel.tsx`
- `packages/file-explorer-ui/src/use-lazy-file-tree.ts`
- `packages/file-explorer/src/actions/file-selection-actions.ts`

### Phase 2: Selection Architecture (3-4 hours)

1. Add `selectionVersion` to store
2. Create `useIsPathSelected` hook
3. Create `useSelectedCountInDirectory` hook
4. Migrate `OptimizedFileTreeRow` to new selectors
5. Migrate `file-tree-row.tsx`

**Files to modify:**
- `packages/file-explorer/src/store.ts`
- `packages/file-explorer/src/actions/file-selection-actions.ts`
- `packages/file-explorer-ui/src/hooks/use-is-path-selected.ts` (new)
- `packages/file-explorer-ui/src/hooks/use-selected-count-in-directory.ts` (new)
- `packages/file-explorer-ui/src/optimized-file-tree-row.tsx`
- `packages/file-explorer-ui/src/file-tree-row.tsx`

### Phase 3: Chunked Updates (2-3 hours)

1. Implement `addMultipleSelectedFilesChunked`
2. Update `use-recursive-select-all.ts` to use chunked version
3. Add progress UI feedback

**Files to modify:**
- `packages/file-explorer/src/actions/file-selection-actions.ts`
- `packages/file-explorer-ui/src/hooks/use-recursive-select-all.ts`
- `packages/file-explorer-ui/src/action-buttons.tsx` (progress UI)

### Phase 4: Deferred Operations (1-2 hours)

1. Make `buildFileHandleMap` lazy
2. Add staleness tracking
3. Implement adaptive debouncing

**Files to modify:**
- `packages/file-explorer-ui/src/use-background-token-indexer-integration.ts`

## Testing Strategy

### Unit Tests

```typescript
// packages/file-explorer-ui/src/__tests__/hooks/use-is-path-selected.test.ts
describe('useIsPathSelected', () => {
  it('returns true for selected paths');
  it('returns false for unselected paths');
  it('does not cause re-render when other paths change');
});

// packages/file-explorer/src/actions/__tests__/file-selection-actions.test.ts
describe('addMultipleSelectedFilesChunked', () => {
  it('adds files in chunks');
  it('yields between chunks');
  it('respects maxSelectionCount');
  it('reports progress correctly');
});
```

### Performance Tests

```typescript
// packages/file-explorer-ui/src/__tests__/select-all-perf.test.ts
describe('Select All Performance', () => {
  it('selects 5000 files without blocking > 100ms per chunk');
  it('maintains responsive UI during selection');
  it('generates < 10 INFO logs for 5000 file selection');
});
```

### Manual Testing Checklist

- [ ] Select all on folder with 100 files - instant
- [ ] Select all on folder with 1,000 files - < 1s, no freeze
- [ ] Select all on folder with 5,000 files - < 3s, UI responsive
- [ ] Scroll during select all - smooth scrolling
- [ ] Cancel select all mid-operation - stops cleanly
- [ ] Deselect all after large selection - instant

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Select 5000 files - completion time | 5-10s freeze | < 3s responsive |
| UI frame rate during select | 0 fps (frozen) | > 30 fps |
| Console logs (select 5000) | ~100 INFO | < 10 INFO |
| Memory spike during select | Large | Gradual |

## Rollback Strategy

Each phase is independently reversible:

1. **Phase 1**: Revert log level changes
2. **Phase 2**: New selectors are additive; remove usage and delete files
3. **Phase 3**: Use original `addMultipleSelectedFiles` instead of chunked
4. **Phase 4**: Revert debounce/lazy changes

## Open Questions

1. Should chunked selection show a progress bar or just spinner?
2. What's the optimal chunk size? (Proposed: 500, may need tuning)
3. Should we add a "Select First N" option for very large folders?

---

*This design was created collaboratively and approved by the user on 2025-01-21.*
