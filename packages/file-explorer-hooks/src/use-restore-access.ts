import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readHandleCache } from './adapter-with-handle-cache.js';
import { useAdapters } from './adapters-context.js';

const logger = createLogger('useRestoreAccess');

/**
 * Delay before checking stored handles on mount.
 * This prevents UI flash if IndexedDB check completes quickly,
 * while still allowing the restore modal to appear promptly.
 */
const HANDLE_CHECK_DELAY_MS = 500;

type RestoreAccessClearListener = () => void;

const clearListenersByHandleCache = new WeakMap<
  WebHandleCacheShape,
  Set<RestoreAccessClearListener>
>();

function subscribeToStoredHandlesCleared(
  handleCache: WebHandleCacheShape | null,
  listener: RestoreAccessClearListener
): () => void {
  if (!handleCache) {
    return () => {};
  }

  let listeners = clearListenersByHandleCache.get(handleCache);
  if (!listeners) {
    listeners = new Set<RestoreAccessClearListener>();
    clearListenersByHandleCache.set(handleCache, listeners);
  }

  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function broadcastStoredHandlesCleared(handleCache: WebHandleCacheShape): void {
  const listeners = clearListenersByHandleCache.get(handleCache);
  if (!listeners) {
    return;
  }

  for (const listener of Array.from(listeners)) {
    listener();
  }
}

export interface PendingRestoreState {
  folderId: string;
  name: string;
  /** Current permission state */
  permissionState: PermissionState | 'unknown';
  /** The raw FileSystemDirectoryHandle for requesting permission synchronously */
  rawHandle: FileSystemDirectoryHandle;
}

interface RestoreAccessState {
  /**
   * Begin restore - requests permission SYNCHRONOUSLY in the click handler.
   * MUST be called directly from a user gesture (click) handler.
   *
   * Multi-root: all requestPermission calls are INITIATED before any is awaited
   * (burst-before-drain), so Chrome batches them into one permission prompt.
   * Returns all granted DirectoryHandles (empty array if none granted).
   */
  beginRestore: () => Promise<readonly DirectoryHandle[]>;
  chooseDifferentFolder: () => Promise<DirectoryHandle | null>;
  clearStoredHandles: () => Promise<void>;
  dismissRestore: () => void;
  /** Whether the hook is still checking for stored handles on startup */
  isCheckingStoredHandles: boolean;
  pendingRestore: PendingRestoreState | null;
  showDeniedBanner: boolean;
  showStaleBanner: boolean;
  storedFolders: Array<{ folderId: string; name: string }>;
}

interface RestoreHandleResult {
  folderId: string;
  handle: FileSystemDirectoryHandle;
  name: string;
  permissionState: PermissionState | 'unknown';
}

interface WebHandleCacheShape {
  clear?: () => Promise<void>;
  /** Returns all stored root handles. The `handle` field is populated when available
   *  (real WebHandleCache always returns it; legacy/test shapes may omit it). */
  getAllRootHandles?: () => Promise<
    Array<{
      folderId: string;
      handle?: FileSystemDirectoryHandle;
      name: string;
      lastAccessedAt: number;
    }>
  >;
  getLastRootHandleForRestore?: () => Promise<RestoreHandleResult | null>;
  markHandleRestored?: (folderId: string) => Promise<void>;
  removeRootHandle?: (folderId: string) => Promise<void>;
  restoreLastRootHandle?: () => Promise<{ handle: FileSystemDirectoryHandle } | null>;
}

const WEB_HANDLE_CACHE_METHODS = [
  'clear',
  'getAllRootHandles',
  'getLastRootHandleForRestore',
  'markHandleRestored',
  'removeRootHandle',
  'restoreLastRootHandle',
] as const satisfies readonly (keyof WebHandleCacheShape)[];

type UncoveredWebHandleCacheMethod = Exclude<
  keyof WebHandleCacheShape,
  (typeof WEB_HANDLE_CACHE_METHODS)[number]
>;
const WEB_HANDLE_CACHE_METHODS_ARE_EXHAUSTIVE: UncoveredWebHandleCacheMethod extends never
  ? true
  : never = true;

function isWebHandleCacheShape(value: unknown): value is WebHandleCacheShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  // This hook deliberately supports partial cache capabilities. Validate every
  // known member that is present, require at least one recognized callable
  // member, then let each call site gate its own method.
  return (
    WEB_HANDLE_CACHE_METHODS_ARE_EXHAUSTIVE &&
    WEB_HANDLE_CACHE_METHODS.every(
      (method) => candidate[method] === undefined || typeof candidate[method] === 'function'
    ) &&
    WEB_HANDLE_CACHE_METHODS.some((method) => typeof candidate[method] === 'function')
  );
}

