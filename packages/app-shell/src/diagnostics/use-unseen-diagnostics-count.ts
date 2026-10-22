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
 * Reactive count of this launch's diagnostic events recorded after the person
 * last opened the chip (`useDiagnosticsSeenStore.lastSeenAtMs`). The
 * retained diagnostic log is read through the native capability.
 */
export function useUnseenDiagnosticsCount(): UnseenDiagnosticsCountResult {
  const lastSeenAtMs = useDiagnosticsSeenStore((state) => state.lastSeenAtMs);
  return useNativeUnseenDiagnosticsCount(retainedCountsCapability(), lastSeenAtMs);
}
