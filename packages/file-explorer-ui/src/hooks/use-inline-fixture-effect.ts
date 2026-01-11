/**
 * Custom hook for managing inline fixture state synchronization.
 *
 * Extracted from FileExplorerLeftPanel to reduce cognitive complexity.
 */

import { isFixtureCapableAdapter } from '@brainstrike/file-system';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

const logger = createLogger('useInlineFixtureEffect');

type FixtureCapableAdapter = FileSystemAdapter & {
  loadInlineFixture: () => Promise<DirectoryHandle | null>;
  clearInlineFixture: () => Promise<void>;
  isInlineFixtureActive?: () => boolean;
  canLoadInlineFixture?: boolean;
};

interface InlineFixtureToast {
  title: string;
  description: string;
  variant?: 'default' | 'destructive';
}

interface UseInlineFixtureEffectOptions {
  fileSystemAdapter: FileSystemAdapter;
  devInlineFixtureEnabled: boolean;
  setDevInlineFixtureEnabled: (enabled: boolean) => void;
  setRootDirectoryHandle: ((handle: DirectoryHandle | null) => void) | undefined;
  clearRootDirectory: (() => void) | undefined;
  showToast: ((toast: InlineFixtureToast) => void) | undefined;
  strings: {
    successTitle: string;
    errorTitle: string;
    enableSuccess: string;
    disableSuccess: string;
    enableError: string;
    disableError: string;
  };
}

interface InlineFixtureState {
  isLoading: boolean;
  isAvailable: boolean;
}

/**
 * Checks if the current state requires no action.
 */
function shouldSkipUpdate(
  fixtureAdapter: FixtureCapableAdapter | null,
  targetState: boolean,
  prevTargetState: boolean | null,
  hasAppliedInitial: boolean
): boolean {
  if (!fixtureAdapter) {
    return true;
  }

  // Skip if target state hasn't changed and we've already applied initial fixture
  if (prevTargetState === targetState && hasAppliedInitial) {
    return true;
  }

  // Skip if fixture is already in desired state
  const currentActive = fixtureAdapter.isInlineFixtureActive?.() ?? false;
  return currentActive === targetState;
}

/**
 * Hook to manage inline fixture state synchronization with the file system adapter.
 */
export function useInlineFixtureEffect(options: UseInlineFixtureEffectOptions): InlineFixtureState {
  const {
    fileSystemAdapter,
    devInlineFixtureEnabled,
    setDevInlineFixtureEnabled,
    setRootDirectoryHandle,
    clearRootDirectory,
    showToast,
    strings,
  } = options;

  const [isLoading, setIsLoading] = useState(false);
  const hasAppliedInitialFixtureRef = useRef(false);
  const prevTargetStateRef = useRef<boolean | null>(null);
  const runIdRef = useRef(0);
  const clearRootDirectoryRef = useRef(clearRootDirectory);
  const showToastRef = useRef(showToast);
  const stringsRef = useRef(strings);

  // Keep refs updated
  useEffect(() => {
    clearRootDirectoryRef.current = clearRootDirectory;
  }, [clearRootDirectory]);

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  useEffect(() => {
    stringsRef.current = strings;
  }, [strings]);

  const fixtureAdapter = isFixtureCapableAdapter(fileSystemAdapter)
    ? (fileSystemAdapter as FixtureCapableAdapter)
    : null;
  const isAvailable = Boolean(fixtureAdapter?.canLoadInlineFixture);

  const enableInlineFixture = useCallback(async () => {
    if (!fixtureAdapter) {
      return;
    }
    const handle = await fixtureAdapter.loadInlineFixture();
    if (handle && setRootDirectoryHandle) {
      setRootDirectoryHandle(handle);
    }
  }, [fixtureAdapter, setRootDirectoryHandle]);

  const disableInlineFixture = useCallback(async () => {
    if (!fixtureAdapter) {
      return;
    }
    await fixtureAdapter.clearInlineFixture();
    clearRootDirectoryRef.current?.();
  }, [fixtureAdapter]);

  const notifySuccess = useCallback((enabled: boolean) => {
    if (!hasAppliedInitialFixtureRef.current) {
      return;
    }
    const s = stringsRef.current;
    const description = enabled ? s.enableSuccess : s.disableSuccess;
    showToastRef.current?.({
      title: s.successTitle,
      description,
    });
  }, []);

  const notifyError = useCallback((enabled: boolean) => {
    const s = stringsRef.current;
    const description = enabled ? s.enableError : s.disableError;
    showToastRef.current?.({
      title: s.errorTitle,
      description,
      variant: 'destructive',
    });
  }, []);

  // Main effect for synchronizing fixture state
  useEffect(() => {
    // Guard: adapter must be available
    if (!(fixtureAdapter && isAvailable)) {
      setIsLoading(false);
      if (devInlineFixtureEnabled) {
        setDevInlineFixtureEnabled(false);
      }
      return;
    }

    // Guard: wait for initial application or explicit enable
    if (!(hasAppliedInitialFixtureRef.current || devInlineFixtureEnabled)) {
      setIsLoading(false);
      return;
    }

    // Guard: skip if no state change needed
    if (
      shouldSkipUpdate(
        fixtureAdapter,
        devInlineFixtureEnabled,
        prevTargetStateRef.current,
        hasAppliedInitialFixtureRef.current
      )
    ) {
      setIsLoading(false);
      hasAppliedInitialFixtureRef.current = true;
      return;
    }

    prevTargetStateRef.current = devInlineFixtureEnabled;

    let isCancelled = false;
    const targetState = devInlineFixtureEnabled;

    const applySetting = async () => {
      runIdRef.current += 1;
      const runId = runIdRef.current;

      const applyToggle = targetState ? enableInlineFixture : disableInlineFixture;
      const rollbackOnEnableFailure: (() => Promise<void>) | null = targetState
        ? async () => {
            try {
              await fixtureAdapter.clearInlineFixture();
            } catch {}
            clearRootDirectoryRef.current?.();
          }
        : null;

      setIsLoading(true);
      try {
        await applyToggle();
        notifySuccess(targetState);
        hasAppliedInitialFixtureRef.current = true;
      } catch (error) {
        logger.warn('Failed to toggle inline fixture', { error, targetState });
        notifyError(targetState);
        await rollbackOnEnableFailure?.();
        setDevInlineFixtureEnabled(!targetState);
      } finally {
        // Only the latest run may clear loading; prevents stale async from wedging the UI.
        if (!isCancelled && runIdRef.current === runId) {
          setIsLoading(false);
        }
        hasAppliedInitialFixtureRef.current = true;
      }
    };

    void applySetting();

    return () => {
      isCancelled = true;
    };
  }, [
    devInlineFixtureEnabled,
    disableInlineFixture,
    enableInlineFixture,
    isAvailable,
    notifyError,
    notifySuccess,
    setDevInlineFixtureEnabled,
    fixtureAdapter,
  ]);

  return {
    isLoading,
    isAvailable,
  };
}
