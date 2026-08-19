import { registerFactoryResetSessionStore } from '@brainstrike/app-state/factory-reset';
import { createFileExplorerStore } from '@brainstrike/file-explorer';
import { useToastManager } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import { type FileExplorerState, FileExplorerStrings } from '@brainstrike/types';
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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

interface FileContentLoadAuthority {
  beginReload: (compositeKeys: readonly string[]) => ReadonlyMap<string, number>;
  clearGeneration: (compositeKey: string, expectedGeneration: number | undefined) => void;
  currentGeneration: (compositeKey: string) => number;
  getActiveLoad: (compositeKey: string) => Promise<void> | undefined;
  invalidateAll: () => void;
  isCurrentGeneration: (compositeKey: string, expectedGeneration: number) => boolean;
  lifecycleId: number;
  releaseActiveLoad: (compositeKeys: readonly string[], expectedPromise: Promise<void>) => void;
  runBatch: (task: () => Promise<void>) => Promise<void>;
  trackActiveLoad: (compositeKeys: readonly string[], promise: Promise<void>) => void;
}

interface PendingFileContentBatch {
  readonly epoch: number;
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
  readonly task: () => Promise<void>;
}

const MAX_CONCURRENT_FILE_CONTENT_BATCHES = 2;
let nextFileContentLifecycleId = 0;

function createFileContentLoadAuthority(): FileContentLoadAuthority {
  const activeLoads = new Map<string, Promise<void>>();
  const activeBatchIds = new Set<number>();
  const generations = new Map<string, number>();
  const pendingBatches: PendingFileContentBatch[] = [];
  let lifecycleEpoch = 0;
  let lifecycleGeneration = 0;
  let nextBatchId = 0;
  let nextGeneration = 0;
  nextFileContentLifecycleId += 1;
  const lifecycleId = nextFileContentLifecycleId;
  const drainBatchQueue = (): void => {
    while (activeBatchIds.size < MAX_CONCURRENT_FILE_CONTENT_BATCHES && pendingBatches.length > 0) {
      const pending = pendingBatches.shift();
      if (!pending) {
        return;
      }
      if (pending.epoch !== lifecycleEpoch) {
        pending.resolve();
        continue;
      }
      nextBatchId += 1;
      const batchId = nextBatchId;
      activeBatchIds.add(batchId);
      void pending
        .task()
        .then(pending.resolve, pending.reject)
        .finally(() => {
          activeBatchIds.delete(batchId);
          drainBatchQueue();
        });
    }
  };
  return {
    beginReload: (compositeKeys) => {
      const requested = new Map<string, number>();
      for (const compositeKey of compositeKeys) {
        nextGeneration += 1;
        const generation = nextGeneration;
        generations.set(compositeKey, generation);
        requested.set(compositeKey, generation);
      }
      return requested;
    },
    clearGeneration: (compositeKey, expectedGeneration) => {
      if (generations.get(compositeKey) === expectedGeneration) {
        generations.delete(compositeKey);
      }
    },
    currentGeneration: (compositeKey) => generations.get(compositeKey) ?? lifecycleGeneration,
    getActiveLoad: (compositeKey) => activeLoads.get(compositeKey),
    invalidateAll: () => {
      lifecycleEpoch += 1;
      nextGeneration += 1;
      lifecycleGeneration = nextGeneration;
      generations.clear();
      activeLoads.clear();
      for (const pending of pendingBatches.splice(0)) {
        pending.resolve();
      }
      activeBatchIds.clear();
    },
    isCurrentGeneration: (compositeKey, expectedGeneration) =>
      (generations.get(compositeKey) ?? lifecycleGeneration) === expectedGeneration,
    lifecycleId,
    releaseActiveLoad: (compositeKeys, expectedPromise) => {
      for (const compositeKey of compositeKeys) {
        if (activeLoads.get(compositeKey) === expectedPromise) {
          activeLoads.delete(compositeKey);
        }
      }
    },
    runBatch: (task) => {
      const scheduled = new Promise<void>((resolve, reject) => {
        pendingBatches.push({ epoch: lifecycleEpoch, reject, resolve, task });
        drainBatchQueue();
      });
      return scheduled;
    },
    trackActiveLoad: (compositeKeys, promise) => {
      for (const compositeKey of compositeKeys) {
        activeLoads.set(compositeKey, promise);
      }
    },
  };
}