interface LoadStoredHandlesOptions {
  dismissedRef: { current: boolean };
  handleCache: WebHandleCacheShape | null;
  hasNewMethod: boolean;
  hasOldMethod: boolean;
  setPendingRestore: (state: PendingRestoreState | null) => void;
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void;
  shouldApplyLoadedHandles: () => boolean;
}

/** Convert a raw FileSystemDirectoryHandle to our DirectoryHandle type */
function toDirectoryHandle(rawHandle: FileSystemDirectoryHandle): DirectoryHandle {
  return {
    _internal: rawHandle,
    kind: 'directory',
    name: rawHandle.name,
    path: rawHandle.name,
    platform: 'web',
  };
}

/** Load handles using the new getLastRootHandleForRestore method */
async function loadHandlesNewMethod(
  handleCache: WebHandleCacheShape,
  setPendingRestore: (state: PendingRestoreState | null) => void,
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void,
  shouldApplyLoadedHandles: () => boolean
): Promise<void> {
  const result = await handleCache.getLastRootHandleForRestore?.();
  if (!shouldApplyLoadedHandles()) {
    return;
  }

  logger.info('getLastRootHandleForRestore result', {
    hasResult: !!result,
    permissionState: result?.permissionState,
  });

  if (result) {
    setPendingRestore({
      folderId: result.folderId,
      name: result.name,
      permissionState: result.permissionState,
      rawHandle: result.handle,
    });

    const allHandles = await handleCache.getAllRootHandles?.();
    if (!shouldApplyLoadedHandles()) {
      return;
    }

    if (allHandles) {
      setStoredFolders(allHandles.map((h) => ({ folderId: h.folderId, name: h.name })));
    }
  } else {
    setStoredFolders([]);
  }
}

/** Load handles using the legacy getAllRootHandles method */
async function loadHandlesLegacyMethod(
  handleCache: WebHandleCacheShape,
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void,
  shouldApplyLoadedHandles: () => boolean
): Promise<void> {
  const handles = await handleCache.getAllRootHandles?.();
  if (!shouldApplyLoadedHandles()) {
    return;
  }

  logger.info('Loaded stored root handles (legacy)', { count: handles?.length ?? 0 });
  if (!handles || handles.length === 0) {
    setStoredFolders([]);
    return;
  }
  setStoredFolders(handles.map((h) => ({ folderId: h.folderId, name: h.name })));
}

async function loadStoredHandles({
  dismissedRef,
  handleCache,
  hasNewMethod,
  hasOldMethod,
  setPendingRestore,
  setStoredFolders,
  shouldApplyLoadedHandles,
}: LoadStoredHandlesOptions): Promise<void> {
  if (dismissedRef.current || !handleCache) {
    return;
  }
  if (hasNewMethod) {
    await loadHandlesNewMethod(
      handleCache,
      setPendingRestore,
      setStoredFolders,
      shouldApplyLoadedHandles
    );
    return;
  }
  if (hasOldMethod) {
    await loadHandlesLegacyMethod(handleCache, setStoredFolders, shouldApplyLoadedHandles);
  }
}

