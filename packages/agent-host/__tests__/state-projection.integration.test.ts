import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { BLOBS_DIR, StateStore, UnknownEventError } from '@brainstrike/state-store';
import approved from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import question from '@brainstrike/test-utils/fixtures/committed-host-question.json' with {
  type: 'json',
};
import rich from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { committedRowAddress } from '../src/committed-identities.js';
import { HostCore } from '../src/core.js';
import { readHostRow, storedHostEvent } from '../src/event-storage.js';
import { HostLogRowSchema } from '../src/protocol.js';
import { decode, messages, search, text } from '../src/state-projection.js';
import { searchHostThreads } from '../src/thread-search.js';
import history from './fixtures/committed-history-search.json' with { type: 'json' };

const recordings = { approved, plan, question, rich };

test('native indexer consumes the actual Core producer and preserves committed truth across reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-core-native-projection-')));
  const options = {
    dbPath: join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: [root],
    stateProjection: {
      mode: 'dev',
      module: new URL('../dist/state-projection.js', import.meta.url).href,
    },
    stateRoot: root,
  } as const;
  // Existing native process deadlines; no new readiness or inference budget.
  const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
  let port: Awaited<ReturnType<typeof openIndexer>> | undefined;
  let store: StateStore | undefined;
  try {
    const captured = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
      errors: 'all',
      onExcessProperty: 'error',
    })(rich);
    const threads = [...new Set(captured.map((row) => row.threadId))];
    port = await openIndexer(options, deadlines);
    store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
    await store.append(captured.map((row) => storedHostEvent(row.threadId, row.event)));
    const raw = await store.readAll();
    // BST-1977: this previously rejected the first metadata row as "Expected string".
    await port.catchUpState(threads);
    for (const threadId of threads) {
      const original = raw.filter((row) => row.threadId === threadId);
      expect(await port.stateStats(threadId)).toMatchObject({
        cursor: original.at(-1)?.seq,
        gaps: [],
      });
      const started = captured.find(
        (row) => row.threadId === threadId && row.event.type === 'run.started'
      );
      if (!started) {
        throw new Error('Runtime recording has no original input');
      }
      expect(await port.matchState(threadId, 'Capture')).toContain(started.seq);
    }
    await port.close();
    port = undefined;
    await store.close();
    store = undefined;
    port = await openIndexer(options, deadlines);
    store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
    await port.catchUpState(threads);
    expect(await store.readAll()).toEqual(raw);
    expect(await port.stateHealth()).toEqual({ indexerErrors: [] });
  } finally {
    await port?.close();
    await store?.close();
    await rm(root, { force: true, recursive: true });
  }
});

test.each(Object.entries(recordings))(
  'actual %s recording keeps Core bytes and public Memory message identities across SQLite reopen',
  async (_name, recording) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-core-projection-'));
    let store: StateStore | undefined;
    try {
      const captured = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
        errors: 'all',
        onExcessProperty: 'error',
      })(recording);
      store = await StateStore.open(root);
      await store.append(captured.map((row) => storedHostEvent(row.threadId, row.event)));
      await store.close();
      store = await StateStore.open(root);
      const raw = await store.readAll();
      const rows = await Promise.all(raw.map((row) => readHostRow(store as StateStore, row)));
      const projected = raw.map((row) => ({
        event: decode(row.raw, 'dev', root),
        seq: row.seq,
        threadId: row.threadId,
      }));
      expect(projected.map((row) => row.event)).toEqual(
        rows.map((row) => ({ ...row.event, seq: row.seq }))
      );
      expect(raw.every((row) => !Object.hasOwn(JSON.parse(row.raw), 'v'))).toBe(true);
      const publicMessages = committedMemoryTranscript(rows, 'recorded-resource');
      const identities = messages(projected);
      expect(identities.map((message) => message.messageId)).toEqual(
        publicMessages.map((message) => message.id)
      );
      for (const identity of identities) {
        const source = rows.find((row) => row.seq === identity.seq);
        if (!source) {
          throw new Error('Projection identity has no original committed row');
        }
        expect(source.event.type).toMatch(/^(run.started|model.step|model.messages)$/);
        if (source.event.type === 'run.started') {
          expect(publicMessages.find((message) => message.id === identity.messageId)?.role).toBe(
            'user'
          );
          expect(text(projected.find((row) => row.seq === source.seq)?.event)).toBe(
            source.event.prompt
          );
        } else {
          expect(identity.messageId).toBe(committedRowAddress(source));
        }
      }
      expect(await store.readAll()).toEqual(raw);
    } finally {
      await store?.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);

