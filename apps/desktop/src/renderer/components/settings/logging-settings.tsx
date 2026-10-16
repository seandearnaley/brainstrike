import {
  openLogsTab,
  useDiagnosticSinkHealthStore,
  useDiagnosticsPurge,
} from '@brainstrike/app-shell/diagnostics';
import { useLoggingPreferencesStore } from '@brainstrike/app-state/stores/logging-preferences-store';
import {
  describeBoundaryError,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import type { LoggingPreferences } from '@brainstrike/logging';
import {
  LoggingSettingsSection,
  type LoggingSettingsSectionProps,
} from '@brainstrike/settings-ui/settings/system/logging-settings-section';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useToast,
} from '@brainstrike/ui';
import { useCallback, useEffect, useReducer } from 'react';
import type { LoggingSettingsPayload } from '../../../logging-shared';

interface LoggingSettingsState {
  error: string | null;
  fileCapabilities: LoggingSettingsSectionProps['fileCapabilities'];
  loading: boolean;
  syncing: boolean;
}

type LoggingSettingsAction =
  | { type: 'start_syncing' }
  | { type: 'stop_syncing' }
  | { type: 'load_success'; fileCapabilities: LoggingSettingsSectionProps['fileCapabilities'] }
  | { type: 'load_error'; error: string };

function loggingSettingsReducer(
  state: LoggingSettingsState,
  action: LoggingSettingsAction
): LoggingSettingsState {
  switch (action.type) {
    case 'start_syncing':
      return { ...state, syncing: true };
    case 'stop_syncing':
      return { ...state, syncing: false };
    case 'load_success':
      return { ...state, error: null, fileCapabilities: action.fileCapabilities, loading: false };
    case 'load_error':
      return { ...state, error: action.error, loading: false };
  }
}

export function DesktopLoggingSettings() {
  const [settingsState, settingsDispatch] = useReducer(loggingSettingsReducer, {
    error: null,
    fileCapabilities: undefined,
    loading: true,
    syncing: false,
  });
  const { loading, syncing, error, fileCapabilities } = settingsState;
  const { toast } = useToast();

  const setPreferences = useLoggingPreferencesStore((state) => state.setPreferences);
  const onPurgeNow = useDiagnosticsPurge();
  const sinkHealthReason = useDiagnosticSinkHealthStore((state) => state.disabledReason);

  const mapPayload = useCallback(
    (payload: LoggingSettingsPayload) => {
      setPreferences(payload.preferences);
      settingsDispatch({
        fileCapabilities: {
          canSelectDestination: payload.capabilities.canSelectDestination,
          defaultDestination: payload.capabilities.defaultDestination,
          fileLoggingSupported: payload.capabilities.fileLoggingSupported,
          reason: payload.capabilities.reason,
        },
        type: 'load_success',
      });
    },
    [setPreferences]
  );

  useEffect(() => {
    let cancelled = false;

    const finishWithPayload = (payload: LoggingSettingsPayload) => {
      if (cancelled) {
        return;
      }
      mapPayload(payload);
    };

    const finishWithError = (err: unknown) => {
      if (cancelled) {
        return;
      }
      const message = describeBoundaryError(err);
      settingsDispatch({ error: message, type: 'load_error' });
    };

    const fetchPreferences = async () => {
      try {
        const fn = window.logging?.getPreferences;
        if (!fn) {
          finishWithError(
            refusalError(
              'availability',
              'logging.unavailable',
              'Logging is unavailable in this window.'
            )
          );
          return;
        }
        const response = await callBoundary(fn);
        if (!response) {
          finishWithError(
            refusalError(
              'availability',
              'logging.unavailable',
              'Logging is unavailable in this window.'
            )
          );
          return;
        }
        finishWithPayload(response);
      } catch (err) {
        finishWithError(err);
      }
    };

    void fetchPreferences();

    return () => {
      cancelled = true;
    };
  }, [mapPayload]);

  const commitPreferences = useCallback(
    async (preferences: LoggingPreferences) => {
      if (!window.logging?.setPreferences) {
        throw refusalError(
          'availability',
          'logging.unavailable',
          'Logging is unavailable in this window.'
        );
      }
      settingsDispatch({ type: 'start_syncing' });
      let caughtError: unknown = null;
      let result: LoggingSettingsPayload | undefined;
      try {
        result = await callBoundary(() => window.logging.setPreferences(preferences));
      } catch (err) {
        caughtError = err;
      }
      settingsDispatch({ type: 'stop_syncing' });
      if (caughtError !== null) {
        const message = describeBoundaryError(caughtError);
        toast({
          description: message,
          title: 'Failed to persist logging preferences',
          variant: 'destructive',
        });
        throw caughtError;
      }
      if (result) {
        mapPayload(result);
        return result.preferences;
      }
      return;
    },
    [mapPayload, toast]
  );

  const resetPreferences = useCallback(
    async (preferences: LoggingPreferences) => {
      await commitPreferences(preferences);
    },
    [commitPreferences]
  );

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

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Logging & Diagnostics</CardTitle>
          <CardDescription>Loading logging preferences…</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground text-sm">Fetching saved logging preferences…</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Logging & Diagnostics</CardTitle>
          <CardDescription>Logging configuration is unavailable.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-destructive text-sm">{error}</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <LoggingSettingsSection
      busy={syncing}
      fileCapabilities={fileCapabilities}
      onCommitPreferences={commitPreferences}
      onOpenLogDestination={openDestination}
      onOpenLogs={openLogsTab}
      onResetPreferences={resetPreferences}
      onSelectLogDestination={selectDestination}
      runtime="electron-renderer"
      sinkHealthReason={sinkHealthReason}
      {...(onPurgeNow === undefined ? {} : { onPurgeNow })}
    />
  );
}

export default DesktopLoggingSettings;
