import { useEffect, useState } from 'react';
import type { UnseenDiagnosticsCountResult } from './use-unseen-diagnostics-count';

interface DiagnosticCounts {
  readonly errorCount: number;
  readonly warningCount: number;
}
interface RetainedCountsCapability {
  getUnseenCounts(sinceMs: number): Promise<DiagnosticCounts>;
}
interface DurableLogNotifications {
  onDurableRecord(listener: () => void): () => void;
}
const EMPTY: UnseenDiagnosticsCountResult = { error: null, errorCount: 0, warningCount: 0 };

export function retainedCountsCapability(): RetainedCountsCapability | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as Window & { desktopDiagnostics?: RetainedCountsCapability }).desktopDiagnostics;
}

/** The existing durable-write notification invalidates this retained-log projection. */
export function useNativeUnseenDiagnosticsCount(
  reader: RetainedCountsCapability | undefined,
  sinceMs: number
): UnseenDiagnosticsCountResult {
  const [result, setResult] = useState<UnseenDiagnosticsCountResult>(EMPTY);
  useEffect(() => {
    if (!reader) {
      return;
    }
    let active = true;
    let request = 0;
    const refresh = (): void => {
      const current = ++request;
      void reader.getUnseenCounts(sinceMs).then(
        (counts) => {
          if (active && request === current) {
            setResult({ ...counts, error: null });
          }
        },
        (cause: unknown) => {
          if (active && request === current) {
            setResult({
              ...EMPTY,
              error: cause instanceof Error ? cause : new Error(String(cause)),
            });
          }
        }
      );
    };
    const notifications = (window as Window & { logging?: DurableLogNotifications }).logging;
    if (!notifications) {
      throw new Error('The native diagnostic reader requires durable log notifications');
    }
    const unsubscribe = notifications.onDurableRecord(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [reader, sinceMs]);
  return result;
}
