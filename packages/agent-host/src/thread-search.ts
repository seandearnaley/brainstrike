/**
 * Gap 10: lexical, semantic and title search over the host's threads, the
 * host half of the Threads panel's one fused list. The derived state index
 * answers which committed conversation rows match, by words or by a query
 * vector the caller embedded. Search covers every branch, so each thread's
 * committed selected path filters the hits at query time; a match on a
 * sibling branch is not shown. Titles come from the committed presentations.
 * BST-1939: the host also fuses the arms into one ranked list of threads.
 */
import { fuseRankedLists, type RankedList } from '@brainstrike/utils/rrf';
import { committedRunIdentity } from './committed-identities.js';
import type { HostCore } from './core.js';
import type { HostLogRow, HostParams, HostResults } from './protocol.js';

/** Legacy `ThreadSearchService` pool sizes, per arm, and its fused list sizes. */
const MESSAGE_SOURCE_LIMIT = 50;
const TITLE_SOURCE_LIMIT = 20;
const THREAD_LIMIT = 20;
const PER_THREAD_MATCH_LIMIT = 3;
/** Legacy `ThreadSearchRepository`'s vector snippet length. */
const SNIPPET_CHARS = 240;

type HostThreadSearchCore = Pick<HostCore, 'listChildren' | 'listThreads' | 'read' | 'threadTimes'>;

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
  /** Every query word (the default) or any one of them. */
  readonly match?: 'all' | 'any';
  readonly query: string;
  readonly threadIds: readonly string[];
}) => Promise<readonly HostStateSearchHit[]>;

/** One row the derived state index found nearest a query vector (`searchStateSimilar`). */
export interface HostStateSimilarHit {
  readonly role: 'assistant' | 'user';
  readonly runId: string;
  /** Cosine similarity: higher is a better match. */
  readonly score: number;
  readonly seq: number;
  readonly text: string;
  readonly threadId: string;
}

/** The semantic arm's index operations; the profile is the caller's embedder identity. */
export interface HostStateSearchVectors {
  coverage(request: {
    readonly profile: Readonly<Record<string, unknown>>;
    readonly threadIds: readonly string[];
  }): Promise<HostResults['thread/search/coverage']>;
  pending(request: {
    readonly limit: number;
    readonly profile: Readonly<Record<string, unknown>>;
    readonly threadIds: readonly string[];
  }): Promise<readonly HostResults['thread/search/pending']['rows'][number][]>;
  put(request: {
    readonly profile: Readonly<Record<string, unknown>>;
    readonly rows: HostParams<'thread/search/vectors'>['rows'];
  }): Promise<HostResults['thread/search/vectors']>;
  similar(request: {
    readonly limit: number;
    readonly profile: Readonly<Record<string, unknown>>;
    readonly threadIds: readonly string[];
    readonly threshold: number;
    readonly vector: readonly number[];
  }): Promise<readonly HostStateSimilarHit[]>;
}

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

/**
 * Legacy's title arm: every query word (or, as the fallback, any word)
 * appears in an admitted root thread's title, ranked by trigram similarity.
 */
function titleMatches(
  core: HostThreadSearchCore,
  owned: ReadonlyMap<string, string>,
  query: string,
  match: 'all' | 'any'
): HostResults['thread/search']['titles'] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const holds = (title: string): boolean =>
    match === 'all'
      ? words.every((word) => title.toLowerCase().includes(word))
      : words.some((word) => title.toLowerCase().includes(word));
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

/**
 * Legacy `ThreadSearchService`'s two-level fusion: each message fuses its
 * lexical and semantic ranks; each root thread then fuses its best message's
 * rank with its title's. Equal weights, k = 60, the lexical headline first.
 */
