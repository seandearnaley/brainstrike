/**
 * File Tree Hook (Context-aware)
 *
 * This hook provides file tree functionality using only the context-based store,
 * avoiding dependencies on the file-explorer-hooks package that uses the old global store.
 */

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { primeFileNodeIndex } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readFullTree as readFullTreeUtil } from './utils/read-full-tree';

type BasicSubtreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: BasicSubtreeNode[];
};

function buildNodesFromSubtree(
  arr: BasicSubtreeNode[],
  depth: number,
  rootFolderId: string
): IFileNode[] {
  return arr.map((e) => {
    if (e.type === 'directory') {
      return {
        name: e.name,
        path: e.path,
        type: 'directory',
        handle: {
          path: e.path,
          name: e.name,
          kind: 'directory',
          platform: 'electron',
        } as unknown as FileSystemDirectoryHandle,
        depth,
        selectionState: 'unchecked',
        children: e.children ? buildNodesFromSubtree(e.children, depth + 1, rootFolderId) : [],
        rootFolderId,
        isVisible: true,
      };
    }
    return {
      name: e.name,
      path: e.path,
      type: 'file',
      handle: {
        path: e.path,
        name: e.name,
        kind: 'file',
        platform: 'electron',
      } as unknown as FileSystemFileHandle,
      depth,
      selectionState: 'unchecked',
      rootFolderId,
      isVisible: true,
    };
  });
}

function replaceChildrenAtPath(
  nodes: IFileNode[],
  targetPath: string,
  newChildren: IFileNode[],
  sortFn: (nodes: IFileNode[]) => IFileNode[]
): IFileNode[] {
  return nodes.map((n) => {
    if (n.path === targetPath && n.type === 'directory') {
      return { ...n, children: sortFn(newChildren), isDepthTruncated: false };
    }
    if (n.type === 'directory' && n.children) {
      return { ...n, children: replaceChildrenAtPath(n.children, targetPath, newChildren, sortFn) };
    }
    return n;
  });
}

// Helper to collect truncated directory paths
function collectTruncatedPaths(roots: IFileNode[]): string[] {
  const result: string[] = [];
  function visit(node: IFileNode): void {
    if (node.type !== 'directory') return;
    if (node.isDepthTruncated) result.push(node.path);
    if (node.children) {
      for (const child of node.children) visit(child);
    }
  }
  for (const root of roots) visit(root);
  return result;
}

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
}

export interface CancellableFileTreeHook {
  fileTree: IFileNode[];
  isLoading: boolean;
  error: Error | null;
  refreshTree: () => Promise<void>;
  loadingProgress: LoadingProgressState;
  /** Whether the current operation can be cancelled */
  cancellable: boolean;
  /** Cancel the current loading operation */
  cancelOperation: () => void;
  /** Whether the operation is currently being cancelled */
  isCancelling: boolean;
  /** On-demand loader for a directory path that was truncated at initial scan */
  loadChildren: (dirPath: string) => Promise<void>;
}

/**
 * Calculates the new total estimate when the current loaded count exceeds the estimate.
 * Ensures the total is always at least the loaded count, with some buffer.
 */
function calculateDynamicTotal(currentTotal: number, loaded: number): number {
  if (loaded <= currentTotal) {
    return currentTotal;
  }

  // Ensure total is at least the loaded count plus a buffer
  const bufferPercentage = 0.25; // 25% buffer
  const minBuffer = 100;

  const buffer = Math.max(Math.ceil(loaded * bufferPercentage), minBuffer);

  return loaded + buffer;
}

// Removed unused calculateProgressPercentage to satisfy linter

/**
 * Checks if an error is a cancellation error
 */
const isCancellationError = (error: unknown): boolean => {
  return error instanceof Error && error.message === 'Operation was cancelled';
};

/**
 * Safely converts any error to an Error instance
 */
const ensureError = (err: unknown): Error => {
  return err instanceof Error ? err : new Error(String(err));
};

