import type { ThreadSearchRepository } from '@brainstrike/db';
import { useEffect, useState } from 'react';
import type { AssistantThreadHostCapability } from './assistant-thread-host-context';
import { useThreadSearchStore } from './thread-search-store';

/** Search results are bounded; resolve their current native identity before labelling them. */
export function useThreadSearchTitles(
  repository: ThreadSearchRepository | null,
  ownerResourceId: string,
  host?: AssistantThreadHostCapability
): ReadonlyMap<string, string> {
  const results = useThreadSearchStore((state) => state.results);
  const [loaded, setLoaded] = useState<{
    readonly results: typeof results;
    readonly ownerResourceId: string;
    readonly titles: ReadonlyMap<string, string>;
  }>();
  useEffect(() => {
    if (!((repository || host) && results)) {
      return;
    }
    let active = true;
    const requestId = useThreadSearchStore.getState().generation;
    (host
      ? host.listThreads(ownerResourceId).then(async (threads) => {
          const byId = new Map(threads.map((thread) => [thread.id, thread]));
          return await Promise.all(
            results.map(async (result) => {
              const thread = byId.get(result.threadId);
              if (thread) {
                return {
                  displayName: null,
                  threadId: thread.id,
                  title: thread.title,
                };
              }
              if (!host.resolveChildThread) {
                throw new Error('Search result conversation unavailable');
              }
              const child = await host.resolveChildThread(result.threadId);
              return { displayName: child.callSign, threadId: child.threadId, title: null };
            })
          );
        })
      : repository
        ? repository.getNavigationTitles(
            ownerResourceId,
            results.map((result) => result.threadId)
          )
        : Promise.reject(new Error('Thread search owner unavailable'))
    ).then(
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
  }, [host, ownerResourceId, repository, results]);
  return loaded?.results === results && loaded.ownerResourceId === ownerResourceId
    ? loaded.titles
    : new Map();
}