/** Handle with a confirmed raw FileSystemDirectoryHandle (post-filter shape).
 *  requestPermission is guaranteed non-optional because the filter checked typeof. */
interface HandleWithRaw {
  folderId: string;
  handle: FileSystemDirectoryHandle & {
    requestPermission: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };
  lastAccessedAt: number;
  name: string;
}

interface MultiRootBurstParams {
  alreadyGranted: DirectoryHandle[];
  handleCache: WebHandleCacheShape | null;
  needsPrompt: HandleWithRaw[];
  setPendingRestore: (state: PendingRestoreState | null) => void;
  setShowDeniedBanner: (v: boolean) => void;
  setShowStaleBanner: (v: boolean) => void;
}

/** Process a rejected permission result and return whether it was stale. */
async function processRejectedPermission(
  reason: unknown,
  folderId: string,
  handleCache: WebHandleCacheShape | null
): Promise<boolean> {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  if (error.name === 'AbortError') {
    logger.debug('beginRestore: user cancelled permission dialog', { folderId });
    return false;
  }
  if (error.name === 'NotFoundError') {
    logger.info('beginRestore: handle target no longer exists', { folderId });
    await handleCache?.removeRootHandle?.(folderId);
    return true;
  }
  logger.warn('beginRestore: permission request failed', {
    error: error.message,
    errorName: error.name,
    folderId,
  });
  return true;
}

interface ClassifyParams {
  handleCache: WebHandleCacheShape | null;
  pendingGrantedFolderId: string | undefined;
  rawHandlesFromCache: HandleWithRaw[];
}

interface ClassifyResult {
  alreadyGranted: DirectoryHandle[];
  needsPrompt: HandleWithRaw[];
}

/** Pre-classify handles into already-granted (skip dialog) vs needs-prompt.
 *  Already-granted ones are marked restored immediately. */
async function classifyHandles({
  handleCache,
  pendingGrantedFolderId,
  rawHandlesFromCache,
}: ClassifyParams): Promise<ClassifyResult> {
  const alreadyGranted: DirectoryHandle[] = [];
  const needsPrompt: HandleWithRaw[] = [];

  for (const h of rawHandlesFromCache) {
    if (pendingGrantedFolderId === h.folderId) {
      await handleCache?.markHandleRestored?.(h.folderId);
      alreadyGranted.push(toDirectoryHandle(h.handle));
    } else {
      needsPrompt.push(h);
    }
  }

  return { alreadyGranted, needsPrompt };
}

/** BURST-BEFORE-DRAIN: start all requestPermission calls, then await results.
 *  Called only when the handle cache exposes raw handles for multiple roots. */
async function runMultiRootBurst({
  alreadyGranted,
  handleCache,
  needsPrompt,
  setShowDeniedBanner,
  setShowStaleBanner,
  setPendingRestore,
}: MultiRootBurstParams): Promise<readonly DirectoryHandle[]> {
  // BURST: initiate ALL requestPermission calls before awaiting any
  const permissionTasks = needsPrompt.map((h) => ({
    h,
    promise: h.handle.requestPermission({ mode: 'read' }),
  }));

  // DRAIN: await all settled results
  const rawResults = await Promise.allSettled(permissionTasks.map((t) => t.promise));
  const taskResults = permissionTasks.map((task, i) => ({
    result: rawResults[i] as PromiseSettledResult<PermissionState>,
    task,
  }));

  const granted: DirectoryHandle[] = [...alreadyGranted];
  let anyDenied = false;
  let anyStale = false;

  for (const { task, result } of taskResults) {
    if (result.status === 'fulfilled') {
      if (result.value === 'granted') {
        await handleCache?.markHandleRestored?.(task.h.folderId);
        granted.push(toDirectoryHandle(task.h.handle));
      } else if (result.value === 'denied') {
        anyDenied = true;
        logger.warn('beginRestore: permission denied for handle', { folderId: task.h.folderId });
      } else {
        logger.debug('beginRestore: permission prompt dismissed', { folderId: task.h.folderId });
      }
    } else {
      const wasStale = await processRejectedPermission(result.reason, task.h.folderId, handleCache);
      if (wasStale) {
        anyStale = true;
      }
    }
  }

  if (anyDenied) {
    setShowDeniedBanner(true);
  }
  if (anyStale) {
    setShowStaleBanner(true);
  }
  if (granted.length > 0) {
    setPendingRestore(null);
  }
  return granted;
}

