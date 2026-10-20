import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { IndexerError } from '@brainstrike/indexer';
import {
  type NativeIndexRefusalCause,
  NativeIndexRefusalError,
} from '@brainstrike/indexing-contract/indexer-client';
import {
  type QueryProcess,
  SqliteQueryClient,
  SqliteQueryProcessExitedError,
} from '@brainstrike/sqlite-query';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalError, canonicalFault } from '../../canonical-utility-protocol';
import {
  markDesktopShuttingDown,
  resetDesktopShutdownStateForTests,
} from '../../desktop-shutdown-state';
import { HostedEmbeddingError } from '../../hosted-embedding-error';
import { settleIpcResult } from '../../platform/desktop-ipc-registry';

const log = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', () => ({ createLogger: () => ({ error: log, info }) }));
afterEach(() => {
  resetDesktopShutdownStateForTests();
  vi.clearAllMocks();
});

const cases: readonly NativeIndexRefusalCause[] = [
  { kind: 'transitioning' },
  { kind: 'closed', reason: 'private-owner-reason' },
  { kind: 'setup-required', message: 'private-owner-message' },
  { kind: 'settings-invalid', message: 'private-owner-message' },
  { kind: 'source-failure', message: 'private-owner-message' },
];

it.each(cases)(
  'preserves the $kind refusal across the renderer boundary without private cause text',
  async (cause) => {
    const inner = new Error('/private/profile/index.sqlite: private-owner-message');
    const error = new NativeIndexRefusalError(cause, inner.message, { cause: inner });
    const wire = await settleIpcResult(
      { category: 'native-index', code: 'native-index-failed' },
      () => {
        throw error;
      }
    );
    expect(wire).toMatchObject({
      error: {
        category:
          cause.kind === 'setup-required' || cause.kind === 'settings-invalid'
            ? 'configuration'
            : 'availability',
        code: `native-index-${cause.kind}`,
        kind: 'refusal',
      },
      ok: false,
    });
    expect(JSON.stringify(wire)).not.toContain('private-owner');
    expect(JSON.stringify(wire)).not.toContain('/private/profile');
    let received: unknown;
    try {
      readBoundaryResult(structuredClone(wire));
    } catch (failure) {
      received = failure;
    }
    expect(received).toMatchObject({ code: error.code });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      cause: inner,
      code: error.code,
      correlationId: expect.any(String),
    });
    if (!wire.ok) {
      expect(log.mock.calls[0]?.[1]).toMatchObject({ correlationId: wire.error.correlationId });
    }
  }
);

it.each([
  ['missing-key', 'configuration'],
  ['input-too-long', 'input'],
  ['rate-limit', 'availability'],
] as const)('retains typed %s through the real status boundary', async (kind, category) => {
  const original = new HostedEmbeddingError(
    kind,
    'No API key configured for the embedding provider.',
    { cause: new Error('private missing-key fixture') }
  );
  const error = canonicalError(
    canonicalFault(
      new AggregateError([original, original], 'Canonical inference and retirement failed.')
    )
  );
  const wire = await settleIpcResult(
    { category: 'native-index', code: 'index-search:status' },
    () => {
      throw error;
    }
  );
  expect(wire).toMatchObject({
    error: {
      category,
      code: `embedding.${kind}`,
      correlationId: expect.any(String),
      kind: 'refusal',
      remedy: expect.any(String),
    },
    ok: false,
  });
  expect(JSON.stringify(wire)).not.toContain('private missing-key fixture');
  expect(() => readBoundaryResult(structuredClone(wire))).toThrow(
    expect.objectContaining({ code: `embedding.${kind}` })
  );
  expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cause: error }));
});

