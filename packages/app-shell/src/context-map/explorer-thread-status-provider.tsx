/**
 * Publishes the active thread's context to the Files explorer (ADR-0021,
 * BST-2018): the "This thread" column and the "Touched in this thread"
 * filter read it. It reads the same fold the Context tab shows, and checks
 * "changed since read" only for files whose rows are on screen, through the
 * explorer's shared content owner: once when a row first shows, and again
 * when the watcher reports a change under the file.
 */
import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import { useThreadContextStore } from '@brainstrike/assistant-ui/thread-context-store';
import {
  createExplorerThreadStatusStore,
  type ExplorerThreadFileStatus,
  ExplorerThreadStatusContext,
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
  refreshReachesFile,
  useFileExplorerStoreSelector,
  useWorkspaceTabs,
} from '@brainstrike/file-explorer-ui/shell';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useOptionalRootIdentity } from '../roots/root-identity-context';
import {
  type ExplorerFolder,
  explorerThreadFileStatus,
  explorerThreadFiles,
  fileFreshness,
  NO_EXPLORER_THREAD_FILES,
} from './explorer-thread-status-model';

export function ExplorerThreadStatusProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [store] = useState(createExplorerThreadStatusStore);
  const threadId = useActiveAssistantThreadId();
  const record = useThreadContextStore((state) =>
    threadId ? state.byThread[threadId] : undefined
  );
  const identity = useOptionalRootIdentity();
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const resolveFolder = useCallback(
    (dbRootId: string): ExplorerFolder | null => {
      const adapterRootId = identity?.resolveAdapterRootId(dbRootId) ?? null;
      const path = adapterRootId ? rootDescriptors[adapterRootId]?.path : undefined;
      return adapterRootId && path ? { adapterRootId, path } : null;
    },
    [identity, rootDescriptors]
  );
  const touched = useMemo(
    () => (record ? explorerThreadFiles(record, resolveFolder) : NO_EXPLORER_THREAD_FILES),
    [record, resolveFolder]
  );
  const watched = useSyncExternalStore(store.subscribeWatched, store.getWatchedKeys);
  const { fileContentErrors, fileContents, loadingFiles, onRetryFileContent } = useWorkspaceTabs();

  // Content keys read since the watcher last reported a change under them.
  const requested = useRef(new Set<string>());
  // A row that starts showing a touched file reads it, once; a row that shows
  // again after a failed read tries again.
  useEffect(() => {
    let shown: ReadonlySet<string> = new Set<string>();
    const readNewlyShown = (): void => {
      const watchedNow = store.getWatchedKeys();
      for (const file of touched.files) {
        if (
          watchedNow.has(file.key) &&
          !shown.has(file.key) &&
          !requested.current.has(file.contentKey)
        ) {
          requested.current.add(file.contentKey);
          onRetryFileContent(file.contentKey);
        }
      }
      shown = watchedNow;
    };
    readNewlyShown();
    return store.subscribeWatched(readNewlyShown);
  }, [onRetryFileContent, store, touched]);
  useEffect(() => {
    // A failed read is not a result: the next time its row shows, read it again.
    for (const file of touched.files) {
      if (fileContentErrors.has(file.contentKey)) {
        requested.current.delete(file.contentKey);
      }
    }
  }, [fileContentErrors, touched]);
  useEffect(() => {
    const onRefresh = (event: Event): void => {
      const { detail } = event as FileExplorerRefreshEvent;
      for (const file of touched.files) {
        if (!refreshReachesFile(detail, file.contentKey)) {
          continue;
        }
        if (store.getWatchedKeys().has(file.key)) {
          onRetryFileContent(file.contentKey);
        } else {
          // Read again when its row next shows.
          requested.current.delete(file.contentKey);
        }
      }
    };
    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);
    };
  }, [onRetryFileContent, store, touched]);

  useEffect(() => {
    const files = new Map<string, ExplorerThreadFileStatus>();
    for (const file of touched.files) {
      const freshness = watched.has(file.key)
        ? fileFreshness(file, fileContents[file.contentKey], {
            failed: fileContentErrors.has(file.contentKey),
            loading: loadingFiles.has(file.contentKey),
          })
        : 'unknown';
      files.set(file.key, explorerThreadFileStatus(file, freshness));
    }
    store.publish({ directories: touched.directories, files, touchedPaths: touched.touchedPaths });
  }, [fileContentErrors, fileContents, loadingFiles, store, touched, watched]);

  return (
    <ExplorerThreadStatusContext.Provider value={store}>
      {children}
    </ExplorerThreadStatusContext.Provider>
  );
}
