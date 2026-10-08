import type { ThreadSearchResultItem } from '@brainstrike/db';
import type { AssistantThreadHistoryHit } from './assistant-thread-host-context';

/** Matches kept per host thread, like the history search service's per-thread cap. */
const HOST_MATCHES_PER_THREAD = 3;

/**
 * Host history hits as thread search results: one result per thread in the
 * order of its best hit, dated by the matched row's committed time. The host
 * ranks by order and reports no score, so scores are 0 rather than invented.
 */
export function hostHistoryResults(
  hits: readonly AssistantThreadHistoryHit[]
): ThreadSearchResultItem[] {
  const byThread = new Map<string, ThreadSearchResultItem>();
  for (const hit of hits) {
    let result = byThread.get(hit.threadId);
    if (!result) {
      result = {
        matches: [],
        score: 0,
        threadId: hit.threadId,
        title: null,
        titleMatched: false,
      };
      byThread.set(hit.threadId, result);
    }
    if (result.matches.length < HOST_MATCHES_PER_THREAD) {
      result.matches.push({
        headline: hit.snippet,
        messageCreatedAt: new Date(hit.ts),
        messageId: `${hit.threadId}:${hit.seq}`,
        role: 'history',
        rrfScore: 0,
        sources: ['fts'],
      });
    }
  }
  return [...byThread.values()];
}
