/**
 * BST-1939: host history search fuses its arms into one ranked thread list,
 * relaxes to any word only when every-word finds nothing, and scopes by
 * workspace root and time. Recorded runs (fresh data root) replay through the
 * real StateStore, native state index and Core; judgments were frozen first.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { runHostCli } from '../src/cli.js';
import { committedRunIdentity } from '../src/committed-identities.js';
import { HostCore } from '../src/core.js';
import { storedHostEvent } from '../src/event-storage.js';
import { HOST_RESULT_SCHEMAS, type HostLogRow, HostLogRowSchema } from '../src/protocol.js';
import { startAgentHost } from '../src/runtime.js';
import { searchHostThreads } from '../src/thread-search.js';
import { fixturePlatform } from './fixtures/child-run-host.js';
import history from './fixtures/committed-history-search.json' with { type: 'json' };
import judgments from './fixtures/history-search-judgments.json' with { type: 'json' };

const recorded = z.array(HostLogRowSchema).parse(history);
const threadIds = [...new Set(recorded.map(({ threadId }) => threadId))];
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
type Port = Awaited<ReturnType<typeof openIndexer>>;
type SearchResult = Awaited<ReturnType<typeof searchHostThreads>>;

let root: string;
let port: Port;
let store: StateStore;
let core: HostCore;
/** Until the CLI case hands the Root to a host, the replay's own Core owns it. */
let coreOwnsRoot = true;

/** Replays each recorded thread in its own append, so their store times differ. */
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m6-history-fusion-')));
  port = await openIndexer(
    {
      dbPath: join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: [root],
      stateProjection: {
        mode: 'dev',
        module: new URL('../dist/state-projection.js', import.meta.url).href,
      },
      stateRoot: root,
    },
    deadlines
  );
  store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  for (const threadId of threadIds) {
    await store.append(
      recorded
        .filter((row) => row.threadId === threadId)
        .map((row) => storedHostEvent(row.threadId, row.event))
    );
    await delay(25);
  }
  await port.catchUpState(threadIds);
  core = await HostCore.open(
    store,
    {
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      validateWorkspaceBinding: async () => undefined,
    },
    () => () => undefined
  );
}, 60_000);

afterAll(async () => {
  if (coreOwnsRoot) {
    await core?.close();
    await store?.close();
  }
  await port?.close();
  await rm(root, { force: true, recursive: true });
});

const search = (params: Parameters<typeof searchHostThreads>[3]): Promise<SearchResult> =>
  searchHostThreads(core, (request) => port.searchState(request), undefined, params);