function fuseResults(
  core: HostThreadSearchCore,
  arms: Pick<HostResults['thread/search'], 'messages' | 'similar' | 'titles'>,
  limit: number
): HostSearchResult[] {
  const found = new Map<string, HostSearchMessage>();
  for (const message of [...arms.messages, ...arms.similar]) {
    if (!found.has(message.messageId)) {
      found.set(message.messageId, message);
    }
  }
  const lexical = new Set(arms.messages.map(({ messageId }) => messageId));
  const semantic = new Set(arms.similar.map(({ messageId }) => messageId));
  const matches = new Map<string, HostSearchResult['matches']>();
  for (const { id, rrfScore } of fuseRankedLists([
    ranked('lexical', [...lexical]),
    ranked('semantic', [...semantic]),
  ])) {
    const message = found.get(id);
    if (!message) {
      continue;
    }
    const sources = [
      ...(lexical.has(id) ? (['lexical'] as const) : []),
      ...(semantic.has(id) ? (['semantic'] as const) : []),
    ];
    matches.set(message.rootThreadId, [
      ...(matches.get(message.rootThreadId) ?? []),
      { ...message, score: rrfScore, sources },
    ]);
  }
  const titled = new Set(arms.titles.map(({ threadId }) => threadId));
  const titles = new Map(
    core.listThreads().flatMap(({ threadId, title }) => (title ? [[threadId, title]] : []))
  );
  // A thread's first fused message is its best: a Map keeps first insertion order.
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
 * The host's lexical, semantic and title arms for one query, best first in
 * each, and their fused list. When neither lexical arm finds every query word,
 * both answer for any word instead, and the result says so.
 */
export async function searchHostThreads(
  core: HostThreadSearchCore,
  search: HostStateSearch | undefined,
  vectors: HostStateSearchVectors | undefined,
  params: HostParams<'thread/search'>
): Promise<HostResults['thread/search']> {
  if (!search) {
    throw new Error("Thread search requires the host's state index");
  }
  if (params.semantic && !vectors) {
    throw new Error("Semantic thread search requires the host's state index vectors");
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
  const [everyWord, nearest] = await Promise.all([
    lexicalArms('all'),
    params.semantic && vectors
      ? vectors.similar({ ...params.semantic, limit, threadIds })
      : Promise.resolve([]),
  ]);
  const anyWord = everyWord.messages.length === 0 && everyWord.titles.length === 0;
  const { messages, titles } = anyWord ? await lexicalArms('any') : everyWord;
  const similar = await selectedMessages(
    core,
    owned,
    window,
    nearest.map((hit) => ({ ...hit, headline: hit.text.slice(0, SNIPPET_CHARS) }))
  );
  return {
    lexical: anyWord ? 'any-word' : 'all-words',
    messages,
    results: fuseResults(core, { messages, similar, titles }, Math.min(limit, THREAD_LIMIT)),
    similar,
    titles,
  };
}

/** The semantic arm's backlog over every host thread, for the caller's embedder. */
export async function pendingHostSearchVectors(
  core: HostThreadSearchCore,
  vectors: HostStateSearchVectors | undefined,
  params: HostParams<'thread/search/pending'>
): Promise<HostResults['thread/search/pending']> {
  if (!vectors) {
    throw new Error("Semantic thread search requires the host's state index vectors");
  }
  const rows = await vectors.pending({ ...params, threadIds: [...ownedThreads(core).keys()] });
  return { rows: [...rows] };
}

/** The semantic arm's coverage of every host thread, for the panel's embedding progress. */
export async function coverageHostSearchVectors(
  core: HostThreadSearchCore,
  vectors: HostStateSearchVectors | undefined,
  params: HostParams<'thread/search/coverage'>
): Promise<HostResults['thread/search/coverage']> {
  if (!vectors) {
    throw new Error("Semantic thread search requires the host's state index vectors");
  }
  return await vectors.coverage({ ...params, threadIds: [...ownedThreads(core).keys()] });
}

/** Stores the caller's vectors for backlog rows; a row that changed since is stale. */
export async function putHostSearchVectors(
  vectors: HostStateSearchVectors | undefined,
  params: HostParams<'thread/search/vectors'>
): Promise<HostResults['thread/search/vectors']> {
  if (!vectors) {
    throw new Error("Semantic thread search requires the host's state index vectors");
  }
  return await vectors.put(params);
}
