import {
  LoggingSettingsSection,
  type LoggingSettingsSectionProps,
  useLoggingPreferencesStore,
} from '@brainstrike/preferences';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useToast,
} from '@brainstrike/ui';
import type { LoggingPreferences } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LoggingSettingsPayload } from '../../../logging-shared';
import { getRendererLogBuffer } from '../../log-buffer';

export function DesktopLoggingSettings() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileCapabilities, setFileCapabilities] =
    useState<LoggingSettingsSectionProps['fileCapabilities']>();
  const { toast } = useToast();

  const setPreferences = useLoggingPreferencesStore((state) => state.setPreferences);
  const logSource = useMemo<LoggingSettingsSectionProps['logSource']>(() => {
    const buffer = getRendererLogBuffer();
    return {
      getInitialRecords: async () => {
        const rendererRecords = buffer.getRecords();
        if (!window.logging?.getBufferedLogs) {
          return rendererRecords;
        }
        try {
          const mainRecords = await window.logging.getBufferedLogs();
          return [...rendererRecords, ...mainRecords];
        } catch {
          return rendererRecords;
        }
      },
      subscribe: (handler) => buffer.subscribe(handler),
    };
  }, []);

  const mapPayload = useCallback(
    (payload: LoggingSettingsPayload) => {
      setPreferences(payload.preferences);
      setFileCapabilities({
        fileLoggingSupported: payload.capabilities.fileLoggingSupported,
        canSelectDestination: payload.capabilities.canSelectDestination,
        reason: payload.capabilities.reason,
        defaultDestination: payload.capabilities.defaultDestination,
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
      setError(null);
      setLoading(false);
    };

    const finishWithError = (err: unknown) => {
      if (cancelled) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
    };

    const fetchPreferences = async () => {
      try {
        const response = await window.logging?.getPreferences?.();
        if (!response) {
          throw new Error('Logging bridge is unavailable in this build.');
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
      setSyncing(true);
      try {
        const updated = await window.logging.setPreferences(preferences);
        mapPayload(updated);
        return updated.preferences;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast({
          title: 'Failed to persist logging preferences',
          description: message,
          variant: 'destructive',
        });
        throw err;
      } finally {
        setSyncing(false);
      }
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

export default DesktopLoggingSettings;
