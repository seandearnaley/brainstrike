---
title: "File Tree Index Implementation 2025 01 25"
---

# FileTreeIndex Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a shared, incremental FileTreeIndex that eliminates duplicate O(N) tree traversals across file-explorer-ui hooks.

**Architecture:** A `FileTreeIndex` class provides O(1) lookups by composite key. It receives patch-based updates via callback from `useLazyFileTree`. The index is exposed via React context integrated into `FileTreeProvider`.

**Tech Stack:** TypeScript, React 19, Vitest, Zustand patterns

---

## Task 1: Create FileTreeIndex Class with Core Types

**Files:**
- Create: `packages/file-explorer-ui/src/file-tree-index.ts`
- Create: `packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts`

**Step 1.1: Write the failing test for basic structure**

```typescript
// packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts
import { describe, expect, it } from 'vitest';
import { FileTreeIndex } from '../file-tree-index';

describe('FileTreeIndex', () => {
  it('should create an empty index', () => {
    const index = new FileTreeIndex();
    expect(index.stats).toEqual({
      totalNodes: 0,
      totalFiles: 0,
      totalDirectories: 0,
    });
  });
});
```

**Step 1.2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/file-explorer-ui -- file-tree-index.test.ts`
Expected: FAIL with "Cannot find module '../file-tree-index'"

**Step 1.3: Write minimal implementation**

```typescript
// packages/file-explorer-ui/src/file-tree-index.ts
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';

/**
 * Electron-style handle with path property
 */
interface ElectronFileHandle {
  path: string;
  name: string;
  kind: 'file';
  platform: 'electron';
}

/**
 * Combined handle info for indexing.
 * Includes file metadata for upfront filtering before queuing.
 */
export interface HandleInfo {
  webHandle?: FileSystemFileHandle;
  electronHandle?: ElectronFileHandle;
  fileName: string;
  fileSize: number | undefined;
}

export interface FileTreeIndexStats {
  totalNodes: number;
  totalFiles: number;
  totalDirectories: number;
}

/**
 * Type guard to check if handle is an Electron handle with path
 */
function isElectronHandle(handle: unknown): handle is ElectronFileHandle {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    'platform' in handle &&
    (handle as ElectronFileHandle).platform === 'electron' &&
    'path' in handle &&
    typeof (handle as ElectronFileHandle).path === 'string'
  );
}

/**
 * Type guard to check if handle is a Web FileSystemFileHandle
 */
function isWebFileHandle(handle: unknown): handle is FileSystemFileHandle {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    'getFile' in handle &&
    typeof (handle as FileSystemFileHandle).getFile === 'function'
  );
}

/**
 * Shared index for O(1) file node and handle lookups.
 * Receives incremental updates from tree mutations.
 */
export class FileTreeIndex {
  private nodeByKey = new Map<string, IFileNode>();
  private handleByKey = new Map<string, HandleInfo>();
  private _stats: FileTreeIndexStats = {
    totalNodes: 0,
    totalFiles: 0,
    totalDirectories: 0,
  };

  get stats(): FileTreeIndexStats {
    return { ...this._stats };
  }

  clear(): void {
    this.nodeByKey.clear();
    this.handleByKey.clear();
    this._stats = { totalNodes: 0, totalFiles: 0, totalDirectories: 0 };
  }
}
```

**Step 1.4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/file-explorer-ui -- file-tree-index.test.ts`
Expected: PASS

**Step 1.5: Commit**

```bash
git add packages/file-explorer-ui/src/file-tree-index.ts packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts
git commit -m "feat(file-explorer-ui): add FileTreeIndex class with basic structure"
```

---

## Task 2: Implement addNodes Method

**Files:**
- Modify: `packages/file-explorer-ui/src/file-tree-index.ts`
- Modify: `packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts`

**Step 2.1: Write the failing test for addNodes**

