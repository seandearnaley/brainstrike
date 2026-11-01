/**
 * ADR-0035: the Explorer's Search tab, served by the agent host. One live text
 * search over every root the host's registry holds live, through the same
 * streaming ripgrep core the agent's grepSearch runs (`live-grep.ts`): the same
 * entry policy, agent ignore files, credential floor and caps. Each root is
 * borrowed through its pinned handle for the whole search, so the registry
 * cannot close a folder under it, and the search reads that root's canonical
 * path. Matches stream to the caller in batches as ripgrep finds them.
 */
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import type { FileSearchBatch, HostFileSearch, HostResults } from '@brainstrike/agent-host';
import type { GrepMatch } from '@brainstrike/assistant-contract';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { createGrepLineMatcher, type LineMatcher } from '@brainstrike/utils/grep-line-matcher';
import { streamLiveGrep } from '../native-tools/live-grep.ts';
import type { LiveRoot, PinnedRoot, WorkspaceRootPins } from './root-pins.ts';

/** The most matches one search returns; past it the search stops and says so. */
export const FILE_SEARCH_MATCH_LIMIT = 5000;
/** The longest line a match carries; the Explorer shows one line per row. */
const MAX_LINE_TEXT = 1000;
/** Batches after the first coalesce for this long, so a burst is one notification. */
const BATCH_INTERVAL_MS = 16;

export interface HostFileSearchOptions {
  readonly pins: WorkspaceRootPins;
}

type SearchParams = Parameters<HostFileSearch['search']>[0];
type SearchResult = HostResults['workspace/files/search'];
type WireMatch = FileSearchBatch['matches'][number];

/** Whole word wraps the pattern in word boundaries, which makes it a regex. */
function searchPattern(params: SearchParams): { isRegex: boolean; pattern: string } {
  if (!params.wholeWord) {
    return { isRegex: params.isRegex, pattern: params.query };
  }
  const source = params.isRegex
    ? `(?:${params.query})`
    : params.query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return { isRegex: true, pattern: `\\b${source}\\b` };
}

/** The user's own pattern is the only thing the matcher refuses, so it is an input refusal. */
function searchMatcher(pattern: string, isRegex: boolean, caseSensitive: boolean): LineMatcher {
  try {
    return createGrepLineMatcher(pattern, isRegex, caseSensitive);
  } catch (error) {
    throw refusalError(
      'input',
      'workspace.search-pattern-invalid',
      error instanceof Error ? error.message : String(error),
      'Correct the pattern, or turn off regular expressions.'
    );
  }
}

/**
 * Borrows every live root's pinned handle and runs `use` while all are held.
 * A root that left between the listing and its borrow is simply not searched.
 */
async function withPinnedRoots<T>(
  pins: WorkspaceRootPins,
  live: readonly LiveRoot[],
  use: (pinned: readonly PinnedRoot[]) => Promise<T>,
  held: readonly PinnedRoot[] = []
): Promise<T> {
  const [next, ...rest] = live;
  if (!next) {
    return await use(held);
  }
  let entered = false;
  try {
    return await pins.use(next, async (pinned) => {
      entered = true;
      return await withPinnedRoots(pins, rest, use, [...held, pinned]);
    });
  } catch (cause) {
    if (entered) {
      throw cause;
    }
    return await withPinnedRoots(pins, rest, use, held);
  }
}

function toRuntimeRoot(pinned: PinnedRoot): RuntimeWorkspaceRoot {
  return {
    displayName: path.basename(pinned.presentationPath) || pinned.presentationPath,
    path: pinned.canonicalPath,
    rootId: pinned.rootId,
  };
}

function toWireMatch(match: GrepMatch): WireMatch {
  return {
    line: match.line,
    lineText:
      match.lineText.length > MAX_LINE_TEXT
        ? match.lineText.slice(0, MAX_LINE_TEXT)
        : match.lineText,
    path: match.path,
    rootId: match.rootId ?? '',
  };
}

/** Coalesces matches into batches: the first goes out at once, later ones per interval. */
function createBatcher(send: (matches: WireMatch[]) => void) {
  let pending: WireMatch[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sentFirst = false;
  const flush = (): void => {
    timer = undefined;
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    sentFirst = true;
    send(batch);
  };
  return {
    add(matches: readonly WireMatch[]): void {
      pending.push(...matches);
      if (!sentFirst) {
        flush();
        return;
      }
      timer ??= setTimeout(flush, BATCH_INTERVAL_MS);
    },
    /** Drops what is pending: the caller has gone. */
    discard(): void {
      clearTimeout(timer);
      timer = undefined;
      pending = [];
    },
    /** Sends what is pending now. */
    finish(): void {
      clearTimeout(timer);
      flush();
    },
  };
}

export function createHostFileSearch(options: HostFileSearchOptions): HostFileSearch {
  const { pins } = options;
  return {
    search: async (params, signal, send) => {
      const { isRegex, pattern } = searchPattern(params);
      const matcher = searchMatcher(pattern, isRegex, params.caseSensitive);
      const live = await pins.liveRoots();
      if (live.length === 0) {
        throw refusalError(
          'configuration',
          'workspace.search-no-folder',
          'No folder is open, so there is nothing to search.',
          'Open a folder, then search again.'
        );
      }
      // The match cap ends the search the way the client's cancellation does.
      const limit = new AbortController();
      const ended = AbortSignal.any([signal, limit.signal]);
      const batcher = createBatcher(send);
      let matches = 0;
      let matchLimitReached = false;
      const onMatches = (found: readonly GrepMatch[]): void => {
        const kept = found.slice(0, FILE_SEARCH_MATCH_LIMIT - matches);
        matches += kept.length;
        batcher.add(kept.map(toWireMatch));
        if (matches >= FILE_SEARCH_MATCH_LIMIT) {
          matchLimitReached = true;
          limit.abort();
        }
      };
      try {
        const outcome = await withPinnedRoots(pins, live, async (pinned) => {
          if (pinned.length === 0) {
            throw refusalError(
              'availability',
              'workspace.search-no-folder',
              'The open folders are not available.',
              'Reconnect the folder and retry.'
            );
          }
          try {
            return await streamLiveGrep(
              {
                caseSensitive: params.caseSensitive,
                contextLines: 0,
                isRegex,
                pattern,
                roots: pinned.map(toRuntimeRoot),
                signal: ended,
              },
              matcher,
              onMatches
            );
          } catch (cause) {
            if (limit.signal.aborted && !signal.aborted) {
              return;
            }
            throw cause;
          }
        });
        signal.throwIfAborted();
        batcher.finish();
        const result: SearchResult = {
          candidatesTruncated: outcome?.candidatesTruncated ?? false,
          matches,
          matchLimitReached,
          scanLimited: outcome?.scanLimited ?? false,
          timedOut: outcome?.timedOut ?? false,
          unreadableRootIds: outcome?.unreadableRoots.map((root) => root.rootId) ?? [],
        };
        return result;
      } catch (cause) {
        batcher.discard();
        throw cause;
      }
    },
  };
}
