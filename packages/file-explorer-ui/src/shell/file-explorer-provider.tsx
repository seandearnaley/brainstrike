import { createFileExplorerStore } from '@brainstrike/file-explorer';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState } from '@brainstrike/types';
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand';
import { type UseBoundStoreWithEqualityFn, useStoreWithEqualityFn } from 'zustand/traditional';
import { setupInlineFixtureSubscription } from '../setup-inline-fixture-subscription';
import { shouldExposeAutomatedTestApis } from '../utils/fixture-test-exposure';

type FileExplorerStore = UseBoundStoreWithEqualityFn<StoreApi<FileExplorerState>>;
type FileExplorerStoreSelector<T> = (state: FileExplorerState) => T;
type EqualityFn<T> = (left: T, right: T) => boolean;

const unsubscribeNoop = (): void => {};
const subscribeNoop = (): (() => void) => unsubscribeNoop;

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: Test hook uses double underscores by convention
    __brainstrike_e2e_expose_file_explorer_store__?: boolean | undefined;
    // biome-ignore lint/style/useNamingConvention: Test hook uses double underscores by convention
    __brainstrike_file_explorer_provider_store__?: FileExplorerStore | undefined;
  }
}

// Create a context for the file explorer store
const FileExplorerStoreContext = createContext<FileExplorerStore | null>(null);

export interface FileExplorerProviderProps {
  children: React.ReactNode;
  /** Optional file system adapter — when provided, enables inline fixture subscription */
  fileSystemAdapter?: FileSystemAdapter;
  storageAdapter: StorageAdapter;
}

export function FileExplorerProvider({
  storageAdapter,
  fileSystemAdapter,
  children,
}: FileExplorerProviderProps) {
  // Create store instance with the provided storage adapter
  const store = useMemo(() => createFileExplorerStore(storageAdapter), [storageAdapter]);

  // Set up inline fixture subscription when adapter is available.
  // Runs once on mount, outside the React render cycle.
  useEffect(() => {
    if (!fileSystemAdapter) {
      return;
    }
    return setupInlineFixtureSubscription(store, fileSystemAdapter);
  }, [store, fileSystemAdapter]);

  useEffect(() => {
    const env = (
      import.meta as ImportMeta & {
        env?: Record<string, unknown>;
      }
    ).env;
    if (typeof window === 'undefined' || !shouldExposeAutomatedTestApis(env)) {
      return;
    }
    window.__brainstrike_file_explorer_provider_store__ = store;
    return () => {
      if (window.__brainstrike_file_explorer_provider_store__ === store) {
        window.__brainstrike_file_explorer_provider_store__ = undefined;
      }
    };
  }, [store]);

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
