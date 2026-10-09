/**
 * Gap 10: lexical and title search over the host's threads, the host half of
 * the Threads panel's one fused list. The derived state index answers which
 * committed conversation rows match. Search covers every branch, so each
 * thread's committed selected path filters the hits at query time; a match on
 * a sibling branch is not shown. Titles come from the committed presentations.
 */
import { committedRunIdentity } from './committed-identities.js';
import type { HostCore } from './core.js';
import type { HostLogRow, HostParams, HostResults } from './protocol.js';

/** Legacy `ThreadSearchService` pool sizes, per arm. */
const MESSAGE_SOURCE_LIMIT = 50;
const TITLE_SOURCE_LIMIT = 20;

type HostThreadSearchCore = Pick<HostCore, 'listChildren' | 'listThreads' | 'read'>;

/** One committed conversation row the derived state index matched (`searchState`). */
export interface HostStateSearchHit {
  /** bm25: lower is a better match. */
  readonly rank: number;
  readonly role: 'assistant' | 'user';
  readonly runId: string;
  readonly seq: number;
  readonly snippet: string;
  readonly threadId: string;
}

/** The derived state index's search over the requested threads, best match first. */
export type HostStateSearch = (request: {
  readonly limit: number;
  readonly query: string;
  readonly threadIds: readonly string[];
}) => Promise<readonly HostStateSearchHit[]>;

/** Every committed thread and the root it is listed under: a child resolves to its root. */
function ownedThreads(core: HostThreadSearchCore): Map<string, string> {
  const owned = new Map<string, string>();
  const visit = (threadId: string, rootThreadId: string): void => {
    owned.set(threadId, rootThreadId);
    for (const child of core.listChildren(threadId)) {
      visit(child.threadId, rootThreadId);
    }
  };
  for (const { threadId } of core.listThreads()) {
    visit(threadId, threadId);
  }
  return owned;
}

/**
 * A thread's committed selected path: its latest run, the run each user
 * message follows back to the thread root, and the user messages those runs
 * answer. A sibling branch's answer is never on it; a regeneration answers the
 * same user message, so that message stays on it.
 */
function selectedPath(rows: readonly HostLogRow[]): {
  readonly runs: ReadonlySet<string>;
  readonly userMessages: ReadonlySet<string>;
} {
  const runs = new Set<string>();
  const userMessages = new Set<string>();
  const tip = rows.findLast((row) => row.event.type === 'run.started')?.event;
  let runId = tip?.type === 'run.started' ? tip.runId : null;
  while (runId !== null && !runs.has(runId)) {
    const identity = committedRunIdentity(rows, runId);
    runs.add(runId);
    userMessages.add(identity.userMessageId);
    runId = identity.parentMessageId;
  }
  return { runs, userMessages };
}

/** pg_trgm's word trigrams: lower-cased words padded with two spaces before and one after. */
function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      grams.add(padded.slice(index, index + 3));
    }
  }
  return grams;
}

/** pg_trgm `similarity`: shared trigrams over all trigrams, as legacy's title arm ranked. */
function similarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  const shared = [...a].filter((gram) => b.has(gram)).length;
  const total = a.size + b.size - shared;
  return total === 0 ? 0 : shared / total;
}

/** Legacy's title arm: every query word appears in the title, ranked by trigram similarity. */
function titleMatches(
  core: HostThreadSearchCore,
  query: string
): HostResults['thread/search']['titles'] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return core
    .listThreads()
    .flatMap(({ threadId, title }) =>
      title !== undefined && words.every((word) => title.toLowerCase().includes(word))
        ? [{ similarity: similarity(title, query), threadId, title }]
        : []
    )
    .sort((a, b) => b.similarity - a.similarity || a.threadId.localeCompare(b.threadId))
    .slice(0, TITLE_SOURCE_LIMIT);
}

/** The host's message and title arms for one query, best first in each. */
export async function searchHostThreads(
  core: HostThreadSearchCore,
  search: HostStateSearch | undefined,
  params: HostParams<'thread/search'>
): Promise<HostResults['thread/search']> {
  if (!search) {
    throw new Error("Thread search requires the host's state index");
  }
  const owned = ownedThreads(core);
  const hits = await search({
    limit: params.limit ?? MESSAGE_SOURCE_LIMIT,
    query: params.query,
    threadIds: [...owned.keys()],
  });
  const threads = new Map<
    string,
    { readonly path: ReturnType<typeof selectedPath>; readonly rows: HostLogRow[] }
  >();
  const thread = async (threadId: string) => {
    const known = threads.get(threadId);
    if (known) {
      return known;
    }
    const rows = await core.read(threadId, 0);
    const read = { path: selectedPath(rows), rows };
    threads.set(threadId, read);
    return read;
  };
  const messages: HostResults['thread/search']['messages'] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const rootThreadId = owned.get(hit.threadId);
    const { path, rows } = await thread(hit.threadId);
    const row = rows.find(({ seq }) => seq === hit.seq);
    if (rootThreadId === undefined || row?.ts === undefined) {
      continue;
    }
    // The ids the conversation renders: the run's user message, or its answer,
    // which every step of that run shares; its best match stands for it.
    const identity = committedRunIdentity(rows, hit.runId);
    const messageId = hit.role === 'user' ? identity.userMessageId : identity.assistantMessageId;
    const selected =
      hit.role === 'user' ? path.userMessages.has(messageId) : path.runs.has(hit.runId);
    if (!selected || seen.has(messageId)) {
      continue;
    }
    seen.add(messageId);
    messages.push({
      createdAt: row.ts,
      headline: hit.snippet,
      messageId,
      role: hit.role,
      rootThreadId,
      threadId: hit.threadId,
    });
  }
  return { messages, titles: titleMatches(core, params.query) };
}