```typescript
// Add to file-tree-index.test.ts
import type { IFileNode } from '@brainstrike/types';

const createMockFileNode = (overrides: Partial<IFileNode> = {}): IFileNode => ({
  name: 'file.txt',
  path: 'src/file.txt',
  type: 'file',
  rootFolderId: 'folder-123',
  ...overrides,
});

const createMockDirectoryNode = (overrides: Partial<IFileNode> = {}): IFileNode => ({
  name: 'src',
  path: 'src',
  type: 'directory',
  rootFolderId: 'folder-123',
  children: [],
  loadState: 'loaded',
  ...overrides,
});

describe('addNodes', () => {
  it('should add file nodes to the index', () => {
    const index = new FileTreeIndex();
    const fileNode = createMockFileNode();

    index.addNodes([fileNode], null);

    expect(index.stats.totalNodes).toBe(1);
    expect(index.stats.totalFiles).toBe(1);
    expect(index.stats.totalDirectories).toBe(0);
  });

  it('should add directory nodes to the index', () => {
    const index = new FileTreeIndex();
    const dirNode = createMockDirectoryNode();

    index.addNodes([dirNode], null);

    expect(index.stats.totalNodes).toBe(1);
    expect(index.stats.totalFiles).toBe(0);
    expect(index.stats.totalDirectories).toBe(1);
  });

  it('should recursively add nested children', () => {
    const index = new FileTreeIndex();
    const dirNode = createMockDirectoryNode({
      children: [
        createMockFileNode({ name: 'a.txt', path: 'src/a.txt' }),
        createMockFileNode({ name: 'b.txt', path: 'src/b.txt' }),
      ],
    });

    index.addNodes([dirNode], null);

    expect(index.stats.totalNodes).toBe(3);
    expect(index.stats.totalFiles).toBe(2);
    expect(index.stats.totalDirectories).toBe(1);
  });
});
```

**Step 2.2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/file-explorer-ui -- file-tree-index.test.ts`
Expected: FAIL with "index.addNodes is not a function"

**Step 2.3: Write the addNodes implementation**

```typescript
// Add to FileTreeIndex class in file-tree-index.ts

/**
 * Extract handle info from a file node.
 */
private extractHandleInfo(node: IFileNode): HandleInfo | null {
  if (!node.handle) {
    return null;
  }

  if (isWebFileHandle(node.handle)) {
    return {
      webHandle: node.handle,
      fileName: node.name,
      fileSize: node.size,
    };
  }

  if (isElectronHandle(node.handle)) {
    return {
      electronHandle: node.handle,
      fileName: node.name,
      fileSize: node.size,
    };
  }

  return null;
}

/**
 * Add nodes to the index. Recurses into children.
 * @param nodes - Nodes to add
 * @param _parentPath - Parent path (unused, kept for callback signature compatibility)
 */
addNodes(nodes: IFileNode[], _parentPath: string | null): void {
  for (const node of nodes) {
    if (!node.rootFolderId) {
      continue;
    }

    const key = encodeFileSelection(node.rootFolderId, node.path);
    this.nodeByKey.set(key, node);

    if (node.type === 'file') {
      this._stats.totalFiles++;
      const handleInfo = this.extractHandleInfo(node);
      if (handleInfo) {
        this.handleByKey.set(key, handleInfo);
      }
    } else if (node.type === 'directory') {
      this._stats.totalDirectories++;
    }

    this._stats.totalNodes++;

    // Recurse for children
    if (node.children && node.children.length > 0) {
      this.addNodes(node.children, node.path);
    }
  }
}
```

**Step 2.4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/file-explorer-ui -- file-tree-index.test.ts`
Expected: PASS

**Step 2.5: Commit**

```bash
git add packages/file-explorer-ui/src/file-tree-index.ts packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts
git commit -m "feat(file-explorer-ui): implement FileTreeIndex.addNodes with recursion"
```

---

## Task 3: Implement getNode and getHandle Methods

**Files:**
- Modify: `packages/file-explorer-ui/src/file-tree-index.ts`
- Modify: `packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts`

**Step 3.1: Write the failing tests**