test('purged, unreadable and metadata rows have no searchable content or message identity', () => {
  const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
    errors: 'all',
    onExcessProperty: 'error',
  })(approved);
  const tombstone = decode('{"seq":1,"type":"purged"}', 'dev');
  const unreadable = decode('{"seq":2,"type":"unknown-producer-event"}', 'prod');
  expect(text(tombstone)).toBeNull();
  expect(text(unreadable)).toBeNull();
  expect(
    messages([
      { event: tombstone, seq: 1, threadId: rows[0]?.threadId ?? '' },
      { event: unreadable, seq: 2, threadId: rows[0]?.threadId ?? '' },
    ])
  ).toEqual([]);
  for (const row of rows) {
    if (row.event.type === 'command.accepted' || row.event.type === 'stream.chunk') {
      expect(text(row.event)).toBeNull();
    }
  }
  expect(() => decode('{"seq":2,"type":"unknown-producer-event"}', 'dev')).toThrow(
    UnknownEventError
  );
});

test('message eligibility follows original run/thread binding and refuses a missing accepted command', () => {
  const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
    errors: 'all',
    onExcessProperty: 'error',
  })(rich);
  const original = messages(rows);
  const segments = rows.filter(
    (row) => row.event.type === 'model.step' || row.event.type === 'model.messages'
  );
  expect(segments.length).toBeGreaterThan(0);
  expect(
    messages([
      ...rows,
      ...segments.map((row) => ({ ...row, seq: row.seq + 10_000, threadId: 'foreign-thread' })),
    ])
  ).toEqual(original);
  expect(() =>
    messages(
      rows.filter(
        (row) => !(row.event.type === 'command.accepted' && row.event.method === 'run/start')
      )
    )
  ).toThrow();
});