export function useFileTree(rootDirectoryHandle: DirectoryHandle | null): CancellableFileTreeHook {
  const { fileSystemAdapter } = useAdapters();

  if (!fileSystemAdapter) {
    throw new Error('File system adapter is not available');
  }
  const [fileTree, setFileTree] = useState<IFileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgressState>({
    loaded: 0,
    total: 0,
    phase: 'counting',
  });

  const progressRef = useRef<{
    loaded: number;
    total: number;
    currentPath: string;
    phase: LoadingProgressState['phase'];
    estimatedTotal: number;
  }>({
    loaded: 0,
    total: 0,
    currentPath: '',
    phase: 'counting',
    estimatedTotal: 100,
  });

  // AbortController for cancelling operations
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelOperation = useCallback(() => {
    if (abortControllerRef.current && isLoading && !isCancelling) {
      setIsCancelling(true);
      abortControllerRef.current.abort();
    }
  }, [isLoading, isCancelling]);

  const sortFileNodes = useCallback((nodes: IFileNode[]): IFileNode[] => {
    const directories: IFileNode[] = [];
    const files: IFileNode[] = [];
    for (const n of nodes) {
      if (n.type === 'directory') directories.push(n);
      else files.push(n);
    }
    directories.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
    files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
    return [...directories, ...files];
  }, []);

  // Utility helpers declared early to be available to other callbacks
  const findNodeByPath = useCallback((nodes: IFileNode[], targetPath: string): IFileNode | null => {
    for (const n of nodes) {
      if (n.path === targetPath) return n;
      if (n.type === 'directory' && n.children) {
        const found = findNodeByPath(n.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  }, []);

  const graftChildren = useCallback(
    (nodes: IFileNode[], targetPath: string, newChildren: IFileNode[]): IFileNode[] => {
      return nodes.map((n) => {
        if (n.path === targetPath && n.type === 'directory') {
          return { ...n, children: sortFileNodes(newChildren), isDepthTruncated: false };
        }
        if (n.type === 'directory' && n.children) {
          return { ...n, children: graftChildren(n.children, targetPath, newChildren) };
        }
        return n;
      });
    },
    [sortFileNodes]
  );

  // Use ref to avoid recreating the callback on every render
  const updateProgressRef = useRef((path?: string) => {
    progressRef.current.loaded += 1;
    if (path) {
      progressRef.current.currentPath = path;
    }

    // Dynamically adjust total if we exceed the current estimate
    progressRef.current.total = calculateDynamicTotal(
      progressRef.current.total,
      progressRef.current.loaded
    );

    setLoadingProgress({
      loaded: progressRef.current.loaded,
      total: progressRef.current.total,
      currentPath: progressRef.current.currentPath,
      phase: progressRef.current.phase,
    });
  });

  // Decide initial scan depth: shallow on electron for responsiveness
  const initialMaxDepth = ((): number => {
    const platform = (fileSystemAdapter as { platform?: string }).platform;
    return platform === 'electron' ? 1 : Number.POSITIVE_INFINITY;
  })();

  // Helpers to read children for a directory node with platform-specific fast path
  const buildMaybeReadSubtree = useCallback(
    (node: IFileNode) => async (): Promise<IFileNode[] | null> => {
      if (!rootDirectoryHandle) return null;
      if (rootDirectoryHandle.platform !== 'electron') return null;
      const fs = fileSystemAdapter as FileSystemAdapter & {
        readSubtree?: (args: {
          path: string;
          name: string;
          depth?: number;
          ignore?: string[];
        }) => Promise<BasicSubtreeNode[]>;
      };
      if (typeof fs.readSubtree !== 'function') return null;
      const subtree = await fs.readSubtree({
        path: node.path,
        name: node.name,
        depth: Number.POSITIVE_INFINITY,
      });
      return buildNodesFromSubtree(subtree, node.path.split('/').length, rootDirectoryHandle.name);
    },
    [fileSystemAdapter, rootDirectoryHandle]
  );

  const buildFallbackRead = useCallback(
    (node: IFileNode) => async (): Promise<IFileNode[]> => {
      if (!rootDirectoryHandle) return [];
      const dirHandle: DirectoryHandle = {
        path: node.path,
        name: node.name,
        kind: 'directory',
        platform: rootDirectoryHandle.platform,
        _internal: node.handle,
      };
      const parentPath = node.path.split('/').slice(0, -1).join('/');
      return readFullTreeUtil(
        fileSystemAdapter,
        dirHandle,
        rootDirectoryHandle,
        parentPath,
        false,
        undefined,
        undefined,
        sortFileNodes,
        Number.POSITIVE_INFINITY
      );
    },
    [fileSystemAdapter, rootDirectoryHandle, sortFileNodes]
  );

  const readFullTree = useCallback(
    (
      directoryHandle: DirectoryHandle,
      rootHandle: DirectoryHandle,
      parentPath = '',
      isRoot = true,
      abortSignal?: AbortSignal
    ): Promise<IFileNode[]> => {
      if (isRoot) {
        progressRef.current.phase = 'loading';
        progressRef.current.loaded = 0;
        progressRef.current.total = progressRef.current.estimatedTotal;
        setLoadingProgress({
          loaded: 0,
          total: progressRef.current.estimatedTotal,
          phase: 'loading',
        });
      }

      return readFullTreeUtil(
        fileSystemAdapter,
        directoryHandle,
        rootHandle,
        parentPath,
        isRoot,
        abortSignal,
        updateProgressRef.current,
        sortFileNodes,
        initialMaxDepth
      );
    },
    [fileSystemAdapter, sortFileNodes, initialMaxDepth]
  );

  const loadTree = useCallback(async () => {
    if (!rootDirectoryHandle) {
      setFileTree([]);
      return;
    }

    // Create new AbortController for this operation
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsLoading(true);
    setIsCancelling(false);
    setError(null);

    try {
      const tree = await readFullTree(
        rootDirectoryHandle,
        rootDirectoryHandle,
        '',
        true,
        abortController.signal
      );

      // Only update state if not cancelled
      if (!abortController.signal.aborted) {
        // Prime the fast path index for O(1) path lookups
        primeFileNodeIndex(tree);
        setFileTree(tree);
      }
    } catch (err) {
      const error = ensureError(err);

      // Handle cancellation differently from other errors
      if (isCancellationError(error)) {
        setFileTree([]); // Clear the tree on cancellation
      } else {
        setError(error);
        setFileTree([]);
      }
    } finally {
      setIsLoading(false);
      setIsCancelling(false);
      abortControllerRef.current = null;
    }
  }, [rootDirectoryHandle, readFullTree]);

  const refreshTree = useCallback(async () => {
    await loadTree();
  }, [loadTree]);

  // Background deepening: after initial shallow load on Electron, progressively load truncated dirs
  const scheduleBackgroundDeepening = useCallback(() => {
    const platform = (fileSystemAdapter as { platform?: string }).platform;
    const isElectron = platform === 'electron';
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for env vars
    const isTest = typeof process !== 'undefined' && process.env['NODE_ENV'] === 'test';

    if (!isElectron || isTest) return;
    if (!rootDirectoryHandle || initialMaxDepth === Number.POSITIVE_INFINITY) return;
    if (fileTree.length === 0) return;

    // Collect truncated directory paths breadth-first
    const queue: string[] = collectTruncatedPaths(fileTree);
    if (queue.length === 0) return;

    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };

    const processSlice = () => {
      if (cancelled) return;
      const batchSize = 5;
      // Inline minimal deepening to avoid dependency on loadChildren order
      const tasks = queue.splice(0, batchSize).map(async (dirPath) => {
        if (!rootDirectoryHandle) return;
        const name = dirPath.split('/').pop() ?? '';
        const maybe = buildMaybeReadSubtree({
          name,
          path: dirPath,
          type: 'directory',
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: rootDirectoryHandle.name,
          handle: {
            path: dirPath,
            name,
            kind: 'directory',
            platform: rootDirectoryHandle.platform,
          } as unknown as FileSystemDirectoryHandle,
          children: [],
          isVisible: true,
        } as IFileNode);
        const fallback = buildFallbackRead({
          name,
          path: dirPath,
          type: 'directory',
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: rootDirectoryHandle.name,
          handle: {
            path: dirPath,
            name,
            kind: 'directory',
            platform: rootDirectoryHandle.platform,
          } as unknown as FileSystemDirectoryHandle,
          children: [],
          isVisible: true,
        } as IFileNode);
        const children = (await maybe()) ?? (await fallback());
        setFileTree((prev) => replaceChildrenAtPath(prev, dirPath, children, sortFileNodes));
      });
      void Promise.allSettled(tasks).then(() => {
        if (cancelled) return;
        if (queue.length === 0) return;
        const schedule = (cb: () => void) => {
          if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            (
              window as unknown as { requestIdleCallback: (cb: () => void) => void }
            ).requestIdleCallback(cb);
          } else {
            setTimeout(cb, 50);
          }
        };
        schedule(processSlice);
      });
    };

    processSlice();
    return cancel;
  }, [
    fileTree,
    rootDirectoryHandle,
    initialMaxDepth,
    fileSystemAdapter,
    sortFileNodes,
    buildMaybeReadSubtree,
    buildFallbackRead,
  ]);

  // (moved earlier) findNodeByPath and graftChildren

  // Externally exposed on-demand load
  const loadChildren = useCallback(
    async (dirPath: string) => {
      if (!rootDirectoryHandle) return;
      const node = findNodeByPath(fileTree, dirPath);
      if (!node || node.type !== 'directory') return;
      if (node.children && node.children.length > 0 && node.isDepthTruncated !== true) return;

      const maybeReadSubtree = async (): Promise<IFileNode[] | null> => {
        if (rootDirectoryHandle.platform !== 'electron') return null;
        const fs = fileSystemAdapter as FileSystemAdapter & {
          readSubtree?: (args: {
            path: string;
            name: string;
            depth?: number;
            ignore?: string[];
          }) => Promise<BasicSubtreeNode[]>;
        };
        if (typeof fs.readSubtree !== 'function') return null;
        const subtree = await fs.readSubtree({
          path: node.path,
          name: node.name,
          depth: Number.POSITIVE_INFINITY,
        });
        return buildNodesFromSubtree(
          subtree,
          node.path.split('/').length,
          rootDirectoryHandle.name
        );
      };

      const fallbackRead = async (): Promise<IFileNode[]> => {
        const dirHandle: DirectoryHandle = {
          path: node.path,
          name: node.name,
          kind: 'directory',
          platform: rootDirectoryHandle.platform,
          _internal: node.handle,
        };
        const parentPath = node.path.split('/').slice(0, -1).join('/');
        return readFullTreeUtil(
          fileSystemAdapter,
          dirHandle,
          rootDirectoryHandle,
          parentPath,
          false,
          undefined,
          undefined,
          sortFileNodes,
          Number.POSITIVE_INFINITY
        );
      };

      const children = (await maybeReadSubtree()) ?? (await fallbackRead());

      setFileTree((prev) => graftChildren(prev, dirPath, children));
    },
    [fileTree, rootDirectoryHandle, fileSystemAdapter, sortFileNodes, findNodeByPath, graftChildren]
  );

  // (no-op) removed deepLoad – scheduleBackgroundDeepening calls loadChildren directly

  // Kick off background deepening when tree changes
  useEffect(() => {
    const cancel = scheduleBackgroundDeepening();
    return () => {
      if (typeof cancel === 'function') cancel();
    };
  }, [scheduleBackgroundDeepening]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  return {
    fileTree,
    isLoading,
    error,
    refreshTree,
    loadingProgress,
    cancellable: isLoading && !isCancelling,
    cancelOperation,
    isCancelling,
    loadChildren,
  };
}