```typescript
// Add to file-tree-index.test.ts

describe('getNode', () => {
  it('should return node by folderId and path', () => {
    const index = new FileTreeIndex();
    const fileNode = createMockFileNode({ path: 'src/file.txt', rootFolderId: 'folder-123' });
    index.addNodes([fileNode], null);

    const result = index.getNode('folder-123', 'src/file.txt');

    expect(result).toBe(fileNode);
  });

  it('should return undefined for non-existent node', () => {
    const index = new FileTreeIndex();

    const result = index.getNode('folder-123', 'nonexistent.txt');

    expect(result).toBeUndefined();
  });
});

describe('getHandle', () => {
  it('should return handle info for file with web handle', () => {
    const index = new FileTreeIndex();
    const mockWebHandle = { getFile: () => Promise.resolve(new File([], 'test')) };
    const fileNode = createMockFileNode({
      handle: mockWebHandle as unknown as FileSystemFileHandle,
      size: 1024,
    });
    index.addNodes([fileNode], null);

    const result = index.getHandle('folder-123', 'src/file.txt');

    expect(result).toBeDefined();
    expect(result?.webHandle).toBe(mockWebHandle);
    expect(result?.fileName).toBe('file.txt');
    expect(result?.fileSize).toBe(1024);
  });

  it('should return handle info for file with electron handle', () => {
    const index = new FileTreeIndex();
    const mockElectronHandle = {
      path: '/absolute/path/file.txt',
      name: 'file.txt',
      kind: 'file' as const,
      platform: 'electron' as const,
    };
    const fileNode = createMockFileNode({
      handle: mockElectronHandle,
      size: 2048,
    });
    index.addNodes([fileNode], null);

    const result = index.getHandle('folder-123', 'src/file.txt');

    expect(result).toBeDefined();
    expect(result?.electronHandle).toBe(mockElectronHandle);
    expect(result?.fileName).toBe('file.txt');
    expect(result?.fileSize).toBe(2048);
  });

  it('should return undefined for non-existent handle', () => {
    const index = new FileTreeIndex();

    const result = index.getHandle('folder-123', 'nonexistent.txt');

    expect(result).toBeUndefined();
  });
});
```

**Step 3.2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/file-explorer-ui -- file-tree-index.test.ts`
Expected: FAIL with "index.getNode is not a function"

**Step 3.3: Write the implementation**

```typescript
// Add to FileTreeIndex class in file-tree-index.ts

/**
 * Get a node by folder ID and path.
 * @returns The node or undefined if not found
 */
getNode(folderId: string, path: string): IFileNode | undefined {
  const key = encodeFileSelection(folderId, path);
  return this.nodeByKey.get(key);
}

/**
 * Get handle info by folder ID and path.
 * @returns The handle info or undefined if not found
 */
getHandle(folderId: string, path: string): HandleInfo | undefined {
  const key = encodeFileSelection(folderId, path);
  return this.handleByKey.get(key);
}
```

**Step 3.4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/file-explorer-ui -- file-tree-index.test.ts`
Expected: PASS

**Step 3.5: Commit**

```bash
git add packages/file-explorer-ui/src/file-tree-index.ts packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts
git commit -m "feat(file-explorer-ui): implement FileTreeIndex.getNode and getHandle"
```

---

## Task 4: Implement clear() and Incremental Update Tests

**Files:**
- Modify: `packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts`

**Step 4.1: Write additional tests**

```typescript
// Add to file-tree-index.test.ts

describe('clear', () => {
  it('should remove all entries and reset stats', () => {
    const index = new FileTreeIndex();
    index.addNodes([createMockFileNode(), createMockDirectoryNode()], null);

    index.clear();

    expect(index.stats.totalNodes).toBe(0);
    expect(index.getNode('folder-123', 'src/file.txt')).toBeUndefined();
  });
});

describe('incremental updates', () => {
  it('should accumulate nodes from multiple addNodes calls', () => {
    const index = new FileTreeIndex();

    index.addNodes([createMockFileNode({ path: 'a.txt' })], null);
    index.addNodes([createMockFileNode({ path: 'b.txt' })], 'src');

    expect(index.stats.totalNodes).toBe(2);
    expect(index.getNode('folder-123', 'a.txt')).toBeDefined();
    expect(index.getNode('folder-123', 'b.txt')).toBeDefined();
  });

  it('should update existing node when re-added', () => {
    const index = new FileTreeIndex();
    const originalNode = createMockFileNode({ path: 'file.txt', size: 100 });
    const updatedNode = createMockFileNode({ path: 'file.txt', size: 200 });

    index.addNodes([originalNode], null);
    index.addNodes([updatedNode], null);

    const result = index.getNode('folder-123', 'file.txt');
    expect(result?.size).toBe(200);
    // Stats should not double-count
    expect(index.stats.totalNodes).toBe(1);
  });
});
```

**Step 4.2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/file-explorer-ui -- file-tree-index.test.ts`
Expected: FAIL - "should update existing node when re-added" will fail because stats double-count

**Step 4.3: Fix the addNodes to handle re-adds**

```typescript
// Update addNodes in file-tree-index.ts to check if node exists before counting

