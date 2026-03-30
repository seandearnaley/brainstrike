import { createFileExplorerStore } from '@brainstrike/file-explorer';
import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState } from '@brainstrike/types';
import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand';
import { type UseBoundStoreWithEqualityFn, useStoreWithEqualityFn } from 'zustand/traditional';

type FileExplorerStore = UseBoundStoreWithEqualityFn<StoreApi<FileExplorerState>>;
type FileExplorerStoreSelector<T> = (state: FileExplorerState) => T;
type EqualityFn<T> = (left: T, right: T) => boolean;

const unsubscribeNoop = (): void => {};
const subscribeNoop = (): (() => void) => unsubscribeNoop;

// Create a context for the file explorer store
const FileExplorerStoreContext = createContext<FileExplorerStore | null>(null);

export interface FileExplorerProviderProps {
  children: React.ReactNode;
  storageAdapter: StorageAdapter;
}

export function FileExplorerProvider({ storageAdapter, children }: FileExplorerProviderProps) {
  // Create store instance with the provided storage adapter
  const store = useMemo(() => createFileExplorerStore(storageAdapter), [storageAdapter]);

  return (
    <FileExplorerStoreContext.Provider value={store}>{children}</FileExplorerStoreContext.Provider>
  );
}

export function useFileExplorerStoreContext(): FileExplorerStore {
  const context = useContext(FileExplorerStoreContext);
  if (!context) {
    throw new Error('useFileExplorerStoreContext must be used within a FileExplorerProvider');
  }
  return context;
}

export function useFileExplorerStoreSelector<T>(
  selector: FileExplorerStoreSelector<T>,
  equalityFn?: EqualityFn<T>
): T {
  const store = useFileExplorerStoreContext();
  return useStoreWithEqualityFn(store, selector, equalityFn);
}

/**
 * Optional hook to access the file explorer store context.
 * Returns null when used outside of FileExplorerProvider.
 * Use this when the hook may be called outside the provider and should gracefully handle that case.
 */
export function useOptionalFileExplorerStoreContext(): FileExplorerStore | null {
  return useContext(FileExplorerStoreContext);
}

export function useOptionalFileExplorerStoreSelector<T>(
  selector: FileExplorerStoreSelector<T>,
  fallbackValue: T,
  equalityFn: EqualityFn<T> = Object.is
): T {
  const store = useOptionalFileExplorerStoreContext();
  const lastSelectionRef = useRef<T>(fallbackValue);

  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => {
      if (!store) {
        lastSelectionRef.current = fallbackValue;
        return fallbackValue;
      }

      const nextSelection = selector(store.getState());
      const previousSelection = lastSelectionRef.current;
      if (equalityFn(previousSelection, nextSelection)) {
        return previousSelection;
      }

      lastSelectionRef.current = nextSelection;
      return nextSelection;
    },
    () => fallbackValue
  );
}
