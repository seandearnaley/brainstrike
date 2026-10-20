// @vitest-environment node
// Lifecycle redesign PR D: a slow indexer request or canonical attach is load, not death. Main
// retires the indexer utility only when it exits, and never closes admission on a clock.
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import {
  CANONICAL_CHANNEL,
  decodeCanonicalFrame,
  isCanonicalFrame,
} from '../canonical-utility-protocol';
import { IndexerHostManager } from '../indexer-host-manager';

const SLOW_MS = 7000;
const dbPath = '/explicit/derived.sqlite';
const info = {
  dbPath,
  embedding: { indexMode: 'text-only' },
  journalMode: 'wal',
  pid: 1,
  readerQueryOnly: 1,
  storeId: 'a'.repeat(64),
  vecVersion: 'v0.1.9',
  writerThreadId: 1,
};

type FakeUtility = EventEmitter & {
  kill: () => boolean;
  kills: number;
  postMessage: (message: unknown) => void;
};
const forks = vi.hoisted(() => ({ count: 0, next: undefined as unknown }));

vi.mock('electron', () => ({
  app: { isReady: () => true },
  utilityProcess: {
    fork: () => {
      forks.count += 1;
      return forks.next;
    },
  },
}));

/** An indexer utility that answers indexer requests and canonical `attach` after `SLOW_MS`. */
function slowUtility(slow: { readonly attach: boolean; readonly request: boolean }): FakeUtility {
  let started = false;
  const utility: FakeUtility = Object.assign(new EventEmitter(), {
    kill: () => {
      utility.kills += 1;
      queueMicrotask(() => utility.emit('exit', null));
      return true;
    },
    kills: 0,
    postMessage: (message: unknown): void => {
      if (!started) {
        started = true;
        queueMicrotask(() => utility.emit('message', { kind: 'ready', value: info }));
        return;
      }
      if (isCanonicalFrame(message)) {
        const frame = decodeCanonicalFrame(message);
        if (frame.kind !== 'call') {
          return;
        }
        const answer = (): void => {
          utility.emit('message', {
            channel: CANONICAL_CHANNEL,
            id: frame.id,
            kind: 'result',
            ok: true,
            owner: frame.owner,
            value: null,
          });
        };
        setTimeout(answer, frame.op === 'attach' && slow.attach ? SLOW_MS : 0);
        return;
      }
      const { id, op } = message as { readonly id: number; readonly op: string };
      const answer = (): void => {
        utility.emit('message', { id, kind: 'response', ok: true, value: op === 'close' || info });
        if (op === 'close') {
          queueMicrotask(() => utility.emit('exit', 0));
        }
      };
      setTimeout(answer, op !== 'close' && slow.request ? SLOW_MS : 0);
    },
  });
  return utility;
}

function collection(embeddingSetId: string): CanonicalCollectionDependencies {
  const scope = { embeddingSetId, kind: 'collection' as const };
  return {
    catalog: {
      applyManagedCacheBatch: async () => {},
      completeFiles: async () => {},
      loadAuthorizedBatch: async () => [],
      prepareManagedSourcesBatch: async () => [],
      removeFiles: async () => {},
      resolveProfile: async () => {
        throw new Error('TEXT profile resolved');
      },
    },
    parser: { parser: 'oxc' },
    publication: {
      abortScan: async () => {},
      beginScan: async ({ requestId }) => ({ generation: 1, requestId, scope, storeId: 'store' }),
      commitTextFile: async () => {},
      finishScan: async ({ ticket }) => ({ reason: 'complete', scanComplete: true, ticket }),
      removeFile: async () => {},
      verifyManifest: async () => ({
        changed: [],
        complete: true,
        missing: [],
        storeId: 'store',
        unexpected: [],
      }),
    },
    request: { batchSize: 1, chunkingOptions: { strategy: 'recursive' }, maxFileBytes: 1024 },
    scope,
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: {
        loadFiles: async () => [],
        readRetained: async () => ({ content: '', stat: { mtimeMs: null, size: 0 } }),
      },
    },
  };
}

async function manager(utility: FakeUtility): Promise<IndexerHostManager> {
  forks.next = utility;
  return IndexerHostManager.create(
    {
      dbPath,
      embedding: { indexMode: 'text-only' },
      fileBindings: [],
      rootIds: [],
      scopes: [
        { embeddingSetId: 'first', kind: 'collection' },
        { embeddingSetId: 'second', kind: 'collection' },
      ],
    },
    // Desktop's production native-index deadlines (native-index-activation.ts).
    { closeMs: 1000, exitMs: 1000, requestMs: 5000, startupMs: 60_000 },
    '/explicit/entry.js'
  );
}

afterEach(() => {
  vi.useRealTimers();
  forks.count = 0;
});

it('answers an indexer request slower than any former deadline from the one utility', async () => {
  vi.useFakeTimers();
  const utility = slowUtility({ attach: false, request: true });
  const host = await manager(utility);
  const starting = host.start();
  await vi.advanceTimersByTimeAsync(0);
  const port = await starting;

  const answer = port.info();
  answer.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(SLOW_MS);

  await expect(answer).resolves.toEqual(info);
  expect(utility.kills).toBe(0);
  expect(host.exited).toBe(false);
  expect(forks.count).toBe(1);
  const closing = host.close();
  await vi.advanceTimersByTimeAsync(0);
  await closing;
});

it('attaches a canonical source slower than any former deadline and keeps admission open', async () => {
  vi.useFakeTimers();
  const utility = slowUtility({ attach: true, request: false });
  const host = await manager(utility);

  const first = host.attachCanonicalCollection(collection('first'));
  first.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(SLOW_MS);
  await expect(first).resolves.toBeDefined();

  const second = host.attachCanonicalCollection(collection('second'));
  second.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(SLOW_MS);
  await expect(second).resolves.toBeDefined();
  expect(utility.kills).toBe(0);
  expect(forks.count).toBe(1);
  const closing = host.close();
  await vi.advanceTimersByTimeAsync(0);
  await closing;
});
