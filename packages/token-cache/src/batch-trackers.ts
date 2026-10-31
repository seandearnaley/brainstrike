/** One `indexFiles` call, settled once every file it queued has a result. */
export interface PendingBatchTracker {
  done: boolean;
  reject: (error: Error) => void;
  remainingCompositeKeys: Set<string>;
  resolve: () => void;
}

/** Records a file's result; resolves the trackers it completes and returns the rest. */
export function settleBatchTrackers(
  trackers: readonly PendingBatchTracker[],
  compositeKey: string
): PendingBatchTracker[] {
  const remainingTrackers: PendingBatchTracker[] = [];
  for (const tracker of trackers) {
    if (tracker.done) {
      continue;
    }

    tracker.remainingCompositeKeys.delete(compositeKey);
    if (tracker.remainingCompositeKeys.size === 0) {
      tracker.done = true;
      tracker.resolve();
    } else {
      remainingTrackers.push(tracker);
    }
  }
  return remainingTrackers;
}

/** Rejects every tracker not already settled. */
export function rejectBatchTrackers(trackers: readonly PendingBatchTracker[], error: Error): void {
  for (const tracker of trackers) {
    if (tracker.done) {
      continue;
    }
    tracker.done = true;
    tracker.reject(error);
  }
}
