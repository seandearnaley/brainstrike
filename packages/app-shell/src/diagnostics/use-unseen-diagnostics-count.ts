import { useDiagnosticsSeenStore } from './diagnostics-seen-store';
import {
  retainedCountsCapability,
  useNativeUnseenDiagnosticsCount,
} from './use-native-unseen-diagnostics-count';

export interface UnseenDiagnosticsCountResult {
  readonly error: Error | null;
  readonly errorCount: number;
  readonly warningCount: number;
}

/**
 * Reactive count of diagnostic events recorded since the session watermark
 * (`useDiagnosticsSeenStore.lastSeenAtMs`), backing the status-bar chip. The
 * retained diagnostic log is read through the native capability.
 */
export function useUnseenDiagnosticsCount(): UnseenDiagnosticsCountResult {
  const lastSeenAtMs = useDiagnosticsSeenStore((state) => state.lastSeenAtMs);
  return useNativeUnseenDiagnosticsCount(retainedCountsCapability(), lastSeenAtMs);
}
