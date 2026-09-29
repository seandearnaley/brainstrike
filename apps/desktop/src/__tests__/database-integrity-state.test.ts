import type {
  DatabaseCorruptionSignal,
  DatabaseIntegrityContext,
  DatabaseIntegritySnapshot,
} from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertBackgroundDatabaseWorkAdmitted,
  containDatabaseIntegrityError,
  createDesktopDatabaseIntegrity,
  DatabaseIntegrityError,
  getDesktopDatabaseIntegrity,
  resetDesktopDatabaseIntegrityForTests,
} from '../database-integrity-state';
import type { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

// Drift guard: every `db:*` context is a real IPC channel string.
type DbChannel = (typeof DESKTOP_IPC_CHANNELS.db)[keyof typeof DESKTOP_IPC_CHANNELS.db];
const DB_CONTEXTS_ARE_CHANNELS: Extract<DatabaseIntegrityContext, `db:${string}`> extends DbChannel
  ? true
  : never = true;

const SIGNAL: DatabaseCorruptionSignal = {
  file: 'nbtpage.c',
  message: 'index "idx_file_chunks_bm25" contains unexpected zero page at block 0',
  routine: '_bt_getbuf',
  schema: 'public',
  sqlstate: 'XX002',
  table: 'file_chunks',
};

function createLogger() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function createFixture() {
  const logger = createLogger();
  const clock = { current: Date.parse('2026-09-29T12:00:00.000Z') };
  const integrity = createDesktopDatabaseIntegrity({
    logger,
    now: () => new Date(clock.current),
  });
  return { clock, integrity, logger };
}

describe('desktop database integrity state', () => {
  it('pins the db:* contexts to IPC channel strings', () => {
    expect(DB_CONTEXTS_ARE_CHANNELS).toBe(true);
  });

  it('starts healthy at revision 0', () => {
    const { integrity } = createFixture();
    expect(integrity.getSnapshot()).toEqual({ revision: 0, state: { kind: 'healthy' } });
  });

  it('contains the first integrity error: revision +1, since from the injected clock, one notification, one error log', () => {
    const { integrity, logger } = createFixture();
    const listener = vi.fn();
    integrity.subscribe(listener);

    const snapshot = integrity.contain('db:query', SIGNAL);

    const expected: DatabaseIntegritySnapshot = {
      revision: 1,
      state: {
        context: 'db:query',
        kind: 'contained',
        signal: SIGNAL,
        since: '2026-09-29T12:00:00.000Z',
      },
    };
    expect(snapshot).toEqual(expected);
    expect(integrity.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(snapshot);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Database integrity error contained; background database work is paused. Nothing was deleted or replaced.',
      {
        context: 'db:query',
        file: 'nbtpage.c',
        revision: 1,
        routine: '_bt_getbuf',
        schema: 'public',
        since: '2026-09-29T12:00:00.000Z',
        sqlstate: 'XX002',
        table: 'file_chunks',
      }
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the first containment: a later error only warns, with no revision change and no notification', () => {
    const { clock, integrity, logger } = createFixture();
    const first = integrity.contain('db:query', SIGNAL);
    const listener = vi.fn();
    integrity.subscribe(listener);
    clock.current += 5000;

    const second = integrity.contain('maintenance', { message: 'later', sqlstate: 'XX001' });

    expect(second).toBe(first);
    expect(integrity.getSnapshot()).toBe(first);
    expect(listener).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Database integrity error observed while containment is active',
      {
        containedContext: 'db:query',
        context: 'maintenance',
        since: '2026-09-29T12:00:00.000Z',
        sqlstate: 'XX001',
      }
    );
  });

  it('returns to healthy only when the database is replaced: revision +1, one notification, info log', () => {
    const { integrity, logger } = createFixture();
    integrity.contain('db:query', SIGNAL);
    const listener = vi.fn();
    integrity.subscribe(listener);

    const snapshot = integrity.markDatabaseReplaced('factory-reset');

    expect(snapshot).toEqual({ revision: 2, state: { kind: 'healthy' } });
    expect(integrity.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(snapshot);
    expect(logger.info).toHaveBeenCalledWith(
      'Database integrity containment cleared after the database was replaced',
      { reason: 'factory-reset', revision: 2 }
    );
  });

  it('treats markDatabaseReplaced on a healthy database as a no-op', () => {
    const { integrity, logger } = createFixture();
    const listener = vi.fn();
    integrity.subscribe(listener);

    const snapshot = integrity.markDatabaseReplaced('developer-reset');

    expect(snapshot).toEqual({ revision: 0, state: { kind: 'healthy' } });
    expect(listener).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('contains again after a replacement (a fresh episode gets a new since and revision)', () => {
    const { clock, integrity } = createFixture();
    integrity.contain('db:query', SIGNAL);
    integrity.markDatabaseReplaced('factory-reset');
    clock.current += 60_000;

    const snapshot = integrity.contain('maintenance', SIGNAL);

    expect(snapshot.revision).toBe(3);
    expect(snapshot.state).toMatchObject({
      context: 'maintenance',
      kind: 'contained',
      since: '2026-09-29T12:01:00.000Z',
    });
  });

  it('isolates a throwing subscriber: it is logged and later subscribers still run', () => {
    const { integrity, logger } = createFixture();
    const failure = new Error('subscriber exploded');
    const throwing = vi.fn(() => {
      throw failure;
    });
    const healthy = vi.fn();
    integrity.subscribe(throwing);
    integrity.subscribe(healthy);

    integrity.contain('db:query', SIGNAL);

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Database integrity subscriber failed', {
      error: failure,
    });
  });

  it('stops notifying a subscriber after it unsubscribes', () => {
    const { integrity } = createFixture();
    const listener = vi.fn();
    const unsubscribe = integrity.subscribe(listener);
    unsubscribe();

    integrity.contain('db:query', SIGNAL);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('containDatabaseIntegrityError', () => {
  it('returns null and leaves the state healthy for errors the classifier rejects', () => {
    const { integrity } = createFixture();

    expect(containDatabaseIntegrityError('db:query', { code: 'XX000' }, integrity)).toBeNull();
    expect(
      containDatabaseIntegrityError('db:query', new Error('data corrupted on disk'), integrity)
    ).toBeNull();
    expect(containDatabaseIntegrityError('db:query', 'XX001', integrity)).toBeNull();

    expect(integrity.getSnapshot()).toEqual({ revision: 0, state: { kind: 'healthy' } });
  });

  it('contains an XX001 error and returns a typed error carrying the original as its cause', () => {
    const { integrity } = createFixture();
    const original = Object.assign(new Error('invalid page in block 7 of relation base/1/2'), {
      code: 'XX001',
    });

    const error = containDatabaseIntegrityError('db:exec', original, integrity);

    expect(error).toBeInstanceOf(DatabaseIntegrityError);
    expect(error?.name).toBe('DatabaseIntegrityError');
    expect(error?.cause).toBe(original);
    expect(error?.detail).toEqual({
      context: 'db:exec',
      reason: 'detected',
      signal: { message: 'invalid page in block 7 of relation base/1/2', sqlstate: 'XX001' },
    });
    expect(error?.message).toBe(
      'Database integrity error (SQLSTATE XX001) during db:exec: invalid page in block 7 of relation base/1/2. Background indexing and maintenance are paused until BrainStrike restarts. Nothing was deleted or replaced.'
    );
    expect(integrity.getSnapshot().state).toMatchObject({ context: 'db:exec', kind: 'contained' });
  });

  it('classifies through a wrapper that preserves the original as its cause', () => {
    const { integrity } = createFixture();
    const wrapped = new Error('query failed', {
      cause: Object.assign(new Error('bad index'), { code: 'XX002' }),
    });

    const error = containDatabaseIntegrityError('db:transaction', wrapped, integrity);

    expect(error?.detail).toMatchObject({ reason: 'detected', signal: { sqlstate: 'XX002' } });
    expect(error?.cause).toBe(wrapped);
  });

  it('passes an already-contained error through unchanged instead of wrapping it again', () => {
    const { integrity, logger } = createFixture();
    const original = Object.assign(new Error('bad page'), { code: 'XX001' });
    const first = containDatabaseIntegrityError('db:query', original, integrity);
    const revisionAfterFirst = integrity.getSnapshot().revision;

    const second = containDatabaseIntegrityError('maintenance', first, integrity);

    expect(second).toBe(first);
    expect(integrity.getSnapshot().revision).toBe(revisionAfterFirst);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('assertBackgroundDatabaseWorkAdmitted', () => {
  it('returns while the database is healthy', () => {
    const { integrity } = createFixture();
    expect(() => assertBackgroundDatabaseWorkAdmitted(integrity)).not.toThrow();
  });

  it('throws background-paused with the contained state while contained', () => {
    const { integrity } = createFixture();
    const { state } = integrity.contain('maintenance', SIGNAL);

    let thrown: unknown;
    try {
      assertBackgroundDatabaseWorkAdmitted(integrity);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DatabaseIntegrityError);
    const error = thrown as DatabaseIntegrityError;
    expect(error.detail).toEqual({ reason: 'background-paused', state });
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe(
      'Background database work is paused: the database reported an integrity error (SQLSTATE XX002) during maintenance at 2026-09-29T12:00:00.000Z. Nothing was deleted or replaced.'
    );
  });
});

describe('DatabaseIntegrityError copy', () => {
  it('never contains the word "closed", which the embedding worker treats as a dead database', () => {
    const { integrity } = createFixture();
    const detected = containDatabaseIntegrityError(
      'db:query',
      Object.assign(new Error('page is corrupt'), { code: 'XX001' }),
      integrity
    );
    let paused: unknown;
    try {
      assertBackgroundDatabaseWorkAdmitted(integrity);
    } catch (error) {
      paused = error;
    }

    expect(detected?.message.toLowerCase()).not.toContain('closed');
    expect((paused as Error).message.toLowerCase()).not.toContain('closed');
  });
});

describe('process singleton', () => {
  beforeEach(() => {
    resetDesktopDatabaseIntegrityForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetDesktopDatabaseIntegrityForTests();
  });

  it('shares one instance and defaults the gate arguments to it', () => {
    const integrity = getDesktopDatabaseIntegrity();
    expect(getDesktopDatabaseIntegrity()).toBe(integrity);

    const error = containDatabaseIntegrityError(
      'db:query',
      Object.assign(new Error('bad'), { code: 'XX001' })
    );

    expect(error).toBeInstanceOf(DatabaseIntegrityError);
    expect(integrity.getSnapshot().state.kind).toBe('contained');
    expect(() => assertBackgroundDatabaseWorkAdmitted()).toThrow(DatabaseIntegrityError);
  });

  it('resets to a fresh healthy instance for tests', () => {
    const before = getDesktopDatabaseIntegrity();
    before.contain('db:query', SIGNAL);

    resetDesktopDatabaseIntegrityForTests();

    const after = getDesktopDatabaseIntegrity();
    expect(after).not.toBe(before);
    expect(after.getSnapshot()).toEqual({ revision: 0, state: { kind: 'healthy' } });
  });

  it('refuses to reset outside NODE_ENV=test', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => resetDesktopDatabaseIntegrityForTests()).toThrow(
      'resetDesktopDatabaseIntegrityForTests can only be used in test mode'
    );
  });
});