addNodes(nodes: IFileNode[], _parentPath: string | null): void {
  for (const node of nodes) {
    if (!node.rootFolderId) {
      continue;
    }

    const key = encodeFileSelection(node.rootFolderId, node.path);
    const existingNode = this.nodeByKey.get(key);

    // Only update stats if this is a new node
    if (!existingNode) {
      if (node.type === 'file') {
        this._stats.totalFiles++;
      } else if (node.type === 'directory') {
        this._stats.totalDirectories++;
      }
      this._stats.totalNodes++;
    }

    this.nodeByKey.set(key, node);

    if (node.type === 'file') {
      const handleInfo = this.extractHandleInfo(node);
      if (handleInfo) {
        this.handleByKey.set(key, handleInfo);
      }
    }

    // Recurse for children
    if (node.children && node.children.length > 0) {
      this.addNodes(node.children, node.path);
    }
  }
}
```

**Step 4.4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/file-explorer-ui -- file-tree-index.test.ts`
Expected: PASS

**Step 4.5: Commit**

```bash
git add packages/file-explorer-ui/src/file-tree-index.ts packages/file-explorer-ui/src/__tests__/file-tree-index.test.ts
git commit -m "feat(file-explorer-ui): handle incremental updates without double-counting"
```

---

## Task 5: Add onNodesIndexed Callback to useLazyFileTree

**Files:**
- Modify: `packages/file-explorer-ui/src/use-file-tree-context.ts`
- Modify: `packages/file-explorer-ui/src/use-lazy-file-tree.ts`

**Step 5.1: Update UseFileTreeOptions interface**

```typescript
// In use-file-tree-context.ts, update UseFileTreeOptions:

export interface UseFileTreeOptions {
  /**
   * Filter function to apply workspace include/exclude filters to a tree.
   */
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];

  /**
   * Callback invoked when nodes are added to the tree.
   * Used by FileTreeIndex for incremental indexing.
   * @param nodes - The nodes that were added
   * @param parentPath - The parent path, or null for root-level nodes
   */
  onNodesIndexed?: (nodes: IFileNode[], parentPath: string | null) => void;
}
```

**Step 5.2: Pass callback through to useLazyFileTree**

The callback needs to be wired into `useLazyFileTree`. Find the tree mutation points:

1. Initial root load (in `loadRoot`)
2. `loadChildren` (when a directory is expanded)
3. `expandAllProgressively` (batch loading)

**Step 5.3: Update useLazyFileTree to accept and call the callback**

```typescript
// In use-lazy-file-tree.ts, add options parameter handling:

// Near the top of useLazyFileTree function:
const { filterTreeFn, onNodesIndexed } = options;
const onNodesIndexedRef = useRef(onNodesIndexed);
onNodesIndexedRef.current = onNodesIndexed;

// After initial root load succeeds (in loadRoot), call the callback:
// Find where setState is called with the initial tree and add:
if (onNodesIndexedRef.current && newTree.length > 0) {
  onNodesIndexedRef.current(newTree, null);
}

// After loadChildren succeeds, call the callback:
// Find where children are set on a directory and add:
if (onNodesIndexedRef.current && children.length > 0) {
  onNodesIndexedRef.current(children, path);
}
```

**Step 5.4: Run existing tests**

Run: `pnpm test --filter @brainstrike/file-explorer-ui`
Expected: PASS (no breaking changes)

**Step 5.5: Commit**

```bash
git add packages/file-explorer-ui/src/use-file-tree-context.ts packages/file-explorer-ui/src/use-lazy-file-tree.ts
git commit -m "feat(file-explorer-ui): add onNodesIndexed callback to useFileTree"
```

---

## Task 6: Integrate FileTreeIndex into FileTreeProvider

**Files:**
- Modify: `packages/file-explorer-ui/src/file-tree-provider.tsx`
- Create: `packages/file-explorer-ui/src/__tests__/file-tree-provider.integration.test.tsx`

**Step 6.1: Add context and hook exports**

