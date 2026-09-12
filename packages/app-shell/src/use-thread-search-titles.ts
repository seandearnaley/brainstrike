import type { ThreadSearchRepository } from '@brainstrike/db';
import { useEffect, useState } from 'react';
import { useThreadSearchStore } from './thread-search-store';

/** Search results are bounded; resolve their current native identity before labelling them. */
export function useThreadSearchTitles(
  repository: ThreadSearchRepository | null,
  ownerResourceId: string
): ReadonlyMap<string, string> {
  const results = useThreadSearchStore((state) => state.results);
  const [loaded, setLoaded] = useState<{
    readonly results: typeof results;
    readonly ownerResourceId: string;
    readonly titles: ReadonlyMap<string, string>;
  }>();
  useEffect(() => {
    if (!(repository && results)) {
      return;
    }
    let active = true;
    const requestId = useThreadSearchStore.getState().generation;
    repository
      .getNavigationTitles(
        ownerResourceId,
        results.map((result) => result.threadId)
      )
      .then(
        (entries) => {
          if (active) {
            setLoaded({
              ownerResourceId,
              results,
              titles: new Map(
                entries.map((entry) => [
                  entry.threadId,
                  entry.displayName ?? entry.title ?? 'Untitled thread',
                ])
              ),
            });
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
  return loaded?.results === results && loaded.ownerResourceId === ownerResourceId
    ? loaded.titles
    : new Map();
}
