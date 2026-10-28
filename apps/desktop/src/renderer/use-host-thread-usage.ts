import {
  type CumulativeUsageDisplay,
  EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY,
  resolveCumulativeUsageDisplay,
} from '@brainstrike/assistant-data';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { HostThreadLedger } from './host-thread-ledger';

/**
 * The context meter's thread total over the host's committed provider calls.
 * Undefined until the ledger has read the thread, so the meter keeps its
 * context fraction rather than showing a total it has not read.
 */
export function useHostThreadUsage(
  ledger: HostThreadLedger,
  threadId: string
): CumulativeUsageDisplay | undefined {
  const read = useCallback(() => ledger.getThreadUsage(threadId), [ledger, threadId]);
  const usage = useSyncExternalStore(ledger.subscribe, read, read);
  return useMemo(
    () =>
      usage === undefined
        ? undefined
        : // A read thread with no costed call yet is the honest zero baseline.
          (resolveCumulativeUsageDisplay(usage.perModel.length > 0 ? usage : null) ??
          EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY),
    [usage]
  );
}
