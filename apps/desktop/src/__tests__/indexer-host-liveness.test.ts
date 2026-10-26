// @vitest-environment node
// Lifecycle redesign PR D: a slow indexer request or canonical attach is load, not death. Main
// retires the indexer utility only when it exits, and never closes admission on a clock.
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanonicalRemoteWorkspaceDependencies } from '../canonical-utility-parent';
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
  /** Every canonical call the utility received, by op. */
  canonicalOps: string[];
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
function slowUtility(slow: {
  readonly attach: boolean;
  readonly request: boolean;
  /** It never answers a canonical attachment's `close`: alive, but wedged. */
  readonly wedgedClose?: boolean;
}): FakeUtility {
  let started = false;
  const utility: FakeUtility = Object.assign(new EventEmitter(), {
    canonicalOps: [] as string[],
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
        utility.canonicalOps.push(frame.op);
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
        if (frame.op === 'close' && slow.wedgedClose) {
          return;
        }
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

function workspace(rootId: string): CanonicalRemoteWorkspaceDependencies {
  const scope = { kind: 'workspace' as const, rootId };
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
    managedCollectionId: null,
    onError: vi.fn(),
    onReceipt: vi.fn(),
    onWatchHealth: vi.fn(),
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
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: { loadFiles: async () => [] },
      lease: {
        canonicalPath: `/actual/${rootId}`,
        generation: 'generation',
        listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
        readFile: async () => ({ status: 'not-found' as const }),
        retire: async () => {},
        rootId,
        signal: new AbortController().signal,
        subscribe: async () => ({ close: async () => {} }),
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
      rootIds: ['first', 'second'],
      scopes: [
        { kind: 'workspace', rootId: 'first' },
        { kind: 'workspace', rootId: 'second' },
      ],
    },
    // Desktop's production native-index deadlines (native-index-activation.ts).
    { closeMs: 30_000 },
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
  vi.useRealTimers();
  // The close is the kill (ADR-0031), the first of the utility's life.
  await host.close();
  expect(utility.kills).toBe(1);
});

it('attaches a canonical source slower than any former deadline and keeps admission open', async () => {
  vi.useFakeTimers();
  const utility = slowUtility({ attach: true, request: false });
  const host = await manager(utility);
  const starting = host.start();
  await vi.advanceTimersByTimeAsync(0);
  await starting;

  const first = host.attachCanonicalWorkspace(workspace('first'));
  first.catch(() => undefined);
  await vi.waitFor(() => expect(utility.canonicalOps).toEqual(['attach']));
  await vi.advanceTimersByTimeAsync(SLOW_MS);
  await expect(first).resolves.toBeDefined();

  const second = host.attachCanonicalWorkspace(workspace('second'));
  second.catch(() => undefined);
  await vi.waitFor(() => expect(utility.canonicalOps).toEqual(['attach', 'attach']));
  await vi.advanceTimersByTimeAsync(SLOW_MS);
  await expect(second).resolves.toBeDefined();
  expect(utility.kills).toBe(0);
  expect(forks.count).toBe(1);
  vi.useRealTimers();
  // The close is the kill (ADR-0031), the first of the utility's life.
  await host.close();
  expect(utility.kills).toBe(1);
});

// ADR-0031: quit waits on no process. Every write has committed (WAL), so the close is a kill.
it('closes at once by killing a utility that never answers its close or exits', async () => {
  const utility = slowUtility({ attach: false, request: false, wedgedClose: true });
  const host = await manager(utility);
  await host.start();
  await host.attachCanonicalWorkspace(workspace('first'));
  // Alive and wedged: it answers no close and does not exit when it is killed.
  utility.kill = () => {
    utility.kills += 1;
    return true;
  };

  const closed = vi.fn();
  void host.close().then(closed);

  await vi.waitFor(() => expect(closed).toHaveBeenCalled());
  expect(utility.kills).toBe(1);
  expect(host.exited).toBe(false);
});

/** A utility that is alive but never reports ready, and exits only when it is killed. */
function unreadyUtility(): FakeUtility {
  const utility: FakeUtility = Object.assign(new EventEmitter(), {
    canonicalOps: [] as string[],
    kill: () => {
      utility.kills += 1;
      return true;
    },
    kills: 0,
    postMessage: (): void => {},
  });
  return utility;
}

// ADR-0031: source retirement waits on no process. A utility still starting has no attachments.
it('retires canonical sources without waiting for a utility that never reports ready', async () => {
  const utility = unreadyUtility();
  const host = await manager(utility);
  const starting = host.start();
  starting.catch(() => undefined);
  await vi.waitFor(() => expect(forks.count).toBe(1));

  const retired = vi.fn();
  void host.retireCanonicalSources().then(retired);

  await vi.waitFor(() => expect(retired).toHaveBeenCalled());
  expect(utility.kills).toBe(0);
});
