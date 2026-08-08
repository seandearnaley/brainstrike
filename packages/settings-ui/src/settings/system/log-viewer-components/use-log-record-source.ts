import type { LogRecord } from '@brainstrike/logging';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useEffect } from 'react';
import type { LogSourceAdapter } from './log-source-adapter';

const LOG_SUBSCRIPTION_DEBOUNCE_MS = 100;

interface UseLogRecordSourceOptions {
  readonly applyRetentionLimit: (records: readonly LogRecord[]) => readonly LogRecord[];
  readonly logSource: LogSourceAdapter | undefined;
  readonly onLoadingChange: (loading: boolean) => void;
  readonly onRecordsChange: (records: readonly LogRecord[]) => void;
  readonly toast: ReturnType<typeof useToast>['toast'];
}

export function useLogRecordSource({
  applyRetentionLimit,
  logSource,
  onLoadingChange,
  onRecordsChange,
  toast,
}: UseLogRecordSourceOptions): { readonly refreshLogs: () => Promise<void> } {
  useEffect(() => {
    if (!logSource) {
      onRecordsChange([]);
      return;
    }
    let cancelled = false;
    let pendingSubscriptionRecords: readonly LogRecord[] | null = null;
    let subscriptionTimerId: number | null = null;

    if (logSource.getInitialRecords) {
      onLoadingChange(true);
      logSource
        .getInitialRecords()
        .then((initial) => {
          if (!(cancelled || !initial)) {
            onRecordsChange(applyRetentionLimit(initial));
          }
        })
        .catch((error: unknown) => {
          toast({
            description: error instanceof Error ? error.message : String(error),
            title: 'Failed to load logs',
            variant: 'destructive',
          });
        })
        .finally(() => {
          if (!cancelled) {
            onLoadingChange(false);
          }
        });
    }

    const unsubscribe = logSource.subscribe?.((records) => {
      pendingSubscriptionRecords = records;
      if (subscriptionTimerId !== null) {
        window.clearTimeout(subscriptionTimerId);
      }
      subscriptionTimerId = window.setTimeout(() => {
        subscriptionTimerId = null;
        const pendingRecords = pendingSubscriptionRecords;
        pendingSubscriptionRecords = null;
        if (!(cancelled || pendingRecords === null)) {
          onRecordsChange(applyRetentionLimit(pendingRecords));
        }
      }, LOG_SUBSCRIPTION_DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      if (subscriptionTimerId !== null) {
        window.clearTimeout(subscriptionTimerId);
      }
      unsubscribe?.();
    };
  }, [applyRetentionLimit, logSource, onLoadingChange, onRecordsChange, toast]);

  const refreshLogs = useCallback(async () => {
    const getInitialRecords = logSource?.getInitialRecords;
    if (!getInitialRecords) {
      return;
    }
    onLoadingChange(true);
    try {
      const records = await getInitialRecords();
      onRecordsChange(applyRetentionLimit(records));
      onLoadingChange(false);
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : String(error),
        title: 'Failed to refresh logs',
        variant: 'destructive',
      });
      onLoadingChange(false);
    }
  }, [applyRetentionLimit, logSource, onLoadingChange, onRecordsChange, toast]);

  return { refreshLogs };
}