test('producer and Core decode the same owned blob and expose damage without changing truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-core-projection-blob-'));
  const store = await StateStore.open(root);
  try {
    const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
      errors: 'all',
      onExcessProperty: 'error',
    })(approved);
    const captured = rows.find((row) => row.event.type === 'effect.finished');
    if (captured?.event.type !== 'effect.finished') {
      throw new Error('Recorded Core tool result is missing');
    }
    const result = { ...captured.event, output: rich };
    const [stored] = await store.append([storedHostEvent(captured.threadId, result)]);
    if (!stored || typeof stored.event['blob'] !== 'string') {
      throw new Error('Recorded rich result did not use the actual Core blob boundary');
    }
    const path = join(root, BLOBS_DIR, stored.event['blob']);
    const original = await readFile(path);
    expect(decode(stored.raw, 'dev', root)).toEqual({ ...result, seq: stored.seq });
    expect(await readHostRow(store, stored)).toMatchObject({ event: result });
    expect(() => decode(stored.raw, 'dev')).toThrow(UnknownEventError);
    await writeFile(path, original.subarray(0, original.length - 1));
    expect(() => decode(stored.raw, 'dev', root)).toThrow(UnknownEventError);
    expect(decode(stored.raw, 'prod', root)).toMatchObject({
      raw: stored.raw,
      seq: stored.seq,
      type: 'unreadable',
    });
    await expect(readHostRow(store, stored)).rejects.toThrow();
    expect((await store.readAll())[0]?.raw).toBe(stored.raw);
    await writeFile(path, original);
  } finally {
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('recorded tool and decision history searches retain addresses through rebuild and deletion', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m4-history-search-')));
  const port = await openIndexer(
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
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  let core: HostCore | undefined;
  try {
    const captured = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
      errors: 'all',
      onExcessProperty: 'error',
    })([...approved, ...question, ...plan]);
    await store.append(captured.map((row) => storedHostEvent(row.threadId, row.event)));
    const threads = [...new Set(captured.map(({ threadId }) => threadId))];
    await port.catchUpState(threads);
    core = await HostCore.open(
      store,
      {
        close: async () => undefined,
        readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      },
      () => () => undefined
    );
    const cases = [
      { query: 'fixture', role: 'user', rows: approved, seq: 5 },
      { query: 'approve', role: 'assistant', rows: approved, seq: 14 },
      { query: 'permitted', role: 'assistant', rows: approved, seq: 19 },
      { query: 'environment', role: 'assistant', rows: question, seq: 8 },
      { query: 'Preview', role: 'assistant', rows: question, seq: 13 },
      { query: 'rejected', role: 'assistant', rows: plan, seq: 16 },
    ] as const;
    const assertSearch = async () => {
      for (const scenario of cases) {
        const source = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
          errors: 'all',
          onExcessProperty: 'error',
        })(scenario.rows).find(({ seq }) => seq === scenario.seq);
        if (!(source && 'runId' in source.event && core)) {
          throw new Error('Runtime recording must contain the original run address');
        }
        expect(
          await port.searchState({ limit: 20, query: scenario.query, threadIds: threads })
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: scenario.role,
              runId: source.event.runId,
              seq: source.seq,
              threadId: source.threadId,
            }),
          ])
        );
        if (scenario.role === 'assistant') {
          const result = await searchHostThreads(
            core,
            (request) => port.searchState(request),
            undefined,
            { query: scenario.query }
          );
          expect(result.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                messageId: source.event.runId,
                rootThreadId: source.threadId,
                threadId: source.threadId,
              }),
            ])
          );
        }
        expect(
          await port.searchState({
            limit: 20,
            query: scenario.query,
            threadIds: ['unowned-thread'],
          })
        ).toEqual([]);
      }
    };
    await assertSearch();
    const original = await store.readAll();
    for (const thread of threads) {
      await port.rebuildState(thread);
    }
    await assertSearch();
    expect(await store.readAll()).toEqual(original);
    const deleted = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
      errors: 'all',
      onExcessProperty: 'error',
    })(plan)[0]?.threadId;
    if (!deleted) {
      throw new Error('Recorded plan thread is missing');
    }
    await core.deleteThread({ threadId: deleted });
    await port.rebuildState(deleted);
    expect(await port.searchState({ limit: 20, query: 'rejected', threadIds: [deleted] })).toEqual(
      []
    );
  } finally {
    await core?.close();
    await port.close();
    await store.close();
    await rm(root, { recursive: true });
  }
});

/** The recorded read tool's notes: the `content` string value of its output. */
function recordedNotes(event: unknown): string {
  return z.object({ output: z.object({ content: z.string() }) }).parse(event).output.content;
}

test('recorded multi-line tool output searches by each of its words, not JSON escapes', async () => {
  const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
    errors: 'all',
    onExcessProperty: 'error',
  })(history);
  const results = rows.filter((row) => row.event.type === 'effect.finished');
  expect(results.length).toBeGreaterThan(0);
  for (const row of results) {
    const projected = search(row.event);
    // The recorded value's own lines and tabs, never a JSON-escaped `\n` or `\t`.
    expect(projected?.text.split('\n')).toEqual(
      expect.arrayContaining(recordedNotes(row.event).split('\n'))
    );
    expect(projected?.text).not.toMatch(/\\[nt]/u);
    expect(text(row.event)).toBe(projected?.text);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m6-history-tokens-')));
  const port = await openIndexer(
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
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  try {
    await store.append(rows.map((row) => storedHostEvent(row.threadId, row.event)));
    const threads = [...new Set(rows.map(({ threadId }) => threadId))];
    await port.catchUpState(threads);
    // Each word follows a recorded newline or tab inside a tool's output.
    for (const query of ['notarytool', 'stapler', 'trigram', 'slate', 'status', 'issue']) {
      const owner = results.find((row) =>
        new RegExp(`[\\n\\t]${query}`, 'u').test(recordedNotes(row.event))
      );
      if (!owner) {
        throw new Error(`The recording has no tool output line starting with ${query}`);
      }
      expect(await port.searchState({ limit: 20, query, threadIds: threads })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', seq: owner.seq, threadId: owner.threadId }),
        ])
      );
    }
  } finally {
    await port.close();
    await store.close();
    await rm(root, { recursive: true });
  }
});
