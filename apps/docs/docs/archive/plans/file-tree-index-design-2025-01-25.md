---
title: "File Tree Index Design 2025 01 25"
---

# P1: Shared FileTreeIndex Design

**Date:** 2025-01-25
**Status:** Approved
**Ticket:** P1 - Create a shared, incremental FileTreeIndex to remove repeated O(N) scans

## Problem

Multiple independent mechanisms traverse the file tree to build lookup maps:

1. `use-shared-file-content-loading.ts` - builds `nodeCacheRef` via `buildFileNodeCache()`
2. `use-background-token-indexer-integration.ts` - builds `fileHandleMapRef` via `buildFileHandleMap()`
3. Fallback searches via `fileExplorer.findNodeByPath()` - O(N) per lookup

Each mechanism does O(N) traversal on tree changes. With streaming/lazy-loading, these traversals stack up, creating "death by a thousand cuts" jank.

## Solution Overview

Create a single, shared `FileTreeIndex` that:
- Provides O(1) lookups for nodes and handles by composite key
- Receives incremental updates via callback from `useFileTree`
- Is exposed via React context, integrated into `FileTreeProvider`

## Data Structures

```typescript
// packages/file-explorer-ui/src/file-tree-index.ts

interface HandleInfo {
  webHandle?: FileSystemFileHandle;
  electronHandle?: ElectronFileHandle;
  fileName: string;
  fileSize: number | undefined;
}

interface FileTreeIndexStats {
  totalNodes: number;
  totalFiles: number;
  totalDirectories: number;
}

class FileTreeIndex {
  // O(1) node lookup by composite key (folderId|@|path)
  private nodeByKey: Map<string, IFileNode>;

  // O(1) handle lookup for token indexing
  private handleByKey: Map<string, HandleInfo>;

  // Public methods
  addNodes(nodes: IFileNode[], parentPath: string | null): void;
  removeNodes(parentPath: string): void;
  getNode(folderId: string, path: string): IFileNode | undefined;
  getHandle(folderId: string, path: string): HandleInfo | undefined;
  clear(): void;
  get stats(): FileTreeIndexStats;
}
```

## Integration with Tree Mutations

### Callback in useFileTree

```typescript
// packages/file-explorer-ui/src/use-file-tree-context.ts

interface UseFileTreeOptions {
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];

  // NEW: Called when nodes are added/updated
  onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void;
}
```

### Mutation Points

1. **Initial load**: `readDirectoryRecursive` returns root tree → call with `parentPath: null`
2. **`updateNodeChildren()`**: Lazy-loading populates directory → call with parent's path
3. **`expandAllDirectories()`**: Each batch of loaded children triggers callback

### Patch-Based Update Logic

```typescript
addNodes(nodes: IFileNode[], parentPath: string | null): void {
  for (const node of nodes) {
    const key = encodeFileSelection(node.rootFolderId, node.path);
    this.nodeByKey.set(key, node);

    if (node.type === 'file' && node.handle) {
      this.handleByKey.set(key, this.extractHandleInfo(node));
    }

    // Recurse for children (handles initial load with nested structure)
    if (node.children) {
      this.addNodes(node.children, node.path);
    }
  }
  this.updateStats();
}
```

## React Context Integration

Extend `FileTreeProvider` to include the index:

```typescript
// packages/file-explorer-ui/src/file-tree-provider.tsx

interface FileTreeIndexContextValue {
  getNode: (folderId: string, path: string) => IFileNode | undefined;
  getHandle: (folderId: string, path: string) => HandleInfo | undefined;
  getNodes: (compositeKeys: string[]) => Map<string, IFileNode>;
  stats: FileTreeIndexStats;
}

const FileTreeIndexContext = createContext<FileTreeIndexContextValue | null>(null);

export function FileTreeProvider({ children, rootDirectoryHandle, filterTreeFn }) {
  const index = useMemo(() => new FileTreeIndex(), []);

  // Clear index when root changes
  useEffect(() => {
    index.clear();
  }, [rootDirectoryHandle, index]);

  const fileTreeState = useFileTree(rootDirectoryHandle, {
    filterTreeFn,
    onNodesIndexed: index.addNodes.bind(index),
  });

  const indexContextValue = useMemo(() => ({
    getNode: index.getNode.bind(index),
    getHandle: index.getHandle.bind(index),
    getNodes: index.getNodes.bind(index),
    stats: index.stats,
  }), [index, /* trigger on index updates */]);

  return (
    <FileTreeContext.Provider value={{ ...fileTreeState, rootDirectoryHandle }}>
      <FileTreeIndexContext.Provider value={indexContextValue}>
        {children}
      </FileTreeIndexContext.Provider>
    </FileTreeContext.Provider>
  );
}

export function useFileTreeIndexContext(): FileTreeIndexContextValue {
  const context = useContext(FileTreeIndexContext);
  if (!context) {
    throw new Error('useFileTreeIndexContext must be used within FileTreeProvider');
  }
  return context;
}
```

## Consumer Migration

### useSharedFileContentLoading

**Remove:**
- `nodeCacheRef` and `cacheRebuildTimeoutRef`
- `buildFileNodeCache()` call in useEffect
- Debounce logic

**Replace:**
```typescript
const { getNode } = useFileTreeIndexContext();

// In prepareFileReadRequest:
const fileNode = getNode(folderId, path);  // O(1) lookup
```

### useBackgroundTokenIndexerIntegration

**Remove:**
- `fileHandleMapRef` and related rebuild logic
- `buildFileHandleMap()` function
- `scheduleRebuildIfNeeded()` callback
- Effect A (tree-driven) and Effect B (need-driven) for map rebuilding
- Stale tracking refs

**Replace:**
```typescript
const { getHandle } = useFileTreeIndexContext();

// When processing selected files:
const handleInfo = getHandle(folderId, path);  // O(1) lookup
```

### Code Removal Summary

- `buildFileNodeCache()` in `utils/file-node-cache.ts` - keep for fallback but remove main usage
- `buildFileHandleMap()` in background indexer - remove entirely
- ~150 lines of duplicated traversal/caching/debounce logic

## Testing

### Unit Tests (file-tree-index.test.ts)

1. `addNodes()` correctly indexes files and directories
2. `addNodes()` extracts HandleInfo for web and electron handles
3. `getNode()` returns correct node by composite key
4. `getHandle()` returns correct handle info
5. `clear()` removes all entries
6. Incremental updates accumulate entries correctly
7. Stats are accurate after operations

### Integration Tests

1. `FileTreeProvider` wires callback - index populates on tree load
2. Lazy-load updates index incrementally
3. Root folder change clears and rebuilds index
4. Consumer hooks work correctly with shared index

## Acceptance Criteria

| Criterion | Verification |
|-----------|--------------|
| No full-tree traversals in selection-driven effects | Grep codebase - `buildFileNodeCache`, `buildFileHandleMap` removed from hot paths |
| Streaming expand-all scales with batch size O(Δ) | Profile: time per batch independent of total tree size |
| Index cleared on root workspace change | Test: change root, verify index.stats shows reset |
| Memory: no leaks | Test: change root multiple times, verify old entries gone |

## Implementation Order

1. Create `FileTreeIndex` class with tests
2. Add `onNodesIndexed` callback to `useFileTree`
3. Integrate index into `FileTreeProvider`
4. Migrate `useSharedFileContentLoading` to use shared index
5. Migrate `useBackgroundTokenIndexerIntegration` to use shared index
6. Remove dead code (`buildFileNodeCache`, `buildFileHandleMap`)
7. Integration testing and performance validation

## Risks & Mitigations

**Risk:** Shared stateful data structure - bugs can cascade.
**Mitigation:** Keep first iteration minimal (node + handle lookup only), exhaustive unit tests.

**Risk:** React context updates could cause unnecessary re-renders.
**Mitigation:** Expose stable getter functions, not the raw maps. Use refs internally.

**Risk:** Index out of sync with tree.
**Mitigation:** Index updates are synchronous in the same call stack as tree mutations.
