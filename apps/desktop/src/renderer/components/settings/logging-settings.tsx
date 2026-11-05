import { openLogsTab, useDiagnosticSinkHealthStore } from '@brainstrike/app-shell/diagnostics';
import {
  describeBoundaryError,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import type { LoggingPreferencesPatch } from '@brainstrike/logging';
import { LoggingSettingsSection } from '@brainstrike/settings-ui/settings/system/logging-settings-section';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorNotice,
} from '@brainstrike/ui';
import { useCallback, useEffect, useState } from 'react';
import type { LoggingSettingsPayload } from '../../../logging-shared';

type LoggingSettingsState =
  | { readonly kind: 'loading' }
  | { readonly error: string; readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly payload: LoggingSettingsPayload };

const loggingUnavailable = () =>
  refusalError('availability', 'logging.unavailable', 'Logging is unavailable in this window.');

/** Logging settings over Main, the preferences' one writer: shown as Main holds them, changed through Main. */
export function DesktopLoggingSettings() {
  const [state, setState] = useState<LoggingSettingsState>(() =>
    typeof window.logging?.getPreferences === 'function'
      ? { kind: 'loading' }
      : { error: describeBoundaryError(loggingUnavailable()), kind: 'error' }
  );
  const sinkHealthReason = useDiagnosticSinkHealthStore((store) => store.disabledReason);

  // biome-ignore lint/plugin: Not derived state — a one-shot async read of Main's preferences over the preload bridge plus a subscription to Main's broadcast; `cancelled` discards a response that lands after unmount.
  useEffect(() => {
    let cancelled = false;
    const load = async (getPreferences: Window['logging']['getPreferences']) => {
      try {
        const payload = await callBoundary(getPreferences);
        if (!cancelled) {
          setState({ kind: 'ready', payload });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ error: describeBoundaryError(error), kind: 'error' });
        }
      }
    };
    if (window.logging?.getPreferences) {
      void load(window.logging.getPreferences);
    }
    // A change committed from another window reaches this one as Main's broadcast.
    const unsubscribe = window.logging?.onPreferencesUpdated?.((preferences) => {
      setState((current) =>
        current.kind === 'ready'
          ? { kind: 'ready', payload: { ...current.payload, preferences } }
          : current
      );
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const commitPreferences = useCallback(async (patch: LoggingPreferencesPatch) => {
    if (!window.logging?.setPreferences) {
      throw loggingUnavailable();
    }
    const payload = await callBoundary(() => window.logging.setPreferences(patch));
    setState({ kind: 'ready', payload });
  }, []);

  const selectDestination = useCallback(async () => {
    if (!window.logging?.selectDestination) {
      throw refusalError(
        'availability',
        'logging.unavailable',
        'Log destination selection is unavailable in this window.'
      );
    }
    return callBoundary(() => window.logging.selectDestination());
  }, []);

  const openDestination = useCallback(async (target: string | null) => {
    if (!window.logging?.openDestination) {
      return false;
    }
    return callBoundary(() => window.logging.openDestination(target ?? null));
  }, []);

  if (state.kind === 'loading') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Logging</CardTitle>
          <CardDescription>Loading logging preferences…</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground text-sm" role="status">
            Fetching saved logging preferences…
          </div>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === 'error') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Logging</CardTitle>
          <CardDescription>Logging configuration is unavailable.</CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorNotice message={state.error} />
        </CardContent>
      </Card>
    );
  }

  const { capabilities, defaults, preferences } = state.payload;
  return (
    <LoggingSettingsSection
      defaults={defaults}
      fileCapabilities={{
        canSelectDestination: capabilities.canSelectDestination,
        defaultDestination: capabilities.defaultDestination,
        fileLoggingSupported: capabilities.fileLoggingSupported,
        ...(capabilities.reason === undefined ? {} : { reason: capabilities.reason }),
      }}
      onCommitPreferences={commitPreferences}
      onOpenLogDestination={openDestination}
      onOpenLogs={openLogsTab}
      onSelectLogDestination={selectDestination}
      preferences={preferences}
      runtime="electron-renderer"
      sinkHealthReason={sinkHealthReason}
    />
  );
}
