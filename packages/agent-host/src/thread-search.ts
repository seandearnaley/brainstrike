/**
 * Search committed messages and titles, fused into one ranked list of root threads.
 * Each thread's selected path filters message hits; titles use committed presentations.
 */
import { fuseRankedLists, type RankedList } from '@brainstrike/utils/rrf';
import { committedRunIdentity } from './committed-identities.ts';
import type { HostCore } from './core.ts';
import type { HostLogRow, HostParams, HostResults } from './protocol.ts';

/** Legacy `ThreadSearchService` pool sizes, per arm, and its fused list sizes. */
const MESSAGE_SOURCE_LIMIT = 50;
const TITLE_SOURCE_LIMIT = 20;
const THREAD_LIMIT = 20;
const PER_THREAD_MATCH_LIMIT = 3;

type HostThreadSearchCore = Pick<HostCore, 'listChildren' | 'listThreads' | 'read' | 'threadTimes'>;

/** One committed conversation row the derived state index matched (`searchState`). */
interface HostStateSearchHit {
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
  /** Every query word (the default) or any one of them. */
  readonly match?: 'all' | 'any';
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

/** Words as the state index's lexical arm reads a query: letter, digit and underscore runs. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/**
 * Legacy's title arm, ranked by trigram similarity: every query word appears
 * in an admitted root thread's title. The any-word fallback matches whole
 * title words, so a one-letter query word does not match every title.
 */
function titleMatches(
  core: HostThreadSearchCore,
  owned: ReadonlyMap<string, string>,
  query: string,
  match: 'all' | 'any'
): HostResults['thread/search']['titles'] {
  const queryWords = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const holds = (title: string): boolean => {
    if (match === 'all') {
      return queryWords.every((word) => title.toLowerCase().includes(word));
    }
    const titleWords = new Set(words(title));
    return words(query).some((word) => titleWords.has(word));
  };
  return core
    .listThreads()
    .flatMap(({ threadId, title }) =>
      owned.get(threadId) === threadId && title !== undefined && holds(title)
        ? [{ similarity: similarity(title, query), threadId, title }]
        : []
    )
    .sort((a, b) => b.similarity - a.similarity || a.threadId.localeCompare(b.threadId))
    .slice(0, TITLE_SOURCE_LIMIT);
}

/** The request's time window, in ms since the epoch. */
interface SearchWindow {
  readonly since: number;
  readonly until: number;
}

/**
 * The threads a request admits, each with its root: a child follows its root
 * thread's workspace binding (operating or secondary root), and each thread
 * must have stored an append inside the window.
 */
function admittedThreads(
  core: HostThreadSearchCore,
  rootId: string | undefined,
  window: SearchWindow
): Map<string, string> {
  const bindings = new Map(core.listThreads().map(({ binding, threadId }) => [threadId, binding]));
  const owned = ownedThreads(core);
  for (const [threadId, rootThreadId] of owned) {
    const binding = bindings.get(rootThreadId);
    const bound =
      rootId === undefined ||
      binding?.operatingRootId === rootId ||
      (binding?.secondaryRootIds ?? []).includes(rootId);
    const { createdAt, updatedAt } = core.threadTimes(threadId);
    if (!bound || updatedAt < window.since || createdAt > window.until) {
      owned.delete(threadId);
    }
  }
  return owned;
}

type HostSearchMessage = HostResults['thread/search']['messages'][number];

/**
 * The index's hits as the messages the conversation renders, best first: each
 * on its thread's committed selected path, a message once, at its best hit.
 */
async function selectedMessages(
  core: HostThreadSearchCore,
  owned: ReadonlyMap<string, string>,
  window: SearchWindow,
  hits: readonly {
    readonly headline: string;
    readonly role: 'assistant' | 'user';
    readonly runId: string;
    readonly seq: number;
    readonly threadId: string;
  }[]
): Promise<HostSearchMessage[]> {
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
  const messages: HostSearchMessage[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const rootThreadId = owned.get(hit.threadId);
    const { path, rows } = await thread(hit.threadId);
    const row = rows.find(({ seq }) => seq === hit.seq);
    if (
      rootThreadId === undefined ||
      row?.ts === undefined ||
      row.ts < window.since ||
      row.ts > window.until
    ) {
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
      headline: hit.headline,
      messageId,
      role: hit.role,
      rootThreadId,
      threadId: hit.threadId,
    });
  }
  return messages;
}

type HostSearchResult = HostResults['thread/search']['results'][number];

/** An arm's ids in its own order, best first, as one reciprocal-rank list. */
function ranked(source: string, ids: readonly string[]): RankedList<string> {
  return { items: ids.map((id) => ({ id })), source };
}

/** Root threads fuse their best message's rank with their title's (k = 60). */
function fuseResults(
  core: HostThreadSearchCore,
  arms: Pick<HostResults['thread/search'], 'messages' | 'titles'>,
  limit: number
): HostSearchResult[] {
  const matches = new Map<string, HostSearchResult['matches']>();
  for (const message of arms.messages) {
    matches.set(message.rootThreadId, [...(matches.get(message.rootThreadId) ?? []), message]);
  }
  const titled = new Set(arms.titles.map(({ threadId }) => threadId));
  const titles = new Map(
    core.listThreads().flatMap(({ threadId, title }) => (title ? [[threadId, title]] : []))
  );
  // Each thread's first message is its best; a Map keeps first insertion order.
  return fuseRankedLists([ranked('content', [...matches.keys()]), ranked('title', [...titled])], {
    limit,
  }).map(({ id, rrfScore }) => {
    const title = titles.get(id);
    return {
      matches: (matches.get(id) ?? []).slice(0, PER_THREAD_MATCH_LIMIT),
      score: rrfScore,
      threadId: id,
      ...(title === undefined ? {} : { title }),
      titleMatched: titled.has(id),
    };
  });
}

/**
 * Message and title arms, best first, and their fused list. When neither finds
 * every query word, both answer for any word and the result says so.
 */
export async function searchHostThreads(
  core: HostThreadSearchCore,
  search: HostStateSearch | undefined,
  params: HostParams<'thread/search'>
): Promise<HostResults['thread/search']> {
  if (!search) {
    throw new Error("Thread search requires the host's state index");
  }
  const window = { since: params.since ?? 0, until: params.until ?? Number.POSITIVE_INFINITY };
  const owned = admittedThreads(core, params.rootId, window);
  const threadIds = [...owned.keys()];
  const limit = params.limit ?? MESSAGE_SOURCE_LIMIT;
  const lexicalArms = async (match: 'all' | 'any') => {
    const hits = await search({ limit, match, query: params.query, threadIds });
    return {
      messages: await selectedMessages(
        core,
        owned,
        window,
        hits.map((hit) => ({ ...hit, headline: hit.snippet }))
      ),
      titles: titleMatches(core, owned, params.query, match),
    };
  };
  const everyWord = await lexicalArms('all');
  const relaxed =
    everyWord.messages.length === 0 && everyWord.titles.length === 0
      ? await lexicalArms('any')
      : undefined;
  // `any-word` reports a relaxation that found something; finding nothing changes nothing.
  const anyWord =
    relaxed !== undefined && (relaxed.messages.length > 0 || relaxed.titles.length > 0);
  const { messages, titles } = relaxed ?? everyWord;
  return {
    lexical: anyWord ? 'any-word' : 'all-words',
    messages,
    results: fuseResults(core, { messages, titles }, Math.min(limit, THREAD_LIMIT)),
    titles,
  };
}