/** Request permission and return DirectoryHandle if granted */
async function requestPermissionAndRestore(
  rawHandle: FileSystemDirectoryHandle,
  folderId: string,
  handleCache: WebHandleCacheShape | null,
  setPendingRestore: (state: PendingRestoreState | null) => void
): Promise<{ handle: DirectoryHandle | null; showDenied: boolean; showStale: boolean }> {
  if (typeof rawHandle.requestPermission !== 'function') {
    logger.warn('beginRestore: handle lacks requestPermission method');
    return { handle: null, showDenied: false, showStale: true };
  }

  try {
    // CRITICAL: This requestPermission call happens synchronously in the click handler chain
    const permissionResult = await rawHandle.requestPermission({ mode: 'read' });
    logger.info('beginRestore: permission result', { permissionResult });

    if (permissionResult === 'granted') {
      await handleCache?.markHandleRestored?.(folderId);
      setPendingRestore(null);
      return { handle: toDirectoryHandle(rawHandle), showDenied: false, showStale: false };
    }

    if (permissionResult === 'denied') {
      return { handle: null, showDenied: true, showStale: false };
    }

    return { handle: null, showDenied: false, showStale: true };
  } catch (error) {
    // Differentiate error types for better UX
    const errorName = error instanceof Error ? error.name : '';
    const errorMessage = error instanceof Error ? error.message : String(error);

    // AbortError: User cancelled the permission dialog - not a real error
    if (errorName === 'AbortError') {
      logger.debug('beginRestore: user cancelled permission dialog');
      return { handle: null, showDenied: false, showStale: false };
    }

    // NotFoundError: Handle points to deleted/moved directory - treat as stale
    if (errorName === 'NotFoundError') {
      logger.info('beginRestore: handle target no longer exists', { error: errorMessage });
      await handleCache?.removeRootHandle?.(folderId);
      setPendingRestore(null);
      return { handle: null, showDenied: false, showStale: true };
    }

    // Other errors - log and show stale banner
    logger.warn('beginRestore: permission request failed', {
      error: errorMessage,
      errorName,
    });
    return { handle: null, showDenied: false, showStale: true };
  }
}

interface FallbackRestoreParams {
  handleCache: WebHandleCacheShape | null;
  pendingRestore: PendingRestoreState | null;
  setPendingRestore: (state: PendingRestoreState | null) => void;
  setShowDeniedBanner: (v: boolean) => void;
  setShowStaleBanner: (v: boolean) => void;
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void;
}