it('keeps a closed refusal during quit, with its cause logged at info (ADR-0015)', async () => {
  markDesktopShuttingDown();
  const inner = new Error('Factory reset reopen cancelled by terminal quit');
  const error = new NativeIndexRefusalError(
    { kind: 'closed', reason: 'root-data-deletion' },
    'Native index activation is closed for terminal retirement.',
    { cause: inner }
  );
  const wire = await settleIpcResult(
    { category: 'native-index', code: 'native-index-failed' },
    () => {
      throw error;
    }
  );
  expect(wire).toMatchObject({
    error: { code: 'native-index-closed', kind: 'refusal' },
    ok: false,
  });
  expect(log).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    cause: inner,
    code: error.code,
    correlationId: expect.any(String),
  });
});

// Hosted run 39174635723: a signal to Main's process group ended the indexer under
// a renderer's in-flight index call, and its typed exit was logged at error.
it.each([false, true])(
  'logs an indexer exit under an index call at error, or at info while quitting (quitting=%s)',
  async (quitting) => {
    if (quitting) {
      markDesktopShuttingDown();
    }
    const exited = new IndexerError('indexer-exited', 'Indexer process exited.');
    const wire = await settleIpcResult(
      { category: 'native-index', code: 'native-index-failed' },
      () => {
        throw exited;
      }
    );
    expect(wire).toMatchObject({ error: { code: 'boundary.internal' }, ok: false });
    const fields = {
      correlationId: expect.any(String),
      error: exited,
      operation: { category: 'native-index', code: 'native-index-failed' },
    };
    expect(quitting ? info : log).toHaveBeenCalledExactlyOnceWith(
      'Untyped failure crossed a process boundary',
      fields
    );
    expect(quitting ? log : info).not.toHaveBeenCalled();
  }
);

/** What a SQLite query client rejects a read with when its process exits under it, unasked. */
async function sqliteExitUnderRead(): Promise<unknown> {
  let reply: (message: unknown) => void = () => undefined;
  let exit: () => void = () => undefined;
  const posted = Promise.withResolvers<void>();
  const queryProcess: QueryProcess = {
    kill: vi.fn(),
    onError: () => () => undefined,
    onExit: (listener) => {
      exit = listener;
      return () => undefined;
    },
    onMessage: (listener) => {
      reply = listener;
      return () => undefined;
    },
    postMessage: (request) => {
      if (request.kind === 'open') {
        queueMicrotask(() => reply({ id: request.id, kind: 'ready' }));
      } else {
        posted.resolve();
      }
    },
  };
  const client = await SqliteQueryClient.open({
    databasePath: '/owned/profile/index.sqlite',
    deadlineMs: 1000,
    spawn: () => queryProcess,
    startupDeadlineMs: 1000,
  });
  const read = client
    .grep({ caseSensitive: false, isRegex: false, maxRows: 10, pattern: 'x', rootIds: ['root'] })
    .then(
      () => new Error('The read resolved.'),
      (error: unknown) => error
    );
  await posted.promise;
  exit();
  return read;
}

// Hosted run 39314780076: a signal to Main's process group ended the SQLite query process
// under a renderer's in-flight index read. The spec excused that record by its message; its
// typed exit is now the expected outcome while quitting, and stays a failure otherwise.
it.each([false, true])(
  'logs a SQLite query exit under an index read at error, or at info while quitting (quitting=%s)',
  async (quitting) => {
    if (quitting) {
      markDesktopShuttingDown();
    }
    const exited = await sqliteExitUnderRead();
    // The record the spec's message matcher excused: DesktopIpcRegistry, this message, this error.
    expect(exited).toMatchObject({ message: 'SQLite query process exited.' });
    const wire = await settleIpcResult(
      { category: 'native-index', code: 'native-index-failed' },
      () => {
        throw exited;
      }
    );
    expect(wire).toMatchObject({ error: { code: 'boundary.internal' }, ok: false });
    expect(quitting ? info : log).toHaveBeenCalledExactlyOnceWith(
      'Untyped failure crossed a process boundary',
      {
        correlationId: expect.any(String),
        error: exited,
        operation: { category: 'native-index', code: 'native-index-failed' },
      }
    );
    expect(quitting ? log : info).not.toHaveBeenCalled();
    expect(exited).toBeInstanceOf(SqliteQueryProcessExitedError);
  }
);
