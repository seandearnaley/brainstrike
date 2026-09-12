import type { ThreadSearchRepository } from '@brainstrike/db';
import { useEffect, useState } from 'react';
import { useThreadSearchStore } from './thread-search-store';

/** Search results are bounded; resolve their current native identity before labelling them. */
export function useThreadSearchTitles(
  repository: ThreadSearchRepository | null,
  ownerResourceId: string
) {
  const results = useThreadSearchStore((state) => state.results);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let active = true;
    if (!(repository && results)) {
      setTitles(new Map());
      return;
    }
    const requestId = useThreadSearchStore.getState().generation;
    Promise.all(
      results.map(async (result): Promise<readonly [string, string]> => {
        const target = await repository.getNavigationTarget(ownerResourceId, result.threadId);
        return [
          result.threadId,
          target
            ? (target.displayName ?? target.title ?? 'Untitled thread')
            : 'Unavailable conversation',
        ];
      })
    ).then(
      (entries) => {
        if (active) {
          setTitles(new Map(entries));
        }
      },
      (error: unknown) => {
        if (active) {
          useThreadSearchStore
            .getState()
            .failSearch(error instanceof Error ? error.message : String(error), requestId);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [ownerResourceId, repository, results]);
  return titles;
}