/** Single-handle and legacy paths when the handle cache has no raw handles. */
async function runFallbackRestore({
  handleCache,
  pendingRestore,
  setPendingRestore,
  setShowDeniedBanner,
  setShowStaleBanner,
  setStoredFolders,
}: FallbackRestoreParams): Promise<readonly DirectoryHandle[]> {
  // SINGLE-HANDLE PATH: Cache doesn't expose raw handles — use pendingRestore.
  if (pendingRestore?.rawHandle) {
    const { rawHandle, folderId, permissionState } = pendingRestore;

    if (permissionState === 'granted') {
      logger.info('beginRestore: permission already granted');
      await handleCache?.markHandleRestored?.(folderId);
      setPendingRestore(null);
      return [toDirectoryHandle(rawHandle)];
    }

    if (permissionState === 'denied') {
      logger.info('beginRestore: permission denied');
      setShowDeniedBanner(true);
      return [];
    }

    // Permission is 'prompt' or 'unknown' - request it NOW
    logger.info('beginRestore: requesting permission synchronously');
    const singleResult = await requestPermissionAndRestore(
      rawHandle,
      folderId,
      handleCache,
      setPendingRestore
    );

    if (singleResult.showDenied) {
      setShowDeniedBanner(true);
    }
    if (singleResult.showStale) {
      setShowStaleBanner(true);
    }
    return singleResult.handle ? [singleResult.handle] : [];
  }

  // LEGACY PATH: No raw handle, use old restoreLastRootHandle method
  if (!handleCache?.restoreLastRootHandle) {
    logger.warn('beginRestore: no restore method available');
    return [];
  }

  const legacyResult = await legacyRestore(handleCache, setPendingRestore, setStoredFolders);
  if (legacyResult.showDenied) {
    setShowDeniedBanner(true);
  }
  if (legacyResult.showStale) {
    setShowStaleBanner(true);
  }
  return legacyResult.handle ? [legacyResult.handle] : [];
}

/** Legacy restore using restoreLastRootHandle */
async function legacyRestore(
  handleCache: WebHandleCacheShape,
  setPendingRestore: (state: PendingRestoreState | null) => void,
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void
): Promise<{ handle: DirectoryHandle | null; showDenied: boolean; showStale: boolean }> {
  try {
    logger.debug('beginRestore: using legacy restoreLastRootHandle');
    const result = await handleCache.restoreLastRootHandle?.();

    if (!result?.handle) {
      const remaining = await handleCache.getAllRootHandles?.();
      const hasRemaining = Boolean(remaining && remaining.length > 0);
      return { handle: null, showDenied: hasRemaining, showStale: !hasRemaining };
    }

    setPendingRestore(null);
    const remaining = await handleCache.getAllRootHandles?.();
    if (remaining) {
      setStoredFolders(remaining.map((h) => ({ folderId: h.folderId, name: h.name })));
    }

    logger.info('beginRestore: successfully restored handle', { name: result.handle.name });
    return { handle: toDirectoryHandle(result.handle), showDenied: false, showStale: false };
  } catch (error) {
    logger.warn('Failed to restore handle', { error });
    return { handle: null, showDenied: false, showStale: true };
  }
}

