// BST-568 slice 3: per-root watcher health for Explorer UI.
//
// Capability-gated: adapters without `onWatcherHealth` (web today) yield an
// empty map and an 'unsupported' retry outcome — the UI renders nothing.
import type { WatcherRetryOutcome, WatcherRootHealthEvent } from '@brainstrike/types';
import { useCallback, useEffect, useState } from 'react';
import { useAdapters } from './adapters-context';

export interface WatcherHealthApi {
  /** Latest health transition per watched root path. */
  healthByRoot: ReadonlyMap<string, WatcherRootHealthEvent>;
  /** Deliberate manual retry of a failed watcher. */
  retry: (rootPath: string) => Promise<WatcherRetryOutcome>;
}

export function useWatcherHealth(): WatcherHealthApi {
  const { fileSystemAdapter } = useAdapters();
  const [healthByRoot, setHealthByRoot] = useState<ReadonlyMap<string, WatcherRootHealthEvent>>(
    () => new Map()
  );

  useEffect(() => {
    const subscribe = fileSystemAdapter.onWatcherHealth?.bind(fileSystemAdapter);
    if (!subscribe) {
      return;
    }
    const unsubscribe = subscribe((event) => {
      setHealthByRoot((previous) => {
        const next = new Map(previous);
        next.set(event.rootPath, event);
        return next;
      });
    });
    return unsubscribe;
  }, [fileSystemAdapter]);

  const retry = useCallback(
    async (rootPath: string): Promise<WatcherRetryOutcome> => {
      if (!fileSystemAdapter.retryWatcher) {
        return { reason: 'unsupported', retried: false };
      }
      return await fileSystemAdapter.retryWatcher(rootPath);
    },
    [fileSystemAdapter]
  );

  return { healthByRoot, retry };
}
