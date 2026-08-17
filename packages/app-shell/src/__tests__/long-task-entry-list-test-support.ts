interface RecentPerformanceEntryInit {
  readonly duration: number;
  /** Defaults to 'longtask'; set it to exercise the entry-type filter. */
  readonly entryType?: string;
}

const DEFAULT_START_OFFSET_MS = 100;

/**
 * Builds a PerformanceObserverEntryList whose entries started `startOffsetMs`
 * ago, sampling the clock ONCE here rather than inside getEntries().
 *
 * recordPerformanceEntries() reads its own `performance.now()` into elapsedMs
 * before it calls getEntries(), and preparePerformanceEntry rejects any entry
 * completing more than PERFORMANCE_ENTRY_COMPLETION_TOLERANCE_MS (1ms) after
 * that read. A fixture that computed startTime lazily inside getEntries would
 * therefore sample a strictly later clock, and once scheduling delay pushed the
 * two reads apart the entry looked "completed after delivery" — latching
 * availability = 'failed' with no metric recorded.
 *
 * Sampling at construction makes that ordering structural: the argument is
 * evaluated before the observer callback runs, so the entry's completion time
 * stays at or before elapsedMs no matter how long delivery is delayed.
 */
export function createRecentLongTaskEntryList(
  entries: readonly RecentPerformanceEntryInit[],
  startOffsetMs: number = DEFAULT_START_OFFSET_MS
): PerformanceObserverEntryList {
  const startTime = performance.now() - startOffsetMs;
  const performanceEntries = entries.map(
    ({ duration, entryType = 'longtask' }) =>
      ({ duration, entryType, startTime }) as PerformanceEntry
  );
  return { getEntries: () => performanceEntries } as PerformanceObserverEntryList;
}