function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  const index = ranked.findIndex((id) => relevant.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

function recallAt(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const top = new Set(ranked.slice(0, k));
  return [...relevant].filter((id) => top.has(id)).length / relevant.size;
}

/** The message a judged row belongs to: the run's user message, or its answer. */
async function judgedMessage(threadId: string, seq: number): Promise<string> {
  const rows: HostLogRow[] = await core.read(threadId, 0);
  const event = rows.find((row) => row.seq === seq)?.event;
  if (!(event && 'runId' in event)) {
    throw new Error(`Judged row ${threadId}:${seq} has no run`);
  }
  const identity = committedRunIdentity(rows, event.runId);
  return event.type === 'run.started' ? identity.userMessageId : identity.assistantMessageId;
}

describe('fused history search', () => {
  test('ranks judged threads and messages at least as well as the best single arm', async () => {
    const totals = {
      fused: { messageRecall5: 0, mrr: 0, recall3: 0 },
      lexical: { messageRecall5: 0, mrr: 0, recall3: 0 },
      titles: { mrr: 0, recall3: 0 },
    };
    for (const judged of judgments.queries) {
      const result = await search({ query: judged.query });
      const threads = new Set(judged.relevant.map(({ threadId }) => threadId));
      const messages = new Set(
        await Promise.all(judged.relevant.map(({ seq, threadId }) => judgedMessage(threadId, seq)))
      );
      const lexicalThreads = [...new Set(result.messages.map(({ rootThreadId }) => rootThreadId))];
      const titleThreads = result.titles.map(({ threadId }) => threadId);
      const fusedThreads = result.results.map(({ threadId }) => threadId);
      totals.lexical.mrr += reciprocalRank(lexicalThreads, threads);
      totals.lexical.recall3 += recallAt(lexicalThreads, threads, 3);
      totals.titles.mrr += reciprocalRank(titleThreads, threads);
      totals.titles.recall3 += recallAt(titleThreads, threads, 3);
      totals.fused.mrr += reciprocalRank(fusedThreads, threads);
      totals.fused.recall3 += recallAt(fusedThreads, threads, 3);
      totals.lexical.messageRecall5 += recallAt(
        result.messages.map(({ messageId }) => messageId),
        messages,
        5
      );
      totals.fused.messageRecall5 += recallAt(
        result.results.flatMap(({ matches }) => matches.map(({ messageId }) => messageId)),
        messages,
        5
      );
    }
    const mean = (value: number): number => value / judgments.queries.length;
    const report = {
      fused: {
        messageRecall5: mean(totals.fused.messageRecall5),
        mrr: mean(totals.fused.mrr),
        recall3: mean(totals.fused.recall3),
      },
      lexical: {
        messageRecall5: mean(totals.lexical.messageRecall5),
        mrr: mean(totals.lexical.mrr),
        recall3: mean(totals.lexical.recall3),
      },
      titles: { mrr: mean(totals.titles.mrr), recall3: mean(totals.titles.recall3) },
    };
    expect(report.fused.mrr).toBeGreaterThanOrEqual(
      Math.max(report.lexical.mrr, report.titles.mrr)
    );
    expect(report.fused.recall3).toBeGreaterThanOrEqual(
      Math.max(report.lexical.recall3, report.titles.recall3)
    );
    expect(report.fused.messageRecall5).toBeGreaterThanOrEqual(report.lexical.messageRecall5);
    // The fused list is the panel's list: one entry per root thread, best first.
    for (const judged of judgments.queries) {
      const { results } = await search({ query: judged.query });
      expect(new Set(results.map(({ threadId }) => threadId)).size).toBe(results.length);
      expect(results.map(({ score }) => score)).toEqual(
        [...results.map(({ score }) => score)].sort((a, b) => b - a)
      );
    }
  });

  test('matches any word only when no message or title holds every word, and says so', async () => {
    const every = await search({ query: 'notarytool' });
    expect(every.lexical).toBe('all-words');
    const any = await search({ query: 'release stapler' });
    expect(any.lexical).toBe('any-word');
    expect(any.messages.length).toBeGreaterThan(0);
    expect(any.results[0]).toMatchObject({
      threadId: '854d96a7-d175-401e-bba5-9ef6dc3335fa',
      title: 'Release signing checklist',
      titleMatched: true,
    });
    // Nothing matched at all: the every-word result stands, with no relaxation to report.
    const nothing = await search({ query: 'zeppelin quasar' });
    expect(nothing).toMatchObject({ lexical: 'all-words', messages: [], results: [], titles: [] });
  });

  test('matches any word against whole title words, not letters inside them', async () => {
    // Smoke of #3566: "zeppelin e" listed every title holding the letter e.
    const letter = await search({ query: 'zeppelin e' });
    expect(letter).toMatchObject({ messages: [], results: [], titles: [] });
    const word = await search({ query: 'zeppelin kitchen' });
    expect(word.lexical).toBe('any-word');
    expect(word.titles.map(({ title }) => title)).toEqual(['Kitchen renovation budget']);
    // Every word still matches inside a title word, as before.
    expect((await search({ query: 'renov' })).titles.map(({ title }) => title)).toEqual([
      'Kitchen renovation budget',
    ]);
  });

  test('keeps only threads bound to the requested workspace root', async () => {
    const release = '854d96a7-d175-401e-bba5-9ef6dc3335fa';
    await core.updateWorkspaceBinding({
      commandId: randomUUID(),
      patch: { operatingRootDisplayName: 'Release', operatingRootId: 'release-root' },
      threadId: release,
    });
    const all = await search({ query: 'notarytool' });
    expect(new Set(all.results.map(({ threadId }) => threadId)).size).toBe(2);
    const bound = await search({ query: 'notarytool', rootId: 'release-root' });
    expect(bound.results.map(({ threadId }) => threadId)).toEqual([release]);
    expect(bound.messages.every(({ rootThreadId }) => rootThreadId === release)).toBe(true);
    expect(await search({ query: 'notarytool', rootId: 'other-root' })).toMatchObject({
      messages: [],
      results: [],
      titles: [],
    });
  });

  test('keeps messages and titles inside the requested time window', async () => {
    const release = '854d96a7-d175-401e-bba5-9ef6dc3335fa';
    const untitled = '6a417da2-0612-44d5-98da-9a867f9545dd';
    // The replayed rows only: the root-binding case appended to the release thread since.
    const replayed = (rows: readonly HostLogRow[]) =>
      rows.filter((row) =>
        recorded.some(({ seq, threadId }) => seq === row.seq && threadId === row.threadId)
      );
    const releaseRows = replayed(await core.read(release, 0));
    const untitledRows = replayed(await core.read(untitled, 0));
    const releaseEnd = Math.max(...releaseRows.map(({ ts }) => ts ?? 0));
    const untitledStart = Math.min(...untitledRows.map(({ ts }) => ts ?? Number.MAX_VALUE));
    expect(untitledStart).toBeGreaterThan(releaseEnd);
    const before = await search({ query: 'notarytool', until: releaseEnd });
    expect([...new Set(before.messages.map(({ threadId }) => threadId))]).toEqual([release]);
    const after = await search({ query: 'notarytool', since: untitledStart });
    expect(after.results.map(({ threadId }) => threadId)).toEqual([untitled]);
    expect(after.messages.every(({ createdAt }) => createdAt >= untitledStart)).toBe(true);
    const titled = await search({ query: 'kitchen budget', since: untitledStart });
    expect(titled.titles).toEqual([]);
  });

  test('brainstrike threads search prints the fused lexical list from the Root owner', async () => {
    // The Root's owner becomes a standalone host over the same committed threads and index.
    coreOwnsRoot = false;
    await core.close();
    await store.close();
    const host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        ...fixturePlatform(new MockLanguageModelV4()),
        searchState: (request) => port.searchState(request),
        validateWorkspaceBinding: async () => undefined,
      }
    );
    const cli = async (args: string[]): Promise<unknown> => {
      let output = '';
      await runHostCli(['--data-root', root, 'threads', 'search', ...args], {
        write: (value) => {
          output += value;
        },
      });
      return HOST_RESULT_SCHEMAS['thread/search'].parse(JSON.parse(output));
    };
    try {
      expect(await cli(['--query', 'notarytool', '--scope-root', 'release-root'])).toMatchObject({
        lexical: 'all-words',
        results: [{ threadId: '854d96a7-d175-401e-bba5-9ef6dc3335fa', titleMatched: false }],
      });
      expect(await cli(['--query', 'release stapler', '--limit', '5'])).toMatchObject({
        lexical: 'any-word',
        results: [{ threadId: '854d96a7-d175-401e-bba5-9ef6dc3335fa', titleMatched: true }],
      });
      expect(
        await cli(['--query', 'notarytool', '--since', new Date(Date.now() + 60_000).toISOString()])
      ).toMatchObject({ messages: [], results: [] });
      await expect(cli(['--query', 'notarytool', '--since', 'yesterday'])).rejects.toThrow(
        '--since must be an ISO 8601 date or date-time'
      );
      await expect(
        cli(['--query', 'notarytool', '--since', '2026-10-02', '--until', '2026-10-01'])
      ).rejects.toThrow('--since must not be after --until');
    } finally {
      await host.close();
    }
  });
});