```typescript
// In file-tree-provider.tsx, add imports and context:

import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FileTreeIndex, type FileTreeIndexStats, type HandleInfo } from './file-tree-index';

// Add new context
interface FileTreeIndexContextValue {
  getNode: (folderId: string, path: string) => IFileNode | undefined;
  getHandle: (folderId: string, path: string) => HandleInfo | undefined;
  stats: FileTreeIndexStats;
  /** Version number that increments on each index update */
  version: number;
}

const FileTreeIndexContext = createContext<FileTreeIndexContextValue | null>(null);

// Update FileTreeProvider to create and wire the index:
export function FileTreeProvider({
  children,
  rootDirectoryHandle,
  filterTreeFn,
}: FileTreeProviderProps): React.ReactElement {
  const indexRef = useRef(new FileTreeIndex());
  const [indexVersion, setIndexVersion] = useState(0);

  // Clear index when root changes
  useEffect(() => {
    indexRef.current.clear();
    setIndexVersion((v) => v + 1);
  }, [rootDirectoryHandle]);

  // Callback for tree mutations
  const handleNodesIndexed = useCallback((nodes: IFileNode[], parentPath: string | null) => {
    indexRef.current.addNodes(nodes, parentPath);
    setIndexVersion((v) => v + 1);
  }, []);

  // Build options object
  const options = useMemo(() => {
    const opts: { filterTreeFn?: typeof filterTreeFn; onNodesIndexed: typeof handleNodesIndexed } = {
      onNodesIndexed: handleNodesIndexed,
    };
    if (filterTreeFn) {
      opts.filterTreeFn = filterTreeFn;
    }
    return opts;
  }, [filterTreeFn, handleNodesIndexed]);

  const fileTreeState = useFileTree(rootDirectoryHandle, options);

  const indexContextValue = useMemo(
    () => ({
      getNode: indexRef.current.getNode.bind(indexRef.current),
      getHandle: indexRef.current.getHandle.bind(indexRef.current),
      stats: indexRef.current.stats,
      version: indexVersion,
    }),
    [indexVersion]
  );

  return (
    <FileTreeContext.Provider value={{ ...fileTreeState, rootDirectoryHandle }}>
      <FileTreeIndexContext.Provider value={indexContextValue}>
        {children}
      </FileTreeIndexContext.Provider>
    </FileTreeContext.Provider>
  );
}

// Add hook exports
export function useFileTreeIndexContext(): FileTreeIndexContextValue {
  const context = useContext(FileTreeIndexContext);
  if (!context) {
    throw new Error('useFileTreeIndexContext must be used within FileTreeProvider');
  }
  return context;
}

export function useOptionalFileTreeIndexContext(): FileTreeIndexContextValue | null {
  return useContext(FileTreeIndexContext);
}
```

**Step 6.2: Run existing tests**

Run: `pnpm test --filter @brainstrike/file-explorer-ui`
Expected: PASS

**Step 6.3: Commit**

```bash
git add packages/file-explorer-ui/src/file-tree-provider.tsx packages/file-explorer-ui/src/file-tree-index.ts
git commit -m "feat(file-explorer-ui): integrate FileTreeIndex into FileTreeProvider"
```

---

## Task 7: Migrate useSharedFileContentLoading

**Files:**
- Modify: `packages/file-explorer-ui/src/use-shared-file-content-loading.ts`

**Step 7.1: Update imports and add index context**

```typescript
// Replace buildFileNodeCache imports with index context:
import { useOptionalFileTreeIndexContext } from './file-tree-provider';

// Remove these imports:
// import { buildFileNodeCache, getFileNodeFromCache, refreshFileNodeCacheEntry } from './utils/file-node-cache';
```

**Step 7.2: Remove nodeCacheRef and debounce logic**

Remove:
- `const nodeCacheRef = useRef<Map<string, Map<string, IFileNode>>>(new Map());`
- `const cacheRebuildTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);`
- The entire `useEffect` that rebuilds the cache

**Step 7.3: Update getFileNodeWithRetry to use index**

```typescript
// Replace the function to use index:
async function getFileNodeWithRetry(
  indexContext: ReturnType<typeof useOptionalFileTreeIndexContext>,
  fileTree: IFileNode[],
  folderId: string,
  path: string
): Promise<IFileNode | null> {
  // Try index first (O(1))
  if (indexContext) {
    const node = indexContext.getNode(folderId, path);
    if (node && isFileNodeValid(node, folderId)) {
      return node;
    }
  }

  // Fallback to tree search (O(N)) - handles race conditions during initial load
  const treeNodeCount = countTreeNodes(fileTree);
  let fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);

  if (!isFileNodeValid(fileNode, folderId)) {
    logger.debug('Initial lookup failed, retrying', {
      path,
      folderId,
      treeNodeCount,
      fileTreeLength: fileTree.length,
      foundNode: !!fileNode,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);
  }

  return fileNode;
}
```