export function useRestoreAccess(): RestoreAccessState {
  const { fileSystemAdapter } = useAdapters();
  const [pendingRestore, setPendingRestore] = useState<PendingRestoreState | null>(null);
  const [showDeniedBanner, setShowDeniedBanner] = useState(false);
  const [showStaleBanner, setShowStaleBanner] = useState(false);
  const [storedFolders, setStoredFolders] = useState<Array<{ folderId: string; name: string }>>([]);
  const [isCheckingStoredHandles, setIsCheckingStoredHandles] = useState(true);
  const dismissedRef = useRef(false);
  const clearGenerationRef = useRef(0);
  const isMountedRef = useRef(true);

  // Track mounted state to prevent stale state updates after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleCache = useMemo(() => {
    const cache = readHandleCache(fileSystemAdapter, isWebHandleCacheShape);
    if (cache) {
      logger.debug('Handle cache available for restore checks', {
        hasNewMethod: typeof cache.getLastRootHandleForRestore === 'function',
      });
    }
    return cache;
  }, [fileSystemAdapter]);

  const clearLocalRestoreState = useCallback((): void => {
    clearGenerationRef.current += 1;
    dismissedRef.current = true;
    setPendingRestore(null);
    setShowDeniedBanner(false);
    setShowStaleBanner(false);
    setStoredFolders([]);
    setIsCheckingStoredHandles(false);
  }, []);

  useEffect(
    () => subscribeToStoredHandlesCleared(handleCache, clearLocalRestoreState),
    [clearLocalRestoreState, handleCache]
  );

  // Load stored handles on startup
  useEffect(() => {
    if (dismissedRef.current) {
      logger.debug('Skipping restore check - already dismissed');
      setIsCheckingStoredHandles(false);
      return;
    }

    const hasNewMethod = typeof handleCache?.getLastRootHandleForRestore === 'function';
    const hasOldMethod = typeof handleCache?.getAllRootHandles === 'function';

    if (!(hasNewMethod || hasOldMethod)) {
      setIsCheckingStoredHandles(false);
      return;
    }

    const timer = setTimeout(() => {
      const loadGeneration = clearGenerationRef.current;
      const shouldApplyLoadedHandles = (): boolean =>
        isMountedRef.current &&
        !dismissedRef.current &&
        clearGenerationRef.current === loadGeneration;

      void (async () => {
        try {
          await loadStoredHandles({
            dismissedRef,
            handleCache,
            hasNewMethod,
            hasOldMethod,
            setPendingRestore,
            setStoredFolders,
            shouldApplyLoadedHandles,
          });
        } catch (error) {
          logger.warn('Failed to load stored root handles', { error });
        } finally {
          // Only update state if still mounted
          if (isMountedRef.current) {
            setIsCheckingStoredHandles(false);
          }
        }
      })();
    }, HANDLE_CHECK_DELAY_MS);

    return () => clearTimeout(timer);
  }, [handleCache]);

  const beginRestore = useCallback(async (): Promise<readonly DirectoryHandle[]> => {
    logger.info('beginRestore called', {
      hasPendingRestore: !!pendingRestore,
      hasRawHandle: !!pendingRestore?.rawHandle,
      permissionState: pendingRestore?.permissionState,
    });

    setShowDeniedBanner(false);
    setShowStaleBanner(false);

    // MULTI-ROOT PATH: Fetch all stored handles; initiate all requestPermission calls
    // before awaiting any (burst-before-drain — Chrome batches into one permission prompt).
    const allStored = await handleCache?.getAllRootHandles?.();
    const rawHandlesFromCache = (allStored ?? []).filter(
      (h): h is HandleWithRaw =>
        h.handle !== null &&
        h.handle !== undefined &&
        typeof h.handle.requestPermission === 'function'
    );

    if (rawHandlesFromCache.length > 0) {
      logger.info('beginRestore: multi-root burst path', { count: rawHandlesFromCache.length });

      // pendingRestore carries the last-checked permission state; use folderId to match.
      const pendingGrantedFolderId =
        pendingRestore?.permissionState === 'granted' ? pendingRestore.folderId : undefined;

      const { alreadyGranted, needsPrompt } = await classifyHandles({
        handleCache,
        pendingGrantedFolderId,
        rawHandlesFromCache,
      });

      if (needsPrompt.length === 0) {
        // All handles were already granted — no dialog needed
        if (alreadyGranted.length > 0) {
          setPendingRestore(null);
        }
        return alreadyGranted;
      }

      // Delegate burst-before-drain to extracted helper (complexity limit)
      return runMultiRootBurst({
        alreadyGranted,
        handleCache,
        needsPrompt,
        setPendingRestore,
        setShowDeniedBanner,
        setShowStaleBanner,
      });
    }

    // SINGLE-HANDLE + LEGACY PATH: delegate to extracted helper (complexity limit)
    return runFallbackRestore({
      handleCache,
      pendingRestore,
      setPendingRestore,
      setShowDeniedBanner,
      setShowStaleBanner,
      setStoredFolders,
    });
  }, [handleCache, pendingRestore]);

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
    if (handleCache) {
      broadcastStoredHandlesCleared(handleCache);
    } else {
      clearLocalRestoreState();
    }
  }, [clearLocalRestoreState, handleCache]);

  return {
    beginRestore,
    chooseDifferentFolder,
    clearStoredHandles,
    dismissRestore,
    isCheckingStoredHandles,
    pendingRestore,
    showDeniedBanner,
    showStaleBanner,
    storedFolders,
  };
}
