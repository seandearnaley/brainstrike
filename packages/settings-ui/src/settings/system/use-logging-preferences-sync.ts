import { useLoggingPreferencesStore } from '@brainstrike/app-state/stores/logging-preferences-store';
import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type { LoggingPreferences } from '@brainstrike/logging';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useRef, useState } from 'react';

interface UseLoggingPreferencesSyncOptions {
  readonly onCommitPreferences?:
    | ((preferences: LoggingPreferences) => Promise<LoggingPreferences | undefined>)
    | undefined;
  readonly onOpenLogDestination?: ((target: string | null) => Promise<boolean>) | undefined;
  readonly onResetPreferences?: ((preferences: LoggingPreferences) => Promise<void>) | undefined;
  readonly onSelectLogDestination?: (() => Promise<string | null>) | undefined;
  readonly toast: ReturnType<typeof useToast>['toast'];
}

interface LoggingPreferencesSync {
  readonly applyNestedUpdates: (updates: Partial<LoggingPreferences['file']>) => Promise<void>;
  readonly applyUpdates: (updates: Partial<LoggingPreferences>) => Promise<void>;
  readonly handleOpenDestination: () => Promise<void>;
  readonly handleRedactChange: (value: string) => Promise<void>;
  readonly handleReset: () => Promise<void>;
  readonly handleSelectDestination: () => Promise<void>;
  readonly isSyncing: boolean;
  readonly preferences: LoggingPreferences;
}

function clonePreferences(preferences: LoggingPreferences): LoggingPreferences {
  return {
    ...preferences,
    file: { ...preferences.file },
    redactPaths: [...preferences.redactPaths],
  };
}

export function useLoggingPreferencesSync({
  onCommitPreferences,
  onOpenLogDestination,
  onResetPreferences,
  onSelectLogDestination,
  toast,
}: UseLoggingPreferencesSyncOptions): LoggingPreferencesSync {
  const preferences = useLoggingPreferencesStore((state) => state.preferences);
  const updatePreferences = useLoggingPreferencesStore((state) => state.updatePreferences);
  const setPreferences = useLoggingPreferencesStore((state) => state.setPreferences);
  const resetPreferences = useLoggingPreferencesStore((state) => state.resetPreferences);
  const [isSyncing, setIsSyncing] = useState(false);
  const updateTokenRef = useRef(0);

  const commitPreferences = useCallback(
    async (nextPreferences: LoggingPreferences) => {
      if (!onCommitPreferences) {
        return;
      }
      setIsSyncing(true);
      try {
        const result = await onCommitPreferences(nextPreferences);
        if (result) {
          setPreferences(result);
        }
      } catch (error) {
        setIsSyncing(false);
        const message = describeBoundaryError(error);
        toast({
          description: message,
          title: 'Failed to update logging preferences',
          variant: 'destructive',
        });
        throw error;
      }
      setIsSyncing(false);
    },
    [onCommitPreferences, setPreferences, toast]
  );

  const applyUpdates = useCallback(
    async (updates: Partial<LoggingPreferences>) => {
      const previous = clonePreferences(useLoggingPreferencesStore.getState().preferences);
      updatePreferences(updates);
      const requestId = updateTokenRef.current + 1;
      updateTokenRef.current = requestId;
      const next = clonePreferences(useLoggingPreferencesStore.getState().preferences);
      try {
        await commitPreferences(next);
      } catch {
        if (updateTokenRef.current === requestId) {
          setPreferences(previous);
        }
      }
    },
    [commitPreferences, setPreferences, updatePreferences]
  );

  const applyNestedUpdates = useCallback(
    async (updates: Partial<LoggingPreferences['file']>) => {
      await applyUpdates({ file: { ...preferences.file, ...updates } });
    },
    [applyUpdates, preferences.file]
  );

  const handleRedactChange = useCallback(
    async (value: string) => {
      const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      await applyUpdates({ redactPaths: entries });
    },
    [applyUpdates]
  );

  const handleSelectDestination = useCallback(async () => {
    if (!onSelectLogDestination) {
      return;
    }
    setIsSyncing(true);
    try {
      const selected = await onSelectLogDestination();
      if (!selected) {
        setIsSyncing(false);
        return;
      }
      await applyNestedUpdates({ destination: selected, enabled: true });
    } catch (error) {
      const message = describeBoundaryError(error);
      toast({
        description: message,
        title: 'Failed to update log destination',
        variant: 'destructive',
      });
    }
    setIsSyncing(false);
  }, [applyNestedUpdates, onSelectLogDestination, toast]);

  const handleOpenDestination = useCallback(async () => {
    if (!onOpenLogDestination) {
      return;
    }
    const currentDestination = preferences.file.destination;
    const success = await onOpenLogDestination(currentDestination);
    if (success) {
      return;
    }
    toast({
      description: currentDestination
        ? `Path "${currentDestination}" is not accessible.`
        : 'No log file destination is configured.',
      title: 'Unable to open log file',
      variant: 'destructive',
    });
  }, [onOpenLogDestination, preferences.file.destination, toast]);

  // The catch branch never rethrows, so the trailing reset runs on both paths.
  // A finally clause blocks React Compiler memoization (react-hooks-js/todo).
  const handleReset = useCallback(async () => {
    const previous = useLoggingPreferencesStore.getState().preferences;
    resetPreferences();
    const next = useLoggingPreferencesStore.getState().preferences;
    try {
      if (onResetPreferences) {
        setIsSyncing(true);
        await onResetPreferences(next);
      }
      await commitPreferences(next);
      toast({ title: 'Logging preferences reset' });
    } catch (error) {
      setPreferences(previous);
      toast({
        description: describeBoundaryError(error),
        title: 'Failed to reset logging preferences',
        variant: 'destructive',
      });
    }
    setIsSyncing(false);
  }, [commitPreferences, onResetPreferences, resetPreferences, setPreferences, toast]);

  return {
    applyNestedUpdates,
    applyUpdates,
    handleOpenDestination,
    handleRedactChange,
    handleReset,
    handleSelectDestination,
    isSyncing,
    preferences,
  };
}