**Step 7.4: Update hook to use index context**

```typescript
// In useSharedFileContentLoading, add:
const indexContext = useOptionalFileTreeIndexContext();

// Update prepareFileReadRequest call signature and implementation to use indexContext
```

**Step 7.5: Run tests**

Run: `pnpm test --filter @brainstrike/file-explorer-ui`
Expected: PASS

**Step 7.6: Commit**

```bash
git add packages/file-explorer-ui/src/use-shared-file-content-loading.ts
git commit -m "refactor(file-explorer-ui): migrate useSharedFileContentLoading to FileTreeIndex"
```

---

## Task 8: Migrate useBackgroundTokenIndexerIntegration

**Files:**
- Modify: `packages/file-explorer-ui/src/use-background-token-indexer-integration.ts`

**Step 8.1: Add index context import**

```typescript
import { useOptionalFileTreeIndexContext } from './file-tree-provider';
```

**Step 8.2: Remove buildFileHandleMap and related code**

Remove:
- `buildFileHandleMap` function
- `fileHandleMapRef`
- `fileHandleMapStaleRef`
- `previousSelectionSizeForMapRef`
- `rebuildTimeoutRef`
- `scheduleRebuildIfNeeded` callback
- Effect A (tree-driven rebuild)
- Effect B (selection-driven rebuild)
- `setFileHandleMapSize` state

**Step 8.3: Update handle lookups to use index**

```typescript
// In the hook, add:
const indexContext = useOptionalFileTreeIndexContext();

// Replace fileHandleMapRef.current.get(compositeKey) with:
const handleInfo = indexContext?.getHandle(folderId, path);

// Update diagnostics to use index stats:
diagnostics: {
  indexedCount: indexedFilesRef.current.size,
  inFlightCount: inFlightRef.current.size,
  fileHandleMapSize: indexContext?.stats.totalFiles ?? 0,
  workerReady: isReady,
  cacheOperational: !!tokenCache,
  cachePersisted: tokenCache?.isPersisted ?? false,
  clearIndexedCache,
},
```

**Step 8.4: Run tests**

Run: `pnpm test --filter @brainstrike/file-explorer-ui`
Expected: PASS

**Step 8.5: Commit**

```bash
git add packages/file-explorer-ui/src/use-background-token-indexer-integration.ts
git commit -m "refactor(file-explorer-ui): migrate useBackgroundTokenIndexerIntegration to FileTreeIndex"
```

---

## Task 9: Clean Up Dead Code

**Files:**
- Modify: `packages/file-explorer-ui/src/utils/file-node-cache.ts`
- Modify: `packages/file-explorer-ui/src/use-shared-file-content-loading.ts`

**Step 9.1: Remove unused exports from file-node-cache.ts**

Check if `buildFileNodeCache` is still used anywhere. If not, remove or mark as deprecated.

**Step 9.2: Remove unused imports**

Clean up any unused imports in migrated files.

**Step 9.3: Run full test suite**

Run: `pnpm test --filter @brainstrike/file-explorer-ui`
Expected: PASS

**Step 9.4: Run lint and type-check**

Run: `pnpm lint && pnpm type-check`
Expected: PASS

**Step 9.5: Commit**

```bash
git add -A
git commit -m "chore(file-explorer-ui): remove dead code after FileTreeIndex migration"
```

---

## Task 10: Final Validation

**Step 10.1: Run full check pipeline**

Run: `pnpm check`
Expected: PASS

**Step 10.2: Manual testing**

1. Open the app
2. Select a folder
3. Expand directories - verify no jank
4. Run expand-all - verify smooth streaming
5. Select files - verify token indexing still works

**Step 10.3: Create summary commit**

```bash
git log --oneline -10  # Review commits
```

---

## Acceptance Criteria Verification

| Criterion | How to Verify |
|-----------|---------------|
| No full-tree traversals in selection effects | `grep -r "buildFileHandleMap\|buildFileNodeCache" packages/file-explorer-ui/src --include="*.ts"` returns no matches in hot paths |
| Streaming expand-all scales O(Δ) | Index updates only process new nodes, not full tree |
| Index cleared on root change | Test: change root folder, verify stats reset to 0 |
| No memory leaks | Test: change root multiple times, verify old entries gone |
