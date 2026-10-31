import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type { LoggingPreferences } from '@brainstrike/logging';
import type { useToast } from '@brainstrike/ui';
import { useState } from 'react';

interface UseLoggingPreferenceActionsOptions {
  /** Main's defaults, which Restore Defaults commits. */
  readonly defaults: LoggingPreferences;
  /** Commits to the preferences' one writer; `preferences` reflects the result once it resolves. */
  readonly onCommitPreferences: (preferences: LoggingPreferences) => Promise<void>;
  readonly onOpenLogDestination?: ((target: string | null) => Promise<boolean>) | undefined;
  readonly onSelectLogDestination?: (() => Promise<string | null>) | undefined;
  readonly preferences: LoggingPreferences;
  readonly toast: ReturnType<typeof useToast>['toast'];
}

interface LoggingPreferenceActions {
  readonly applyNestedUpdates: (updates: Partial<LoggingPreferences['file']>) => Promise<void>;
  readonly applyUpdates: (updates: Partial<LoggingPreferences>) => Promise<void>;
  readonly handleOpenDestination: () => Promise<void>;
  readonly handleRedactChange: (value: string) => Promise<void>;
  readonly handleReset: () => Promise<void>;
  readonly handleSelectDestination: () => Promise<void>;
  /** A commit is in flight; the controls stay disabled so the next change builds on its result. */
  readonly isSyncing: boolean;
}

/** The Logging settings' changes, each committed whole to the writer the caller names. */
export function useLoggingPreferenceActions({
  defaults,
  onCommitPreferences,
  onOpenLogDestination,
  onSelectLogDestination,
  preferences,
  toast,
}: UseLoggingPreferenceActionsOptions): LoggingPreferenceActions {
  const [isSyncing, setIsSyncing] = useState(false);

  const commit = async (next: LoggingPreferences, failureTitle: string): Promise<boolean> => {
    setIsSyncing(true);
    const committed = await onCommitPreferences(next).then(
      () => true,
      (error: unknown) => {
        toast({
          description: describeBoundaryError(error),
          title: failureTitle,
          variant: 'destructive',
        });
        return false;
      }
    );
    setIsSyncing(false);
    return committed;
  };

  const applyUpdates = async (updates: Partial<LoggingPreferences>) => {
    await commit({ ...preferences, ...updates }, 'Failed to update logging preferences');
  };

  const applyNestedUpdates = async (updates: Partial<LoggingPreferences['file']>) => {
    await applyUpdates({ file: { ...preferences.file, ...updates } });
  };

  const handleRedactChange = async (value: string) => {
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    await applyUpdates({ redactPaths: entries });
  };

  const handleSelectDestination = async () => {
    if (!onSelectLogDestination) {
      return;
    }
    const selected = await onSelectLogDestination().catch((error: unknown) => {
      toast({
        description: describeBoundaryError(error),
        title: 'Failed to update log destination',
        variant: 'destructive',
      });
      return null;
    });
    if (selected) {
      await applyNestedUpdates({ destination: selected, enabled: true });
    }
  };

  const handleOpenDestination = async () => {
    if (!onOpenLogDestination) {
      return;
    }
    const currentDestination = preferences.file.destination;
    if (await onOpenLogDestination(currentDestination)) {
      return;
    }
    toast({
      description: currentDestination
        ? `Path "${currentDestination}" is not accessible.`
        : 'No log file destination is configured.',
      title: 'Unable to open log file',
      variant: 'destructive',
    });
  };

  const handleReset = async () => {
    if (await commit(defaults, 'Failed to reset logging preferences')) {
      toast({ title: 'Logging preferences reset' });
    }
  };

  return {
    applyNestedUpdates,
    applyUpdates,
    handleOpenDestination,
    handleRedactChange,
    handleReset,
    handleSelectDestination,
    isSyncing,
  };
}
