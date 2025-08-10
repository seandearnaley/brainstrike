import React, { useEffect, useMemo } from 'react';
import type { TreeNode } from './types/lazy-tree';
import { useLazyTreeStore } from './use-lazy-tree-store';

export const LazyTreeContext = React.createContext(
  null as unknown as ReturnType<typeof useLazyTreeStore>
);
export const useLazyTree = () => React.useContext(LazyTreeContext);

export function LazyTreeProvider({
  sourceTree,
  expandedPaths,
  children,
}: {
  sourceTree: TreeNode[];
  expandedPaths: Set<string>;
  children: React.ReactNode;
}) {
  const store = useLazyTreeStore();
  const worker = useMemo(
    () => new Worker(new URL('./workers/lazy-tree.worker.js', import.meta.url), { type: 'module' }),
    []
  );

  useEffect(() => {
    store.init(worker, sourceTree, expandedPaths);
    return () => store.teardown();
  }, [store, worker, sourceTree, expandedPaths]);

  useEffect(() => {
    // update source tree without dropping expansion
    store.setSourceTree(sourceTree);
  }, [store, sourceTree]);

  return <LazyTreeContext.Provider value={store}>{children}</LazyTreeContext.Provider>;
}