const FileContentLoadAuthorityContext = createContext<FileContentLoadAuthority | null>(null);

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
  const [fileContentResetRevision, setFileContentResetRevision] = useState(0);
  // Store and content-read authority share one lifecycle: replacing the
  // storage adapter must never carry active reads into the replacement store.
  const { fileContentLoadAuthority, store } = useMemo(
    () => ({
      fileContentLoadAuthority: createFileContentLoadAuthority(),
      store: createFileExplorerStore(storageAdapter),
    }),
    [storageAdapter]
  );

  useLayoutEffect(
    () => () => {
      fileContentLoadAuthority.invalidateAll();
    },
    [fileContentLoadAuthority]
  );

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

  // Factory reset clears chunk selections via the session-store registry, but
  // search also selects containing files in this live store. Without clearing
  // those file selections, "no chunk subset + file selected" reads as a
  // whole-file selection after reset (docs/agents/explorer-search-tapestry.md search bridge invariant).
  // Persist keys are wiped by localStorage.clear(); this drains the in-memory
  // instance for reset paths that do not immediately reload.
  useEffect(
    () =>
      registerFactoryResetSessionStore(() => {
        const state = store.getState();
        fileContentLoadAuthority.invalidateAll();
        state.clearAllFileContents();
        state.clearSelectedFiles();
        state.resetSelectionToExplicit();
        for (const folderId of Object.keys(state.folderStates)) {
          state.setFolderSelection(folderId, []);
        }
        setFileContentResetRevision((revision) => revision + 1);
      }),
    [fileContentLoadAuthority, store]
  );

  const fileContentLifecycleKey = `${fileContentLoadAuthority.lifecycleId}:${fileContentResetRevision}`;

  return (
    <FileExplorerStoreContext.Provider value={store}>
      <FileContentLoadAuthorityContext.Provider value={fileContentLoadAuthority}>
        <Fragment key={fileContentLifecycleKey}>
          <PersistenceRecoveryNotifier />
          {children}
        </Fragment>
      </FileContentLoadAuthorityContext.Provider>
    </FileExplorerStoreContext.Provider>
  );
}

function PersistenceRecoveryNotifier() {
  const store = useFileExplorerStoreContext();
  const notice = useFileExplorerStoreSelector((state) => state.persistenceRecoveryNotice);
  const { showToast } = useToastManager();

  useEffect(() => {
    if (notice === null) {
      return;
    }
    if (!store.getState().consumePersistenceRecoveryNotice()) {
      return;
    }
    const isUnavailable = notice === 'persisted-state-unavailable';
    showToast({
      description: isUnavailable
        ? FileExplorerStrings.recovery.persistedStateUnavailable
        : FileExplorerStrings.recovery.persistedStateDiscarded,
      title: isUnavailable
        ? FileExplorerStrings.recovery.unavailableTitle
        : FileExplorerStrings.recovery.title,
    });
  }, [notice, showToast, store]);

  return null;
}

export function useFileExplorerStoreContext(): FileExplorerStore {
  const context = useContext(FileExplorerStoreContext);
  if (!context) {
    throw new Error('useFileExplorerStoreContext must be used within a FileExplorerProvider');
  }
  return context;
}

export function useFileContentLoadAuthority(): FileContentLoadAuthority {
  const context = useContext(FileContentLoadAuthorityContext);
  if (!context) {
    throw new Error('useFileContentLoadAuthority must be used within a FileExplorerProvider');
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
