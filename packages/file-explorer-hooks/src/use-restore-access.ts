import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';

const logger = createLogger('useRestoreAccess');

export interface PendingRestoreState {
  folderId: string;
  name: string;
}

interface RestoreAccessState {
  pendingRestore: PendingRestoreState | null;
  showDeniedBanner: boolean;
  showStaleBanner: boolean;
  storedFolders: PendingRestoreState[];
  beginRestore: () => Promise<DirectoryHandle | null>;
  dismissRestore: () => void;
  chooseDifferentFolder: () => Promise<DirectoryHandle | null>;
  clearStoredHandles: () => Promise<void>;
}

interface WebHandleCacheShape {
  getAllRootHandles?: () => Promise<
    Array<{ folderId: string; name: string; lastAccessedAt: number }>
  >;
  restoreLastRootHandle?: () => Promise<{ handle: FileSystemDirectoryHandle } | null>;
  removeRootHandle?: (folderId: string) => Promise<void>;
  clear?: () => Promise<void>;
}

interface WebAdapterWithCache {
  getHandleCache?: () => WebHandleCacheShape;
}

export function useRestoreAccess(): RestoreAccessState {
  const { fileSystemAdapter } = useAdapters();
  const [pendingRestore, setPendingRestore] = useState<PendingRestoreState | null>(null);
  const [showDeniedBanner, setShowDeniedBanner] = useState(false);
  const [showStaleBanner, setShowStaleBanner] = useState(false);
  const [storedFolders, setStoredFolders] = useState<PendingRestoreState[]>([]);
  const dismissedRef = useRef(false);

  const handleCache = useMemo(() => {
    const adapter = fileSystemAdapter as WebAdapterWithCache | null;
    return adapter?.getHandleCache?.() ?? null;
  }, [fileSystemAdapter]);

  useEffect(() => {
    if (dismissedRef.current) {
      return;
    }
    if (!handleCache?.getAllRootHandles) {
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const handles = await handleCache.getAllRootHandles?.();
          if (!handles || handles.length === 0) {
            setStoredFolders([]);
            return;
          }
          const latestRecord = handles.reduce((current, candidate) =>
            candidate.lastAccessedAt > current.lastAccessedAt ? candidate : current
          );

          setPendingRestore({
            folderId: latestRecord.folderId,
            name: latestRecord.name,
          });
          setStoredFolders(
            handles.map((handle) => ({ folderId: handle.folderId, name: handle.name }))
          );
        } catch (error) {
          logger.warn('Failed to load stored root handles', { error });
        }
      })();
    }, 500);

    return () => clearTimeout(timer);
  }, [handleCache]);

  const beginRestore = useCallback(async (): Promise<DirectoryHandle | null> => {
    if (!handleCache?.restoreLastRootHandle) {
      return null;
    }
    setShowDeniedBanner(false);
    setShowStaleBanner(false);

    try {
      const result = await handleCache.restoreLastRootHandle();
      if (!result?.handle) {
        const remaining = await handleCache.getAllRootHandles?.();
        if (!remaining || remaining.length === 0) {
          setShowStaleBanner(true);
        } else {
          setShowDeniedBanner(true);
        }
        return null;
      }

      setPendingRestore(null);
      const remaining = await handleCache.getAllRootHandles?.();
      if (remaining) {
        setStoredFolders(
          remaining.map((handle) => ({ folderId: handle.folderId, name: handle.name }))
        );
      }
      return {
        path: result.handle.name,
        name: result.handle.name,
        kind: 'directory',
        platform: 'web',
        _internal: result.handle,
      };
    } catch (error) {
      logger.warn('Failed to restore handle', { error });
      setShowStaleBanner(true);
      return null;
    }
  }, [handleCache]);

  const dismissRestore = useCallback(() => {
    dismissedRef.current = true;
    setPendingRestore(null);
    setShowDeniedBanner(false);
    setShowStaleBanner(false);
  }, []);

  const chooseDifferentFolder = useCallback(async (): Promise<DirectoryHandle | null> => {
    setPendingRestore(null);
    setShowDeniedBanner(false);
    setShowStaleBanner(false);
    dismissedRef.current = true;
    if (typeof fileSystemAdapter.requestDirectoryAccess === 'function') {
      return fileSystemAdapter.requestDirectoryAccess();
    }
    return null;
  }, [fileSystemAdapter]);

  const clearStoredHandles = useCallback(async (): Promise<void> => {
    if (handleCache?.clear) {
      await handleCache.clear();
    }
    setPendingRestore(null);
    setShowDeniedBanner(false);
    setShowStaleBanner(false);
    setStoredFolders([]);
    dismissedRef.current = true;
  }, [handleCache]);

  return {
    pendingRestore,
    showDeniedBanner,
    showStaleBanner,
    storedFolders,
    beginRestore,
    dismissRestore,
    chooseDifferentFolder,
    clearStoredHandles,
  };
}
