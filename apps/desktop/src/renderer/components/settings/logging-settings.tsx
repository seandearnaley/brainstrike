import {
  LoggingSettingsSection,
  type LoggingSettingsSectionProps,
} from '@brainstrike/preferences/settings/system/logging-settings-section';
import { useLoggingPreferencesStore } from '@brainstrike/preferences/stores/logging-preferences-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useToast,
} from '@brainstrike/ui';
import { LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import type { LoggingPreferences } from '@brainstrike/utils/logging-preferences';
import { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { LoggingSettingsPayload } from '../../../logging-shared';
import { getRendererLogBuffer } from '../../log-buffer';

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
      return { ...state, loading: false, error: null, fileCapabilities: action.fileCapabilities };
    case 'load_error':
      return { ...state, loading: false, error: action.error };
  }
}

export function DesktopLoggingSettings() {
  const [settingsState, settingsDispatch] = useReducer(loggingSettingsReducer, {
    loading: true,
    syncing: false,
    error: null,
    fileCapabilities: undefined,
  });
  const { loading, syncing, error, fileCapabilities } = settingsState;
  const { toast } = useToast();

  const setPreferences = useLoggingPreferencesStore((state) => state.setPreferences);
  const logSource = useMemo<LoggingSettingsSectionProps['logSource']>(() => {
    const buffer = getRendererLogBuffer();
    const loadRecords = (rendererRecords: readonly LogRecord[]) =>
      loadDesktopLogRecords(rendererRecords);
    return {
      getInitialRecords: async () => loadRecords(buffer.getRecords()),
      subscribe: (handler) => {
        let disposed = false;
        const unsubscribe = buffer.subscribe((rendererRecords) => {
          void loadRecords(rendererRecords).then((records) => {
            if (!disposed) {
              handler(records);
            }
          });
        });
        return () => {
          disposed = true;
          unsubscribe();
        };
      },
    };
  }, []);

  const mapPayload = useCallback(
    (payload: LoggingSettingsPayload) => {
      setPreferences(payload.preferences);
      settingsDispatch({
        type: 'load_success',
        fileCapabilities: {
          fileLoggingSupported: payload.capabilities.fileLoggingSupported,
          canSelectDestination: payload.capabilities.canSelectDestination,
          reason: payload.capabilities.reason,
          defaultDestination: payload.capabilities.defaultDestination,
        },
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
      const message = err instanceof Error ? err.message : String(err);
      settingsDispatch({ type: 'load_error', error: message });
    };

    const fetchPreferences = async () => {
      try {
        const fn = window.logging?.getPreferences;
        if (!fn) {
          finishWithError(new Error('Logging bridge is unavailable in this build.'));
          return;
        }
        const response = await fn();
        if (!response) {
          finishWithError(new Error('Logging bridge is unavailable in this build.'));
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
        throw new Error('Logging bridge is unavailable in this build.');
      }
      settingsDispatch({ type: 'start_syncing' });
      let caughtError: unknown = null;
      let result: Awaited<ReturnType<typeof window.logging.setPreferences>> | undefined;
      try {
        result = await window.logging.setPreferences(preferences);
      } catch (err) {
        caughtError = err;
      }
      settingsDispatch({ type: 'stop_syncing' });
      if (caughtError !== null) {
        const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
        toast({
          title: 'Failed to persist logging preferences',
          description: message,
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
      throw new Error('Cannot select destination in this environment.');
    }
    return window.logging.selectDestination();
  }, []);

  const openDestination = useCallback(async (target: string | null) => {
    if (!window.logging?.openDestination) {
      return false;
    }
    return window.logging.openDestination(target ?? null);
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
      logSource={logSource}
      onCommitPreferences={commitPreferences}
      onOpenLogDestination={openDestination}
      onResetPreferences={resetPreferences}
      onSelectLogDestination={selectDestination}
      runtime="electron-renderer"
    />
  );
}

async function loadDesktopLogRecords(rendererRecords: readonly LogRecord[]): Promise<LogRecord[]> {
  const getMainRecords = window.logging?.getBufferedLogs;
  if (!getMainRecords) {
    return [
      ...rendererRecords,
      createMainLogSourceDiagnostic('Electron main logging bridge is unavailable.'),
    ];
  }
  try {
    const mainRecords = await getMainRecords();
    return [...rendererRecords, ...mainRecords];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [...rendererRecords, createMainLogSourceDiagnostic(message)];
  }
}

function createMainLogSourceDiagnostic(reason: string): LogRecord {
  return {
    args: [{ reason }],
    bindings: {
      logSource: 'electron-main',
      runtime: 'electron-renderer',
    },
    level: LogLevel.WARN,
    message: 'Electron main logs unavailable',
    scope: 'DesktopLoggingSettings',
    timestamp: Date.now(),
  };
}

export default DesktopLoggingSettings;
